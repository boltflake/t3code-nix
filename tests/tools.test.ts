// The cache job's checks and test.ts's retry, with stand-ins for nix.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeLike, plan, unfreeNames } from "../scripts/ci/cache.ts";
import { agentBrowserFailures, desktopFailures, noFlakesFailures, smokeRuns } from "../scripts/ci/test.ts";
import { GitHub } from "../scripts/ci/gh.ts";
import { assess, CRON_KEYS } from "../scripts/ci/health.ts";
import { groupAlive, stopGroup } from "../scripts/lib/proc.ts";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "tools-test-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ---- cache.ts -------------------------------------------------------------------

const SYS = "x86_64-linux";
const store = (n: string) => `/nix/store/${n}`;

/** A fake `nix`: one evaluation, builds, narHashes, and the closure. */
function fakeNix(opts: { unfreeLicense?: string[]; closure?: string[]; narHash?: Record<string, string> } = {}) {
  const calls: string[][] = [];
  const sh = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (args[0] === "eval") {
      const names = ["codex", "fx", "grok", "muse"];
      return JSON.stringify(Object.fromEntries(names.map((n) => [n, { free: !opts.unfreeLicense?.includes(n), out: store(n), drv: store(`${n}.drv`), srcs: [store(`${n}-src`)] }])));
    }
    if (args[0] === "build") return "";
    if (args[0] === "path-info" && args[1] === "--json") return JSON.stringify(args.slice(2).map((p) => ({ path: p, narHash: opts.narHash?.[p] ?? "h" })));
    if (args[0] === "path-info" && args[1] === "--recursive") return [...args.slice(2), ...(opts.closure ?? [])].join("\n");
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
  return { sh, calls };
}
const manifest = { codex: { path: store("codex"), narHash: "h" }, fx: { path: store("fx"), narHash: "h" } };

test("cache: matching free packages with a clean closure are pushed, in four nix calls", () => {
  const { sh, calls } = fakeNix({ closure: [store("glibc")] });
  const r = plan(manifest, ["codex", "fx"], ["grok"], SYS, sh);
  assert.deepEqual(r, { paths: [store("codex"), store("fx")], observations: [] });
  assert.equal(calls.length, 4);
  // One evaluation, which also gives the .drv paths; the build uses those.
  assert.equal(calls.filter((c) => c[1] === "eval").length, 1);
  assert.match(calls[0].at(-1)!, /drv = p\.drvPath;/);
  assert.deepEqual(calls.find((c) => c[1] === "build"), ["nix", "build", "--no-link", `${store("codex.drv")}^*`, `${store("fx.drv")}^*`]);
});

test("cache: a different narHash pushes nothing", () => {
  const { sh } = fakeNix({ narHash: { [store("fx")]: "other" } });
  const r = plan(manifest, ["codex", "fx"], ["grok"], SYS, sh);
  assert.deepEqual([r.paths, r.observations.map((o) => [o.kind, o.package])], [[], [["nondeterministic", "fx"]]]);
});

test("cache: an unfree package on the allowlist pushes nothing and nothing is built", () => {
  const { sh, calls } = fakeNix({ unfreeLicense: ["fx"] });
  const r = plan(manifest, ["codex", "fx"], ["grok"], SYS, sh);
  assert.deepEqual(r.paths, []);
  assert.match(r.observations[0].detail, /not free: fx/);
  assert.equal(r.observations[0].channel, SYS);
  assert.ok(!calls.some((c) => c[1] === "build"));
  // Listed in unfree.nix is enough, whatever meta.license says.
  assert.match(plan(manifest, ["codex", "grok"], ["grok"], SYS, fakeNix().sh).observations[0].detail, /not free: grok/);
});

test("cache: an unfree package or its download in the closure pushes nothing", () => {
  for (const leak of [store("grok"), store("grok-src")]) {
    const r = plan(manifest, ["codex", "fx"], ["grok", "muse"], SYS, fakeNix({ closure: [leak] }).sh);
    assert.deepEqual(r.paths, []);
    assert.match(r.observations[0].detail, /unfree grok/);
  }
});

test("cache: Google Chrome in the closure pushes nothing, from any nixpkgs (matched by name)", () => {
  const chrome = ["/nix/store/s6hgx5x0k3yc28k0i94ylw7srbz7l0f7-google-chrome-157.0.8103.50",
    "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-google-chrome-stable_157.0.8103.50-1_amd64.deb"];
  for (const leak of chrome) {
    const r = plan(manifest, ["codex", "fx"], ["grok"], SYS, fakeNix({ closure: [leak] }).sh);
    assert.deepEqual(r.paths, [], leak);
    assert.match(r.observations[0].detail, /unfree google-chrome/);
  }
  // The pins' own Chrome, once they record it.
  for (const f of ["browser-unstable", "browser-stable"]) {
    const pin = JSON.parse(readFileSync(join(import.meta.dirname, "..", "versions", `${f}.json`), "utf8"));
    for (const p of Object.values<string>(pin.browsers?.["google-chrome"]?.outPaths ?? {})) assert.ok(chromeLike(p), p);
  }
  // Not Chrome: names that only start alike, and Chromium.
  for (const p of ["/nix/store/s6hgx5x0k3yc28k0i94ylw7srbz7l0f7-google-chrome-extension-x", "/nix/store/5iyrnmahv0zkpr5b9gy7ynan71p74isk-chromium-157.0.8103.50"]) {
    assert.equal(chromeLike(p), false, p);
  }
});

// ---- test.ts --------------------------------------------------------------------

/** Run test.ts with fake nix and nix-store: check `a` passes, `b` passes only
 * when built a second time, `c` never passes; of the desktop apps, `t3code`
 * and `t3code-electron-bundled` build (as fake paths, so their smokes fail)
 * and `t3code-nightly` doesn't. */
