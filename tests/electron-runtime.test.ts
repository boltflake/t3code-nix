// The Electron record, ci/electron-runtime.json: its schema and matching, the
// record a tree gets (candidate.ts), the words the status page and the release
// notes show, and the resolve step's table (electron-runtime.ts) with the
// evaluation injected. Real git repositories in temporary folders; no Nix, no
// network.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as candidate from "../scripts/ci/candidate.ts";
import { makeTable, rowsFrom, trees, write, type Evaluate } from "../scripts/ci/electron-runtime.ts";
import { electronLine } from "../scripts/ci/reconcile.ts";
import { build, decide, rows } from "../scripts/status.ts";
import {
  bundledOf, canonical, electronInfo, electronNote, FALLBACK_FILE, fromDir, recordFor, RUNTIME_FILE, runtimeRecord, validRecord,
  validRows, validRuntime, type Row, type Runtime,
} from "../scripts/lib/electron-fallback.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

let tmp: string, cand: string;
const cwd = process.cwd();
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "electron-runtime-test-"));
  cand = `${tmp}-cand`;
  process.chdir(tmp);
  git("init", "-q", "-b", "main");
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(cand, { recursive: true, force: true });
});

const REV = "a".repeat(40), REV2 = "b".repeat(40);
const hash = (h: string, s: string) => `sha256-${(h + s).padEnd(43, "0")}=`;
const pin = (name: string, version: string, electron: unknown = "44.10.1", h = "A") =>
  JSON.stringify({ name, version, electron, assets: { "x86_64-linux": { url: "u", hash: hash(h, "x") }, "aarch64-linux": { url: "u", hash: hash(h, "a") } } }, null, 2) + "\n";
const lock = (rev: string) => JSON.stringify({ nodes: { nixpkgs: { locked: { rev } } } }, null, 2) + "\n";
const base = { "versions/t3code.json": pin("t3code", "0.1.9"), "versions/t3code-nightly.json": pin("t3code-nightly", "0.2.0-n"), "flake.lock": lock(REV) };

/** One system's entry; a pin's entries on both systems. */
const nix = (version: string, bundled: string | null = "44.10.1", rev = REV): Runtime => ({ choice: "nixpkgs", version, bundled, rev });
const own = (bundled: string | null = "44.10.1", rev = REV): Runtime => ({ choice: "bundled", version: bundled, bundled, rev });
const both = (e: Runtime, a: Runtime = e) => ({ "x86_64-linux": e, "aarch64-linux": a });
const row = (pin: "t3code" | "t3code-nightly", system: string, e: Runtime): Row => ({ pin, system, ...e });
const rowsBoth = (pin: "t3code" | "t3code-nightly", e: Runtime, a: Runtime = e) => [row(pin, "x86_64-linux", e), row(pin, "aarch64-linux", a)];

function commit(files: Record<string, string | null>) {
  for (const [p, t] of Object.entries(files)) {
    if (t === null) rmSync(p, { force: true });
    else { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); }
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "c");
}

/** A candidate in `cand` changing these files over the committed base, with
 * a table when given. */
function makeCandidate(inputs: { name: string; files: Record<string, string> }[], table?: Row[]) {
  rmSync(cand, { recursive: true, force: true });
  mkdirSync(join(cand, "files"), { recursive: true });
  for (const i of inputs) for (const [p, t] of Object.entries(i.files)) { mkdirSync(join(cand, "files", p, ".."), { recursive: true }); writeFileSync(join(cand, "files", p), t); }
  writeFileSync(join(cand, "inputs.json"), JSON.stringify({ base: git("rev-parse", "HEAD"), inputs: inputs.map((i) => ({ name: i.name, files: Object.keys(i.files), from: null, to: "x" })) }));
  if (table) writeFileSync(join(cand, candidate.TABLE_FILE), JSON.stringify(table));
}
const shown = (tree: string, path = RUNTIME_FILE) => {
  try { return git("show", `${tree}:${path}`) + "\n"; } catch { return null; }
};

// ---- the schema and matching -------------------------------------------------

