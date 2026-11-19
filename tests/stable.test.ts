// The NixOS-stable snapshot (scripts/lib/snapshot.ts) and the stable test
// step (scripts/ci/stable.ts), against real git repositories in temporary
// folders and a stand-in for Nix that derives "derivations" from the files
// it's given. No network, no Nix.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { current, differing, inSnapshot, moved } from "../scripts/lib/snapshot.ts";
import * as stable from "../scripts/ci/stable.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const pin = (name: string, version: string) => JSON.stringify({ name, version, assets: {} }, null, 2) + "\n";

let tmp: string;
const cwd = process.cwd();
const saved = { ...stable.nix }, savedSmokes = { ...stable.smokes };
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "stable-test-"));
  process.chdir(tmp);
  git("init", "-q", "-b", "main");
});
afterEach(() => {
  process.chdir(cwd);
  Object.assign(stable.nix, saved);
  Object.assign(stable.smokes, savedSmokes);
  rmSync(tmp, { recursive: true, force: true });
});

/** Write files (path -> text, null deletes) and commit them. */
function commit(files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(path, { force: true });
    else {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    }
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "c");
  return git("rev-parse", "HEAD^{tree}");
}

const base = {
  "flake.nix": "{}\n",
  "versions/t3code.json": pin("t3code", "1.0.0"),
  "versions/t3code-nightly.json": pin("t3code-nightly", "1.1.0-n"),
  "versions/codex.json": pin("codex", "2.0.0"),
  "versions/nixpkgs-stable.json": pin("nixpkgs-stable", "abc"),
  "versions/stable/t3code.json": pin("t3code", "1.0.0"),
  "versions/stable/codex.json": pin("codex", "2.0.0"),
};

test("the snapshot holds every pin but the nightly ones and nixpkgs-stable", () => {
  assert.equal(inSnapshot("t3code"), true);
  assert.equal(inSnapshot("browser-stable"), true);
  assert.equal(inSnapshot("t3code-nightly"), false);
  assert.equal(inSnapshot("nixpkgs-stable"), false);
});

test("current and differing compare names and bytes", () => {
  assert.equal(current(commit(base)), true);
  assert.deepEqual(differing(git("rev-parse", "HEAD^{tree}")), []);
  // A new version, a new package and a removed one all count.
  const t = commit({ "versions/t3code.json": pin("t3code", "1.0.1"), "versions/grok.json": pin("grok", "1"), "versions/codex.json": null });
  assert.equal(current(t), false);
  assert.deepEqual(differing(t), ["codex", "grok", "t3code"]);
  // Same version but different bytes (a re-hashed asset) counts too.
  const u = commit({ ...base, "versions/grok.json": null, "versions/codex.json": pin("codex", "2.0.0").replace("{}", "{\"a\":1}") });
  assert.deepEqual(differing(u), ["codex"]);
});

test("a tree without a snapshot is behind by every pin", () => {
  const t = commit({ ...base, "versions/stable/t3code.json": null, "versions/stable/codex.json": null });
  assert.deepEqual(differing(t), ["codex", "t3code"]);
});

test("a move is an exact copy of the eligible pins, and the same tree everywhere", () => {
  commit(base);
  const t = commit({ "versions/t3code.json": pin("t3code", "1.0.1"), "versions/grok.json": pin("grok", "1"), "versions/codex.json": null,
    "versions/stable/stray.txt": "not a pin\n" });
  const m = moved(t);
  assert.equal(current(m), true);
  assert.equal(moved(t), m, "the same tree each time");
  assert.equal(moved(m), m, "moving a current snapshot changes nothing");
  // Only versions/stable/ changed, and it holds the bytes of the pins.
  const changed = git("diff-tree", "-r", "--name-only", t, m).split("\n").sort();
  assert.deepEqual(changed, ["versions/stable/codex.json", "versions/stable/grok.json", "versions/stable/stray.txt", "versions/stable/t3code.json"]);
  assert.equal(git("rev-parse", `${m}:versions/stable/t3code.json`), git("rev-parse", `${t}:versions/t3code.json`));
  assert.equal(git("ls-tree", "--name-only", `${m}:versions/stable`), "grok.json\nt3code.json");
  // A copy made on disk (as anyone would) gives the same tree.
  git("checkout", "-q", "--detach");
  rmSync("versions/stable", { recursive: true });
  mkdirSync("versions/stable");
  for (const f of readdirSync("versions")) if (f.endsWith(".json") && inSnapshot(f.slice(0, -5))) writeFileSync(`versions/stable/${f}`, readFileSync(`versions/${f}`));
  assert.equal(stable.workingTree(), m);
});

test("the tested tree includes the working tree's changes, and leaves the index alone", () => {
  const t = commit(base);
  assert.equal(stable.workingTree(), t);
  writeFileSync("versions/codex.json", pin("codex", "3"));
  writeFileSync("new.txt", "x");
  const w = stable.workingTree();
  assert.notEqual(w, t);
  assert.equal(git("show", `${w}:new.txt`), "x");
  assert.equal(git("diff", "--cached", "--name-only"), "");
});