function runTest(desktop = false, part?: string, extra: string[] = []): { result: any; manifest: any; builds: string[]; evals: number } {
  const bin = join(tmp, "bin");
  const state = join(tmp, "state");
  mkdirSync(bin);
  mkdirSync(state);
  const names = ["a", "agent-browser", "b", "c", "codex", "fx", "pi", "t3code", "t3code-electron-bundled", "t3code-nightly", "t3code-unwrapped"];
  const evaled = JSON.stringify(Object.fromEntries(names.map((n) => [n, { out: `/nix/store/${n}`, drv: `/nix/store/${n}.drv` }])));
  writeFileSync(join(bin, "nix"), `#!/bin/sh
state=${state}
case "$1" in
  # The stable part of default-nix-no-flakes (both sides unevaluable: nothing to compare).
  eval)
    # home-manager-lazy's control: an hm-* check, evaluated on the copy, reaches the abort.
    case " $* " in *" path:"*"#checks.${SYS}.hm-"*) echo "error: home-manager-lazy: Home Manager was evaluated" >&2; exit 1 ;; esac
    case " $* " in *" --raw "*) ls "${join(tmp, "out")}"/candidate-${SYS}*.json >/dev/null 2>&1 && touch "$state/raw-after-result"; exit 1 ;; esac
    # A part asks for the names first, then only its checks.
    case " $* " in *" builtins.attrNames "*) echo '${JSON.stringify(names)}'; exit 0 ;; esac
    # home-manager-lazy, on a copy of the tree: the list with an hm-* check.
    case " $* " in *" path:"*"#checks.${SYS} "*) touch "$state/hm-lazy"; echo '{"a":{"out":"/nix/store/a","drv":"/nix/store/a.drv","na":false,"electron":null},"hm-module-eval":null}'; exit 0 ;; esac
    echo x >> "$state/evals"
    case " $* " in *"inherit (cs)"*) for a; do last=$a; done
      ${process.execPath} -e 'const want = [...process.argv[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]); const all = JSON.parse(process.argv[2]); console.log(JSON.stringify(Object.fromEntries(Object.entries(all).filter(([n]) => want.includes(n)))))' "$last" '${evaled}' ;;
    *) echo '${evaled}' ;; esac ;;
  build)
    shift
    echo "$*" >> "$state/builds"
    for arg in "$@"; do
      case "$arg" in
        -*) ;;
        /nix/store/*.drv^\*) name=\$(basename "\${arg%.drv^\*}")
          case "$name" in
            a|agent-browser|codex|fx|t3code|t3code-electron-bundled|t3code-unwrapped) touch "$state/$name" ;;
            b) if [ -e "$state/b-tried" ]; then touch "$state/b"; else touch "$state/b-tried"; fi ;;
          esac ;;
        *) echo "unexpected build argument $arg" >&2; exit 2 ;;
      esac
    done
    exit 1 ;;
  path-info) echo "$*" >> "$state/path-info"; echo '{"/nix/store/codex":{"narHash":"sha256-c"},"/nix/store/fx":{"narHash":"sha256-f"}}' ;;
  *) echo "unexpected nix $1" >&2; exit 2 ;;
esac
`);
  writeFileSync(join(bin, "nix-store"), `#!/bin/sh
[ -e "${state}/$(basename "$2")" ]
`);
  // default-nix-no-flakes's stable part and default-nix-lazy, which list nothing here.
  // The flake's own derivation for each attribute (default-nix-no-flakes);
  // none for the stable set, which the fake flake can't evaluate either.
  writeFileSync(join(bin, "nix-instantiate"), `#!/bin/sh\nfor a; do last=$a; done\necho "$last" >> "${state}/instantiated"\ncase "$last" in stable.*) exit 1 ;; esac\necho "/nix/store/$last.drv"\n`);
  writeFileSync(join(bin, "nix-env"), `#!/bin/sh\necho "$*" >> "${state}/nix-env"\n`);
  chmodSync(join(bin, "nix"), 0o755);
  chmodSync(join(bin, "nix-store"), 0o755);
  chmodSync(join(bin, "nix-instantiate"), 0o755);
  chmodSync(join(bin, "nix-env"), 0o755);
  const out = join(tmp, "out");
  // A checkout for default-nix-lazy's copy (the sandbox has no git repository).
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "flake.nix"), 'let\n  stableSrc = builtins.fetchTarball {\n    url = "x";\n  };\n  homeManagerSrc = builtins.fetchTarball {\n    url = "y";\n  };\nin { }\n');
  writeFileSync(join(repo, "default.nix"), "{ }\n");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "x"]]) execFileSync("git", args, { cwd: repo, env: gitEnv });
  execFileSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "ci", "test.ts"), "candidate", SYS, out, ...(desktop ? ["--desktop"] : []), ...(part ? [`--part=${part}`] : []), ...extra],
    { cwd: repo, env: { ...gitEnv, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  return {
    result: JSON.parse(readFileSync(join(out, `candidate-${SYS}${part ? `-${part}` : ""}.json`), "utf8")),
    manifest: JSON.parse(readFileSync(join(out, `manifest-candidate-${SYS}${part ? `-${part}` : ""}.json`), "utf8")),
    builds: readFileSync(join(state, "builds"), "utf8").trim().split("\n"),
    evals: readFileSync(join(state, "evals"), "utf8").trim().split("\n").length,
  };
}

test("test.ts: failures are built once more, and only they are", () => {
  const { result, manifest, builds, evals } = runTest();
  // One path-info for the built allowlisted packages (pi failed to build).
  assert.deepEqual(readFileSync(join(tmp, "state", "path-info"), "utf8").trim(), "path-info --json /nix/store/t3code-unwrapped /nix/store/codex /nix/store/fx /nix/store/agent-browser");
  assert.deepEqual(manifest, { codex: { path: "/nix/store/codex", narHash: "sha256-c" }, fx: { path: "/nix/store/fx", narHash: "sha256-f" } });
  const { electron, nixCalls, ...rest } = result;
  assert.deepEqual(rest, { set: "candidate", system: SYS, passed: false, failed: ["c", "pi", "t3code-nightly"], checked: [], notes: [] });
  // Every Nix call it made is in the record, in order, with its outcome.
  assert.ok(nixCalls.length > 0 && nixCalls.every((c: any) => ["nix", "nix-store", "nix-instantiate", "nix-env"].includes(c.cmd)
    && c.start <= c.end && !c.timedOut && !/\n/.test(c.label)));
  assert.ok(["nix-store", "nix-instantiate", "nix-env"].every((cmd) => nixCalls.some((c: any) => c.cmd === cmd)), "the other Nix programs too");
  assert.ok(nixCalls.every((c: any, i: number) => i === 0 || nixCalls[i - 1].end <= c.start), "one at a time, in order");
  assert.equal(nixCalls.filter((c: any) => c.sub === "build").length, builds.length, "each build the fake nix saw");
  assert.ok(nixCalls.some((c: any) => c.sub === "build" && c.status !== 0), "a failed build is recorded as one");
  assert.ok(nixCalls.some((c: any) => c.sub === "eval") && nixCalls.some((c: any) => c.sub === "path-info"));
  // The last two, NixOS stable's evaluations after the first write, are in
  // the file too (it's written again after them).
  const last = nixCalls.slice(-2);
  assert.deepEqual(last.map((c: any) => [c.cmd, c.sub]), [["nix", "eval"], ["nix-instantiate", ""]]);
  // (The second's label may be cut short: it holds a temporary path.)
  assert.ok(last[0].label === `eval --raw .#legacyPackages.${SYS}.stable.t3.drvPath` && last[1].label.startsWith("--option experimental-features "));
  assert.equal(electron.smokeRan, false, "no desktop smoke without --desktop");
  // One evaluation; both builds from the .drv paths it gave.
  assert.equal(evals, 1);
  assert.equal(builds.length, 2);
  assert.match(builds[0], /^--no-link --keep-going -L \/nix\/store\/a\.drv\^\* \/nix\/store\/agent-browser\.drv\^\* \/nix\/store\/b\.drv\^\* \/nix\/store\/c\.drv\^\* /);
  assert.doesNotMatch(builds[1], /\/a\.drv/);
  assert.equal(builds[1], "--no-link --keep-going -L /nix/store/b.drv^* /nix/store/c.drv^* /nix/store/pi.drv^* /nix/store/t3code-nightly.drv^*");
  // The stable comparison ran once the default's result was saved.
  assert.ok(existsSync(join(tmp, "state", "raw-after-result")));
  // The manifest is saved before the result, so a result always has its
  // manifest beside it (the cache job needs both).
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "ci", "test.ts"), "utf8");
  const manifestAt = src.indexOf("rewriteJson(join(outDir, `manifest-${set}-${system}${suffix}.json`), manifest);");
  assert.ok(manifestAt > 0 && manifestAt < src.indexOf("\n  write();\n"), "manifest, then the result");
  // default-nix-lazy listed default.nix (from a copy) without flakes.
  assert.match(readFileSync(join(tmp, "state", "nix-env"), "utf8"), /^--option experimental-features {2}-qa -f \/.*\/default\.nix --argstr system x86_64-linux\n$/);
  // home-manager-lazy evaluated the checks from a copy, Home Manager swapped.
  assert.ok(existsSync(join(tmp, "state", "hm-lazy")));
});

test("test.ts: a part builds only its own checks and runs only its own smokes and evaluations, into its own files", async () => {
  const built = (builds: string[]) => [...builds[0].matchAll(/\/nix\/store\/([^.]+)\.drv/g)].map((m) => m[1]);
  // desktop: the apps and their smokes; no evaluation without flakes.
  let { result, builds, manifest } = runTest(true, "desktop");
  assert.deepEqual(built(builds), ["t3code", "t3code-electron-bundled", "t3code-nightly", "t3code-unwrapped"]);
  assert.deepEqual(result.failed, ["t3code-nightly", "desktop-smoke", "desktop-smoke-electron-bundled", "desktop-smoke-nightly"]);
  assert.deepEqual(result.electron.channels.t3code.passed, ["t3code-electron-bundled"], "the desktop part vouches for the bundled app it built");
  assert.ok(!existsSync(join(tmp, "state", "nix-env")), "the lazy evaluation is rest2's");
  assert.ok(!existsSync(join(tmp, "state", "hm-lazy")), "so is Home Manager's");
  assert.ok(!existsSync(join(tmp, "state", "raw-after-result")), "the stable evaluation is rest2's");
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  // rest2: its share of the others, no desktop or agent-browser smoke, the
  // evaluations. (The shares, by the name's hash, written out here.)
  ({ result, builds, manifest } = runTest(true, "rest2", ["--agent-browser"]));
  assert.deepEqual(built(builds), ["codex", "fx", "pi"]);
  // default.nix is compared with the flake on t3code (another part's check,
  // evaluated here too); nothing silently skipped.
  const compared = readFileSync(join(tmp, "state", "instantiated"), "utf8").split("\n");
  assert.ok(compared.includes("t3code") && compared.includes("agent-browser"), compared.join(" "));
  assert.deepEqual(Object.keys(manifest), ["codex", "fx"], "the cache manifest holds the part's own built packages");
  assert.ok(!result.failed.some((f: string) => /smoke/.test(f)), "no smoke in rest2");
  assert.ok(existsSync(join(tmp, "state", "nix-env")) && existsSync(join(tmp, "state", "raw-after-result")));
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  // rest1: the other share and the agent-browser smoke (agent-browser's
  // fake output isn't a real one, and agent-browser-stable-chromium isn't
  // in this fake set, so both smokes fail without starting).
  ({ result, builds, manifest } = runTest(true, "rest1", ["--agent-browser"]));
  assert.deepEqual(built(builds), ["a", "agent-browser", "b", "c"]);
  assert.deepEqual(manifest, {}, "none of rest2's packages");
  // The desktop apps aren't rest1's: it vouches for none of them.
  assert.deepEqual(Object.values(result.electron.channels).flatMap((c: any) => c.passed), []);
  assert.deepEqual(result.failed.filter((f: string) => /smoke/.test(f)), ["agent-browser-smoke", "agent-browser-smoke-stable"]);
  assert.ok(!existsSync(join(tmp, "state", "nix-env")), "the lazy evaluation is rest2's");
  // An unknown part is refused, for that reason.
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  assert.throws(() => runTest(false, "rest3"), (e: any) => /--part must be one of desktop, rest1, rest2/.test(String(e.stderr)));
});

