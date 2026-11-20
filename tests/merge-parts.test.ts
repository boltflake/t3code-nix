// merge-parts.ts: the update runs' part results as the whole-suite files
// narrow.ts, publish and the cache job read.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { merge, mergeElectron } from "../scripts/ci/merge-parts.ts";
import { load, loadStable } from "../scripts/ci/narrow.ts";
import { STABLE_PARTS, TEST_PARTS } from "../scripts/lib/parts.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "merge-parts-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SYS = "x86_64-linux";
const put = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const quiet = () => {};
const TREE = "a".repeat(40);

function testParts(over: Record<string, object> = {}) {
  for (const p of TEST_PARTS) {
    put(`candidate-${SYS}-${p}.json`, { set: "candidate", system: SYS, passed: true, failed: [], checked: [], notes: [], nixCalls: [{ part: p }], ...over[p] });
    put(`manifest-candidate-${SYS}-${p}.json`, { [`pkg-${p}`]: { path: `/nix/store/${p}`, narHash: "h" } });
    writeFileSync(join(dir, `tree-part-candidate-${SYS}-${p}.txt`), `${TREE}\n`);
  }
}

test("the default suite: every part's failures, checks and notes, one manifest; narrow.ts reads it", () => {
  testParts({ rest1: { passed: false, failed: ["codex"], checked: ["codex"] }, rest2: { notes: [{ package: "fx", detail: "d" }] } });
  assert.deepEqual(merge(dir, quiet).sort(), [`candidate-${SYS}.json`, `manifest-candidate-${SYS}.json`, `tree-candidate-${SYS}.txt`]);
  const r = read(`candidate-${SYS}.json`);
  assert.equal(r.passed, false);
  assert.deepEqual(r.failed, ["codex"]);
  assert.deepEqual(r.checked, ["codex"]);
  assert.deepEqual(r.notes, [{ package: "fx", detail: "d" }]);
  assert.equal(r.nixCalls.length, TEST_PARTS.length);
  assert.deepEqual(Object.keys(read(`manifest-candidate-${SYS}.json`)).sort(), TEST_PARTS.map((p) => `pkg-${p}`).sort());
  const loaded = load(dir).get("candidate")!;
  assert.equal(loaded.passed, false);
  assert.deepEqual([...loaded.failed], ["codex"]);
});

test("the default suite: a part without a result leaves the suite without one (incomplete)", () => {
  testParts();
  rmSync(join(dir, `candidate-${SYS}-rest2.json`));
  const logged: string[] = [];
  assert.deepEqual(merge(dir, (m) => logged.push(m)), []);
  assert.ok(!existsSync(join(dir, `candidate-${SYS}.json`)));
  assert.match(logged[0], /no result from rest2/);
});

test("a whole file already there (narrowing's, unparted) is left alone", () => {
  put(`main-${SYS}.json`, { set: "main", system: SYS, passed: true, failed: [] });
  assert.deepEqual(merge(dir, quiet), []);
});

test("Electron evidence: what any part saw pass, the smoke from the part that ran it", () => {
  const ch = (passed: string[]) => ({ t3code: { runtime: ["t3code"], bundled: ["t3code-electron-bundled"], passed, forcedNotApplicable: false, active: false, pair: null } });
  const e = mergeElectron([
    { channels: ch(["t3code"]), smokes: { "desktop-smoke": "pass" }, dependsOn: { x: ["t3code"] }, confirmed: ["x"], smokeRan: true },
    { channels: ch(["t3code-electron-bundled"]), smokes: { "desktop-smoke": "not-run" }, dependsOn: { y: ["t3code"] }, confirmed: [], smokeRan: false },
    undefined,
  ]);
  assert.deepEqual(e.channels.t3code.passed, ["t3code", "t3code-electron-bundled"]);
  assert.deepEqual(e.smokes, { "desktop-smoke": "pass" });
  assert.deepEqual(e.dependsOn, { x: ["t3code"], y: ["t3code"] });
  assert.deepEqual(e.confirmed, ["x"]);
  assert.equal(e.smokeRan, true);
  assert.equal(mergeElectron([undefined, null]), undefined);
});

/** NixOS stable's part files: each part's stable group, and its stable-next
 * in a job of its own (part a's with the equivalence step's move). */