// The stand-in for Nix: a check's "derivation" is a hash of what it reads.
// Default checks read everything but versions/stable/; stable-<x> reads the
// snapshot; stable-next-<x> reads versions/ (the nightly pins left out). The
// "noread" check reads nothing.
const read = (src: string, dir: string, keep: (f: string) => boolean) =>
  existsSync(join(src, dir)) ? readdirSync(join(src, dir)).filter((f) => f.endsWith(".json") && keep(f.slice(0, -5))).sort()
    .map((f) => `${f}:${readFileSync(join(src, dir, f), "utf8")}`).join("|") : "";
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const CHECKS = ["t3code", "agent-browser", "unit"];
let leaky = false; // a default check that starts reading the snapshot
function fakeNix(broken: Set<string> = new Set(), badEval: Set<string> = new Set()) {
  const drvsOf = (src: string, attr: string): Record<string, { out: string; drv: string }> | null => {
    const one = (name: string, input: string) => ({ out: `/out/${name}-${h(input)}`, drv: `/drv/${name}-${h(input)}.drv` });
    if (attr.startsWith("checks.")) {
      const all = read(src, "versions", () => true) + readFileSync(join(src, "flake.nix"), "utf8") + (leaky ? read(src, "versions/stable", () => true) : "");
      return Object.fromEntries(CHECKS.map((c) => [c, one(c, all)]));
    }
    const next = attr.endsWith("stableNextChecks");
    const prefix = next ? "stable-next-" : "stable-";
    if (attr.endsWith("Checks")) {
      const input = next ? read(src, "versions", inSnapshot) : read(src, "versions/stable", () => true);
      return Object.fromEntries([...CHECKS, "noread"].map((c) => [prefix + c, one(c, c === "noread" ? "" : input)]));
    }
    if (attr.endsWith(".stable")) return { t3: one("t3", read(src, "versions/stable", () => true)) };
    return null;
  };
  Object.assign(stable.nix, {
    drvs(src: string, attr: string) {
      if ([...badEval].some((b) => attr.endsWith("Checks") && attr.includes(b.startsWith("stable-next-") ? "stableNextChecks" : "stableChecks"))) return null;
      return drvsOf(src, attr);
    },
    names(src: string, attr: string) {
      const d = drvsOf(src, attr);
      return d && Object.keys(d);
    },
    one(src: string, attr: string) {
      const [group, name] = [attr.slice(0, attr.lastIndexOf(".")), attr.slice(attr.lastIndexOf(".") + 1)];
      if (badEval.has(name)) return null;
      return drvsOf(src, group)?.[name] ?? null;
    },
    build(checks: Record<string, { out: string; drv: string }>, names: string[]) {
      return { missing: names.filter((n) => broken.has(checks[n].drv)), proven: true };
    },
    valid: (out: string) => ![...broken].some((d) => d.replace("/drv/", "/out/").replace(/\.drv$/, "") === out),
    outcome: (d: { drv: string }) => (broken.has(d.drv) ? "fail" : "pass"),
    tops: (src: string, attr: string) => [`/drv/${attr}-${h(read(src, "versions", () => true))}.drv`],
    noFlakes: (src: string) => drvsOf(src, "legacyPackages.x86_64-linux.stable")!.t3.drv,
    tools: () => ({ path: "/stable-tools/bin" }),
  });
}

test("a group that doesn't evaluate as a whole is evaluated one check at a time", () => {
  commit(base);
  fakeNix(new Set(), new Set(["stable-agent-browser"]));
  const e = stable.evaluate(tmp, "legacyPackages.x86_64-linux.stableChecks");
  assert.equal(e.complete, true);
  assert.deepEqual(e.failed, ["stable-agent-browser"]);
  assert.deepEqual(Object.keys(e.drvs).sort(), ["stable-noread", "stable-t3code", "stable-unit"]);
  // Nothing evaluates at all (not even the names): incomplete.
  stable.nix.names = () => null;
  assert.deepEqual(stable.evaluate(tmp, "legacyPackages.x86_64-linux.stableChecks"), { drvs: {}, failed: [], complete: false });
});

test("a group's failures: builds that fail twice, checks that don't evaluate, and the smokes", async () => {
  commit(base);
  fakeNix();
  const first = stable.evaluate(tmp, "legacyPackages.x86_64-linux.stableChecks").drvs;
  fakeNix(new Set([first["stable-unit"].drv]), new Set(["stable-noread"]));
  const smoked: string[] = [];
  stable.smokes.desktop = async (out) => {
    assert.ok(process.env.PATH!.startsWith("/stable-tools/bin:"), "the stable smoke tools come first on PATH");
    smoked.push(out);
    return smoked.length > 1; // flaky: passes the second time
  };
  stable.smokes.agentBrowser = async () => false;
  const r = await stable.runGroup(tmp, "x86_64-linux", "stable-", true);
  assert.deepEqual(r.group, { complete: true, failed: ["stable-noread", "stable-set-agent-browser-smoke", "stable-unit"] });
  assert.equal(smoked.length, 2);
  assert.ok(!process.env.PATH!.includes("/stable-tools/bin"), "PATH is put back");
  // Smoke tools that fail to build fail both smokes without starting them;
  // tools with no build result (a timeout, the daemon) leave the group incomplete.
  stable.nix.tools = () => ({ outcome: "fail" });
  stable.smokes.desktop = async () => { throw new Error("started"); };
  const noTools = await stable.runGroup(tmp, "x86_64-linux", "stable-", true);
  assert.deepEqual(noTools.group.failed.filter((f) => f.endsWith("smoke")), ["stable-desktop-smoke", "stable-set-agent-browser-smoke"]);
  stable.nix.tools = () => ({ outcome: "incomplete" });
  assert.deepEqual((await stable.runGroup(tmp, "x86_64-linux", "stable-", true)).group, { complete: false, failed: [] });
  // Without smokes, a stable-next group only builds.
  fakeNix();
  stable.smokes.agentBrowser = async () => { throw new Error("not run"); };
  const n = await stable.runGroup(tmp, "x86_64-linux", "stable-next-", false);
  assert.deepEqual(n.group.failed, []);
});