test("parts: every check has exactly one part, by the rules in scripts/lib/parts.ts", async () => {
  const { testPart, stablePart, partArg, TEST_PARTS, STABLE_PARTS } = await import("../scripts/lib/parts.ts");
  assert.equal(testPart("t3code"), "desktop");
  assert.equal(testPart("t3code-nightly-electron-bundled"), "desktop");
  assert.equal(testPart("agent-browser"), "rest1");
  assert.equal(testPart("agent-browser-stable-chromium"), "rest1");
  assert.equal(testPart("module-eval"), "desktop");
  for (const n of ["hm-module-eval", "hm-nixos-eval", "hm-unit-parity", "hm-template"]) assert.equal(testPart(n), "desktop");
  for (const n of ["codex", "fx", "unit", "provider-wrappers"]) {
    assert.ok(["rest1", "rest2"].includes(testPart(n)));
    assert.equal(testPart(n), testPart(n), "the same every time");
  }
  assert.equal(stablePart("stable-t3code"), "a");
  assert.equal(stablePart("stable-next-agent-browser"), "a");
  assert.equal(stablePart("stable-unit"), "b");
  // Each smoke runs in the part that builds its package.
  const { ROLES } = await import("../scripts/lib/electron-fallback.ts");
  const { smokesOfGroup } = await import("../scripts/ci/stable.ts");
  const apps = Object.values(ROLES).flatMap((r) => Object.keys(r.smokes));
  assert.ok(apps.length > 0 && apps.every((app) => testPart(app) === "desktop"), apps.join(" "));
  assert.deepEqual(["agent-browser", "agent-browser-stable-chromium"].map(testPart), ["rest1", "rest1"]);
  for (const prefix of ["stable-", "stable-next-"] as const) {
    const pkgs = Object.values(smokesOfGroup(prefix)).map((s) => s.pkg);
    assert.ok(pkgs.length > 0 && pkgs.every((pkg) => stablePart(pkg) === "a"), pkgs.join(" "));
  }
  assert.equal(partArg([], TEST_PARTS), undefined);
  assert.equal(partArg(["--next", "--part=b"], STABLE_PARTS), "b");
  assert.throws(() => partArg(["--part=c"], STABLE_PARTS), /--part must be one of a, b/);
  assert.throws(() => partArg(["--part"], STABLE_PARTS), /--part must be one of a, b/, "a bare --part");
  assert.throws(() => partArg(["--part=a", "--part=b"], STABLE_PARTS), /more than once/);
});

test("test.ts: the desktop smoke uses the built checks, with no build or evaluation of its own", () => {
  const { result, builds, evals } = runTest(true);
  assert.equal(evals, 1);
  assert.equal(builds.length, 2);
  // t3code and t3code-electron-bundled built but aren't real apps;
  // t3code-nightly didn't build: their smokes fail, each after its one retry.
  assert.deepEqual(result.failed, ["c", "pi", "t3code-nightly", "desktop-smoke", "desktop-smoke-electron-bundled", "desktop-smoke-nightly"]);
});

test("test.ts: each channel's smoke gets its own app's output, and one retry", async () => {
  const checks = { t3code: { out: "/nix/store/latest", drv: "" }, "t3code-nightly": { out: "/nix/store/nightly", drv: "" } };
  const calls: string[] = [];
  // The latest channel's app passes on its retry; nightly never does.
  let latestChannelTries = 0;
  const smoke = async (pkg: string, bin: string) => {
    calls.push(`${bin} ${pkg}`);
    return bin === "t3code" && ++latestChannelTries === 2;
  };
  assert.deepEqual(await desktopFailures(checks, smoke, () => true), ["desktop-smoke-nightly"]);
  assert.deepEqual(calls, ["t3code /nix/store/latest", "t3code /nix/store/latest", "t3code-nightly /nix/store/nightly", "t3code-nightly /nix/store/nightly"]);
  // An output that isn't there fails without starting the app.
  calls.length = 0;
  const started = async (pkg: string, bin: string) => (calls.push(`${bin} ${pkg}`), true);
  assert.deepEqual(await desktopFailures(checks, started, (p) => p !== "/nix/store/nightly"), ["desktop-smoke-nightly"]);
  assert.deepEqual(calls, ["t3code /nix/store/latest"]);
});

test("test.ts: agent-browser's smoke runs with each browser pin's package, with one retry", async () => {
  const checks = { "agent-browser": { out: "/nix/store/ab", drv: "" }, "agent-browser-stable-chromium": { out: "/nix/store/ab-stable", drv: "" } };
  const calls: string[] = [];
  let tries = 0;
  const smoke = async (pkg: string) => (calls.push(pkg), pkg === "/nix/store/ab" && ++tries === 2);
  assert.deepEqual(await agentBrowserFailures(checks, smoke, () => true), ["agent-browser-smoke-stable"]);
  assert.deepEqual(calls, ["/nix/store/ab", "/nix/store/ab", "/nix/store/ab-stable", "/nix/store/ab-stable"]);
  calls.length = 0;
  assert.deepEqual(await agentBrowserFailures(checks, async (pkg) => (calls.push(pkg), true), (p) => p !== "/nix/store/ab"), ["agent-browser-smoke"]);
  assert.deepEqual(calls, ["/nix/store/ab-stable"], "an output that isn't there fails without starting");
});

// ---- gh.ts: the real REST client ---------------------------------------------------