function stableParts(o: { behind?: boolean; next?: Record<string, object>; move?: object | null; set?: string } = {}) {
  const behind = o.behind ?? true, set = o.set ?? "candidate";
  const base = { set, system: SYS, tree: TREE, drvs: "d", base: "b", behind };
  for (const p of STABLE_PARTS) {
    put(`stable-${set}-${SYS}-${p}.json`, { ...base, stable: { complete: true, failed: p === "b" ? ["stable-unit"] : [], ...(p === "b" ? { notApplicable: ["stable-x"] } : {}) }, nixCalls: [p] });
    const move = p === "a" && behind && o.move !== null ? { move: { ok: true, tree: "c".repeat(40), reason: "", ...o.move } } : {};
    put(`stable-${set}-${SYS}-${p}-next.json`, { set, system: SYS, tree: TREE, behind, stableNext: { complete: true, failed: [], ...o.next?.[p] }, ...move, nixCalls: [`${p}-next`] });
  }
}
const fresh = () => { rmSync(dir, { recursive: true, force: true }); dir = mkdtempSync(join(tmpdir(), "merge-parts-")); };

test("NixOS stable: both groups from their jobs, the move from part a's stable-next; narrow.ts reads it", () => {
  stableParts();
  assert.deepEqual(merge(dir, quiet), [`stable-candidate-${SYS}.json`]);
  const r = read(`stable-candidate-${SYS}.json`);
  assert.deepEqual(r.stable, { complete: true, failed: ["stable-unit"], notApplicable: ["stable-x"] });
  assert.deepEqual(r.stableNext, { complete: true, failed: [] });
  assert.equal(r.move.ok, true);
  assert.equal(r.base, "b");
  assert.equal(r.nixCalls.length, 2 * STABLE_PARTS.length);
  const f = loadStable(dir).get("candidate")!.get(SYS)!;
  assert.equal(f.move?.ok, true);
  assert.deepEqual(f.stable.failed, ["stable-unit"]);
});

test("NixOS stable: the move stands only when stable-next passed in every part", () => {
  stableParts({ next: { b: { failed: ["stable-next-unit"] } } });
  merge(dir, quiet);
  const r = read(`stable-candidate-${SYS}.json`);
  assert.deepEqual(r.stableNext.failed, ["stable-next-unit"]);
  assert.equal(r.move, undefined);
  fresh();
  stableParts({ next: { b: { complete: false, failed: [] } } });
  merge(dir, quiet);
  assert.deepEqual(read(`stable-candidate-${SYS}.json`).stableNext, { complete: false, failed: [] });
  assert.equal(read(`stable-candidate-${SYS}.json`).move, undefined);
  // Not behind: no move.
  fresh();
  stableParts({ behind: false });
  merge(dir, quiet);
  assert.equal(read(`stable-candidate-${SYS}.json`).move, undefined);
});

test("NixOS stable: a part without a result leaves its group incomplete, never complete, and the other group stands", () => {
  // Both stable-next parts lost: stable-next is incomplete, not untested.
  stableParts();
  for (const p of STABLE_PARTS) rmSync(join(dir, `stable-candidate-${SYS}-${p}-next.json`));
  merge(dir, quiet);
  let r = read(`stable-candidate-${SYS}.json`);
  assert.deepEqual(r.stableNext, { complete: false, failed: [] });
  assert.deepEqual(r.stable, { complete: true, failed: ["stable-unit"], notApplicable: ["stable-x"] });
  assert.equal(r.move, undefined);
  // One stable part lost: the stable group is incomplete; stable-next stands.
  fresh();
  stableParts();
  rmSync(join(dir, `stable-candidate-${SYS}-a.json`));
  merge(dir, quiet);
  r = read(`stable-candidate-${SYS}.json`);
  assert.deepEqual(r.stable, { complete: false, failed: [] });
  assert.deepEqual(r.stableNext, { complete: true, failed: [] });
  assert.deepEqual([r.drvs, r.base], ["", null], "one stable part's evaluation alone says nothing about main");
});

