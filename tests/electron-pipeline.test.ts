// The desktop app's Electron fallback in the pipeline: the generated file
// (candidate.ts, scripts/lib/electron-fallback.ts), the evidence (test.ts),
// narrowing, decide and the verdict (narrow.ts), the resolve job's observations
// and the issues. Real git repositories in temporary folders; no Nix, no
// network.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as candidate from "../scripts/ci/candidate.ts";
import * as narrow from "../scripts/ci/narrow.ts";
import * as issues from "../scripts/ci/issues.ts";
import { branchElectronReported, desktopFailures, electronEvidence, type ElectronEvidence, type SmokeState } from "../scripts/ci/test.ts";
import { mergeElectron } from "../scripts/ci/merge-parts.ts";
import { TEST_PARTS, testPart } from "../scripts/lib/parts.ts";
import { activeChannels, canonical, CHANNELS, FALLBACK_FILE, generated, pairOf, ROLES, runtimeList } from "../scripts/lib/electron-fallback.ts";
import { electronFallbackChecks, obs, Report } from "../scripts/update.ts";
import { SYSTEMS } from "../scripts/lib/util.ts";
import { Fake } from "./fake-gh.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

let tmp: string;
const cwd = process.cwd();
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "electron-test-"));
  process.chdir(tmp);
  git("init", "-q", "-b", "main");
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

const REV = "a".repeat(40), REV2 = "b".repeat(40);
const hash = (h: string, s: string) => `sha256-${(h + s).padEnd(43, "0")}=`;
const pin = (name: string, version: string, h = "A") =>
  JSON.stringify({ name, version, assets: { "x86_64-linux": { url: "u", hash: hash(h, "x") }, "aarch64-linux": { url: "u", hash: hash(h, "a") } } }, null, 2) + "\n";
const lock = (rev: string) => JSON.stringify({ nodes: { nixpkgs: { locked: { rev } } } }, null, 2) + "\n";
const pairFor = (version: string, rev: string, h = "A") => ({ version, assets: { "aarch64-linux": hash(h, "a"), "x86_64-linux": hash(h, "x") }, nixpkgs: rev });

function commit(files: Record<string, string | null>) {
  for (const [p, t] of Object.entries(files)) {
    if (t === null) rmSync(p, { force: true });
    else { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); }
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "c");
}
const base = { "versions/t3code.json": pin("t3code", "0.1.9"), "versions/t3code-nightly.json": pin("t3code-nightly", "0.2.0-n"), "flake.lock": lock(REV) };

/** A candidate in DIR changing these files, relative to the committed base. */
function makeCandidate(dir: string, inputs: { name: string; files: Record<string, string> }[]) {
  mkdirSync(join(dir, "files"), { recursive: true });
  for (const i of inputs) for (const [p, t] of Object.entries(i.files)) { mkdirSync(join(dir, "files", p, ".."), { recursive: true }); writeFileSync(join(dir, "files", p), t); }
  writeFileSync(join(dir, "inputs.json"), JSON.stringify({ base: git("rev-parse", "HEAD"), inputs: inputs.map((i) => ({ name: i.name, files: Object.keys(i.files), from: null, to: "x" })) }));
}

// ---- the generated file ------------------------------------------------------