test("gh: lists every page, drops pull requests, and sends the token", async () => {
  const real = globalThis.fetch;
  const seen: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    seen.push({ url: String(url), method: init.method!, auth: h.get("authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
    const u = new URL(String(url));
    if (u.pathname.endsWith("/issues") && init.method === "GET") {
      const page = Number(u.searchParams.get("page"));
      const items = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: "t", body: null, state: "open", ...(i === 0 ? { pull_request: {} } : {}) }))
        : [{ number: 101, title: "t", body: "b", state: "closed" }];
      return Response.json(items);
    }
    if (u.pathname.includes("/git/matching-refs/")) return Response.json([{ ref: "refs/tags/t3code-v1", object: { sha: "abc" } }]);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (u.pathname.endsWith("/workflows/health.yml")) return new Response("rate limited", { status: 403 });
    if (u.pathname.endsWith("/workflows/update.yml/runs")) {
      return Response.json({ workflow_runs: [
        { id: 6, display_title: "update", created_at: "2026-11-13T02:10:00Z", status: "queued", conclusion: null },
        { id: 5, display_title: "update", created_at: "2026-11-13T01:50:00Z", run_started_at: "2026-11-13T02:00:00Z", status: "in_progress", conclusion: null },
        { id: 4, display_title: "update (dry run)", created_at: "2026-11-13T01:30:00Z", status: "in_progress", conclusion: null },
        { id: 3, display_title: "update", created_at: "2026-11-13T01:00:00Z", status: "completed", conclusion: "cancelled", updated_at: "2026-11-13T01:05:00Z" },
        { id: 2, display_title: "update", created_at: "2026-11-13T00:30:00Z", status: "completed", conclusion: "success", updated_at: "2026-11-13T00:31:00Z" },
        // Its failed jobs re-run at 02:20: the run restarted, resolve didn't.
        { id: 1, display_title: "update", created_at: "2026-11-13T00:00:00Z", run_started_at: "2026-11-13T02:20:00Z", status: "completed", conclusion: "failure", updated_at: "2026-11-13T02:40:00Z" },
        // Made yesterday, re-run in full and finished just now.
        { id: 0, display_title: "update", created_at: "2026-11-12T00:00:00Z", run_started_at: "2026-11-13T02:30:00Z", status: "completed", conclusion: "failure", updated_at: "2026-11-13T02:50:00Z" },
      ] });
    }
    // Run 2 was re-dispatched by the gate (its issues job skipped); run 1
    // re-ran its failed jobs only (GitHub copies the jobs it didn't re-run,
    // resolve here, into attempt 2 with their old times); run 0 re-ran in full.
    const jobsOf = /\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
    if (jobsOf) {
      const job = (name: string, attempt: number, started_at?: string, conclusion = "success") => ({ name, run_attempt: attempt, conclusion, ...(started_at ? { started_at } : {}) });
      const attempts: Record<string, any[]> = {
        0: [job("resolve", 1, "2026-11-12T00:01:00Z"), job("issues", 1), job("resolve", 2, "2026-11-13T02:31:00Z"), job("issues", 2)],
        1: [job("resolve", 1, "2026-11-13T00:01:00Z"), job("issues", 1), job("resolve", 2, "2026-11-13T00:01:00Z"), job("issues", 2, "2026-11-13T02:21:00Z")],
        2: [job("resolve", 1, "2026-11-13T00:31:00Z"), job("issues", 1, undefined, "skipped")],
        // Replaced while waiting: no jobs ever ran.
        3: [],
      };
      const all = attempts[jobsOf[1]] ?? [job("resolve", 1, "2026-11-13T00:31:00Z"), job("issues", 1)];
      const last = Math.max(0, ...all.map((j) => j.run_attempt));
      const jobs = u.searchParams.get("filter") === "all" ? all : all.filter((j) => j.run_attempt === last);
      return Response.json({ total_count: jobs.length, jobs });
    }
    return Response.json({ number: 7 });
  }) as typeof fetch;
  try {
    const gh = new GitHub("o/r", "tok");
    const list = await gh.issues();
    assert.equal(list.length, 100);
    assert.deepEqual([list[0].number, list[0].body, list.at(-1)!.state], [2, "", "closed"]);
    assert.deepEqual(seen.slice(0, 2).map((s) => new URL(s.url).searchParams.get("page")), ["1", "2"]);
    assert.ok(seen.every((s) => s.auth === "Bearer tok"));

    assert.deepEqual(await gh.refs("tags/t3code-v"), { "refs/tags/t3code-v1": "abc" });
    await gh.deleteRef("refs/heads/bot/candidate/1");
    assert.equal(seen.at(-1)!.url, "https://api.github.com/repos/o/r/git/refs/heads/bot/candidate/1");
    await gh.createStatus("sha", "success", "x".repeat(200), "https://run");
    assert.deepEqual(seen.at(-1)!.body, { state: "success", description: "x".repeat(140), target_url: "https://run", context: "tested" });
    await assert.rejects(gh.workflowState("health.yml"), /HTTP 403 rate limited/);
    // Real runs only (dry runs by title); a replaced (cancelled) one did nothing,
    // nor did a run the gate re-dispatched. A finished run read upstream when
    // its latest resolve job started (a re-run of failed jobs keeps the
    // earlier attempt's, a full re-run reads anew); finished
    // runs older than the window aren't looked into.
    assert.deepEqual(await gh.updateRuns(new Date("2026-11-13T03:00:00Z")), [
      { read: "2026-11-13T02:10:00Z", running: false, waiting: true, done: false, finished: null },
      { read: "2026-11-13T02:00:00Z", running: true, waiting: false, done: false, finished: null },
      { read: "2026-11-13T01:00:00Z", running: false, waiting: false, done: false, ran: false, finished: "2026-11-13T01:05:00Z" },
      { read: "2026-11-13T00:31:00Z", running: false, waiting: false, done: false, ran: true, finished: "2026-11-13T00:31:00Z" },
      { read: "2026-11-13T00:01:00Z", running: false, waiting: false, done: true, ran: true, finished: "2026-11-13T02:40:00Z" },
      { read: "2026-11-13T02:31:00Z", running: false, waiting: false, done: true, ran: true, finished: "2026-11-13T02:50:00Z" },
    ]);
    const asked = seen.length;
    assert.deepEqual((await gh.updateRuns(new Date("2026-11-14T03:00:00Z"))).map((x) => x.done), [false, false, false, true, true, true]);
    // The list and the in-progress list; jobs only for runs 1 and 0, which
    // ended after run 5 (still in progress here) was made.
    assert.equal(seen.length, asked + 4, "no jobs looked up for other old runs");

  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: an update run's latest attempt is the run's own, and a cut-off job history isn't trusted", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows/update.yml/runs")) {
      const run = (id: number, run_attempt?: number) => ({ id, run_attempt, display_title: "update", created_at: "2026-11-13T00:00:00Z",
        run_started_at: "2026-11-13T02:00:00Z", status: "completed", conclusion: "failure", updated_at: "2026-11-13T02:30:00Z" });
      // Run 3: run 1's history without the run's attempt number.
      return Response.json({ workflow_runs: [run(1, 30), run(2, 3), run(3)] });
    }
    const id = /\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname)![1];
    const page = Number(u.searchParams.get("page"));
    const job = (name: string, attempt: number) => ({ name, run_attempt: attempt, conclusion: "success", started_at: "2026-11-13T00:01:00Z" });
    if (id === "1" || id === "3") {
      // 580 jobs over 30 attempts; the first five pages reach attempt 25.
      const all = Array.from({ length: 30 }, (_, a) => [job("resolve", a + 1), job("issues", a + 1),
        ...Array.from({ length: 18 }, () => job("test", a + 1))]).flat().slice(0, 580);
      return Response.json({ total_count: 580, jobs: all.slice((page - 1) * 100, page * 100) });
    }
    // Run 2 is on attempt 3, whose jobs aren't listed (yet): not done.
    return Response.json({ total_count: 4, jobs: [job("resolve", 1), job("issues", 1), job("resolve", 2), job("issues", 2)] });
  }) as typeof fetch;
  try {
    assert.deepEqual((await new GitHub("o/r", "tok").updateRuns(new Date("2026-11-13T03:00:00Z"))).map((r) => r.done), [false, false, false]);
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: a run that no longer exists counts as finished", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/actions/runs/1")) return new Response("Not Found", { status: 404 });
    if (url.endsWith("/actions/runs/2")) return Response.json({ status: "in_progress" });
    if (url.endsWith("/actions/runs/3")) return Response.json({ status: "completed" });
    return new Response("boom", { status: 500 });
  }) as typeof fetch;
  try {
    const gh = new GitHub("o/r", "tok");
    assert.deepEqual([await gh.runCompleted("1"), await gh.runCompleted("2"), await gh.runCompleted("3")], [true, false, true]);
    await assert.rejects(gh.runCompleted("4"), /HTTP 500/, "other errors still stop reconcile");
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: open issues only, without pull requests (the status page)", async () => {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json([
      { number: 1, title: "a", body: "x", state: "open" },
      { number: 2, title: "b", body: "y", state: "open", pull_request: {} },
      { number: 3, title: "c", body: null, state: "closed" },
    ]);
  }) as typeof fetch;
  try {
    assert.deepEqual(await new GitHub("o/r", "tok").openIssues(), [{ number: 1, title: "a", body: "x", state: "open" }]);
    assert.match(urls[0], /\/repos\/o\/r\/issues\?labels=t3code-nix&state=open&per_page=100&page=1$/);
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: releases leave drafts out and keep the prerelease flag; latest and by-tag read a 404 as none; writes", async () => {
  const real = globalThis.fetch;
  const seen: { method: string; url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    seen.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (u.pathname.endsWith("/releases") && (init.method ?? "GET") === "GET") {
      return Response.json([{ id: 1, tag_name: "t3code-v0.2.0", draft: true }, { id: 2, tag_name: "t3code-v0.1.9", draft: false },
        { id: 4, tag_name: "t3code-v0.1.8", draft: false, prerelease: true }]);
    }
    if (u.pathname.endsWith("/releases/latest") || u.pathname.includes("/releases/tags/")) return new Response("Not Found", { status: 404 });
    if (init.method === "POST") return Response.json({ id: 3, tag_name: "t3code-v0.2.0" });
    return Response.json({});
  }) as typeof fetch;
  try {
    const gh = new GitHub("o/r", "tok");
    assert.deepEqual(await gh.releases(), [{ id: 2, tag: "t3code-v0.1.9", prerelease: false }, { id: 4, tag: "t3code-v0.1.8", prerelease: true }]);
    assert.equal(await gh.latestRelease(), null);
    assert.equal(await gh.releaseByTag("t3code-v0.2.0"), null);
    const made = await gh.createRelease({ tag: "t3code-v0.2.0", target: "abc", name: "T3 Code 0.2.0", body: "b" });
    assert.deepEqual(seen.at(-1)!.body, { tag_name: "t3code-v0.2.0", target_commitish: "abc", name: "T3 Code 0.2.0", body: "b", make_latest: "false" });
    await gh.markLatest(made);
    assert.deepEqual([seen.at(-1)!.method, new URL(seen.at(-1)!.url).pathname, seen.at(-1)!.body], ["PATCH", "/repos/o/r/releases/3", { make_latest: "true" }]);
    // An issue edit can set its title (a downgrade issue names its version).
    await gh.editIssue(7, { title: "downgrade: codex (0.9 pulled)", body: "b" });
    assert.deepEqual([seen.at(-1)!.method, new URL(seen.at(-1)!.url).pathname, seen.at(-1)!.body],
      ["PATCH", "/repos/o/r/issues/7", { title: "downgrade: codex (0.9 pulled)", body: "b" }]);
  } finally {
    globalThis.fetch = real;
  }
});

// ---- cache.ts as the workflow runs it --------------------------------------------

/** Run cache.ts with fake nix and cachix; LEAK adds a path to the closure. */
function runCache(leak = ""): { out: any; pushes: string[] } {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, "cachix.log");
  // eval: every allowlisted package free, plus grok's paths; the rest as above.
  writeFileSync(join(bin, "nix"), `#!/bin/sh
echo "$1" >> ${join(tmp, "nix.log")}
case "$1" in
  eval) node -e 'console.log(JSON.stringify(Object.fromEntries(["t3code-unwrapped","t3-unwrapped","codex","fx","opencode","pi","t3code-free","t3-free","boat","agent-browser","antigravity","chrome-headless-shell","claude-code","cursor-agent","grok","kiro-cli","muse"].map((p, i) => [p, { free: i < 10, out: "/nix/store/" + p, drv: "/nix/store/" + p + ".drv", srcs: ["/nix/store/" + p + "-src"] }]))))' ;;
  build) shift; for a in "$@"; do case "$a" in --no-link|/nix/store/*.drv^\*) ;; *) echo "unexpected build argument $a" >&2; exit 2 ;; esac; done ;;
  path-info)
    if [ "$2" = --json ]; then shift 2; node -e 'console.log(JSON.stringify(process.argv.slice(1).map((p) => ({ path: p, narHash: "h" }))))' "$@"
    else shift 2; for p in "$@" ${leak}; do echo "$p"; done; fi ;;
esac
`);
  writeFileSync(join(bin, "cachix"), `#!/bin/sh\necho "$*" >> ${log}\n`);
  chmodSync(join(bin, "nix"), 0o755);
  chmodSync(join(bin, "cachix"), 0o755);
  const root = join(import.meta.dirname, "..");
  const allow: string[] = JSON.parse(readFileSync(join(root, "ci", "cache-allowlist.json"), "utf8"));
  const manifestFile = join(tmp, "manifest.json");
  writeFileSync(manifestFile, JSON.stringify(Object.fromEntries(allow.map((p) => [p, { path: `/nix/store/${p}`, narHash: "h" }]))));
  const out = execFileSync(process.execPath, [join(root, "scripts", "ci", "cache.ts"), manifestFile, SYS], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CACHIX_CACHE: "c", DRY_RUN: "false" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  let pushes: string[] = [];
  try { pushes = readFileSync(log, "utf8").trim().split("\n"); } catch { /* none */ }
  return { out: JSON.parse(out), pushes };
}

test("unfree.nix is read as a list of names", () => {
  const root = join(import.meta.dirname, "..");
  assert.deepEqual(unfreeNames(readFileSync(join(root, "pkgs", "unfree.nix"), "utf8")),
    ["antigravity", "chrome-headless-shell", "claude-code", "cursor-agent", "grok", "kiro-cli", "muse"]);
  assert.throws(() => unfreeNames("# nothing\n[ ]"), /lists no packages/);
  assert.deepEqual(unfreeNames('[\n  "a"\n  # "b" (dropped for now)\n  "c" # "d"\n]'), ["a", "c"]);
});