test("the record's schema: exact keys, both systems, choice and versions that make sense", () => {
  assert.ok(validRuntime(nix("44.10.2")) && validRuntime(own()) && validRuntime(own(null)));
  assert.ok(!validRuntime({ ...nix("44.10.2"), extra: 1 }));
  assert.ok(!validRuntime({ ...nix("44.10.2"), choice: "package" }));
  assert.ok(!validRuntime(nix("44.10.2", null)), "nixpkgs needs a known bundled version");
  assert.ok(!validRuntime({ ...own(), version: "44.10.2" }), "bundled runs the bundled version");
  assert.ok(!validRuntime({ ...own(), bundled: "unknown", version: "unknown" }), "unknown is null, never the label");
  assert.ok(!validRuntime({ ...own(), rev: "abc" }));
  assert.ok(validRecord({ t3code: both(nix("44.10.2")) }));
  assert.ok(!validRecord({}));
  assert.ok(!validRecord({ t3: both(nix("44.10.2")) }));
  assert.ok(!validRecord({ t3code: { "x86_64-linux": nix("44.10.2") } }), "one system missing");
  assert.deepEqual(validRows([row("t3code", "x86_64-linux", own()), { pin: "t3code", system: "riscv64-linux", ...own() }, null, "x"]), [row("t3code", "x86_64-linux", own())]);
  assert.equal(bundledOf({ electron: "44.10.1" }), "44.10.1");
  for (const e of [null, "unknown", "44.10", 44]) assert.equal(bundledOf({ electron: e }), null);
});

test("an entry counts only when both systems' bundled version and revision are its tree's", () => {
  commit({ ...base, [RUNTIME_FILE]: canonical({ t3code: both(nix("44.10.2")) }) });
  assert.deepEqual(recordFor(tmp, "t3code"), both(nix("44.10.2")));
  assert.equal(recordFor(tmp, "t3code-nightly"), null, "no entry");
  commit({ [RUNTIME_FILE]: canonical({ t3code: both(nix("44.10.2"), nix("44.10.2", "44.10.0")) }) });
  assert.equal(recordFor(tmp, "t3code"), null, "one system's bundled differs");
  commit({ [RUNTIME_FILE]: canonical({ t3code: both(nix("44.10.2"), nix("44.10.2", "44.10.1", REV2)) }) });
  assert.equal(recordFor(tmp, "t3code"), null, "one system's revision differs");
  commit({ [RUNTIME_FILE]: canonical({ t3code: both(nix("44.10.2")) }), "flake.lock": lock(REV2) });
  assert.equal(recordFor(tmp, "t3code"), null, "the lock moved on");
  commit({ [RUNTIME_FILE]: "{ not json", "flake.lock": lock(REV) });
  assert.equal(recordFor(tmp, "t3code"), null, "malformed");
  commit({ [RUNTIME_FILE]: JSON.stringify({ t3code: { "x86_64-linux": nix("44.10.2") } }) });
  assert.equal(recordFor(tmp, "t3code"), null, "one system missing");
});

// ---- the words ----------------------------------------------------------------

test("the words: the version and its source, the fallback per system, both systems when they differ", () => {
  const words = (record: object | null, files: Record<string, string | null> = {}) => {
    commit({ ...base, [RUNTIME_FILE]: record ? canonical(record) : null, [FALLBACK_FILE]: null, ...files });
    return electronNote(tmp, "t3code");
  };
  assert.equal(words({ t3code: both(nix("44.10.2")) }), "Electron 44.10.2 (nixpkgs)");
  assert.equal(words({ t3code: both(own()) }), "Electron 44.10.1 (bundled)");
  assert.equal(words({ t3code: both(own(null)) }, { "versions/t3code.json": pin("t3code", "0.1.9", null) }), "Electron (bundled; version not recorded)");
  assert.equal(words({ t3code: both(nix("44.10.2"), own()) }), "Electron 44.10.2 (nixpkgs) on x86_64-linux, 44.10.1 (bundled) on aarch64-linux");
  // An active fallback: where nixpkgs' was chosen it failed; where bundled
  // was chosen anyway, nothing failed there.
  const fallback = canonical({ t3code: { version: "0.1.9", assets: { "aarch64-linux": hash("A", "a"), "x86_64-linux": hash("A", "x") }, nixpkgs: REV } });
  assert.equal(words({ t3code: both(nix("44.10.2")) }, { [FALLBACK_FILE]: fallback }), "Electron 44.10.1 (bundled; nixpkgs' 44.10.2 failed this release's tests)");
  assert.equal(words({ t3code: both(nix("44.10.2"), own()) }, { [FALLBACK_FILE]: fallback }),
    "Electron 44.10.1 (bundled; nixpkgs' 44.10.2 failed this release's tests) on x86_64-linux, 44.10.1 (bundled) on aarch64-linux");
  // No record that matches: what git alone says.
  assert.equal(words(null), "Electron: bundled 44.10.1; nixpkgs' newer patch of 44 is used when available");
  assert.equal(words({ t3code: both(nix("44.10.2", "44.10.1", REV2)) }), "Electron: bundled 44.10.1; nixpkgs' newer patch of 44 is used when available");
  assert.equal(electronInfo(tmp, "t3code-nightly")?.recorded, false);
});