test("NixOS stable: parts of different trees give no result; stable parts whose evaluations differ say nothing about main", () => {
  for (const [file, change] of [["a", { tree: "b".repeat(40) }], ["b-next", { behind: false }]] as const) {
    fresh();
    stableParts();
    const f = `stable-candidate-${SYS}-${file}.json`;
    put(f, { ...read(f), ...change });
    assert.deepEqual(merge(dir, quiet), [], file);
  }
  // An evaluation that failed in one stable part (its digest differs): the
  // groups and the move stand, with no base (no evidence about main).
  for (const change of [{ drvs: "other" }, { base: null }]) {
    fresh();
    stableParts();
    const f = `stable-candidate-${SYS}-b.json`;
    put(f, { ...read(f), ...change });
    assert.deepEqual(merge(dir, quiet), [`stable-candidate-${SYS}.json`], JSON.stringify(change));
    const r = read(`stable-candidate-${SYS}.json`);
    assert.deepEqual([r.drvs, r.base, r.move?.ok], ["", null, true]);
    assert.equal(loadStable(dir).get("candidate")!.get(SYS)!.base, null);
  }
  // The stable parts both lost: the digests too.
  fresh();
  stableParts();
  for (const p of STABLE_PARTS) rmSync(join(dir, `stable-candidate-${SYS}-${p}.json`));
  merge(dir, quiet);
  const r = read(`stable-candidate-${SYS}.json`);
  assert.deepEqual([r.drvs, r.base, r.stable.complete], ["", null, false]);
});

test("a part file that isn't an object is refused; a group that isn't one is incomplete", () => {
  stableParts();
  const f = `stable-candidate-${SYS}-a.json`;
  put(f, { ...read(f), stable: null });
  merge(dir, quiet);
  assert.deepEqual(read(`stable-candidate-${SYS}.json`).stable, { complete: false, failed: [] });
  fresh();
  testParts();
  writeFileSync(join(dir, `candidate-${SYS}-rest1.json`), "null");
  assert.throws(() => merge(dir, quiet), /is not a part's result/);
});

test("the tree: the suite's result, manifest and tree only when every part reports the same tree", () => {
  testParts();
  merge(dir, quiet);
  assert.equal(readFileSync(join(dir, `tree-candidate-${SYS}.txt`), "utf8"), `${TREE}\n`);
  const logged: string[] = [];
  for (const spoil of [() => rmSync(join(dir, `tree-part-candidate-${SYS}-rest2.txt`)),
    () => writeFileSync(join(dir, `tree-part-candidate-${SYS}-rest2.txt`), `${"b".repeat(40)}\n`),
    () => { for (const p of TEST_PARTS) writeFileSync(join(dir, `tree-part-candidate-${SYS}-${p}.txt`), "\n"); }]) {
    fresh();
    testParts();
    spoil();
    assert.deepEqual(merge(dir, (m) => logged.push(m)), []);
    for (const f of [`candidate-${SYS}.json`, `manifest-candidate-${SYS}.json`, `tree-candidate-${SYS}.txt`]) assert.ok(!existsSync(join(dir, f)), f);
  }
  assert.match(logged[0], /don't all report one valid tree/);
});

test("end to end: the merged parts of both systems pass narrowing's plan and the verdict", async () => {
  const { plan, verdict } = await import("../scripts/ci/narrow.ts");
  for (const system of ["x86_64-linux", "aarch64-linux"]) {
    for (const p of TEST_PARTS) {
      put(`candidate-${system}-${p}.json`, { set: "candidate", system, passed: true, failed: [], checked: [], notes: [] });
      writeFileSync(join(dir, `tree-part-candidate-${system}-${p}.txt`), `${TREE}\n`);
    }
    for (const p of STABLE_PARTS) {
      put(`stable-candidate-${system}-${p}.json`, { set: "candidate", system, tree: TREE, drvs: "d", base: "b", behind: false, stable: { complete: true, failed: [] } });
      put(`stable-candidate-${system}-${p}-next.json`, { set: "candidate", system, tree: TREE, behind: false, stableNext: { complete: true, failed: [] } });
    }
  }
  merge(dir, quiet);
  const inputs = [{ name: "codex", files: ["versions/codex.json"], from: "1", to: "2" }];
  assert.equal(plan(inputs, load(dir), loadStable(dir)), null, "nothing to narrow");
  const v = verdict(inputs, dir, "candidate", ["codex"]);
  assert.equal(v.ok, true, JSON.stringify(v));
  // One part's result missing on one system: the candidate didn't pass.
  rmSync(join(dir, "candidate-aarch64-linux.json"));
  rmSync(join(dir, "candidate-aarch64-linux-rest1.json"));
  merge(dir, quiet);
  assert.notEqual(plan(inputs, load(dir), loadStable(dir)), null);
  assert.equal(verdict(inputs, dir, "candidate", ["codex"]).ok, false);
});