test("cache.ts: pushes every allowlisted path once checks pass, in four nix calls", () => {
  const { out, pushes } = runCache();
  assert.deepEqual(readFileSync(join(tmp, "nix.log"), "utf8").trim().split("\n"), ["eval", "build", "path-info", "path-info"]);
  assert.deepEqual(out.observations.map((o: any) => o.kind), ["cache-ok"]);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /^push c \/nix\/store\/t3code-unwrapped /);
});

test("the cache allowlist is the latest channel's free set, with the free variants", () => {
  const root = join(import.meta.dirname, "..");
  const allow: string[] = JSON.parse(readFileSync(join(root, "ci", "cache-allowlist.json"), "utf8"));
  assert.deepEqual(allow, ["t3code-unwrapped", "t3-unwrapped", "codex", "fx", "opencode", "pi", "t3code-free", "t3-free", "boat", "agent-browser"]);
  // The latest channel only, and never an unfree package or the full (unfree) wrappers.
  const unfree = unfreeNames(readFileSync(join(root, "pkgs", "unfree.nix"), "utf8"));
  for (const p of allow) {
    assert.ok(!p.includes("nightly"), p);
    assert.ok(!unfree.includes(p) && !["t3code", "t3", "default"].includes(p), p);
  }
});

test("cache.ts: an unfree download in the closure means no cachix call at all", () => {
  const { out, pushes } = runCache("/nix/store/grok-src");
  assert.deepEqual(out.observations.map((o: any) => o.kind), ["update-failed"]);
  assert.deepEqual(pushes, []);
});

// ---- proc.ts ------------------------------------------------------------------------