test("the release notes and the status page use the words, and the notes name upstream's version", () => {
  commit({ ...base, [RUNTIME_FILE]: canonical({ t3code: both(nix("44.10.2")) }) });
  const recorded = git("rev-parse", "HEAD");
  assert.deepEqual(electronLine(recorded), ["Electron 44.10.2 (nixpkgs); `electron = \"bundled\"` forces upstream's 44.10.1 (see the README).", ""]);
  assert.equal(rows().find((r) => r.name === "t3code")!.electron, "Electron 44.10.2 (nixpkgs)");
  commit({ "versions/t3code.json": pin("t3code", "0.1.9", null), [RUNTIME_FILE]: canonical({ t3code: both(own(null)) }) });
  assert.equal(electronLine(git("rev-parse", "HEAD"))[0], "Electron (bundled; version not recorded); `electron = \"bundled\"` forces upstream's bundled Electron (see the README).");
  // An old commit's notes read that commit's record, whatever came later.
  commit({ [RUNTIME_FILE]: null, "versions/t3code.json": pin("t3code", "0.1.9") });
  assert.equal(electronLine(recorded)[0], "Electron 44.10.2 (nixpkgs); `electron = \"bundled\"` forces upstream's 44.10.1 (see the README).");
  assert.equal(electronLine(git("rev-parse", "HEAD"))[0], "Electron: bundled 44.10.1; nixpkgs' newer patch of 44 is used when available (`electron = \"bundled\"` forces it; see the README).");
});

test("status page: new words change the data id and digest and deploy during a failed live read; a rebuild deploys nothing", () => {
  commit({ ...base, [RUNTIME_FILE]: canonical({ t3code: both(nix("44.10.2")) }) });
  const site = (dir: string) => { build(dir); return JSON.parse(readFileSync(join(dir, "status.json"), "utf8")); };
  const a = site(join(tmp, "out-a")), again = site(join(tmp, "out-b"));
  assert.match(readFileSync(join(tmp, "out-a", "index.html"), "utf8"), /<p class="electron">Electron 44\.10\.2 \(nixpkgs\)<\/p>/, "the row shows it");
  assert.equal(again.digest, a.digest);
  assert.deepEqual(decide(again, a, false), { deploy: false, fail: false });
  commit({ [RUNTIME_FILE]: canonical({ t3code: both(own()) }) });
  const b = site(join(tmp, "out-c"));
  assert.notEqual(b.id, a.id);
  assert.notEqual(b.digest, a.digest);
  assert.deepEqual(decide(b, a, true), { deploy: true, fail: false }, "git-derived");
});

// ---- the record a tree gets ---------------------------------------------------------

