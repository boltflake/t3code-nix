// The update runs' test and final jobs run in parts (scripts/lib/parts.ts),
// as branch CI does, each writing its own result files; this writes the
// whole-suite files that narrow.ts, publish and the cache job read, from
// every part's, in the same directory. A set and system whose parts aren't
// all there gets no whole file, which the readers take as incomplete, as
// when a step runs out of time.
//
//   node merge-parts.ts DIR
//
// The default suite: SET-SYSTEM-PART.json, manifest-SET-SYSTEM-PART.json and
// tree-part-SET-SYSTEM-PART.txt for each of TEST_PARTS. NixOS stable:
// stable-SET-SYSTEM-PART.json (the stable group) and
// stable-SET-SYSTEM-PART-next.json (stable-next, and in part a the
// equivalence step's move) for each of STABLE_PARTS. A stable group without
// every part's result is incomplete; the move needs stable-next to pass in
// every part.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../lib/util.ts";
import { STABLE_PARTS, TEST_PARTS } from "../lib/parts.ts";

const SYS = "(?<system>x86_64-linux|aarch64-linux)";
// Not a manifest or a stable file (no set is named so).
const TEST_FILE = new RegExp(`^(?!manifest-|stable-)(?<set>[a-z0-9][a-z0-9-]*?)-${SYS}-(?<part>${TEST_PARTS.join("|")})\\.json$`);
const STABLE_FILE = new RegExp(`^stable-(?<set>[a-z0-9][a-z0-9-]*?)-${SYS}-(?<part>(?:${STABLE_PARTS.join("|")})(?:-next)?)\\.json$`);
const TREE_FILE = new RegExp(`^tree-part-(?<set>[a-z0-9][a-z0-9-]*?)-${SYS}-(?<part>${TEST_PARTS.join("|")})\\.txt$`);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** The part files in DIR matching `re`, read, by set and system. A JSON
 * part that isn't an object is refused: written where vendor code runs. */
function byRun<T = any>(dir: string, re: RegExp, read: (path: string) => T = (path) => readPart(path) as T): Map<string, Map<string, T>> {
  const runs = new Map<string, Map<string, T>>();
  for (const f of readdirSync(dir)) {
    const m = re.exec(f);
    if (!m) continue;
    const key = `${m.groups!.set}\t${m.groups!.system}`;
    if (!runs.has(key)) runs.set(key, new Map());
    runs.get(key)!.set(m.groups!.part, read(join(dir, f)));
  }
  return runs;
}
function readPart(path: string): any {
  const r = readJson<any>(path);
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`${path} is not a part's result`);
  return r;
}

/** Each part's Electron evidence (test.ts) as one: every channel's lists
 * are the same in every part (each evaluates the desktop apps' checks,
 * test.ts's evaluateChecks); what passed is what any part saw pass, as each
 * vouches only for the checks it ran. */
export function mergeElectron(es: any[]): any {
  const present = es.filter((e) => e && typeof e === "object");
  if (!present.length) return undefined;
  const channels: Record<string, any> = {};
  for (const e of present) {
    for (const [c, ev] of Object.entries<any>(e.channels ?? {})) {
      if (!channels[c]) channels[c] = { ...ev, passed: [...(ev.passed ?? [])] };
      else channels[c].passed = uniq([...channels[c].passed, ...(ev.passed ?? [])]).sort();
    }
  }
  // A smoke ran in one part; the others list it as not run.
  const smokes: Record<string, string> = {};
  for (const e of present) {
    for (const [n, s] of Object.entries<any>(e.smokes ?? {})) if (!(n in smokes) || smokes[n] === "not-run") smokes[n] = s;
  }
  const dependsOn: Record<string, string[]> = {};
  for (const e of present) for (const [n, cs] of Object.entries<any>(e.dependsOn ?? {})) dependsOn[n] = uniq([...(dependsOn[n] ?? []), ...cs]);
  return { channels, smokes, dependsOn, confirmed: uniq(present.flatMap((e) => e.confirmed ?? [])).sort(), smokeRan: present.some((e) => e.smokeRan) };
}

/** A stable group (stable or stableNext) from every part's: complete only
 * when every part's is. */
function mergeGroup(gs: any[]): any {
  const complete = gs.every((g) => g.complete);
  const notApplicable = uniq(gs.flatMap((g) => g.notApplicable ?? [])).sort();
  return { complete, failed: complete ? uniq(gs.flatMap((g) => g.failed)).sort() : [], ...(notApplicable.length ? { notApplicable } : {}) };
}