test("a smoke whose package didn't build fails without starting", async () => {
  commit(base);
  fakeNix();
  const d = stable.evaluate(tmp, "legacyPackages.x86_64-linux.stableChecks").drvs;
  fakeNix(new Set([d["stable-t3code"].drv]));
  stable.smokes.desktop = async () => { throw new Error("started"); };
  stable.smokes.agentBrowser = async () => true;
  const r = await stable.runGroup(tmp, "x86_64-linux", "stable-", true);
  assert.ok(r.group.failed.includes("stable-desktop-smoke"));
  assert.ok(r.group.failed.includes("stable-t3code"));
});

test("the digest follows names and derivations, not order", () => {
  const a = { x: { out: "1", drv: "a" }, y: { out: "2", drv: "b" } };
  assert.equal(stable.digest(a), stable.digest({ y: a.y, x: a.x }));
  assert.notEqual(stable.digest(a), stable.digest({ ...a, y: { out: "2", drv: "c" } }));
});

test("the equivalence step accepts a move whose stable checks are the tested stable-next ones", async () => {
  commit(base);
  const t = commit({ "versions/t3code.json": pin("t3code", "1.0.1"), "versions/grok.json": pin("grok", "1") });
  fakeNix();
  const src = stable.unpack(t);
  try {
    const next = stable.evaluate(src, "legacyPackages.x86_64-linux.stableNextChecks").drvs;
    let asked: unknown[] = [];
    const ok = await stable.equivalence(t, src, "x86_64-linux", next, async (...a) => { asked = a; return { missing: [], unknown: [] }; });
    assert.deepEqual(ok, { ok: true, tree: moved(t), reason: "" });
    assert.equal(asked.length, 2);
    // The cache misses something, or can't be checked.
    const miss = await stable.equivalence(t, src, "x86_64-linux", next, async () => ({ missing: ["x86_64-linux: libfoo"], unknown: [] }));
    assert.match(miss.reason, /cache.nixos.org lacks: x86_64-linux: libfoo/);
    const unknown = await stable.equivalence(t, src, "x86_64-linux", next, async () => ({ missing: [], unknown: ["p"] }));
    assert.match(unknown.reason, /^incomplete/);
    // default.nix without flakes fails, or disagrees with the flake, on the moved tree.
    stable.nix.noFlakes = () => null;
    assert.match((await stable.equivalence(t, src, "x86_64-linux", next, async () => ({ missing: [], unknown: [] }))).reason, /without flakes gives nothing/);
    stable.nix.noFlakes = () => "/drv/other.drv";
    assert.match((await stable.equivalence(t, src, "x86_64-linux", next, async () => ({ missing: [], unknown: [] }))).reason,
      /^on the moved tree, default.nix without flakes gives \/drv\/other.drv for the stable t3, the flake \/drv\/t3-/);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("the equivalence step refuses a move that changes a default check or a stable pair", async () => {
  commit(base);
  const t = commit({ "versions/t3code.json": pin("t3code", "1.0.1") });
  fakeNix();
  const src = stable.unpack(t);
  try {
    const next = stable.evaluate(src, "legacyPackages.x86_64-linux.stableNextChecks").drvs;
    const cache = async () => ({ missing: [], unknown: [] });
    leaky = true;
    const r = await stable.equivalence(t, src, "x86_64-linux", next, cache);
    leaky = false;
    assert.equal(r.ok, false);
    assert.match(r.reason, /changes default checks: agent-browser, t3code, unit/);
    // A stable-next result from another tree doesn't match the moved tree's stable checks.
    const other = { ...next, "stable-next-unit": { out: "/x", drv: "/drv/other.drv" } };
    assert.match((await stable.equivalence(t, src, "x86_64-linux", other, cache)).reason, /don't match the tested stable-next ones: unit/);
  } finally {
    leaky = false;
    rmSync(src, { recursive: true, force: true });
  }
});

test("branch CI fails only on stable failures the branch made", async () => {
  const d = (drv: string) => ({ out: `/o/${drv}`, drv });
  const drvs = { "stable-a": d("a1"), "stable-b": d("b2"), "stable-c": d("c2"), "stable-d": d("d1"), "stable-e": d("e2") };
  const parent = { "stable-a": d("a1"), "stable-b": d("b1"), "stable-c": d("c1"), "stable-e": d("e1") };
  const outcomes: Record<string, stable.Outcome> = { "stable-b": "pass", "stable-c": "fail", "stable-e": "incomplete",
    "stable-desktop-smoke": "fail", "stable-set-agent-browser-smoke": "pass" };
  const asked: string[] = [];
  const parentOutcome = async (n: string) => { asked.push(n); return outcomes[n] ?? "pass"; };
  const group = { complete: true, failed: ["stable-a", "stable-b", "stable-c", "stable-d", "stable-desktop-smoke", "stable-e", "stable-set-agent-browser-smoke"] };
  // a: the parent's own derivation (fails there too, not even built); b:
  // changed, the parent's passes; c: changed, the parent's fails too; d: new;
  // e: the parent's ran out of time (unproven); the smokes as their parent runs say.
  assert.deepEqual(await stable.branchFailures(group, drvs, parent, parentOutcome),
    ["stable-b", "stable-d", "stable-e", "stable-set-agent-browser-smoke"]);
  assert.ok(!asked.includes("stable-a"));
  assert.deepEqual(await stable.branchFailures({ complete: false, failed: [] }, {}, parent, parentOutcome), ["stable (incomplete)"]);
  assert.deepEqual(await stable.branchFailures({ complete: true, failed: [] }, drvs, parent, parentOutcome), []);
});

test("main: a candidate records main's stable derivations; stable-next's smokes only when behind; no move after a failure", async () => {
  commit(base);
  fakeNix();
  let smoked = 0;
  stable.smokes.desktop = async () => (smoked++, true);
  stable.smokes.agentBrowser = async () => (smoked++, true);
  const result = async (args: string[]) => {
    rmSync("out", { recursive: true, force: true });
    await stable.main([args[0], "x86_64-linux", "out", ...args.slice(1)]);
    return JSON.parse(readFileSync(`out/stable-${args[0]}-x86_64-linux.json`, "utf8"));
  };
  // A candidate (any set but main) records the base's stable derivations.
  assert.equal(typeof (await result(["candidate"])).base, "string");
  assert.equal((await result(["main"])).base, undefined);
  // Not behind: stable-next runs without its smokes.
  smoked = 0;
  await result(["main"]);
  const alone = smoked;
  smoked = 0;
  const current = await result(["main", "--next"]);
  assert.equal(current.behind, false);
  assert.equal(smoked, alone, "stable-next's smokes don't run when the snapshot is current");
  // Behind, with stable-next failing: no move is tried.
  commit({ "versions/codex.json": pin("codex", "2.0.1") });
  const next = stable.evaluate(tmp, "legacyPackages.x86_64-linux.stableNextChecks").drvs;
  fakeNix(new Set([next["stable-next-unit"].drv]));
  const behind = await result(["main", "--next"]);
  assert.equal(behind.behind, true);
  assert.deepEqual(behind.stableNext.failed, ["stable-next-unit"]);
  assert.equal(behind.move, undefined);
});

test("main: a default check that reads the snapshot fails the branch", async () => {
  commit(base);
  commit({ "versions/codex.json": pin("codex", "2.0.1") }); // behind
  fakeNix();
  stable.smokes.desktop = async () => true;
  stable.smokes.agentBrowser = async () => true;
  leaky = true;
  try {
    await stable.main(["branch", "x86_64-linux", "out", "--branch", "--parent=HEAD~1"]);
  } finally { leaky = false; }
  const branch = JSON.parse(readFileSync("out/stable-branch-x86_64-linux.json", "utf8")).branch;
  assert.deepEqual(branch, ["equivalence (moving the snapshot changes agent-browser, t3code, unit)"]);
});

test("noFlakesDisagree: nothing on both sides is a disagreement", () => {
  stable.nix.one = () => null;
  stable.nix.noFlakes = () => null;
  assert.match(stable.noFlakesDisagree(tmp, "x86_64-linux")!, /gives nothing .* the flake nothing/);
});

test("nix.outcome: a build that exits 0 without its output is no result, not a pass", () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-nix-"));
  writeFileSync(join(bin, "nix"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = bin;
  stable.nix.valid = () => false;
  try {
    assert.equal(saved.outcome({ out: "/nix/store/x-out", drv: "/nix/store/x.drv", na: false }), "incomplete");
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("branch CI: a check main can't evaluate doesn't make every failure the branch's", async () => {
  // Main has a stable check that doesn't evaluate (stable-agent-browser) and
  // one that fails to build (stable-unit); the branch changes nothing either
  // reads. Before, the parent's group evaluated as a whole gave nothing, so
  // all three failures (with the agent-browser smoke) counted on every branch.
  commit(base);
  fakeNix();
  const d = stable.evaluate(tmp, "legacyPackages.x86_64-linux.stableChecks").drvs;
  commit({ "flake.nix": "{ }\n" });
  fakeNix(new Set([d["stable-unit"].drv]), new Set(["stable-agent-browser"]));
  stable.smokes.desktop = async () => true;
  stable.smokes.agentBrowser = async () => true;
  mkdirSync("out");
  await stable.main(["branch", "x86_64-linux", "out", "--branch", "--parent=HEAD~1"]);
  const r = JSON.parse(readFileSync("out/stable-branch-x86_64-linux.json", "utf8"));
  assert.ok(r.stable.failed.includes("stable-agent-browser") && r.stable.failed.includes("stable-unit"), JSON.stringify(r.stable));
  assert.deepEqual(r.branch, []);
  // A check that evaluates on main but not on the branch still counts.
  fakeNix();
  const [drvs, one] = [stable.nix.drvs, stable.nix.one];
  const onBranch = (src: string) => readFileSync(join(src, "flake.nix"), "utf8") === "{ }\n";
  stable.nix.drvs = (src, attr) => (onBranch(src) && attr.endsWith("stableChecks") ? null : drvs(src, attr));
  stable.nix.one = (src, attr) => (onBranch(src) && attr.endsWith(".stable-unit") ? null : one(src, attr));
  rmSync("out", { recursive: true });
  await stable.main(["branch", "x86_64-linux", "out", "--branch", "--parent=HEAD~1"]);
  const written = JSON.parse(readFileSync("out/stable-branch-x86_64-linux.json", "utf8"));
  assert.deepEqual(written.branch, ["stable-unit"]);
  assert.ok(Array.isArray(written.nixCalls), "the record of Nix calls (util.ts) is written with the result");
});

test("branch CI: the same in stable-next, as branch CI runs it (--next, the snapshot behind on both)", async () => {
  commit(base);
  commit({ "versions/codex.json": pin("codex", "2.0.1") }); // main: behind
  fakeNix();
  const d = stable.evaluate(tmp, "legacyPackages.x86_64-linux.stableNextChecks").drvs;
  commit({ "flake.nix": "{ }\n" }); // the branch: nothing stable-next reads changes
  fakeNix(new Set([d["stable-next-unit"].drv]), new Set(["stable-next-agent-browser"]));
  stable.smokes.desktop = async () => true;
  stable.smokes.agentBrowser = async () => true;
  const run = async () => {
    rmSync("out", { recursive: true, force: true });
    await stable.main(["branch", "x86_64-linux", "out", "--next", "--branch", "--parent=HEAD~1"]);
    return JSON.parse(readFileSync("out/stable-branch-x86_64-linux.json", "utf8"));
  };
  const r = await run();
  assert.equal(r.behind, true);
  assert.ok(r.stableNext.failed.includes("stable-next-agent-browser") && r.stableNext.failed.includes("stable-next-unit"), JSON.stringify(r.stableNext));
  assert.deepEqual(r.branch, []);
  // Only the branch failing to evaluate it: counted.
  fakeNix();
  const [drvs, one] = [stable.nix.drvs, stable.nix.one];
  const onBranch = (src: string) => readFileSync(join(src, "flake.nix"), "utf8") === "{ }\n";
  stable.nix.drvs = (src, attr) => (onBranch(src) && attr.endsWith("stableNextChecks") ? null : drvs(src, attr));
  stable.nix.one = (src, attr) => (onBranch(src) && attr.endsWith(".stable-next-unit") ? null : one(src, attr));
  assert.deepEqual((await run()).branch, ["stable-next-unit"]);
});

test("branch CI: the parent's outcome of a check is its build's, of a smoke its own run with the parent's script and tools", async () => {
  commit(base);
  fakeNix();
  const d = (drv: string) => ({ out: `/out/${drv}`, drv: `/drv/${drv}.drv` });
  const parent = { "stable-unit": d("u"), "stable-t3code": d("t"), "stable-agent-browser": d("ab") };
  let built: string[] = [];
  stable.nix.outcome = (x) => { built.push(x.drv); return x.drv === "/drv/u.drv" ? "incomplete" : "pass"; };
  const ran: string[] = [];
  const parentSmokes: stable.Smokes = {
    desktop: async (pkg) => { ran.push(`desktop ${pkg} ${process.env.PATH!.split(":")[0]}`); return false; },
    agentBrowser: async (pkg) => { ran.push(`ab ${pkg}`); return true; },
  };
  const outcome = stable.parentOutcomes(tmp, "x86_64-linux", "stable-", parent, async () => parentSmokes);
  assert.equal(await outcome("stable-unit"), "incomplete");
  assert.equal(await outcome("stable-new"), "pass", "no parent counterpart: counted");
  assert.equal(await outcome("stable-desktop-smoke"), "fail");
  assert.equal(await outcome("stable-set-agent-browser-smoke"), "pass");
  assert.deepEqual(ran, ["desktop /out/t /stable-tools/bin", "desktop /out/t /stable-tools/bin", "ab /out/ab"]);
  assert.deepEqual(built, ["/drv/u.drv", "/drv/t.drv", "/drv/ab.drv"]);
  // The parent's package itself failing, or its tools not building (the
  // agent-browser smoke, whose fake passes, so only the package decides).
  stable.nix.outcome = () => "fail";
  assert.equal(await outcome("stable-desktop-smoke"), "fail");
  assert.equal(await outcome("stable-set-agent-browser-smoke"), "fail");
  stable.nix.outcome = () => "incomplete";
  assert.equal(await outcome("stable-set-agent-browser-smoke"), "incomplete");
  stable.nix.outcome = () => "pass";
  stable.nix.tools = () => ({ outcome: "incomplete" });
  assert.equal(await outcome("stable-desktop-smoke"), "incomplete");
  stable.nix.tools = () => ({ outcome: "fail" });
  assert.equal(await outcome("stable-desktop-smoke"), "fail");
  // No parent package: counted.
  assert.equal(await stable.parentOutcomes(tmp, "x86_64-linux", "stable-", {}, async () => parentSmokes)("stable-desktop-smoke"), "pass");
  // A "not applicable" parent twin isn't smoked: counted.
  stable.nix.outcome = () => "pass";
  stable.nix.tools = () => ({ path: "/stable-tools/bin" });
  ran.length = 0;
  const na = { "stable-t3code": { ...d("t"), na: true } };
  assert.equal(await stable.parentOutcomes(tmp, "x86_64-linux", "stable-", na, async () => parentSmokes)("stable-desktop-smoke"), "pass");
  assert.deepEqual(ran, []);
});

test("branch CI loads the parent tree's own smoke scripts", async () => {
  mkdirSync("scripts", { recursive: true });
  writeFileSync("scripts/desktop-smoke.ts", "export const desktopSmoke = async () => 'parent desktop';\n");
  writeFileSync("scripts/agent-browser-smoke.ts", "export const agentBrowserSmoke = async () => 'parent ab';\n");
  const s = await stable.smokesOf(tmp);
  assert.deepEqual([await s.desktop("x", "y"), await s.agentBrowser("x")], ["parent desktop", "parent ab"]);
});

test("a nix build's outcome: a proven failure only from Nix's build-failure status without the timeout bit", () => {
  // Reads the exit status of `nix build`; a fake nix on PATH answers.
  mkdirSync("bin");
  const status = (code: number) => {
    writeFileSync("bin/nix", `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
    writeFileSync("bin/nix-store", "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${join(tmp, "bin")}:${path}`;
    try { return saved.outcome({ out: "/nix/store/x", drv: "/nix/store/x.drv" }); } finally { process.env.PATH = path; }
  };
  assert.equal(status(100), "fail");
  assert.equal(status(104), "fail");
  assert.equal(status(101), "incomplete", "timed out");
  assert.equal(status(1), "incomplete", "not a build failure");
});

test("the cache job's checkout writes exactly the moved snapshot, and only a real move", async () => {
  const { checkout } = await import("../scripts/lib/snapshot.ts");
  commit(base);
  const t = commit({ "versions/t3code.json": pin("t3code", "1.0.1") });
  checkout(t, t); // not moved: nothing to do
  assert.equal(readFileSync("versions/stable/t3code.json", "utf8"), pin("t3code", "1.0.0"));
  assert.throws(() => checkout(t, t.replace(/./, (c) => (c === "0" ? "1" : "0"))), /isn't .* with the snapshot moved/);
  writeFileSync("versions/stable/extra.json", "{}");
  checkout(t, moved(t));
  assert.deepEqual(readdirSync("versions/stable").sort(), ["codex.json", "t3code.json"]);
  assert.equal(stable.workingTree(), moved(t));
});

test("snapshot: a browser pin's Google Chrome .debs are among its downloads", async () => {
  const { urlsOf } = await import("../scripts/lib/snapshot.ts");
  const p = { name: "browser-stable", version: "r", assets: {}, browsers: { chromium: { version: "1", outPaths: {} },
    "google-chrome": { version: "1", outPaths: {}, assets: { "x86_64-linux": { url: "https://dl.google.com/a.deb", hash: "sha256-a" },
      "aarch64-linux": { url: "https://dl.google.com/b.deb", hash: "sha256-b" } } } } };
  assert.deepEqual(urlsOf(p).sort(), ["https://dl.google.com/a.deb", "https://dl.google.com/b.deb"]);
  assert.deepEqual(urlsOf({ name: "browser-stable", version: "r", assets: {} }), [], "a pin from before `browsers`");
});

test("resolve: stable-current from the files, and the snapshot's downloads probed within the time left", async () => {
  const { stableSnapshotChecks, Report, PROBE } = await import("../scripts/update.ts");
  const withUrls = (name: string, version: string, urls: string[]) =>
    JSON.stringify({ name, version, assets: Object.fromEntries(urls.map((u, i) => [`a${i}`, { url: u, hash: "h" }])) }, null, 2) + "\n";
  const t3 = withUrls("t3code", "1", ["https://x/t3-1.deb"]);
  commit({ ...base, "versions/t3code.json": t3, "versions/stable/t3code.json": t3,
    "versions/stable/codex.json": withUrls("codex", "1", ["https://x/codex-1", "https://x/gone"]) });
  const kinds = (r: InstanceType<typeof Report>) => r.observations.map((o) => [o.kind, o.detail]);
  const probe = async (url: string) => (url.endsWith("gone") ? "missing" as const : url.endsWith("t3-1.deb") ? "missing" as const : "ok" as const);
  let r = new Report();
  await stableSnapshotChecks(r, Date.now() + 60_000, probe, Date.now, git("rev-parse", "HEAD^{tree}"));
  assert.deepEqual(kinds(r), [["stable-unfetchable", "https://x/gone\nhttps://x/t3-1.deb (main pins it too)"]], "behind: codex differs");
  // Current, everything there.
  commit({ "versions/stable/codex.json": pin("codex", "2.0.0") });
  r = new Report();
  await stableSnapshotChecks(r, Date.now() + 60_000, async () => "ok", Date.now, git("rev-parse", "HEAD^{tree}"));
  assert.deepEqual(kinds(r), [["stable-current", ""], ["fetchable", ""]]);
  // Out of time, or an answer that isn't 404/410: nothing either way.
  r = new Report();
  let asked = 0;
  await stableSnapshotChecks(r, Date.now() - 1, async () => { asked++; return "ok"; }, Date.now, git("rev-parse", "HEAD^{tree}"));
  assert.deepEqual([kinds(r), asked], [[["stable-current", ""]], 0]);
  r = new Report();
  await stableSnapshotChecks(r, Date.now() + 60_000, async () => "unknown", Date.now, git("rev-parse", "HEAD^{tree}"));
  assert.deepEqual(kinds(r), [["stable-current", ""]]);
  // At most PROBE.concurrency at once.
  let open = 0, most = 0;
  commit({ "versions/stable/t3code.json": withUrls("t3code", "1", Array.from({ length: 12 }, (_, i) => `https://x/${i}`)) });
  await stableSnapshotChecks(new Report(), Date.now() + 60_000, async () => {
    most = Math.max(most, ++open);
    await new Promise((res) => setTimeout(res, 5));
    open--;
    return "ok";
  }, Date.now, git("rev-parse", "HEAD^{tree}"));
  assert.equal(most, PROBE.concurrency);
});

test("resolve: a download probe follows redirects, retries with GET where HEAD is refused, and only 404/410 is missing", async () => {
  const { probeUrl } = await import("../scripts/update.ts");
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.url === "/moved") { res.writeHead(302, { location: "/here" }); return res.end(); }
    if (req.url === "/here") { res.writeHead(200); return res.end(); }
    if (req.url === "/nohead") { res.writeHead(req.method === "HEAD" ? 405 : 206); return res.end(); }
    if (req.url === "/forbidhead") { res.writeHead(req.method === "HEAD" ? 403 : 206); return res.end(); }
    if (req.url === "/gone") { res.writeHead(410); return res.end(); }
    if (req.url === "/busy") { res.writeHead(503); return res.end(); }
    if (req.url === "/slow") return; // never answers
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const at = (p: string) => `http://127.0.0.1:${(server.address() as any).port}${p}`;
  try {
    assert.equal(await probeUrl(at("/moved"), 2000), "ok");
    assert.equal(await probeUrl(at("/nohead"), 2000), "ok");
    assert.equal(await probeUrl(at("/forbidhead"), 2000), "ok", "a 403 to HEAD (S3, some CDNs) is asked again with GET");
    assert.equal(await probeUrl(at("/gone"), 2000), "missing");
    assert.equal(await probeUrl(at("/nothing"), 2000), "missing");
    assert.equal(await probeUrl(at("/busy"), 2000), "unknown");
    assert.equal(await probeUrl(at("/slow"), 200), "unknown");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("resolve: an unreadable snapshot pin makes its downloads unknown, never fetchable", async () => {
  const { stableSnapshotChecks, Report } = await import("../scripts/update.ts");
  // Another snapshot pin reads, and its download is there: still not fetchable.
  const t3 = JSON.stringify({ name: "t3code", version: "1.0.0", assets: { a: { url: "https://x/t3-1.deb", hash: "h" } } }, null, 2) + "\n";
  commit({ ...base, "versions/stable/codex.json": "{ not json", "versions/stable/t3code.json": t3 });
  const r = new Report();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await stableSnapshotChecks(r, Date.now() + 60_000, async () => "ok", Date.now, git("rev-parse", "HEAD^{tree}"));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(r.observations.map((o) => o.kind), []);
});

test("default-nix-no-flakes's stable part: only a disagreement fails the default", async () => {
  const { stableNoFlakesFailures } = await import("../scripts/ci/test.ts");
  const ok = (stdout: string) => () => ({ status: 0, stdout, stderr: "" });
  const bad = () => ({ status: 1, stdout: "", stderr: "error: cannot fetch" });
  const err = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(stableNoFlakesFailures("x86_64-linux", ok("/nix/store/a.drv"), ok("warning\n/nix/store/a.drv\n")), []);
    assert.deepEqual(stableNoFlakesFailures("x86_64-linux", bad, bad), [], "the stable set not evaluating is the stable checks' failure");
    assert.deepEqual(stableNoFlakesFailures("x86_64-linux", ok("/nix/store/a.drv"), ok("/nix/store/b.drv")), ["default-nix-no-flakes"]);
    assert.deepEqual(stableNoFlakesFailures("x86_64-linux", ok("/nix/store/a.drv"), bad), ["default-nix-no-flakes"]);
    assert.deepEqual(stableNoFlakesFailures("x86_64-linux", bad, ok("/nix/store/a.drv")), ["default-nix-no-flakes"]);
  } finally {
    console.error = err;
  }
});

test("default-nix-lazy: lists the packages with NixOS stable swapped for an abort, and can't pass without the swap", async () => {
  const { lazyFailures } = await import("../scripts/ci/test.ts");
  const flake = 'let\n  stableSrc = builtins.fetchTarball {\n    url = "https://x/${stablePin.rev}.tar.gz";\n    sha256 = stablePin.narHash;\n  };\nin { }\n';
  const tree = (text: string) => () => { const d = mkdtempSync(join(tmp, "copy-")); writeFileSync(join(d, "flake.nix"), text); return d; };
  let seen = "";
  const list = (dir: string) => { seen = readFileSync(join(dir, "flake.nix"), "utf8"); return { status: 0, stdout: "", stderr: "" }; };
  const err = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(lazyFailures("x86_64-linux", tree(flake), list), []);
    assert.equal(seen, 'let\n  stableSrc = abort "default-nix-lazy: NixOS stable was evaluated";\nin { }\n');
    assert.deepEqual(lazyFailures("x86_64-linux", tree(flake), () => ({ status: 1, stdout: "", stderr: "aborted" })), ["default-nix-lazy"]);
    assert.deepEqual(lazyFailures("x86_64-linux", tree("{ }\n"), list), ["default-nix-lazy"]);
  } finally {
    console.error = err;
  }
});

test("a group whose builds are lost to a timeout or an infrastructure error has no complete result", async () => {
  commit(base);
  fakeNix();
  let calls = 0;
  stable.nix.build = (_c, names) => { calls++; return { missing: names.filter((n) => n === "stable-unit"), proven: calls === 1 }; };
  const r = await stable.runGroup(tmp, "x86_64-linux", "stable-", false);
  assert.deepEqual(r.group, { complete: false, failed: [] });
  assert.equal(calls, 2, "built once more first");
  assert.equal(stable.provenFailure(100), true);
  assert.equal(stable.provenFailure(106), true);
  assert.equal(stable.provenFailure(101), false);
  assert.equal(stable.provenFailure(1), false);
  for (const s of [0, 2, 4, 98]) assert.equal(stable.provenFailure(s), false, String(s));
});

test("default-nix-no-flakes's stable part: a side that runs out of time compares nothing", async () => {
  const { stableNoFlakesFailures } = await import("../scripts/ci/test.ts");
  const ok = () => ({ status: 0, stdout: "/nix/store/a.drv", stderr: "" });
  const slow = () => ({ status: 1, stdout: "", stderr: "(ETIMEDOUT: spawnSync nix ETIMEDOUT)" });
  const err = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(stableNoFlakesFailures("x86_64-linux", ok, slow), []);
    assert.deepEqual(stableNoFlakesFailures("x86_64-linux", slow, ok), []);
  } finally {
    console.error = err;
  }
});

test("the stable smokes cover the forced Electron twins, once per distinct output, and skip a \"not applicable\" one", async () => {
  fakeNix();
  const d = (out: string, na = false) => ({ out, drv: `${out}.drv`, na });
  const drvs = { "stable-t3code": d("/o/swapped"), "stable-t3code-electron-nixpkgs": d("/o/swapped"),
    "stable-t3code-electron-bundled": d("/o/bundled"), "stable-agent-browser": d("/o/ab") };
  const runs: string[] = [];
  const s: stable.Smokes = { desktop: async (pkg) => (runs.push(pkg), pkg !== "/o/bundled"), agentBrowser: async () => true };
  assert.deepEqual(await stable.smokeFailures(tmp, "x86_64-linux", "stable-", drvs, s), ["stable-desktop-smoke-electron-bundled"]);
  assert.deepEqual(runs, ["/o/swapped", "/o/bundled", "/o/bundled"], "the shared output once; a failure tried twice");
  const na = { ...drvs, "stable-t3code-electron-nixpkgs": d("/o/na", true) };
  runs.length = 0;
  await stable.smokeFailures(tmp, "x86_64-linux", "stable-", na, s);
  assert.ok(!runs.includes("/o/na"));
});

test("a \"not applicable\" twin keeps its marker on the one-at-a-time path, and the group records it", async () => {
  commit(base);
  fakeNix(new Set(), new Set(["stable-agent-browser"])); // the whole group doesn't evaluate
  const realOne = stable.nix.one;
  stable.nix.one = (src, attr) => {
    const r = realOne(src, attr);
    return r && attr.endsWith(".stable-noread") ? { ...r, na: true } : r;
  };
  const e = stable.evaluate(tmp, "legacyPackages.x86_64-linux.stableChecks");
  assert.equal(e.drvs["stable-noread"].na, true);
  const r = await stable.runGroup(tmp, "x86_64-linux", "stable-", false);
  assert.deepEqual(r.group.notApplicable, ["stable-noread"]);
});