test("runtimeRecord: the base's record for a tree that changes neither pin nor lock; fresh entries where the table covers", () => {
  commit({ ...base, [RUNTIME_FILE]: canonical({ t3code: both(own()), "t3code-nightly": both(own()) }) });
  const baseRead = fromDir(tmp);
  const over = (files: Record<string, string>) => (p: string) => files[p] ?? baseRead(p);
  const table = [...rowsBoth("t3code", nix("44.10.2", "44.10.1", REV2)), ...rowsBoth("t3code-nightly", nix("44.10.2", "44.10.1", REV2))];
  assert.equal(runtimeRecord(baseRead, baseRead, table), undefined, "unchanged: left as it is");
  assert.equal(runtimeRecord(over({ "versions/codex.json": "{}" }), baseRead, table), undefined, "another pin only");
  assert.deepEqual(JSON.parse(runtimeRecord(over({ "flake.lock": lock(REV2) }), baseRead, table)!),
    { t3code: both(nix("44.10.2", "44.10.1", REV2)), "t3code-nightly": both(nix("44.10.2", "44.10.1", REV2)) });
  // Not covered (on one system): that pin keeps the base's entries.
  assert.deepEqual(JSON.parse(runtimeRecord(over({ "flake.lock": lock(REV2) }), baseRead, table.slice(0, 3))!),
    { t3code: both(nix("44.10.2", "44.10.1", REV2)), "t3code-nightly": both(own()) });
  // A pin that's gone takes its entries with it; nothing left, no file.
  const gone = (p: string) => (p === "versions/t3code-nightly.json" ? null : baseRead(p));
  assert.deepEqual(Object.keys(JSON.parse(runtimeRecord(gone, baseRead, [])!)), ["t3code"]);
  commit({ [RUNTIME_FILE]: null });
  assert.equal(runtimeRecord(over({ "flake.lock": lock(REV2) }), fromDir(tmp), []), null);
});

test("candidate.ts: tree and apply write the same record, with and without fallback channels, for every narrowing", () => {
  commit({ ...base, [RUNTIME_FILE]: canonical({ t3code: both(nix("44.10.2")), "t3code-nightly": both(nix("44.10.2")) }) });
  const table = [
    ...rowsBoth("t3code", nix("44.11.1", "44.11.0")), ...rowsBoth("t3code", own("44.11.0", REV2)),
    ...rowsBoth("t3code", nix("44.10.2", "44.10.1", REV2)), ...rowsBoth("t3code-nightly", nix("44.10.2", "44.10.1", REV2)),
    ...rowsBoth("t3code", nix("44.10.2")), ...rowsBoth("t3code-nightly", nix("44.10.2")),
    ...rowsBoth("t3code-nightly", own("45.0.0")), ...rowsBoth("t3code-nightly", own("45.0.0", REV2)),
  ];
  makeCandidate([
    { name: "codex", files: { "versions/codex.json": "{}\n" } },
    { name: "nixpkgs", files: { "flake.lock": lock(REV2) } },
    { name: "t3code", files: { "versions/t3code.json": pin("t3code", "0.1.10", "44.11.0", "C") } },
    { name: "t3code-nightly", files: { "versions/t3code-nightly.json": pin("t3code-nightly", "0.2.1-n", "45.0.0", "D") } },
  ], table);
  // Each pin's entries follow its own pin and the lock.
  const entries = (names: string[]) => {
    const bump = names.includes("nixpkgs"), rev = bump ? REV2 : REV;
    const t3 = names.includes("t3code") ? (bump ? own("44.11.0", REV2) : nix("44.11.1", "44.11.0")) : nix("44.10.2", "44.10.1", rev);
    const nightly = names.includes("t3code-nightly") ? own("45.0.0", rev) : nix("44.10.2", "44.10.1", rev);
    return { t3code: both(t3), "t3code-nightly": both(nightly) };
  };
  const baseText = readFileSync(RUNTIME_FILE, "utf8");
  const all = ["codex", "nixpkgs", "t3code", "t3code-nightly"];
  for (let mask = 1; mask < 1 << all.length; mask++) {
    const names = all.filter((_, i) => mask & (1 << i));
    for (const electron of [[], ["t3code"]] as const) {
      const t = candidate.tree(cand, names.join(","), [...electron]);
      if (names.join() === "codex") assert.equal(shown(t), baseText, "codex alone: the base's bytes");
      else assert.equal(shown(t), canonical(entries(names)), names.join());
      candidate.apply(cand, names.join(","), [...electron]);
      // apply staged everything itself: the index is the tree.
      assert.equal(git("write-tree"), t, `apply writes what tree hashed (${names.join()}, ${electron.join(",") || "no fallback"})`);
      git("reset", "-q", "--hard");
      git("clean", "-qfd", "--", "versions", "ci");
    }
  }
});