export function merge(dir: string, log = console.error): string[] {
  const written: string[] = [];
  if (!existsSync(dir)) return written;
  // Each part reports the tree it tested; the suite's result stands only
  // when every part tested the same one.
  const trees = byRun(dir, TREE_FILE, (path) => readFileSync(path, "utf8").trim());
  for (const [key, parts] of byRun(dir, TEST_FILE)) {
    const [set, system] = key.split("\t");
    const missing = TEST_PARTS.filter((p) => !parts.has(p));
    if (missing.length) { log(`${set} on ${system}: no result from ${missing.join(", ")}, so none for the suite`); continue; }
    const tested = new Set(TEST_PARTS.map((p) => trees.get(key)?.get(p)));
    const tree = tested.size === 1 ? [...tested][0] : undefined;
    if (!tree || !/^[0-9a-f]{40,64}$/.test(tree)) { log(`${set} on ${system}: the parts don't all report one valid tree, so no result for the suite`); continue; }
    writeFileSync(join(dir, `tree-${set}-${system}.txt`), `${tree}\n`);
    written.push(`tree-${set}-${system}.txt`);
    const rs = TEST_PARTS.map((p) => parts.get(p));
    const failed = uniq(rs.flatMap((r) => r.failed ?? []));
    writeJson(join(dir, `${set}-${system}.json`), {
      set, system, passed: rs.every((r) => r.passed === true) && failed.length === 0, failed,
      checked: uniq(rs.flatMap((r) => r.checked ?? [])), notes: rs.flatMap((r) => r.notes ?? []),
      updateNotice: Object.assign({}, ...rs.map((r) => (r.updateNotice && typeof r.updateNotice === "object" ? r.updateNotice : {}))),
      electron: mergeElectron(rs.map((r) => r.electron)), nixCalls: rs.flatMap((r) => r.nixCalls ?? []),
    });
    written.push(`${set}-${system}.json`);
    const manifests = TEST_PARTS.map((p) => join(dir, `manifest-${set}-${system}-${p}.json`));
    if (manifests.every(existsSync)) {
      writeJson(join(dir, `manifest-${set}-${system}.json`), Object.assign({}, ...manifests.map((m) => readJson<any>(m))));
      written.push(`manifest-${set}-${system}.json`);
    }
  }
  for (const [key, parts] of byRun(dir, STABLE_FILE)) {
    const [set, system] = key.split("\t");
    const name = `stable ${set} on ${system}`;
    // The update runs' layout: each part's stable group, and its stable-next
    // group in a job of its own. Every job must have tested one tree (both
    // read from git).
    const files = [...parts.values()];
    const same = (k: string, of: any[]) => of.every((r) => JSON.stringify(r[k]) === JSON.stringify(of[0][k]));
    if (!same("tree", files) || !same("behind", files)) { log(`${name}: the parts tested different trees, so no result`); continue; }
    // A group is complete only with every part's result; a part without one
    // leaves that group incomplete, not the other.
    const group = (results: any[]) => (results.some((r) => !r || typeof r !== "object") ? { complete: false, failed: [] } : mergeGroup(results));
    const stable = group(STABLE_PARTS.map((p) => parts.get(p)?.stable));
    const stableNext = group(STABLE_PARTS.map((p) => parts.get(`${p}-next`)?.stableNext));
    // The stable group's derivations and the base's, from the stable jobs
    // (evaluations: one that failed differs). Without one agreed value the
    // result says nothing about main (no base).
    const stableJobs = STABLE_PARTS.map((p) => parts.get(p)).filter(Boolean);
    const agreed = stableJobs.length === STABLE_PARTS.length && typeof stableJobs[0].drvs === "string" && stableJobs[0].drvs !== ""
      && same("drvs", stableJobs) && same("base", stableJobs);
    if (!agreed) log(`${name}: no agreed evaluation from every stable part, so nothing about main`);
    const drvs = agreed ? stableJobs[0].drvs : "";
    const base = agreed ? stableJobs[0].base : null;
    // The equivalence step for a move ran in part a's stable-next job, after
    // its own share passed; the move stands only when every part's did.
    const move = stableNext.complete && stableNext.failed.length === 0 ? parts.get(`${STABLE_PARTS[0]}-next`)?.move : undefined;
    const first = files[0];
    writeJson(join(dir, `stable-${set}-${system}.json`), {
      set: first.set, system: first.system, tree: first.tree, behind: first.behind, drvs, base: base ?? null,
      stable, stableNext, ...(move ? { move } : {}), nixCalls: files.flatMap((r) => r.nixCalls ?? []),
    });
    written.push(`stable-${set}-${system}.json`);
  }
  return written;
}

if (import.meta.main) {
  const written = merge(process.argv[2]);
  console.log(`merged: ${written.join(", ") || "nothing"}`);
}