test("proc: stopping a group waits for a child that ignores SIGTERM", async () => {
  // The leader exits on SIGTERM; its child ignores it and needs SIGKILL.
  const child = spawn("sh", ["-c", "sh -c 'trap \"\" TERM; while :; do sleep 1; done' & wait"], { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(groupAlive(child.pid!));
  const start = Date.now();
  assert.equal(await stopGroup(child.pid, 300, 3000), true);
  assert.ok(Date.now() - start >= 300, "needed SIGKILL");
  assert.equal(groupAlive(child.pid!), false);
});

test("test.ts: default.nix without flakes must give the flake's own agent-browser", () => {
  const checks = { "agent-browser": { out: "/nix/store/ab", drv: "/nix/store/ab.drv" } };
  const asked: string[] = [];
  const inst = (stdout: string, status = 0) => (sys: string) => (asked.push(sys), { status, stdout, stderr: status ? "error: flakes builtin" : "" });
  assert.deepEqual(noFlakesFailures("aarch64-linux", checks, inst("/nix/store/ab.drv\n")), []);
  assert.deepEqual(asked, ["aarch64-linux"]);
  assert.deepEqual(noFlakesFailures("x86_64-linux", checks, inst("/nix/store/other.drv")), ["default-nix-no-flakes"]);
  assert.deepEqual(noFlakesFailures("x86_64-linux", checks, inst("", 1)), ["default-nix-no-flakes"]);
  asked.length = 0;
  assert.deepEqual([noFlakesFailures("x86_64-linux", {}, inst("x")), asked], [[], []], "no agent-browser check: nothing to compare, nothing run");
  // t3code too: its Electron choice reads flake.lock and the fallback file the same way in both.
  const both = { ...checks, t3code: { out: "/nix/store/t", drv: "/nix/store/t.drv" } };
  const per = (drvs: Record<string, string>) => (_sys: string, attr: string) => ({ status: 0, stdout: drvs[attr], stderr: "" });
  assert.deepEqual(noFlakesFailures("x86_64-linux", both, per({ "agent-browser": "/nix/store/ab.drv", t3code: "/nix/store/t.drv" })), []);
  assert.deepEqual(noFlakesFailures("x86_64-linux", both, per({ "agent-browser": "/nix/store/ab.drv", t3code: "/nix/store/bundled.drv" })), ["default-nix-no-flakes"]);
});

test("cache: an allowlisted name that isn't in packages.<system> (a NixOS-stable-only one) is refused as such, not as unfree", () => {
  const { sh, calls } = fakeNix();
  const r = plan(manifest, ["codex", "stable-only"], ["grok"], SYS, sh);
  assert.deepEqual(r.paths, []);
  assert.deepEqual(r.observations.map((o) => [o.kind, o.channel]), [["update-failed", SYS]]);
  assert.match(r.observations[0].detail, /^on the cache allowlist but not in packages\.x86_64-linux \(only the default packages are cached, never NixOS stable's\): stable-only; nothing pushed$/);
  assert.doesNotMatch(r.observations[0].detail, /not free/);
  assert.ok(!calls.some((c) => c[1] === "build"));
});

test("GitHub client: matching refs is one request, however many tags there are", async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  const many = Array.from({ length: 261 }, (_, i) => ({ ref: `refs/tags/t3code-v0.${i}.0`, object: { sha: `sha${i}` } }));
  // Like GitHub: the same full list whatever page is asked for.
  globalThis.fetch = (async (url: string) => (asked.push(String(url)), Response.json(many))) as typeof fetch;
  try {
    const refs = await new GitHub("o/r", "tok").refs("tags/t3code-v");
    assert.equal(Object.keys(refs).length, 261);
    assert.equal(asked.length, 1);
    assert.doesNotMatch(asked[0], /page=/);
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: update runs page past a burst of dry runs to find the real ones", async () => {
  const real = globalThis.fetch;
  const pages: string[] = [];
  const dry = (i: number) => ({ id: 1000 + i, display_title: "dry run", status: "completed", conclusion: "success", created_at: "2026-11-13T02:00:00Z", updated_at: "2026-11-13T02:05:00Z" });
  globalThis.fetch = (async (url: string) => {
    const page = new URL(url).searchParams.get("page");
    if (new URL(url).searchParams.get("status")) return Response.json({ workflow_runs: [] });
    pages.push(page!);
    return Response.json({ workflow_runs: page === "1" ? Array.from({ length: 100 }, (_, i) => dry(i))
      : [{ id: 1, display_title: "update", status: "in_progress", created_at: "2026-11-13T01:00:00Z", run_started_at: "2026-11-13T01:00:00Z" }] });
  }) as typeof fetch;
  try {
    const runs = await new GitHub("o/r", "tok").updateRuns(new Date("2026-11-13T03:00:00Z"));
    assert.deepEqual(runs.map((x) => x.running), [true]);
    assert.deepEqual(pages, ["1", "2"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: update runs stop paging once 20 real runs are seen", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  const run = (i: number, title: string) => ({ id: i, display_title: title, status: "completed", conclusion: "success", created_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T00:05:00Z" });
  globalThis.fetch = (async (url: string) => new URL(url).searchParams.get("status") ? Response.json({ workflow_runs: [] })
    : (calls++, Response.json({ workflow_runs: Array.from({ length: 100 }, (_, i) => run(i, i < 25 ? "update" : "dry run")) }))) as typeof fetch;
  try {
    await new GitHub("o/r", "tok").updateRuns(new Date("2026-11-13T03:00:00Z"));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: a run whose publish re-dispatched a retry isn't done; the retry is a real run", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows/update.yml/runs")) {
      return Response.json({ workflow_runs: [
        // Publish found main moved at 01:40 and re-dispatched: the retry waits.
        { id: 2, run_attempt: 1, display_title: "update (retry 1)", created_at: "2026-11-13T01:40:00Z", status: "queued", conclusion: null },
        { id: 1, run_attempt: 1, display_title: "update", created_at: "2026-11-13T01:00:00Z", run_started_at: "2026-11-13T01:00:00Z",
          status: "completed", conclusion: "success", updated_at: "2026-11-13T01:45:00Z" },
        // An earlier run, done before the retry was made.
        { id: 0, run_attempt: 1, display_title: "update", created_at: "2026-11-13T00:00:00Z", run_started_at: "2026-11-13T00:00:00Z",
          status: "completed", conclusion: "success", updated_at: "2026-11-13T00:30:00Z" },
      ] });
    }
    return Response.json({ total_count: 2, jobs: [{ name: "resolve", run_attempt: 1, conclusion: "success", started_at: u.pathname.includes("/runs/1/") ? "2026-11-13T01:05:00Z" : "2026-11-13T00:05:00Z" },
      { name: "issues", run_attempt: 1, conclusion: "success" }] });
  }) as typeof fetch;
  try {
    const runs = await new GitHub("o/r", "tok").updateRuns(new Date("2026-11-13T02:00:00Z"));
    assert.deepEqual(runs.map((r) => [r.waiting, r.done, r.ran ?? false]), [[true, false, false], [false, false, true], [false, true, true]]);
    // Health: the watcher saw 2.0 at 00:20, before the run's read (01:05);
    // with the retry waiting just after, it waits rather than calling a lag.
    const key = { written: "2026-11-13T01:46:00Z", entries: { codex: { version: "2.0", firstSeen: "2026-11-13T00:20:00Z" } }, sources: {} };
    const keys = Object.fromEntries(CRON_KEYS.map((k) => [k, key]));
    const out = assess({ keys }, null, { codex: "1.0" }, [], new Date("2026-11-13T01:50:00Z"), runs);
    assert.ok(!out.some((o) => o.kind === "update-lag"), JSON.stringify(out));
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: a gate re-dispatch hands over too, so a chained retry waiting in the queue isn't a lag", async () => {
  const real = globalThis.fetch;
  const run = (id: number, title: string, created: string, extra: object) => ({ id, run_attempt: 1, display_title: title, created_at: created, ...extra });
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows/update.yml/runs")) {
      return Response.json({ workflow_runs: [
        // The gate's re-dispatch of retry 1, waiting.
        run(3, "update (retry 1)", "2026-11-13T02:00:00Z", { status: "queued", conclusion: null }),
        // Retry 1: the gate found new scripts and re-dispatched (issues skipped).
        run(2, "update (retry 1)", "2026-11-13T01:40:00Z", { run_started_at: "2026-11-13T01:50:00Z", status: "completed", conclusion: "success", updated_at: "2026-11-13T02:01:00Z" }),
        // The original: its publish found main moved and made retry 1.
        run(1, "update", "2026-11-13T00:30:00Z", { run_started_at: "2026-11-13T00:30:00Z", status: "completed", conclusion: "success", updated_at: "2026-11-13T01:45:00Z" }),
      ] });
    }
    const gated = u.pathname.includes("/runs/2/");
    return Response.json({ total_count: 2, jobs: [
      { name: "resolve", run_attempt: 1, conclusion: "success", started_at: gated ? "2026-11-13T01:50:00Z" : "2026-11-13T00:35:00Z" },
      { name: "issues", run_attempt: 1, conclusion: gated ? "skipped" : "success" }] });
  }) as typeof fetch;
  try {
    const now = new Date("2026-11-13T02:02:00Z");
    const runs = await new GitHub("o/r", "tok").updateRuns(now);
    assert.deepEqual(runs.map((r) => [r.waiting, r.done, r.ran ?? false]), [[true, false, false], [false, false, true], [false, false, true]]);
    const key = { written: "2026-11-13T02:00:00Z", entries: { codex: { version: "2.0", firstSeen: "2026-11-13T00:20:00Z" } }, sources: {} };
    const out = assess({ keys: Object.fromEntries(CRON_KEYS.map((k) => [k, key])) }, null, { codex: "1.0" }, [], now, runs);
    assert.ok(!out.some((o) => o.kind === "update-lag"), JSON.stringify(out));
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: a queue stuck for hours, with each hourly dispatch replacing the waiting run, is still a lag", async () => {
  const real = globalThis.fetch;
  const run = (id: number, title: string, created: string, extra: object) => ({ id, run_attempt: 1, display_title: title, created_at: created, run_started_at: created, ...extra });
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows/update.yml/runs")) {
      return Response.json({ workflow_runs: [
        run(5, "update", "2026-11-13T05:17:00Z", { status: "pending", conclusion: null }),        // health's 05:17 dispatch
        run(4, "update", "2026-11-13T04:17:00Z", { status: "completed", conclusion: "cancelled", updated_at: "2026-11-13T05:17:02Z" }), // replaced
        run(3, "update", "2026-11-13T03:17:00Z", { status: "completed", conclusion: "cancelled", updated_at: "2026-11-13T04:17:02Z" }), // replaced
        run(2, "update", "2026-11-13T01:10:00Z", { status: "queued", conclusion: null }),          // holds the group, never gets a runner
        run(1, "update", "2026-11-13T00:00:00Z", { status: "completed", conclusion: "success", updated_at: "2026-11-13T00:40:00Z" }),
      ] });
    }
    // Only run 1 ran; the replaced ones have no jobs.
    if (!u.pathname.includes("/runs/1/")) return Response.json({ total_count: 0, jobs: [] });
    return Response.json({ total_count: 2, jobs: [{ name: "resolve", run_attempt: 1, conclusion: "success", started_at: "2026-11-13T00:05:00Z" },
      { name: "issues", run_attempt: 1, conclusion: "success" }] });
  }) as typeof fetch;
  try {
    const now = new Date("2026-11-13T05:20:00Z");
    const runs = await new GitHub("o/r", "tok").updateRuns(now);
    assert.deepEqual(runs.map((r) => r.ran ?? false), [false, false, false, false, true], "replaced runs never ran");
    const key = { written: "2026-11-13T05:19:00Z", entries: { codex: { version: "2.0", firstSeen: "2026-11-13T01:00:00Z" } }, sources: {} };
    const out = assess({ keys: Object.fromEntries(CRON_KEYS.map((k) => [k, key])) }, null, { codex: "1.0" }, [], now, runs);
    assert.ok(out.some((o) => o.kind === "update-lag"), JSON.stringify(out));
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: a run in progress for over 12 hours isn't going, so a lag shows", async () => {
  const real = globalThis.fetch;
  let started = "2026-11-13T00:00:00Z";
  globalThis.fetch = (async () => Response.json({ workflow_runs: [{ id: 1, run_attempt: 1, display_title: "update", created_at: started,
    run_started_at: started, status: "in_progress", conclusion: null }] })) as typeof fetch;
  try {
    const now = new Date("2026-11-13T13:00:00Z");
    const key = { written: "2026-11-13T12:59:00Z", entries: { codex: { version: "2.0", firstSeen: "2026-11-12T23:00:00Z" } }, sources: {} };
    const lag = async () => assess({ keys: Object.fromEntries(CRON_KEYS.map((k) => [k, key])) }, null, { codex: "1.0" }, [], now,
      await new GitHub("o/r", "tok").updateRuns(now)).some((o) => o.kind === "update-lag");
    assert.equal(await lag(), true, "13 hours in progress: stuck");
    started = "2026-11-13T02:00:00Z";
    assert.equal(await lag(), false, "11 hours: still working");
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: a gate-only run stays not done while its replacement can still be working", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows/update.yml/runs")) {
      return Response.json({ workflow_runs: [
        // The gate's replacement, building for seven hours.
        { id: 2, run_attempt: 1, display_title: "update", created_at: "2026-11-13T00:02:00Z", run_started_at: "2026-11-13T00:04:00Z", status: "in_progress", conclusion: null },
        // Found changed scripts and re-dispatched (issues skipped).
        { id: 1, run_attempt: 1, display_title: "update", created_at: "2026-11-13T00:00:00Z", run_started_at: "2026-11-13T00:00:00Z",
          status: "completed", conclusion: "success", updated_at: "2026-11-13T00:03:00Z" },
      ] });
    }
    return Response.json({ total_count: 2, jobs: [{ name: "resolve", run_attempt: 1, conclusion: "skipped" }, { name: "issues", run_attempt: 1, conclusion: "skipped" }] });
  }) as typeof fetch;
  try {
    const now = new Date("2026-11-13T07:00:00Z");
    const key = { written: "2026-11-13T06:59:00Z", entries: { codex: { version: "2.0", firstSeen: "2026-11-12T23:50:00Z" } }, sources: {} };
    const runs = await new GitHub("o/r", "tok").updateRuns(now);
    assert.deepEqual(runs.map((r) => [r.running, r.done]), [[true, false], [false, false]]);
    const out = assess({ keys: Object.fromEntries(CRON_KEYS.map((k) => [k, key])) }, null, { codex: "1.0" }, [], now, runs);
    assert.ok(!out.some((o) => o.kind === "update-lag"), JSON.stringify(out));
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: a run in progress past the listed pages still counts, and a gate-only run before it is looked into however old", async () => {
  const real = globalThis.fetch;
  const working = { id: 1, run_attempt: 1, display_title: "update", created_at: "2026-11-13T00:00:00Z", run_started_at: "2026-11-13T00:00:00Z", status: "in_progress", conclusion: null };
  let busyAsked = false;
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows/update.yml/runs")) {
      if (u.searchParams.get("status") === "in_progress") return (busyAsked = true, Response.json({ workflow_runs: [working] }));
      // 99 replaced waiting runs and one pending: the working run is on page 2.
      return Response.json({ workflow_runs: u.searchParams.get("page") === "1"
        ? [{ id: 200, run_attempt: 1, display_title: "update", created_at: "2026-11-13T03:59:00Z", status: "pending", conclusion: null },
          ...Array.from({ length: 99 }, (_, i) => ({ id: 100 + i, run_attempt: 1, display_title: "update", created_at: "2026-11-13T01:00:00Z",
            status: "completed", conclusion: "cancelled", updated_at: "2026-11-13T03:00:00Z" }))]
        : [working] });
    }
    return Response.json({ total_count: 0, jobs: [] });
  }) as typeof fetch;
  const key = (at: string, firstSeen: string) => {
    const k = { written: at, entries: { codex: { version: "2.0", firstSeen } }, sources: {} };
    return { keys: Object.fromEntries(CRON_KEYS.map((c) => [c, k])) };
  };
  try {
    const now = new Date("2026-11-13T04:00:00Z");
    const runs = await new GitHub("o/r", "tok").updateRuns(now);
    assert.ok(busyAsked && runs.some((r) => r.running));
    assert.ok(!assess(key("2026-11-13T03:59:00Z", "2026-11-12T23:00:00Z"), null, { codex: "1.0" }, [], now, runs).some((o) => o.kind === "update-lag"));
  } finally {
    globalThis.fetch = real;
  }
  // The gate's run ended 14 hours ago; its replacement waited 3 hours, then
  // has worked 11: the gate run is still looked into, so it isn't done.
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows/update.yml/runs")) {
      return Response.json({ workflow_runs: [
        { id: 2, run_attempt: 1, display_title: "update", created_at: "2026-11-13T00:02:00Z", run_started_at: "2026-11-13T03:00:00Z", status: "in_progress", conclusion: null },
        { id: 1, run_attempt: 1, display_title: "update", created_at: "2026-11-13T00:00:00Z", run_started_at: "2026-11-13T00:00:00Z", status: "completed", conclusion: "success", updated_at: "2026-11-13T00:03:00Z" },
      ] });
    }
    return Response.json({ total_count: 2, jobs: [{ name: "resolve", run_attempt: 1, conclusion: "skipped" }, { name: "issues", run_attempt: 1, conclusion: "skipped" }] });
  }) as typeof fetch;
  try {
    const now = new Date("2026-11-13T14:00:00Z");
    const runs = await new GitHub("o/r", "tok").updateRuns(now);
    assert.deepEqual(runs.map((r) => [r.running, r.done]), [[true, false], [false, false]]);
    assert.ok(!assess(key("2026-11-13T13:59:00Z", "2026-11-12T23:50:00Z"), null, { codex: "1.0" }, [], now, runs).some((o) => o.kind === "update-lag"));
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: a run cancelled mid-way that did its work is done evidence, so a hang every run still shows a lag", async () => {
  const real = globalThis.fetch;
  const jobsAsked: string[] = [];
  const cancelledRun = (id: number, start: string, end: string) => ({ id, run_attempt: 1, display_title: "update", created_at: start, run_started_at: start,
    status: "completed", conclusion: "cancelled", updated_at: end });
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows/update.yml/runs")) {
      if (u.searchParams.get("status")) return Response.json({ workflow_runs: [] });
      return Response.json({ workflow_runs: [
        { id: 9, run_attempt: 1, display_title: "update", created_at: "2026-11-13T09:00:00Z", run_started_at: "2026-11-13T09:00:00Z", status: "in_progress", conclusion: null },
        // Timed out (cancelled) after doing its work, three times running.
        cancelledRun(3, "2026-11-13T06:00:00Z", "2026-11-13T08:40:00Z"),
        cancelledRun(2, "2026-11-13T03:00:00Z", "2026-11-13T05:40:00Z"),
        cancelledRun(1, "2026-11-13T00:30:00Z", "2026-11-13T02:40:00Z"),
        { id: 5, run_attempt: 1, display_title: "update", created_at: "2026-11-12T09:00:00Z", run_started_at: "2026-11-12T09:00:00Z",
          status: "completed", conclusion: "success", updated_at: "2026-11-12T10:00:00Z" },
        // A stuck run (over 12 hours) doesn't widen what's looked into.
        { id: 0, run_attempt: 1, display_title: "update", created_at: "2026-11-11T00:00:00Z", run_started_at: "2026-11-11T00:00:00Z", status: "in_progress", conclusion: null },
      ] });
    }
    const id = /\/runs\/(\d+)\/jobs$/.exec(u.pathname)![1];
    jobsAsked.push(id);
    const at = { 1: "2026-11-13T00:31:00Z", 2: "2026-11-13T03:01:00Z", 3: "2026-11-13T06:01:00Z" }[id]!;
    return Response.json({ total_count: 2, jobs: [{ name: "resolve", run_attempt: 1, conclusion: "success", started_at: at },
      { name: "issues", run_attempt: 1, conclusion: "success", started_at: at }] });
  }) as typeof fetch;
  try {
    const now = new Date("2026-11-13T09:30:00Z");
    const runs = await new GitHub("o/r", "tok").updateRuns(now);
    assert.deepEqual(runs.map((r) => r.done), [false, true, true, true, true, false]);
    const key = { written: "2026-11-13T09:29:00Z", entries: { codex: { version: "2.0", firstSeen: "2026-11-13T00:00:00Z" } }, sources: {} };
    const out = assess({ keys: Object.fromEntries(CRON_KEYS.map((k) => [k, key])) }, null, { codex: "1.0" }, [], now, runs);
    assert.ok(out.some((o) => o.kind === "update-lag"), JSON.stringify(out));
    assert.deepEqual(jobsAsked.sort(), ["1", "2", "3"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("GitHub client: cancelled runs are looked into by when they finished, until three that ran, at most 30", async () => {
  const real = globalThis.fetch;
  let jobsAsked: number[] = [];
  let ranIds = new Set<number>();
  let list: any[] = [];
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows/update.yml/runs")) return Response.json({ workflow_runs: u.searchParams.get("status") ? [] : list });
    const id = Number(/\/runs\/(\d+)\/jobs$/.exec(u.pathname)![1]);
    jobsAsked.push(id);
    return Response.json(ranIds.has(id)
      ? { total_count: 2, jobs: [{ name: "resolve", run_attempt: 1, conclusion: "success", started_at: "2026-11-13T00:01:00Z" }, { name: "issues", run_attempt: 1, conclusion: "cancelled", started_at: "2026-11-13T02:58:00Z" }] }
      : { total_count: 0, jobs: [] });
  }) as typeof fetch;
  const cancelled = (id: number, created: string, ended: string) => ({ id, run_attempt: 1, display_title: "update", created_at: created,
    run_started_at: created, status: "completed", conclusion: "cancelled", updated_at: ended });
  try {
    // Run 1 worked three hours and was cancelled 2 minutes ago; ten newer
    // dispatches were replaced while it worked; its successor is pending.
    list = [{ id: 50, run_attempt: 1, display_title: "update", created_at: "2026-11-13T02:55:00Z", status: "pending", conclusion: null },
      ...Array.from({ length: 10 }, (_, i) => cancelled(40 - i, `2026-11-13T0${1 + Math.floor(i / 5)}:${10 + i}:00Z`, `2026-11-13T0${1 + Math.floor(i / 5)}:${20 + i}:00Z`)),
      cancelled(1, "2026-11-13T00:00:00Z", "2026-11-13T02:58:00Z")];
    ranIds = new Set([1]);
    const now = new Date("2026-11-13T03:00:00Z");
    const runs = await new GitHub("o/r", "tok").updateRuns(now);
    assert.deepEqual([runs.at(-1)!.done, runs.at(-1)!.ran], [true, true], "the run that worked is found");
    assert.equal(jobsAsked[0], 1, "most recently finished first");
    const key = (firstSeen: string) => ({ keys: Object.fromEntries(CRON_KEYS.map((k) => [k, { written: "2026-11-13T02:59:00Z", entries: { codex: { version: "2.0", firstSeen } }, sources: {} }])) });
    // Seen after its read: the pending run takes over from it, so no lag.
    assert.ok(!assess(key("2026-11-13T01:00:00Z"), null, { codex: "1.0" }, [], now, runs).some((o) => o.kind === "update-lag"));
    // Seen before its read: it did its work without it, so a lag.
    assert.ok(assess(key("2026-11-12T23:00:00Z"), null, { codex: "1.0" }, [], now, runs).some((o) => o.kind === "update-lag"));

    // Many that ran: it stops once three are found (in batches of five).
    list = Array.from({ length: 12 }, (_, i) => cancelled(100 - i, "2026-11-13T01:00:00Z", `2026-11-13T02:${String(50 - i).padStart(2, "0")}:00Z`));
    ranIds = new Set(list.map((x) => x.id));
    jobsAsked = [];
    await new GitHub("o/r", "tok").updateRuns(now);
    assert.deepEqual(jobsAsked.sort((a, b) => b - a), [100, 99, 98, 97, 96]);

    // None that ran: at most 30 requests, the most recently finished.
    list = Array.from({ length: 40 }, (_, i) => cancelled(200 - i, "2026-11-13T01:00:00Z", new Date(Date.parse("2026-11-13T02:50:00Z") - i * 60_000).toISOString()));
    ranIds = new Set();
    jobsAsked = [];
    const none = await new GitHub("o/r", "tok").updateRuns(now);
    assert.ok(none.every((r) => !r.done && !r.ran));
    assert.deepEqual(jobsAsked.sort((a, b) => b - a), Array.from({ length: 30 }, (_, i) => 200 - i));
  } finally {
    globalThis.fetch = real;
  }
});

// Bursts of dispatches and requests: bounded and paced.
{
  const now = new Date("2026-11-13T10:00:00Z");
  const run = (id: number, created: string, extra: object = {}) => ({ id, run_attempt: 1,
    display_title: "update", created_at: created, run_started_at: created,
    status: "completed", conclusion: "cancelled", updated_at: "2026-11-13T09:40:00Z", ...extra });
  const health = (firstSeen: string, at = now) => ({ keys: Object.fromEntries(CRON_KEYS.map(k => [k, {
    written: at.toISOString(), sources: {}, entries: { codex: { version: "2.0", firstSeen } },
  }])) });

  for (const waiting of [true, false]) test(`GitHub client: a finished run that worked, past a page of replaced runs, still counts (${waiting ? "handover" : "done evidence"})`, async () => {
    const real = globalThis.fetch;
    const worker = run(1, "2026-11-13T00:00:00Z", { updated_at: "2026-11-13T09:58:00Z" });
    const next = run(200, "2026-11-13T09:50:00Z", { status: waiting ? "pending" : "in_progress", conclusion: null,
      run_started_at: "2026-11-13T09:59:00Z" });
    const replaced = Array.from({length: 99}, (_, i) => run(100 + i, "2026-11-13T05:00:00Z"));
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url); asked.push(u.pathname + u.search);
      if (u.pathname.endsWith("/runs")) return Response.json({workflow_runs:
        u.searchParams.has("status") ? (waiting ? [] : [next]) : u.searchParams.get("page") === "1" ? [next, ...replaced] : [worker]});
      return Response.json(u.pathname.includes("/runs/1/jobs") ? { total_count: 2, jobs: [
        { name: "resolve", run_attempt: 1, conclusion: "success", started_at: "2026-11-13T00:01:00Z" },
        { name: "issues", run_attempt: 1, conclusion: "cancelled", started_at: "2026-11-13T09:57:00Z" },
      ] } : {total_count: 0, jobs: []});
    }) as typeof fetch;
    try {
      const at = waiting ? now : new Date("2026-11-13T14:00:00Z");
      const runs = await new GitHub("o/r", "tok").updateRuns(at);
      const firstSeen = waiting ? "2026-11-13T01:00:00Z" : "2026-11-12T23:00:00Z";
      const lag = assess(health(firstSeen, at), null, {codex: "1.0"}, [], at, runs).some(o => o.kind === "update-lag");
      assert.equal(lag, !waiting);
    } finally { globalThis.fetch = real; }
  });

  test("GitHub client: cancelled runs' jobs pages count against the 30-request cap", async () => {
    const real = globalThis.fetch;
    let jobsRequests = 0;
    const list = Array.from({length: 30}, (_, i) => run(i + 1, "2026-11-13T01:00:00Z", {run_attempt: i < 25 ? 1 : 40}));
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/runs")) return Response.json({workflow_runs: u.searchParams.has("status") ? [] : list});
      jobsRequests++;
      const id = Number(/\/runs\/(\d+)\/jobs/.exec(u.pathname)![1]);
      if (id <= 25) return Response.json({total_count: 0, jobs: []});
      // Five older runs were repeatedly retried; 25 newer runs never started.
      const page = Number(u.searchParams.get("page"));
      return Response.json({total_count: 600, jobs: Array.from({length: 100}, (_, i) => {
        const index = (page - 1) * 100 + i;
        return {name: index % 15 === 0 ? "resolve" : index % 15 === 1 ? "issues" : `test-${index % 15}`,
          run_attempt: 1 + Math.floor(index / 15), conclusion: "success", started_at: "2026-11-13T01:01:00Z"};
      })});
    }) as typeof fetch;
    try {
      await new GitHub("o/r", "tok").updateRuns(now);
      assert.ok(jobsRequests <= 30);
    } finally { globalThis.fetch = real; }
  });

  test("GitHub client: jobs are asked for a few at a time (GitHub limits concurrent requests)", async () => {
    const real = globalThis.fetch;
    let active = 0, peak = 0;
    const done = (id: number) => run(id, "2026-11-13T01:00:00Z", {conclusion: "success"});
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/runs")) return Response.json({workflow_runs: u.searchParams.has("status") ? []
        : u.searchParams.get("page") === "1" ? [
          ...Array.from({length: 19}, (_, i) => done(i)),
          ...Array.from({length: 81}, (_, i) => ({...done(1000+i), display_title: "update (dry run)"})),
        ] : Array.from({length: 100}, (_, i) => done(100+i))});
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return Response.json({total_count: 0, jobs: []});
    }) as typeof fetch;
    try {
      await new GitHub("o/r", "tok").updateRuns(now);
      assert.ok(peak <= 5, String(peak));
    } finally { globalThis.fetch = real; }
  });
}