test("candidate.ts apply stages a record that's new, and a table that doesn't parse counts as none", () => {
  commit(base);
  makeCandidate([{ name: "nixpkgs", files: { "flake.lock": lock(REV2) } }], [...rowsBoth("t3code", own("44.10.1", REV2)), ...rowsBoth("t3code-nightly", own("44.10.1", REV2))]);
  candidate.apply(cand, "nixpkgs");
  assert.match(git("diff", "--cached", "--name-only"), /ci\/electron-runtime\.json/);
  assert.equal(git("write-tree"), candidate.tree(cand, "nixpkgs"));
  git("reset", "-q", "--hard");
  git("clean", "-qfd", "--", "ci");
  writeFileSync(join(cand, candidate.TABLE_FILE), "[{ cut sho");
  assert.equal(shown(candidate.tree(cand, "nixpkgs")), null, "no table, no base record: no file");
  candidate.apply(cand, "nixpkgs");
  assert.equal(git("diff", "--cached", "--name-only"), "flake.lock");
});

test("candidate.ts: without a table (or a tree it doesn't cover) the base's entries stay; checkout writes no record", () => {
  commit({ ...base, [RUNTIME_FILE]: canonical({ t3code: both(nix("44.10.2")) }) });
  makeCandidate([{ name: "nixpkgs", files: { "flake.lock": lock(REV2) } }, { name: "t3code-nightly", files: { "versions/t3code-nightly.json": pin("t3code-nightly", "0.2.1-n") } }]);
  assert.equal(shown(candidate.tree(cand, "nixpkgs")), canonical({ t3code: both(nix("44.10.2")) }));
  // checkout: exactly the base plus the inputs, a new pin included; the record untouched.
  commit({ "versions/t3code-nightly.json": null });
  makeCandidate([{ name: "nixpkgs", files: { "flake.lock": lock(REV2) } }, { name: "t3code-nightly", files: { "versions/t3code-nightly.json": pin("t3code-nightly", "0.2.1-n") } }],
    [...rowsBoth("t3code", nix("44.10.2", "44.10.1", REV2)), ...rowsBoth("t3code-nightly", nix("44.10.2", "44.10.1", REV2))]);
  for (const [names, nightly, rev] of [[["t3code-nightly"], true, REV], [["nixpkgs"], false, REV2], [[], false, REV]] as const) {
    const target = join(cand, `co-${names.join("-") || "base"}`);
    writeFileSync(`${target}.tar`, "someone else's");
    candidate.checkout(cand, [...names], target);
    assert.equal(readFileSync(`${target}.tar`, "utf8"), "someone else's", "nothing beside the target is touched");
    assert.equal(existsSync(join(target, "versions/t3code-nightly.json")), nightly);
    assert.equal(JSON.parse(readFileSync(join(target, "flake.lock"), "utf8")).nodes.nixpkgs.locked.rev, rev);
    assert.equal(readFileSync(join(target, RUNTIME_FILE), "utf8"), canonical({ t3code: both(nix("44.10.2")) }), "the base's record, not regenerated");
  }
});

// ---- the resolve step's table ----------------------------------------------------

/** An evaluation that answers per tree from its flake.lock and pins: nixpkgs
 * 44.10.2 at REV, none at REV2; fails as `fail` says. */
const evaluator = (fail: (rev: string, calls: number) => boolean = () => false) => {
  const calls: string[] = [], limits: number[] = [];
  const evaluate: Evaluate = (flake, ms) => {
    const dir = flake.replace(/^path:/, "");
    calls.push(dir);
    limits.push(ms);
    const rev = JSON.parse(readFileSync(join(dir, "flake.lock"), "utf8")).nodes.nixpkgs.locked.rev;
    if (fail(rev, calls.length)) throw new Error("error: evaluation aborted\nerror: out of memory");
    const per = (p: string) => {
      const f = join(dir, `versions/${p}.json`);
      if (!existsSync(f)) return null;
      const b = bundledOf(JSON.parse(readFileSync(f, "utf8")));
      // A bundled choice's version is the pin's `electron` as it is, as the
      // package's passthru has it.
      return rev === REV && b !== null ? { choice: "nixpkgs", version: "44.10.2" } : { choice: "bundled", version: JSON.parse(readFileSync(f, "utf8")).electron ?? null };
    };
    return Object.fromEntries(["x86_64-linux", "aarch64-linux"].map((s) => [s, { t3code: per("t3code"), "t3code-nightly": per("t3code-nightly") }]));
  };
  return { evaluate, calls, limits };
};
const table = () => JSON.parse(readFileSync(join(cand, candidate.TABLE_FILE), "utf8")) as Row[];