test("the file a final gets: the listed channels' pairs, active entries kept, inert ones dropped, none when empty", () => {
  commit(base);
  assert.equal(generated(tmp, []), null);
  const one = generated(tmp, ["t3code"])!;
  assert.deepEqual(JSON.parse(one), { t3code: pairFor("0.1.9", REV) });
  assert.equal(one, canonical(JSON.parse(one)), "canonical form");
  assert.match(one, /^\{\n  "t3code": \{\n    "assets": \{\n      "aarch64-linux"/);
  // An active entry is kept without being listed; an inert one (old version) is dropped.
  commit({ [FALLBACK_FILE]: canonical({ t3code: pairFor("0.1.9", REV), "t3code-nightly": pairFor("0.1.0-n", REV) }) });
  assert.deepEqual(activeChannels(tmp), ["t3code"]);
  assert.deepEqual(Object.keys(JSON.parse(generated(tmp, [])!)), ["t3code"]);
  assert.deepEqual(Object.keys(JSON.parse(generated(tmp, ["t3code-nightly"])!)), ["t3code", "t3code-nightly"]);
  // A nixpkgs bump makes every entry inert.
  commit({ "flake.lock": lock(REV2) });
  assert.deepEqual(activeChannels(tmp), []);
  assert.equal(generated(tmp, []), null);
});

test("an entry is inert with same-version replacement files, and a malformed file counts as none", () => {
  commit({ ...base, [FALLBACK_FILE]: canonical({ t3code: pairFor("0.1.9", REV) }) });
  assert.deepEqual(activeChannels(tmp), ["t3code"]);
  commit({ "versions/t3code.json": pin("t3code", "0.1.9", "B") });
  assert.deepEqual(activeChannels(tmp), []);
  commit({ [FALLBACK_FILE]: "{ not json" });
  assert.deepEqual(activeChannels(tmp), []);
  commit({ [FALLBACK_FILE]: JSON.stringify({ t3code: { version: "0.1.9" } }) });
  assert.deepEqual(activeChannels(tmp), []);
});

test("candidate.ts: tree and apply with --electron give the same bytes, without it the base's file stays", () => {
  commit({ ...base, [FALLBACK_FILE]: canonical({ "t3code-nightly": pairFor("0.1.0-n", REV) }) }); // an inert entry on main
  const dir = join(tmp, "..", `${tmp.split("/").pop()}-cand`);
  makeCandidate(dir, [{ name: "t3code", files: { "versions/t3code.json": pin("t3code", "0.1.10", "C") } }]);
  try {
    // Without a channel list (a set that passed without a fallback): the base's file, inert entry included.
    const plain = candidate.tree(dir, "t3code");
    assert.equal(git("show", `${plain}:${FALLBACK_FILE}`), canonical({ "t3code-nightly": pairFor("0.1.0-n", REV) }).trim());
    // With one: generated from the tree (the input's pin), the inert entry dropped.
    const t = candidate.tree(dir, "t3code", ["t3code"]);
    assert.deepEqual(JSON.parse(git("show", `${t}:${FALLBACK_FILE}`)), { t3code: pairFor("0.1.10", REV, "C") });
    candidate.apply(dir, "t3code", ["t3code"]);
    assert.match(git("diff", "--cached", "--name-only"), /ci\/electron-fallback\.json/, "staged, so the flake sees it");
    git("add", "-A");
    assert.equal(git("write-tree"), t, "apply writes what tree hashed");
    git("reset", "-q", "--hard");
    // An entry that is active in the final tree (here once the nixpkgs input
    // brings its revision) is kept beside the listed channel.
    commit({ [FALLBACK_FILE]: canonical({ t3code: pairFor("0.1.9", REV2) }) });
    makeCandidate(dir, [{ name: "nixpkgs", files: { "flake.lock": lock(REV2) } }]);
    const kept = candidate.tree(dir, "nixpkgs", ["t3code-nightly"]);
    assert.deepEqual(JSON.parse(git("show", `${kept}:${FALLBACK_FILE}`)), { t3code: pairFor("0.1.9", REV2), "t3code-nightly": pairFor("0.2.0-n", REV2) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- test.ts's evidence ------------------------------------------------------

test("desktop smokes: once per distinct output, its result for every name sharing it, \"not applicable\" never started", async () => {
  const checks = {
    t3code: { out: "/o/swapped", drv: "" }, "t3code-electron-nixpkgs": { out: "/o/swapped", drv: "" },
    "t3code-electron-bundled": { out: "/o/bundled", drv: "" },
    "t3code-nightly": { out: "/o/n-bundled", drv: "" }, "t3code-nightly-electron-bundled": { out: "/o/n-bundled", drv: "" },
    "t3code-nightly-electron-nixpkgs": { out: "/o/na", drv: "", na: true },
  };
  const runs: string[] = [];
  let flaky = 0;
  const states: Record<string, SmokeState> = {};
  const failed = await desktopFailures(checks, async (out) => { runs.push(out); return out === "/o/swapped" ? ++flaky > 1 : out !== "/o/bundled"; }, () => true, states);
  assert.deepEqual(failed, ["desktop-smoke-electron-bundled"]);
  assert.deepEqual(states, {
    "desktop-smoke": "pass", "desktop-smoke-electron-nixpkgs": "pass", "desktop-smoke-electron-bundled": "fail",
    "desktop-smoke-nightly": "pass", "desktop-smoke-nightly-electron-bundled": "pass", "desktop-smoke-nightly-electron-nixpkgs": "not-applicable",
  });
  assert.deepEqual(runs, ["/o/swapped", "/o/swapped", "/o/bundled", "/o/bundled", "/o/n-bundled"]);
});

test("the evidence: per-system runtime lists, what passed, provisional failures, the pair and the active entry", () => {
  commit(base);
  const c = (drv: string, electron: string | null = null, na = false) => ({ out: `/o/${drv}`, drv: `/d/${drv}.drv`, electron, na });
  const checks = {
    "t3code-unwrapped": c("u", "nixpkgs"), t3code: c("w", "nixpkgs"), "t3code-free": c("f", "nixpkgs"),
    "t3code-electron-nixpkgs": c("w", "nixpkgs"), "t3code-electron-bundled": c("b", "bundled"),
    "t3code-unwrapped-nightly": c("nu", "bundled"), "t3code-nightly": c("nw", "bundled"),
    "t3code-nightly-electron-nixpkgs": c("na", null, true), "t3code-nightly-electron-bundled": c("nw", "bundled"),
    "preview-browser-pin": c("p"), codex: c("x"),
  };
  const smokes: Record<string, SmokeState> = { "desktop-smoke": "fail", "desktop-smoke-electron-nixpkgs": "fail", "desktop-smoke-electron-bundled": "pass",
    "desktop-smoke-nightly": "pass", "desktop-smoke-nightly-electron-bundled": "pass", "desktop-smoke-nightly-electron-nixpkgs": "not-applicable" };
  const failed = ["desktop-smoke", "desktop-smoke-electron-nixpkgs", "preview-browser-pin", "codex"];
  const e = electronEvidence(checks, failed, smokes, tmp, (drv) => (drv === "/d/p.drv" ? ["/d/p.drv", "/d/w.drv"] : [drv]));
  assert.deepEqual(e.channels.t3code!.runtime, runtimeList("t3code", true, true));
  assert.deepEqual(e.channels["t3code-nightly"]!.runtime, [], "auto is bundled and the forced check is not applicable");
  assert.equal(e.channels["t3code-nightly"]!.forcedNotApplicable, true);
  assert.deepEqual(e.channels.t3code!.passed.sort(), ["t3code", "t3code-electron-bundled", "t3code-electron-nixpkgs", "t3code-unwrapped", "desktop-smoke-electron-bundled"].sort());
  assert.ok(!e.channels.t3code!.runtime.includes("t3code-free"), "no bundled twin: never a runtime check");
  assert.deepEqual(e.dependsOn, { "preview-browser-pin": ["t3code"] }, "codex depends on no listed app");
  assert.deepEqual(e.channels.t3code!.pair, pairFor("0.1.9", REV));
  assert.equal(e.channels.t3code!.active, false);
  assert.equal(e.smokeRan, true);
  // A part of the suite (branch CI) vouches only for what it ran: here none
  // of the apps, so none passed, whatever the failures say.
  const rest = electronEvidence(checks, [], {}, tmp, () => [], new Set(["codex", "preview-browser-pin"]));
  assert.deepEqual(rest.channels.t3code!.passed, []);
  // The update runs' parts, merged (merge-parts.ts), give the whole suite's
  // evidence: each part evaluates only its own checks and the desktop apps'
  // (evaluateChecks), with its own failures and the smokes in desktop. A
  // rest part's failure that builds on a desktop app (preview-browser-pin)
  // still depends on it.
  const notRun = Object.fromEntries(Object.keys(smokes).map((n) => [n, "not-run" as SmokeState]));
  const apps = new Set(CHANNELS.flatMap((ch) => [...ROLES[ch].auto, ROLES[ch].forced, ROLES[ch].bundled, ...Object.keys(ROLES[ch].smokes)]));
  assert.notEqual(testPart("preview-browser-pin"), "desktop");
  const parts = TEST_PARTS.map((part) => {
    const names = Object.keys(checks).filter((n) => testPart(n) === part);
    const evaluated = Object.fromEntries(Object.entries(checks).filter(([n]) => names.includes(n) || apps.has(n)));
    return electronEvidence(evaluated, failed.filter((f) => names.includes(f) || (part === "desktop" && f in smokes)),
      part === "desktop" ? smokes : notRun, tmp, (drv) => (drv === "/d/p.drv" ? ["/d/p.drv", "/d/w.drv"] : [drv]), new Set(names));
  });
  const merged = mergeElectron(parts);
  const sorted = (ev: any) => Object.fromEntries(Object.entries(ev.channels).map(([c, x]: [string, any]) => [c, { ...x, passed: [...x.passed].sort() }]));
  assert.deepEqual(sorted(merged), sorted(e));
  assert.deepEqual([merged.dependsOn, merged.smokes, merged.smokeRan], [e.dependsOn, e.smokes, e.smokeRan]);
});

test("branch CI: a runtime failure under an active entry is reported unless the branch changed it and the parent passes", async () => {
  const ev = (active: boolean): ElectronEvidence => ({ channels: { t3code: { runtime: ["t3code", "t3code-electron-nixpkgs", "desktop-smoke-electron-nixpkgs"],
    bundled: [], passed: [], forcedNotApplicable: false, active, pair: null } }, smokes: {}, dependsOn: {}, confirmed: [], smokeRan: true });
  const checks = { "t3code-electron-nixpkgs": { out: "/o/n", drv: "/d/n2.drv" }, t3code: { out: "/o/w", drv: "/d/w.drv" } };
  const parent = { "t3code-electron-nixpkgs": { out: "/o/n", drv: "/d/n1.drv" }, t3code: { out: "/o/w", drv: "/d/w.drv" } };
  const failed = ["t3code", "t3code-electron-nixpkgs", "desktop-smoke-electron-nixpkgs", "codex"];
  const asked: string[] = [];
  // t3code unchanged: reported without asking; the forced check changed: the parent's passes, so it counts.
  assert.deepEqual(await branchElectronReported(ev(true), failed, checks, parent, async (n) => (asked.push(n), true)), ["t3code"]);
  assert.deepEqual(asked, ["t3code-electron-nixpkgs", "desktop-smoke-electron-nixpkgs"]);
  // The parent's fails too: reported.
  assert.deepEqual(await branchElectronReported(ev(true), failed, checks, parent, async () => false),
    ["desktop-smoke-electron-nixpkgs", "t3code", "t3code-electron-nixpkgs"]);
  // No active entry: nothing reported.
  assert.deepEqual(await branchElectronReported(ev(false), failed, checks, parent, async () => false), []);
});

// ---- narrowing ---------------------------------------------------------------

const inputs: candidate.Input[] = [{ name: "t3code", files: [], from: "0.1.9", to: "0.1.10" }, { name: "codex", files: [], from: "1", to: "2" }];
/** A result file for a set on one system, with Electron evidence for t3code. */
function result(set: string, system: string, failed: string[], r: { active?: boolean; bundledOk?: boolean; smokeRan?: boolean; pair?: object; dependsOn?: object; confirmed?: string[] } = {}) {
  const runtime = runtimeList("t3code", true, true);
  const bundled = ["t3code-electron-bundled", "desktop-smoke-electron-bundled"];
  writeFileSync(join(tmp, `${set}-${system}.json`), JSON.stringify({ set, system, passed: failed.length === 0, failed, checked: [], notes: [],
    electron: { channels: { t3code: { runtime, bundled, passed: [...runtime.filter((n) => !failed.includes(n)), ...(r.bundledOk === false ? [] : bundled)],
      forcedNotApplicable: false, active: r.active ?? false, pair: r.pair ?? pairFor("0.1.10", REV) } },
      smokes: {}, dependsOn: r.dependsOn ?? {}, confirmed: r.confirmed ?? [], smokeRan: r.smokeRan ?? true } }));
}
const both = (set: string, failed: string[], r: Parameters<typeof result>[3] = {}) => SYSTEMS.forEach((s) => result(set, s, failed, r));

test("narrow: a set failing only on the nixpkgs runtime passes with a fallback; anything else doesn't", () => {
  both("candidate", ["desktop-smoke", "t3code-electron-nixpkgs"]);
  assert.deepEqual(narrow.fallbackOf(narrow.load(tmp), "candidate"), ["t3code"]);
  assert.deepEqual(narrow.plan(inputs, narrow.load(tmp)), [], "the final is every input; nothing alone");
  // A failure that depends on a listed app counts only once it passed on bundled.
  both("candidate", ["preview-browser-pin"], { dependsOn: { "preview-browser-pin": ["t3code"] }, confirmed: ["preview-browser-pin"] });
  assert.deepEqual(narrow.fallbackOf(narrow.load(tmp), "candidate"), ["t3code"]);
  both("candidate", ["preview-browser-pin"], { dependsOn: { "preview-browser-pin": ["t3code"] } });
  assert.equal(narrow.fallbackOf(narrow.load(tmp), "candidate"), null, "failing on bundled too: ordinary");
  // Not when: something else fails, a bundled twin failed, the smoke didn't run, a system is missing.
  both("candidate", ["desktop-smoke", "codex"]);
  assert.equal(narrow.fallbackOf(narrow.load(tmp), "candidate"), null);
  both("candidate", ["desktop-smoke"], { bundledOk: false });
  assert.equal(narrow.fallbackOf(narrow.load(tmp), "candidate"), null);
  both("candidate", ["t3code"], { smokeRan: false });
  assert.equal(narrow.fallbackOf(narrow.load(tmp), "candidate"), null);
  rmSync(join(tmp, "candidate-aarch64-linux.json"));
  result("candidate", "x86_64-linux", ["desktop-smoke"]);
  assert.equal(narrow.fallbackOf(narrow.load(tmp), "candidate"), null);
});

test("narrow: an active entry makes its channel's runtime failures passes, in any set", () => {
  both("candidate", ["desktop-smoke-electron-nixpkgs", "t3code-electron-nixpkgs"], { active: true });
  assert.equal(narrow.passed(narrow.load(tmp), "candidate"), true);
  assert.equal(narrow.plan(inputs, narrow.load(tmp)), null);
});

test("decide: the shortcut finals every input with the candidate's fallback", () => {
  both("candidate", ["desktop-smoke"]);
  assert.deepEqual(narrow.decide(inputs, narrow.load(tmp)), { final: ["t3code", "codex"], electron: ["t3code"], observations: [] });
});

test("decide: a fallback only for the final tree's tested pair; the runtime-only input is never held", () => {
  both("main", []);
  both("t3code", ["desktop-smoke"], { pair: pairFor("0.1.10", REV) });
  both("codex", ["codex"]);
  const finalPair = () => pairFor("0.1.10", REV);
  let d = narrow.decide(inputs, narrow.load(tmp), new Map(), finalPair);
  assert.deepEqual([d.final, d.electron], [["t3code"], ["t3code"]]);
  assert.deepEqual(d.observations.filter((o) => o.kind === "test-failed").map((o) => o.package), ["codex"]);
  // With a nixpkgs bump in the final, the pair 0.1.10 + new nixpkgs was never tested: no fallback.
  d = narrow.decide(inputs, narrow.load(tmp), new Map(), () => pairFor("0.1.10", REV2));
  assert.deepEqual([d.final, d.electron], [["t3code"], []]);
});

test("verdict: a final's runtime failure without an entry in its tree is update-failed; published sets report the issue", () => {
  for (const s of SYSTEMS) writeFileSync(join(tmp, `tree-final-${s}.txt`), "t");
  both("final", ["desktop-smoke"]);
  let v = narrow.verdict(inputs, tmp, "final", ["t3code"]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.observations.map((o) => o.kind), ["update-failed"]);
  assert.match(v.observations[0].detail, /runtime failed for t3code, which the tested tree has no fallback for/);
  // With the entry in the tested tree: published, and the issue is reported.
  both("final", ["desktop-smoke-electron-nixpkgs", "t3code-electron-nixpkgs"], { active: true });
  v = narrow.verdict(inputs, tmp, "final", ["t3code"]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.guard.map((o) => [o.kind, o.package, o.detail]), [["electron-fallback", "t3code", `nixpkgs ${REV.slice(0, 12)}`]]);
  // No entry and the nixpkgs runtime passed: electron-ok.
  both("final", []);
  assert.deepEqual(narrow.verdict(inputs, tmp, "final", ["t3code"]).guard.map((o) => o.kind), ["electron-ok"]);
});

// ---- the resolve job and the issues ------------------------------------------

test("resolve: main's file says which channels are on a fallback, every run", () => {
  commit({ ...base, [FALLBACK_FILE]: canonical({ t3code: pairFor("0.1.9", REV) }) });
  const r = new Report();
  electronFallbackChecks(r, (p) => (existsSync(join(tmp, p)) ? readFileSync(join(tmp, p), "utf8") : null));
  assert.deepEqual(r.observations.map((o) => [o.kind, o.package, o.detail]),
    [["electron-fallback", "t3code", `nixpkgs ${REV.slice(0, 12)}`], ["electron-ok", "t3code-nightly", ""]]);
  // A channel with no pin on main says nothing either way.
  const none = new Report();
  electronFallbackChecks(none, (p) => (p === "versions/t3code-nightly.json" || !existsSync(join(tmp, p)) ? null : readFileSync(join(tmp, p), "utf8")));
  assert.deepEqual(none.observations.map((o) => [o.kind, o.package]), [["electron-fallback", "t3code"]]);
});

test("issues: electron-fallback opens per channel and closes on electron-ok for that channel", async () => {
  const gh = new Fake();
  const now = new Date(Date.UTC(2026, 10, 14, 12));
  await issues.apply([obs("electron-fallback", "t3code", null, "nixpkgs aaaa"), obs("electron-fallback", "t3code-nightly", null, "nixpkgs aaaa")], gh, now);
  await issues.apply([obs("electron-ok", "t3code")], gh, new Date(now.getTime() + 3600_000));
  assert.deepEqual(gh.issueList.map((i) => i.state), ["closed", "open"]);
  assert.equal(issues.heldVersions(gh.issueList).length, 0, "nothing held");
});

test("the pair a tree has", () => {
  commit(base);
  assert.deepEqual(pairOf(tmp, "t3code-nightly"), pairFor("0.2.0-n", REV));
  commit({ "versions/t3code-nightly.json": null });
  assert.equal(pairOf(tmp, "t3code-nightly"), null);
});

test("what git says about the desktop app's Electron: three wordings", async () => {
  const { electronNote } = await import("../scripts/lib/electron-fallback.ts");
  const withElectron = (v: unknown) => JSON.stringify({ ...JSON.parse(pin("t3code", "0.1.9")), electron: v }, null, 2) + "\n";
  commit({ ...base, "versions/t3code.json": withElectron("44.10.1") });
  assert.equal(electronNote(tmp, "t3code"), "Electron: bundled 44.10.1; nixpkgs' newer patch of 44 is used when available");
  commit({ [FALLBACK_FILE]: canonical({ t3code: pairFor("0.1.9", REV) }) });
  assert.equal(electronNote(tmp, "t3code"), "Electron: bundled 44.10.1 (nixpkgs' failed this release's tests)");
  commit({ "versions/t3code.json": withElectron(null), [FALLBACK_FILE]: null });
  assert.equal(electronNote(tmp, "t3code"), "Electron: bundled (version not recorded)");
  const { electronLine } = await import("../scripts/ci/reconcile.ts");
  assert.match(electronLine(git("rev-parse", "HEAD"))[0], /^Electron: bundled \(version not recorded\) \(`electron = "bundled"` forces it; see the README\)\.$/);
  const { rows } = await import("../scripts/status.ts");
  commit({ "versions/t3code.json": withElectron("44.10.1") });
  assert.match(rows().find((r) => r.name === "t3code")!.electron!, /^Electron: bundled 44\.10\.1; nixpkgs'/);
  assert.equal(rows().find((r) => r.name === "flake")?.electron, undefined);
});

test("narrow: active entries come from the trusted tree, and only the channel's fixed roles count", () => {
  // The runner claims an active entry and lists codex as a runtime check.
  for (const sys of SYSTEMS) {
    const runtime = [...runtimeList("t3code", true, true), "codex"];
    writeFileSync(join(tmp, `final-${sys}.json`), JSON.stringify({ set: "final", system: sys, passed: false, failed: ["codex", "desktop-smoke"], checked: [], notes: [],
      // The bundled twins passed, so only the role filter keeps codex out.
      electron: { channels: { t3code: { runtime, bundled: ["t3code-electron-bundled", "desktop-smoke-electron-bundled"],
        passed: ["t3code-electron-bundled", "desktop-smoke-electron-bundled"], forcedNotApplicable: false, active: true, pair: pairFor("0.1.10", REV) } },
        smokes: {}, dependsOn: {}, confirmed: [], smokeRan: true } }));
  }
  const trustNone: narrow.Trusted = () => ({ active: [], read: () => null });
  let sets = narrow.load(tmp, trustNone);
  assert.deepEqual([...sets.get("final")!.failed].sort(), ["codex", "desktop-smoke"], "no active entry in the tree: nothing accepted");
  assert.equal(narrow.fallbackOf(sets, "final"), null, "codex is never a runtime check");
  const trustT3: narrow.Trusted = () => ({ active: ["t3code"], read: (p) => (p === "versions/t3code.json" ? pin("t3code", "0.1.10") : p === "flake.lock" ? lock(REV2) : null) });
  sets = narrow.load(tmp, trustT3);
  assert.deepEqual([...sets.get("final")!.failed].sort(), ["codex", "desktop-smoke"],
    "under an active entry auto is bundled: its app's smoke is never excused, nor codex");
  // Only the forced nixpkgs check and its smoke are.
  for (const sys of SYSTEMS) {
    writeFileSync(join(tmp, `final-${sys}.json`), JSON.stringify({ set: "final", system: sys, passed: false,
      failed: ["t3code-electron-nixpkgs", "desktop-smoke-electron-nixpkgs", "t3code-unwrapped"], checked: [], notes: [],
      electron: { channels: { t3code: { runtime: runtimeList("t3code", true, true), bundled: ["t3code-electron-bundled", "desktop-smoke-electron-bundled"],
        passed: [], forcedNotApplicable: false, active: true, pair: pairFor("0.1.10", REV) } }, smokes: {}, dependsOn: {}, confirmed: [], smokeRan: true } }));
  }
  assert.deepEqual([...narrow.load(tmp, trustT3).get("final")!.failed], ["t3code-unwrapped"]);
  // The issue's detail comes from the tree, not the runner's pair.
  both("final", [], { active: false });
  for (const s of SYSTEMS) writeFileSync(join(tmp, `tree-final-${s}.txt`), "t");
  const v = narrow.verdict(inputs, tmp, "final", ["t3code"], trustT3);
  assert.deepEqual(v.guard.map((o) => [o.kind, o.detail]), [["electron-fallback", `nixpkgs ${REV2.slice(0, 12)}`]]);
});

test("decide: main failing only on the nixpkgs runtime isn't env-broken; the inputs' failures are held", () => {
  both("main", ["desktop-smoke"]);
  both("t3code", ["codex"]);
  both("codex", ["codex"]);
  const d = narrow.decide(inputs, narrow.load(tmp));
  assert.ok(!d.observations.some((o) => o.kind === "env-broken"));
  assert.deepEqual(d.observations.filter((o) => o.kind === "test-failed").map((o) => o.package).sort(), ["codex", "t3code"]);
});

test("decide: no shortcut when plan asked for narrowing (the NixOS-stable rule) and its results are missing", () => {
  const ins = [...inputs, { name: "nixpkgs-stable", files: [], from: "r1", to: "r2" }];
  both("candidate", ["desktop-smoke"]);
  // The candidate's stable group failed: plan narrows instead of the shortcut.
  for (const s of SYSTEMS) writeFileSync(join(tmp, `stable-candidate-${s}.json`), JSON.stringify({ set: "candidate", system: s, tree: "a".repeat(40),
    stable: { complete: true, failed: ["stable-unit"] }, drvs: "d", base: "d", behind: false }));
  const st = narrow.loadStable(tmp);
  assert.notDeepEqual(narrow.plan(ins, narrow.load(tmp), st), []);
  const d = narrow.decide(ins, narrow.load(tmp), st);
  assert.notDeepEqual(d.final, ins.map((i) => i.name), "missing narrowing results don't admit every input");
});

test("an ordinary failure that only builds on the desktop app narrows as usual: innocent inputs aren't held", () => {
  // t3code 0.1.10 breaks preview-browser-pin on any Electron.
  both("candidate", ["preview-browser-pin"], { dependsOn: { "preview-browser-pin": ["t3code"] } });
  assert.deepEqual(narrow.plan(inputs, narrow.load(tmp)), ["main", "t3code", "codex"], "no shortcut: it failed on bundled too");
  both("main", []);
  both("t3code", ["preview-browser-pin"], { dependsOn: { "preview-browser-pin": ["t3code"] } });
  both("codex", []);
  const d = narrow.decide(inputs, narrow.load(tmp));
  assert.deepEqual([d.final, d.electron], [["codex"], []]);
  assert.deepEqual(d.observations.filter((o) => o.kind === "test-failed").map((o) => o.package), ["t3code"]);
});

test("confirmProvisional: only failures that pass on bundled Electron, built once per set", async () => {
  const { confirmProvisional } = await import("../scripts/ci/test.ts");
  const asked: unknown[] = [];
  const got = await confirmProvisional({ "preview-browser-pin": ["t3code"], "speech-libs": ["t3code"], "acp-runtimes": ["t3code-nightly"] }, "x86_64-linux",
    async (channels, names) => { asked.push([channels, names]); return ["speech-libs", "codex"]; });
  assert.deepEqual(got, ["speech-libs"], "only asked names count");
  assert.deepEqual(asked, [[["t3code", "t3code-nightly"], ["preview-browser-pin", "speech-libs", "acp-runtimes"]]]);
  assert.deepEqual(await confirmProvisional({}, "x86_64-linux", async () => { throw new Error("not built"); }), []);
});

test("narrow.ts verdict on the command line: the final's --electron channels make its tree's entry active", () => {
  const cdir = join(tmp, "cand");
  mkdirSync(join(cdir, "files", "versions"), { recursive: true });
  writeFileSync(join(cdir, "files", "versions", "t3code.json"), pin("t3code", "0.1.10", "C"));
  writeFileSync(join(cdir, "inputs.json"), JSON.stringify({ base: "x", inputs: [{ name: "t3code", files: ["versions/t3code.json"], from: "0.1.9", to: "0.1.10" }] }));
  const rdir = join(tmp, "results");
  mkdirSync(rdir);
  for (const sys of SYSTEMS) {
    writeFileSync(join(rdir, `tree-final-${sys}.txt`), "t");
    writeFileSync(join(rdir, `final-${sys}.json`), JSON.stringify({ set: "final", system: sys, passed: false,
      failed: ["t3code-electron-nixpkgs", "desktop-smoke-electron-nixpkgs"], checked: [], notes: [],
      electron: { channels: { t3code: { runtime: runtimeList("t3code", false, true), bundled: ["t3code-electron-bundled", "desktop-smoke-electron-bundled"],
        passed: ["t3code-electron-bundled", "desktop-smoke-electron-bundled"], forcedNotApplicable: false, active: false, pair: null } },
        smokes: {}, dependsOn: {}, confirmed: [], smokeRan: true } }));
  }
  const script = join(cwd, "scripts", "ci", "narrow.ts");
  const run = (...extra: string[]) => JSON.parse(execFileSync(process.execPath, [script, "verdict", cdir, rdir, "final", "t3code", ...extra], { encoding: "utf8", cwd }));
  const withFallback = run("--electron=t3code");
  assert.equal(withFallback.ok, true);
  assert.deepEqual(withFallback.guard.map((o: any) => o.kind), ["electron-fallback"]);
  const without = run("--electron=");
  assert.equal(without.ok, false, "without decide's channel the forced failures aren't excused");
});

test("a check that builds on both channels' apps records both, and its fallback covers both", () => {
  commit(base);
  const c = (drv: string, electron: string | null = null) => ({ out: `/o/${drv}`, drv: `/d/${drv}.drv`, electron, na: false });
  const checks = {
    "t3code-unwrapped": c("u", "nixpkgs"), t3code: c("w", "nixpkgs"), "t3code-electron-nixpkgs": c("w", "nixpkgs"), "t3code-electron-bundled": c("b", "bundled"),
    "t3code-unwrapped-nightly": c("nu", "nixpkgs"), "t3code-nightly": c("nw", "nixpkgs"), "t3code-nightly-electron-nixpkgs": c("nw", "nixpkgs"),
    "t3code-nightly-electron-bundled": c("nb", "bundled"), "speech-libs": c("s"),
  };
  // nightly comes first in the closure, as in the real one.
  const e = electronEvidence(checks, ["speech-libs"], { "desktop-smoke": "pass" }, tmp, () => ["/d/s.drv", "/d/nu.drv", "/d/u.drv"]);
  assert.deepEqual(e.dependsOn, { "speech-libs": ["t3code", "t3code-nightly"] });
  for (const sys of SYSTEMS) {
    writeFileSync(join(tmp, `candidate-${sys}.json`), JSON.stringify({ set: "candidate", system: sys, passed: false, failed: ["speech-libs"], checked: [], notes: [],
      electron: { ...e, confirmed: ["speech-libs"], channels: Object.fromEntries(Object.entries(e.channels).map(([k, v]) => [k, { ...v, passed: [...v!.passed, ...v!.bundled] }])) } }));
  }
  assert.deepEqual(narrow.fallbackOf(narrow.load(tmp), "candidate"), ["t3code", "t3code-nightly"]);
});

test("the confirmation build: the working tree with the fallback generated for the asked channels; only a pass confirms", async () => {
  const { bundledBuild } = await import("../scripts/ci/test.ts");
  const stable = await import("../scripts/ci/stable.ts");
  commit(base);
  writeFileSync("versions/t3code.json", pin("t3code", "0.1.10", "D")); // a dirty pin: the candidate
  const saved = { ...stable.nix };
  let seen: { file: string | null; pin: string } | null = null;
  try {
    stable.nix.drvs = (dir) => {
      const f = join(dir, FALLBACK_FILE);
      seen = { file: existsSync(f) ? readFileSync(f, "utf8") : null, pin: readFileSync(join(dir, "versions/t3code.json"), "utf8") };
      return { "speech-libs": { out: "/o/s", drv: "/d/s.drv" }, "preview-browser-pin": { out: "/o/p", drv: "/d/p.drv" } };
    };
    stable.nix.outcome = (d) => (d.drv === "/d/s.drv" ? "pass" : "incomplete");
    const passed = await bundledBuild("x86_64-linux")(["t3code"], ["speech-libs", "preview-browser-pin", "acp-runtimes"]);
    assert.deepEqual(passed, ["speech-libs"], "incomplete and missing never confirm");
    assert.deepEqual(JSON.parse(seen!.file!), { t3code: pairFor("0.1.10", REV, "D") }, "the fallback for the asked channel, from the candidate");
    assert.equal(seen!.pin, pin("t3code", "0.1.10", "D"), "the working tree, not HEAD");
  } finally {
    Object.assign(stable.nix, saved);
  }
});

test("candidate.ts apply stages what it applies, so the flake sees a new pin", () => {
  commit(base);
  const dir = join(tmp, "..", `${tmp.split("/").pop()}-new`);
  makeCandidate(dir, [{ name: "boat", files: { "versions/boat.json": pin("boat", "1.0.0") } }]);
  try {
    candidate.apply(dir, "boat");
    assert.match(git("diff", "--cached", "--name-only"), /^versions\/boat\.json$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