test("desktop smoke: the folder dialog step can't hang when the page goes away", async () => {
  const { folderDialog } = await import("../scripts/desktop-smoke.ts");
  const { within } = await import("../scripts/lib/proc.ts");
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  assert.equal(await within(50, new Promise(() => {})), null, "a promise that never settles gives null");
  assert.equal(await within(1000, Promise.resolve(7)), 7);
  for (const mode of ["refuse", "close"] as const) {
    const server = createServer((_req, res) => {
      const { port } = server.address() as import("node:net").AddressInfo;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }]));
    });
    server.on("upgrade", (req, socket) => {
      if (mode === "refuse") return socket.destroy();
      // A real handshake, then the page goes away without answering.
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      setTimeout(() => socket.destroy(), 200);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    const started = Date.now();
    const problems = await folderDialog(port, {}, () => true);
    server.close();
    assert.equal(problems.length, 1, `${mode}: ${problems}`);
    assert.match(problems[0], mode === "refuse" ? /couldn't reach the page/ : /didn't answer/);
    assert.ok(Date.now() - started < 5000, `${mode}: settled in ${Date.now() - started} ms`);
  }
  // Nothing listening at all.
  const free = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as import("node:net").AddressInfo; s.close(() => resolve(port)); });
  });
  assert.match((await folderDialog(free, {}, () => true))[0], /couldn't list the app's pages/);
});