test("the step's trees: a pin, the bump, both or neither, the whole candidate first", () => {
  commit(base);
  const names = (inputs: string[]) => { makeCandidate(inputs.map((n) => ({ name: n, files: n === "nixpkgs" ? { "flake.lock": lock(REV2) } : { [`versions/${n}.json`]: "{}\n" } }))); return trees(cand); };
  assert.deepEqual(names(["codex"]), [], "a run without the Desktop app evaluates nothing");
  assert.deepEqual(names(["t3code"]), [["t3code"], []]);
  assert.deepEqual(names(["nixpkgs"]), [["nixpkgs"], []]);
  assert.deepEqual(names(["codex", "nixpkgs", "t3code", "t3code-nightly"]), [["t3code", "t3code-nightly", "nixpkgs"], ["t3code", "t3code-nightly"], ["nixpkgs"], []]);
  const { evaluate, calls } = evaluator();
  makeCandidate([{ name: "codex", files: { "versions/codex.json": "{}\n" } }]);
  assert.deepEqual(makeTable(cand, { evaluate }), []);
  assert.deepEqual([calls.length, table()], [0, []]);
});

test("the step's trees come after held inputs: a held Desktop app pin is never evaluated", () => {
  commit(base);
  const held = join(tmp, "..", `${tmp.split("/").pop()}-held.json`);
  const env = process.env.HELD_JSON;
  try {
    writeFileSync(held, JSON.stringify([{ package: "t3code", version: "0.1.10" }]));
    process.env.HELD_JSON = held;
    writeFileSync("versions/t3code.json", pin("t3code", "0.1.10", "44.11.0"));
    writeFileSync("flake.lock", lock(REV2));
    assert.deepEqual(candidate.make(cand), ["nixpkgs"]);
    assert.deepEqual(trees(cand), [["nixpkgs"], []]);
    // Everything held: a retry run tests (and evaluates) them all.
    writeFileSync(held, JSON.stringify([{ package: "t3code", version: "0.1.10" }, { package: "nixpkgs", version: REV2 }]));
    writeFileSync("versions/t3code.json", pin("t3code", "0.1.10", "44.11.0"));
    rmSync(cand, { recursive: true, force: true });
    assert.deepEqual(candidate.make(cand), ["nixpkgs", "t3code"]);
    assert.deepEqual(trees(cand), [["t3code", "nixpkgs"], ["t3code"], ["nixpkgs"], []]);
  } finally {
    if (env === undefined) delete process.env.HELD_JSON; else process.env.HELD_JSON = env;
    rmSync(held, { force: true });
  }
});

test("the step: a table every tree's record comes from; a tree with nothing new isn't evaluated again", () => {
  commit(base);
  makeCandidate([{ name: "nixpkgs", files: { "flake.lock": lock(REV2) } }, { name: "t3code", files: { "versions/t3code.json": pin("t3code", "0.1.10") } }]);
  const { evaluate, calls } = evaluator();
  const summary = makeTable(cand, { evaluate });
  // The candidate's t3code has the same bundled version as main's: two trees cover every pair.
  assert.equal(calls.length, 2);
  assert.deepEqual(summary, ["Electron record: evaluated main with t3code, nixpkgs.", "Electron record: evaluated main with t3code."]);
  assert.equal(table().length, 8);
  assert.equal(shown(candidate.tree(cand, "t3code")), canonical({ t3code: both(nix("44.10.2")), "t3code-nightly": both(nix("44.10.2")) }));
  assert.equal(shown(candidate.tree(cand, null)), canonical({ t3code: both(own("44.10.1", REV2)), "t3code-nightly": both(own("44.10.1", REV2)) }));
});