test("desktop smoke: the folder dialog step fails without the bridge, without a dialog, or on a non-null cancel", async () => {
  const { folderDialog } = await import("../scripts/desktop-smoke.ts");
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const { chmodSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  // A page that answers each Runtime.evaluate with answer(expression).
  const page = async (answer: (expr: string) => unknown) => {
    const server = createServer((_req, res) => {
      const { port } = server.address() as import("node:net").AddressInfo;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }]));
    });
    server.on("upgrade", (req, socket) => {
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      socket.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 6) {
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
          if (buf.length < off + 4 + len) return;
          const mask = buf.subarray(off, off + 4);
          const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
          const opcode = buf[0] & 0x0f;
          buf = buf.subarray(off + 4 + len);
          if (opcode === 8) return void socket.destroy();
          if (opcode !== 1) continue;
          const msg = JSON.parse(payload.toString());
          const out = Buffer.from(JSON.stringify({ id: msg.id, result: { result: { value: answer(msg.params.expression) } } }));
          const head = out.length < 126 ? Buffer.from([0x81, out.length]) : Buffer.from([0x81, 126, out.length >> 8, out.length & 0xff]);
          socket.write(Buffer.concat([head, out]));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as import("node:net").AddressInfo).port, close: () => { server.closeAllConnections(); server.close(); } };
  };
  // xdotool that finds a dialog window (or not).
  const xdotool = (finds: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "xdotool-"));
    writeFileSync(join(dir, "xdotool"), `#!/bin/sh\n${finds ? '[ "$1" = search ] && echo 4242\n' : ""}exit 0\n`);
    chmodSync(join(dir, "xdotool"), 0o755);
    return { PATH: dir };
  };
  const bridge = (picked: unknown) => (e: string) => (e.startsWith("typeof") ? "function" : picked);
  const cases: [string, (e: string) => unknown, boolean, string[]][] = [
    ["no bridge", () => "undefined", true, ["the app has no desktopBridge.pickFolder (undefined)"]],
    ["no dialog", bridge(null), false, ["the folder dialog never showed"]],
    ["a non-null cancel", bridge("/home/x"), true, ['the cancelled folder dialog returned "/home/x", not null']],
    ["a dialog cancelled to null", bridge(null), true, []],
  ];
  for (const [name, answer, finds, want] of cases) {
    const p = await page(answer);
    try {
      assert.deepEqual(await folderDialog(p.port, xdotool(finds), () => true, 2), want, name);
    } finally { p.close(); }
  }
});


test("smokeRuns: the desktop smoke's verdict, in the part that runs it; the run's --desktop elsewhere", () => {
  assert.deepEqual([smokeRuns(undefined, true, false), smokeRuns(undefined, false, true)], [true, false]);
  assert.deepEqual([smokeRuns("desktop", true, true), smokeRuns("desktop", false, true)], [true, false]);
  assert.deepEqual([smokeRuns("rest1", false, true), smokeRuns("rest2", false, false), smokeRuns("rest1", true, false)], [true, false, false]);
});

test("evaluateChecks: a part evaluates its own checks, the desktop apps' and (rest2) those default.nix is compared with", async () => {
  const { evaluateChecks, NO_FLAKES_ATTRS } = await import("../scripts/ci/test.ts");
  const { testPart } = await import("../scripts/lib/parts.ts");
  const all = ["a", "b", "c", "codex", "fx", "agent-browser", "module-eval", "unit", "t3code", "t3code-unwrapped", "t3code-electron-bundled", "t3code-nightly", "t3code-free"];
  const asked: string[][] = [];
  let names = all;
  const nix = (_cmd: string, args: string[]) => {
    asked.push(args);
    const apply = args[args.length - 1];
    if (apply === "builtins.attrNames") return JSON.stringify(names);
    // The part's names, quoted in the expression's `inherit (cs)`.
    const m = /\{ inherit \(cs\) (.*); \}$/.exec(apply);
    const wanted: string[] = m ? m[1].split(" ").map((s) => JSON.parse(s)) : names;
    return JSON.stringify(Object.fromEntries(wanted.map((n) => [n, { out: n, drv: n }])));
  };
  const apps = ["t3code", "t3code-unwrapped", "t3code-electron-bundled", "t3code-nightly"];
  for (const part of ["desktop", "rest1", "rest2"] as const) {
    asked.length = 0;
    const got = Object.keys(evaluateChecks("x86_64-linux", part, nix)).sort();
    const want = all.filter((n) => testPart(n) === part || apps.includes(n) || (part === "rest2" && NO_FLAKES_ATTRS.includes(n))).sort();
    assert.deepEqual(got, want, part);
    assert.equal(asked.length, 2, "the names, then the part's checks");
  }
  // module-eval (the costliest evaluation) is desktop's; t3code-free isn't an app the evidence lists.
  assert.ok(Object.keys(evaluateChecks("x86_64-linux", "desktop", nix)).includes("module-eval"));
  assert.ok(!Object.keys(evaluateChecks("x86_64-linux", "rest1", nix)).includes("t3code-free"));
  // The whole suite: one evaluation of everything.
  asked.length = 0;
  assert.deepEqual(Object.keys(evaluateChecks("x86_64-linux", undefined, nix)).sort(), [...all].sort());
  assert.equal(asked.length, 1);
  // A name that isn't plain (it would need escaping in the expression): the
  // part evaluates everything instead.
  names = [...all, "t3code-${x}"];
  asked.length = 0;
  assert.deepEqual(Object.keys(evaluateChecks("x86_64-linux", "desktop", nix)).sort(), [...names].sort());
  assert.ok(!asked.some((a) => a.some((x) => x.includes("inherit (cs)"))));
});