test("the step: one failure is retried; two leave that tree out, named, its trees keeping the base's record, and nothing fails", () => {
  commit({ ...base, [RUNTIME_FILE]: canonical({ t3code: both(nix("44.10.2")) }) });
  makeCandidate([{ name: "nixpkgs", files: { "flake.lock": lock(REV2) } }]);
  const once = evaluator((rev, n) => rev === REV2 && n === 1);
  makeTable(cand, { evaluate: once.evaluate });
  assert.equal(once.calls.length, 3, "the bump twice, then main");
  assert.equal(table().length, 8);
  const twice = evaluator((rev) => rev === REV2);
  const summary = makeTable(cand, { evaluate: twice.evaluate });
  assert.equal(twice.calls.length, 3);
  assert.deepEqual(summary, ["Electron record: couldn't evaluate main with nixpkgs (error: out of memory); a tree like it keeps its earlier record.", "Electron record: evaluated main."]);
  assert.equal(shown(candidate.tree(cand, "nixpkgs")), canonical({ t3code: both(nix("44.10.2")) }), "the base's entries, ignored as stale");
  // Each attempt gets its limit, or what's left of the budget; once that's
  // gone, nothing more is tried (no checkout either).
  let clock = 0;
  const late = evaluator();
  const summary2 = makeTable(cand, { evaluate: (f, ms) => { clock += 6 * 60e3; return late.evaluate(f, ms); }, now: () => clock });
  assert.deepEqual(late.limits, [4 * 60e3, 4 * 60e3]);
  assert.deepEqual(summary2, ["Electron record: evaluated main with nixpkgs.", "Electron record: evaluated main."]);
  clock = 0;
  const slow = evaluator(() => true);
  assert.deepEqual(makeTable(cand, { evaluate: (f, ms) => { clock += 3 * 60e3; return slow.evaluate(f, ms); }, now: () => clock }), [
    "Electron record: couldn't evaluate main with nixpkgs (error: out of memory); a tree like it keeps its earlier record.",
    "Electron record: couldn't evaluate main (error: out of memory); a tree like it keeps its earlier record.",
  ]);
  assert.deepEqual(slow.limits, [4 * 60e3, 4 * 60e3, 4 * 60e3, 60e3], "the bump twice, main's retry with the minute left");
  clock = 0;
  const none = evaluator(() => true);
  makeTable(cand, { evaluate: (f, ms) => { clock += 6 * 60e3; return none.evaluate(f, ms); }, now: () => clock });
  assert.equal(none.calls.length, 2, "the bump twice, then no time for main");
});

test("the step: an evaluation that doesn't make sense is a failure; an unknown bundled version is null throughout", () => {
  commit({ ...base, "versions/t3code.json": pin("t3code", "0.1.9", "unknown") });
  const read = fromDir(tmp);
  assert.throws(() => rowsFrom({ "x86_64-linux": { t3code: { choice: "nixpkgs", version: "44.10.2" } } }, read), /t3code on x86_64-linux/);
  assert.throws(() => rowsFrom({}, read));
  makeCandidate([{ name: "nixpkgs", files: { "flake.lock": lock(REV2) } }]);
  makeTable(cand, { evaluate: evaluator().evaluate });
  const t = candidate.tree(cand, "nixpkgs");
  const record = JSON.parse(shown(t)!);
  assert.deepEqual(record.t3code, both(own(null, REV2)));
  assert.ok(validRecord(record));
  git("read-tree", t);
  git("checkout-index", "-a", "-f");
  assert.equal(electronNote(tmp, "t3code"), "Electron (bundled; version not recorded)");
});

test("write: the record for this checkout, from one evaluation", () => {
  commit(base);
  write(() => evaluator().evaluate(`path:${tmp}`, 0), tmp);
  assert.equal(readFileSync(join(tmp, RUNTIME_FILE), "utf8"), canonical({ t3code: both(nix("44.10.2")), "t3code-nightly": both(nix("44.10.2")) }));
  assert.throws(() => write(() => { throw new Error("no nix"); }, tmp));
  // Not the root (no pins there): an error, never a silent nothing.
  mkdirSync(join(tmp, "scripts"));
  assert.throws(() => write(() => evaluator().evaluate(`path:${tmp}`, 0), join(tmp, "scripts")), /repository's root/);
});
