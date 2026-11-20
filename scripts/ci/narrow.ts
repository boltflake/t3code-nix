// What can be published after the tests (the narrow-plan, decide and verdict
// jobs). Pure decisions; the workflow runs the tests these ask for.
//
//   node narrow.ts plan CANDIDATE_DIR RESULTS_DIR [OBS_FILE]
//                                                     "failed=true|false" (+ "sets=[...]",
//                                                     "stable-sets=[...]"); OBS_FILE gets
//                                                     stable-broken/stable-ok evidence
//   node narrow.ts decide CANDIDATE_DIR RESULTS_DIR   JSON {final, observations}
//   node narrow.ts verdict CANDIDATE_DIR RESULTS_DIR SET NAMES
//                                                     JSON {ok, tree, observations, guard, move}
//
// Result files are RESULTS_DIR/<set>-<system>.json ({set, system, passed,
// failed, checked, notes}); beside them, manifest-*.json (test.ts) and
// tree-*.txt (the workflow, or merge-parts.ts from the parts'), which are not
// results. A set passes only when it passed on every system in
// SYSTEMS: a missing result is a failure, never a pass.
//
// Rules (plan, "Update, test, publish", job 3):
//   - every input is tested alone on top of main; the final candidate is main
//     plus every input that passed alone, and it gets the full suite again
//   - testing main alone only classifies: env-broken only when main fails and
//     every input fails too, because a fix for main must still get through
//   - an input that fails alone gets test-failed for that version; one with
//     no failing result but a missing one (a job that died or never ran, or
//     a step that hit its limit outside a build: a hung build fails at the
//     daemon's 15-minute timeout, a failed check) gets update-failed
//     instead: it isn't held, and the next run retries
//   - if the final candidate fails, nothing is published, and each of its
//     inputs gets combination-failed (which holds that version); if it only
//     lacks a result, update-failed (nothing held)
//   - with a single input, testing it alone would repeat the candidate run,
//     so only main is tested
//   - NixOS stable (stable-<set>-<system>.json, apart from the default):
//     a candidate with nixpkgs-stable whose stable group isn't a complete
//     pass narrows even when the default passed; that input then needs its
//     stable group to pass (failing holds it, incomplete leaves it out), and
//     a final with it whose stable group isn't a complete pass publishes
//     nothing; other inputs never wait for the stable groups. A set whose
//     stable derivations are main's is evidence about main's stable set
//     (stable-broken, stable-ok), only when complete. verdict's `move` says
//     whether publishing moves the snapshot, and why not
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Failed, readJson, SYSTEMS, VERSIONS } from "../lib/util.ts";
import { load as loadCandidate, type Input } from "./candidate.ts";
import { ALL, obs, type Observation } from "../update.ts";
import { activeChannels, bundledList, CHANNELS, pairOf, ROLES, samePair, type Channel, type Pair, type Reader } from "../lib/electron-fallback.ts";
import type { ChannelEvidence, ElectronEvidence, SmokeState } from "./test.ts";

const RESULT = /^(?<set>.+)-(?<system>x86_64-linux|aarch64-linux)\.json$/;

export interface SetResult {
  passed: boolean;
  failed: Set<string>;
  systems: Set<string>;
  /** The guard checks' packages and notes (test.ts), from every system. */
  checked: Set<string>;
  notes: Map<string, Set<string>>;
  /** Per system: the failures left once an active Electron fallback has
   * taken its channel's runtime failures, and the Electron evidence. */
  perSystem: Map<string, { failed: string[]; electron: ElectronEvidence | null }>;
}

/** What the trusted candidate tree of a set says (never the runner's
 * word): which channels have an active fallback entry, and its files (for
 * the issue's detail). */
export type Trusted = (set: string) => { active: Channel[]; read: Reader } | null;

export function load(dir: string, trusted: Trusted | null = null): Map<string, SetResult> {
  const sets = new Map<string, SetResult>();
  if (!existsSync(dir)) return sets;
  for (const file of readdirSync(dir)) {
    const m = RESULT.exec(file);
    if (!m || file.startsWith("manifest-") || file.startsWith("stable-")) continue;
    const r = readJson<any>(join(dir, file));
    if (r?.set !== m.groups!.set || r?.system !== m.groups!.system || typeof r?.passed !== "boolean") {
      throw new Failed(`${file} is not a test result`);
    }
    const s = sets.get(r.set)
      ?? { passed: true, failed: new Set<string>(), systems: new Set<string>(), checked: new Set<string>(), notes: new Map(), perSystem: new Map() };
    // An active fallback's channel: its runtime failures are passes.
    const electron = electronOf(r.electron);
    const t = trusted?.(r.set) ?? null;
    if (electron && t) for (const c of CHANNELS) if (electron.channels[c]) electron.channels[c]!.active = t.active.includes(c);
    // Only the forced nixpkgs check and its smoke: under an active entry auto
    // is bundled, so the auto apps' failures are never excused.
    const accepted = new Set((Object.entries(electron?.channels ?? {}) as [Channel, ChannelEvidence][])
      .flatMap(([c, ev]) => (ev.active ? [ROLES[c].forced, ROLES[c].smokes[ROLES[c].forced]].filter((n) => ev.runtime.includes(n)) : [])));
    const failed = (Array.isArray(r.failed) ? r.failed : []).filter((f: unknown) => typeof f === "string" && !accepted.has(f));
    s.passed &&= failed.length === 0 && (r.passed || (r.failed ?? []).length > 0);
    for (const f of failed) s.failed.add(f);
    s.perSystem.set(r.system, { failed, electron });
    // Written where vendor binaries run: only our package names count (they
    // go into issue keys and bodies), and a detail is plain text.
    for (const p of r.checked ?? []) if (ALL.includes(p)) s.checked.add(p);
    for (const n of r.notes ?? []) {
      if (!ALL.includes(n?.package) || typeof n.detail !== "string") continue;
      if (!s.notes.has(n.package)) s.notes.set(n.package, new Set());
      s.notes.get(n.package)!.add(n.detail.slice(0, 2000));
    }
    s.systems.add(r.system);
    sets.set(r.set, s);
  }
  return sets;
}

/** The Electron evidence in a result file (test.ts), shape-checked: it's
 * written where vendor code runs, so only known channels and check names. */
function electronOf(e: any): ElectronEvidence | null {
  if (!e || typeof e !== "object" || !e.channels || typeof e.channels !== "object") return null;
  const name = (n: unknown) => typeof n === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(n);
  const names = (a: unknown) => (Array.isArray(a) ? a.filter(name) as string[] : []);
  const channels: ElectronEvidence["channels"] = {};
  for (const c of CHANNELS) {
    const x = e.channels[c];
    if (!x || typeof x !== "object") continue;
    const pair = x.pair && typeof x.pair.version === "string" && typeof x.pair.nixpkgs === "string" && x.pair.assets && typeof x.pair.assets === "object"
      ? { version: x.pair.version, nixpkgs: x.pair.nixpkgs, assets: Object.fromEntries(SYSTEMS.map((sys) => [sys, String(x.pair.assets[sys] ?? "")])) }
      : null;
    // Only the channel's fixed roles count: never an arbitrary name.
    const r = ROLES[c];
    const allowed = new Set([...r.auto, r.forced, ...[...r.auto, r.forced].map((a) => r.smokes[a]).filter(Boolean)]);
    const bundled = names(x.bundled);
    channels[c] = { runtime: names(x.runtime).filter((n) => allowed.has(n)),
      bundled: JSON.stringify([...bundled].sort()) === JSON.stringify([...bundledList(c)].sort()) ? bundled : [],
      passed: names(x.passed), forcedNotApplicable: x.forcedNotApplicable === true, active: x.active === true, pair };
  }
  const smokes: Record<string, SmokeState> = {};
  for (const [k, v] of Object.entries(e.smokes ?? {})) if (name(k) && ["pass", "fail", "not-run", "not-applicable"].includes(v as string)) smokes[k] = v as SmokeState;
  const dependsOn: Record<string, Channel[]> = {};
  for (const [k, v] of Object.entries(e.dependsOn ?? {})) {
    const cs = (Array.isArray(v) ? v : []).filter((c) => (CHANNELS as readonly string[]).includes(c)) as Channel[];
    if (name(k) && cs.length) dependsOn[k] = [...new Set(cs)].sort();
  }
  return { channels, smokes, dependsOn, confirmed: names(e.confirmed).filter((n) => n in dependsOn), smokeRan: e.smokeRan === true };
}

/** A set that failed only on the nixpkgs Electron runtime, on complete
 * results from every system: the channels whose fallback it needs, or null
 * (it passed, or a failure isn't the runtime's alone). Each failure is in
 * the runtime list of a channel in the answer, or depends on one of its
 * listed apps (provisional); each such channel's bundled twins passed on
 * every system; and the desktop smoke ran. `onlyActive`: the final's rule,
 * where only channels whose entry is in the tested tree may fail (those are
 * already passes), so any runtime failure left is not a fallback. */
export function fallbackOf(sets: Map<string, SetResult>, name: string): Channel[] | null {
  const s = sets.get(name);
  if (!s || s.passed || !SYSTEMS.every((sys) => s.perSystem.has(sys))) return null;
  const channels = new Set<Channel>();
  for (const sys of SYSTEMS) {
    const { failed, electron } = s.perSystem.get(sys)!;
    if (!failed.length) continue;
    if (!electron?.smokeRan) return null;
    for (const f of failed) {
      // A failure that depends on a listed app counts only when it passed
      // on bundled Electron in the same set (test.ts confirmProvisional).
      const runtimeOf = (Object.entries(electron.channels) as [Channel, ChannelEvidence][]).find(([, ev]) => ev.runtime.includes(f))?.[0];
      const cs = runtimeOf ? [runtimeOf] : electron.confirmed.includes(f) ? electron.dependsOn[f] : [];
      if (!cs.length) return null;
      for (const c of cs) channels.add(c);
    }
  }
  for (const c of channels) {
    for (const sys of SYSTEMS) {
      const ev = s.perSystem.get(sys)!.electron?.channels[c];
      if (!ev || !ev.bundled.length || !ev.bundled.every((b) => ev.passed.includes(b))) return null;
    }
  }
  return channels.size ? [...channels].sort() : null;
}

/** The pair (version, .deb hashes, nixpkgs revision) a set tested for a
 * channel, when every system agrees. */
export function setPair(sets: Map<string, SetResult>, name: string, c: Channel): Pair | null {
  const pairs = SYSTEMS.map((sys) => sets.get(name)?.perSystem.get(sys)?.electron?.channels[c]?.pair ?? null);
  return pairs.every((p) => samePair(p, pairs[0])) ? pairs[0] : null;
}

export const passed = (sets: Map<string, SetResult>, name: string) => {
  const s = sets.get(name);
  return Boolean(s && s.passed && SYSTEMS.every((sys) => s.systems.has(sys)));
};

export function failingChecks(sets: Map<string, SetResult>, name: string): string {
  const s = sets.get(name);
  if (!s) return "no result (the test job failed)";
  const missing = SYSTEMS.filter((sys) => !s.systems.has(sys)).map((sys) => `no result for ${sys}`);
  return [...[...s.failed].sort(), ...missing].join(", ") || "unknown";
}

/** A set with no failing result, but not a result for every system: a job
 * died or never ran, which says nothing about the change. */
export const incomplete = (sets: Map<string, SetResult>, name: string) => {
  const s = sets.get(name);
  return !s || (s.passed && !SYSTEMS.every((sys) => s.systems.has(sys)));
};

/** An input's note (a browser pin's Chromium), leading its issue's detail. */
const about = (i: Input) => (i.note ? `${i.note}: ` : "");

// The NixOS-stable results (stable.ts): stable-<set>-<system>.json, kept
// apart from the default's. Written where vendor code runs, so only their
// shape and check names are taken from them.
export const STABLE_PIN = "nixpkgs-stable";
interface GroupFile { complete: boolean; failed: string[] }
export interface StableFile {
  tree: string;
  stable: GroupFile;
  stableNext?: GroupFile;
  drvs: string;
  base?: string | null;
  behind: boolean;
  move?: { ok: boolean; tree: string; reason: string };
}
export type Stable = Map<string, Map<string, StableFile>>;
const STABLE_RESULT = /^stable-(?<set>.+)-(?<system>x86_64-linux|aarch64-linux)\.json$/;
const HASH = /^[0-9a-f]{40,64}$/;
const checkName = (n: unknown) => typeof n === "string" && /^[a-z0-9][a-z0-9-]{0,80}( \(incomplete\))?$/.test(n);

function group(g: any): GroupFile | null {
  if (typeof g?.complete !== "boolean" || !Array.isArray(g.failed) || !g.failed.every(checkName)) return null;
  return { complete: g.complete, failed: [...g.failed].sort() };
}

export function loadStable(dir: string): Stable {
  const sets: Stable = new Map();
  if (!existsSync(dir)) return sets;
  for (const file of readdirSync(dir)) {
    const m = STABLE_RESULT.exec(file);
    if (!m) continue;
    const r = readJson<any>(join(dir, file));
    const stable = group(r?.stable), next = r?.stableNext === undefined ? undefined : group(r.stableNext);
    const move = r?.move;
    if (r?.set !== m.groups!.set || r?.system !== m.groups!.system || !HASH.test(r?.tree) || !stable || next === null
      || typeof r?.drvs !== "string" || typeof r?.behind !== "boolean"
      || (move !== undefined && (typeof move?.ok !== "boolean" || !HASH.test(move?.tree) || typeof move?.reason !== "string"))) {
      throw new Failed(`${file} is not a stable test result`);
    }
    if (!sets.has(r.set)) sets.set(r.set, new Map());
    sets.get(r.set)!.set(r.system, {
      tree: r.tree, stable, stableNext: next ?? undefined, drvs: r.drvs, base: typeof r.base === "string" ? r.base : null, behind: r.behind,
      move: move && { ok: move.ok, tree: move.tree, reason: move.reason.slice(0, 500) },
    });
  }
  return sets;
}

/** `complete`: every system has a complete result (a failing state can
 * have one system failing and another incomplete). */
export type GroupState = { state: "pass" | "fail" | "incomplete"; failed: string[]; complete: boolean };

/** A stable group of a set on every system: a complete pass, failing (any
 * system's failing checks, "system: check"), or incomplete. */
export function groupOf(st: Stable, set: string, key: "stable" | "stableNext"): GroupState {
  const files = st.get(set);
  const failed: string[] = [];
  let complete = true;
  for (const sys of SYSTEMS) {
    const g = files?.get(sys)?.[key];
    if (!g?.complete) complete = false;
    else failed.push(...g.failed.map((f) => `${sys}: ${f}`));
  }
  return { state: failed.length ? "fail" : complete ? "pass" : "incomplete", failed: failed.sort(), complete };
}

/** A set's stable group less the failures main's own stable group has (the
 * same check on the same system): those are main's, not the set's. Main's
 * result is there once the run narrowed; otherwise nothing is taken off. */
export function ownStable(st: Stable, set: string): GroupState {
  const g = groupOf(st, set, "stable");
  if (set === "main" || !st.has("main")) return g;
  const mains = new Set(groupOf(st, "main", "stable").failed);
  const failed = g.failed.filter((f) => !mains.has(f));
  return { state: failed.length ? "fail" : g.complete ? "pass" : "incomplete", failed, complete: g.complete };
}

/** Whether a set's stable result is about main's stable set: main itself,
 * or a set whose stable derivations are main's on every system. */
export function isMains(st: Stable, set: string): boolean {
  const files = st.get(set);
  return SYSTEMS.every((sys) => {
    const f = files?.get(sys);
    return !!f && (set === "main" || (!!f.base && f.base === f.drvs));
  });
}

const DETAIL_LIMIT = 20;
const cut = (names: string[]) =>
  names.length > DETAIL_LIMIT ? `${names.slice(0, DETAIL_LIMIT).join(", ")} and ${names.length - DETAIL_LIMIT} more` : names.join(", ");

/** stable-broken or stable-ok, from a set whose stable result is main's and
 * complete on every system; nothing otherwise. */
export function stableEvidence(st: Stable, set: string): Observation[] {
  if (!isMains(st, set)) return [];
  const g = groupOf(st, set, "stable");
  if (!g.complete) return [];
  if (g.state === "fail") return [obs("stable-broken", null, null, cut(g.failed))];
  if (g.state === "pass") return [obs("stable-ok", null, null, `main's stable set passes (${set})`)];
  return [];
}

export function plan(inputs: Input[], sets: Map<string, SetResult>, st: Stable = new Map()): string[] | null {
  // A nixpkgs-stable bump in the candidate needs its stable group to pass too.
  const stableBump = inputs.some((i) => i.name === STABLE_PIN) && ownStable(st, "candidate").state !== "pass";
  if (passed(sets, "candidate") && !stableBump) return null;
  // Failing only on the nixpkgs Electron runtime: the final candidate is
  // every input, with the fallback; nothing needs testing alone (unless the
  // NixOS-stable rule asks for it, above).
  if (fallbackOf(sets, "candidate") && !stableBump) return [];
  return inputs.length === 1 ? ["main"] : ["main", ...inputs.map((i) => i.name)];
}

/** The narrowing sets that run the stable group: main alone and the
 * nixpkgs-stable input alone; the others' stable results decide nothing. */
export const stableSets = (sets: string[]) => sets.filter((s) => s === "main" || s === STABLE_PIN);

export function decide(inputs: Input[], sets: Map<string, SetResult>, st: Stable = new Map(),
  finalPair: (names: string[], c: Channel) => Pair | null = () => null): { final: string[]; electron: Channel[]; observations: Observation[] } {
  // The candidate failed only on the nixpkgs Electron runtime and nothing
  // was tested alone (plan's shortcut): every input, with its fallback.
  // Only when plan really chose it (not when narrowing jobs left no results).
  const shortcut = fallbackOf(sets, "candidate");
  if (shortcut && plan(inputs, sets, st)?.length === 0) {
    return { final: inputs.map((i) => i.name), electron: shortcut, observations: [] };
  }
  // A single input was already tested alone: the candidate is that input.
  const setOf = (i: Input) => (inputs.length === 1 ? "candidate" : i.name);
  // Passing, or failing only on the nixpkgs Electron runtime, counts as a
  // pass here: such an input is never held for it.
  const passedSet = (name: string) => passed(sets, name) || fallbackOf(sets, name) !== null;
  // nixpkgs-stable also needs its stable group, less what main's fails too:
  // failing holds it, incomplete leaves it out unheld.
  const stableOf = (i: Input) => (i.name === STABLE_PIN ? ownStable(st, setOf(i)) : null);
  const ok = (i: Input) => passedSet(setOf(i)) && (stableOf(i)?.state ?? "pass") === "pass";
  const isFailed = (i: Input) => (!passedSet(setOf(i)) && !incomplete(sets, setOf(i))) || stableOf(i)?.state === "fail";
  const good = inputs.filter(ok);
  const failed = inputs.filter((i) => !ok(i) && isFailed(i));
  const unknown = inputs.filter((i) => !ok(i) && !isFailed(i));
  const why = (i: Input) => {
    const g = stableOf(i);
    const def = passedSet(setOf(i)) ? [] : [failingChecks(sets, setOf(i))];
    if (g?.state === "fail") return [...def, `on NixOS stable: ${cut(g.failed)}`].join("; ");
    if (g?.state === "incomplete" && !def.length) return "no complete NixOS-stable result";
    return def.join("; ");
  };
  // main failing only on the nixpkgs Electron runtime still works.
  const mainOk = passedSet("main");
  // env-broken only on evidence: main failed, and so did every change, by
  // the default checks alone (a change whose default passes shows the
  // environment works, whatever its NixOS-stable result).
  const defaultAlive = inputs.some((i) => passedSet(setOf(i)) || incomplete(sets, setOf(i)));
  if (!mainOk && !incomplete(sets, "main") && !defaultAlive) {
    return { final: [], electron: [], observations: [obs("env-broken", null, null, `main fails on its own and so does every change; main: ${failingChecks(sets, "main")}`)] };
  }
  const observations = failed.map((i) => obs("test-failed", i.name, i.to, `${about(i)}fails on its own on top of main: ${why(i)}`));
  if (unknown.length) {
    observations.push(obs("update-failed", null, null,
      `no complete test result for ${unknown.map((i) => `${i.name} (${why(i)})`).join(", ")}; not held, the next run retries`));
  }
  if (mainOk) observations.push(obs("env-ok", null, null, "main passes on its own"));
  observations.push(...stableEvidence(st, "main"));
  // The fallback channels: from a set a final input passed in with a
  // fallback, only when that set tested the same pair as the final tree
  // (else the final tests nixpkgs' Electron on the new pair).
  const final = good.map((i) => i.name);
  const electron = new Set<Channel>();
  for (const i of good) {
    for (const c of fallbackOf(sets, setOf(i)) ?? []) if (samePair(setPair(sets, setOf(i), c), finalPair(final, c))) electron.add(c);
  }
  return { final, electron: [...electron].sort(), observations };
}

/** The version this checkout pins for a package (main's in a real run; a
 * dry run's on a branch reads the branch), or null. */
function pinOnMain(p: string): string | null {
  try { return readJson<{ version?: string }>(join(VERSIONS, `${p}.json`)).version ?? null; } catch { return null; }
}

/** What a published set's guard checks found, per package they compared:
 * guard-review with the notes (the release still ships; nothing is held), or
 * guard-reviewed, which closes that issue. The version is the package's in
 * the published tree, a change's or main's, so the same note on the next run
 * isn't a change. */
export function guardReview(s: SetResult, chosen: Input[], pinOf = pinOnMain): Observation[] {
  return [...s.checked].sort().map((p) => {
    const version = chosen.find((i) => i.name === p)?.to ?? pinOf(p);
    const notes = s.notes.get(p);
    return notes ? obs("guard-review", p, version, [...notes].sort().join("\n")) : obs("guard-reviewed", p, version, "");
  });
}

export function verdict(inputs: Input[], dir: string, set: string, names: string[], trusted: Trusted | null = null) {
  const sets = load(dir, trusted);
  const chosen = inputs.filter((i) => names.includes(i.name));
  const treeFiles = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`tree-${set}-`) && f.endsWith(".txt")) : [];
  const trees = new Set(treeFiles.map((f) => readFileSync(join(dir, f), "utf8").trim()));
  const st = loadStable(dir);
  const tree = trees.size === 1 ? [...trees][0] : null;
  // A stable result counts for this set only if it tested this tree.
  const files = st.get(set);
  for (const [sys, f] of files ?? []) if (f.tree !== tree) files!.delete(sys);
  const stableBump = chosen.some((i) => i.name === STABLE_PIN);
  // Less what main's stable group fails too (the workflow gives the final
  // main's result from the narrowing).
  const stableGroup = ownStable(st, set);
  const defaultOk = passed(sets, set) && trees.size === 1 && treeFiles.length === SYSTEMS.length;
  const ok = defaultOk && (!stableBump || stableGroup.state === "pass");
  const observations: Observation[] = [...stableEvidence(st, set)];
  if (defaultOk && !ok) {
    // A flaky stable check in the final: nothing this run, the next retries.
    observations.push(obs("update-failed", null, null,
      `${set} can't be published: it has ${STABLE_PIN}, whose NixOS-stable checks ${stableGroup.state === "fail" ? `failed: ${cut(stableGroup.failed)}` : "have no complete result"}`));
  } else if (ok) {
    observations.push(...chosen.map((i) => obs("test-passed", i.name, i.to, `passed in ${set}`)));
    // main plus these changes works, so the environment does too.
    observations.push(obs("env-ok", null, null, `the ${set} candidate passes`));
  } else if (set === "final" && fallbackOf(sets, set)) {
    // Only the nixpkgs Electron runtime failed, for a channel without an
    // entry in the tested tree (those with one are passes already): nothing
    // published, nothing held; the next run's candidate gets the fallback.
    observations.push(obs("update-failed", null, null,
      `${set} can't be published: the nixpkgs Electron runtime failed for ${fallbackOf(sets, set)!.join(", ")}, which the tested tree has no fallback for; ${failingChecks(sets, set)}`));
  } else if (set === "final" && !passed(sets, set) && !incomplete(sets, set)) {
    // Its tests failed: not a tree mismatch or a lost tree file, which hold
    // nothing (below).
    observations.push(...chosen.map((i) => obs("combination-failed", i.name, i.to,
      `${about(i)}passes on its own but fails together with: ${names.filter((n) => n !== i.name).join(", ")}; ${failingChecks(sets, set)}`)));
  } else {
    observations.push(obs("update-failed", null, null,
      `${set} can't be published: ${passed(sets, set) ? "the systems' tree files differ or one is missing" : failingChecks(sets, set)}`));
  }
  // Kept apart: the workflow passes them on only once this set is published
  // (an unpublished set's notes name versions that never shipped, and its
  // guard-reviewed would close the published version's issue).
  const guard = ok ? [...guardReview(sets.get(set)!, chosen), ...electronIssues(sets.get(set)!, trusted?.(set) ?? null)] : [];
  return { ok, tree: ok ? tree : null, observations, guard, move: ok ? moveOf(st, set) : null };
}

/** What a published set says about each channel's Electron fallback (the
 * issue `electron-fallback/<channel>/-`): the problem while its tested tree
 * has an active entry (detail: the entry's short nixpkgs revision, so a
 * nightly that keeps failing on the same nixpkgs doesn't edit the issue),
 * or `electron-ok` when it has none and the forced nixpkgs check really
 * passed on every system (not "not applicable"). Passed on only once the
 * set is published, like the guard notes. */
export function electronIssues(s: SetResult, tree: { active: Channel[]; read: Reader } | null = null): Observation[] {
  const out: Observation[] = [];
  for (const c of CHANNELS) {
    const evs = SYSTEMS.map((sys) => s.perSystem.get(sys)?.electron?.channels[c]);
    if (evs.some((e) => !e)) continue;
    // From the published tree when known (the workflow), else the evidence.
    const active = tree ? tree.active.includes(c) : evs.some((e) => e!.active);
    if (active) {
      const rev = tree ? pairOf(tree.read, c)?.nixpkgs : evs[0]!.pair?.nixpkgs;
      out.push(obs("electron-fallback", c, null, `nixpkgs ${rev?.slice(0, 12) ?? "?"}`));
    } else if (evs.every((e) => !e!.forcedNotApplicable && e!.runtime.length && e!.runtime.every((n) => e!.passed.includes(n)))) {
      out.push(obs("electron-ok", c, null, ""));
    }
  }
  return out;
}

/** The final tree's files: an input's file when the input is in `names`,
 * else the checkout's (the candidate's base). */
export function finalReader(cdir: string, inputs: Input[], names: string[], root = join(VERSIONS, "..")): Reader {
  const own = new Map<string, string>();
  for (const i of inputs) if (names.includes(i.name)) for (const f of i.files) own.set(f, join(cdir, "files", f));
  return (path) => {
    const f = own.get(path) ?? join(root, path);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  };
}

/** Whether publishing this set moves the snapshot: when it's behind, only
 * if stable-next passed completely on every system and every system's
 * equivalence step accepted the same moved tree. `reason` says why not, for
 * the stable-behind issue: stable-next failed, had no complete result, the
 * equivalence step refused, or nixpkgs builds are missing from the cache
 * (an unchecked cache counts as incomplete). */
export function moveOf(st: Stable, set: string): { behind: boolean; tree: string | null; reason: string } {
  const files = SYSTEMS.map((sys) => st.get(set)?.get(sys));
  if (files.some((f) => !f)) return { behind: true, tree: null, reason: "stable-next had no complete result" };
  if (files.every((f) => !f!.behind)) return { behind: false, tree: null, reason: "" };
  const next = groupOf(st, set, "stableNext");
  if (next.state === "fail") return { behind: true, tree: null, reason: `stable-next failed: ${cut(next.failed)}` };
  if (next.state === "incomplete") return { behind: true, tree: null, reason: "stable-next had no complete result" };
  const moves = files.map((f) => f!.move);
  const refused = moves.find((m) => m && !m.ok && !m.reason.startsWith("incomplete"));
  if (refused) {
    return { behind: true, tree: null, reason: /cache\.nixos\.org lacks/.test(refused.reason) ? refused.reason : `the equivalence step refused the move: ${refused.reason}` };
  }
  if (moves.some((m) => !m?.ok)) return { behind: true, tree: null, reason: "stable-next had no complete result" };
  const trees = new Set(moves.map((m) => m!.tree));
  if (trees.size !== 1) return { behind: true, tree: null, reason: "the equivalence step refused the move: the systems' moved trees differ" };
  return { behind: true, tree: [...trees][0], reason: "" };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [cmd, cdir, rdir, set, names] = args.filter((a) => !a.startsWith("--electron="));
  const electron = (args.find((a) => a.startsWith("--electron="))?.slice(11) ?? "").split(",").filter(Boolean) as Channel[];
  const inputs = cdir ? loadCandidate(cdir).inputs : [];
  // Each set's tree, from the candidate: main is the checkout, an input set
  // base plus that input, candidate every input, and the verdict's set its
  // names plus the fallback channels decide gave it.
  const trusted: Trusted = (s) => {
    const all = inputs.map((i) => i.name);
    const setNames = s === "main" ? [] : s === "candidate" ? all : s === set && names !== undefined ? names.split(",").filter(Boolean)
      : all.includes(s) ? [s] : null;
    if (setNames === null || !cdir) return null;
    const read = finalReader(cdir, inputs, setNames);
    const active = [...new Set([...activeChannels(read), ...(s === set ? electron.filter((c) => pairOf(read, c)) : [])])];
    return { active, read };
  };
  if (cmd === "plan" && rdir) {
    // set (the 4th argument) is where the observations go: stable-broken or
    // stable-ok when the candidate's stable result is main's.
    const st = loadStable(rdir);
    const sets = plan(inputs, load(rdir, trusted), st);
    if (set) writeFileSync(set, JSON.stringify({ observations: stableEvidence(st, "candidate") }, null, 2));
    console.log(sets === null ? "failed=false" : `failed=true\nsets=${JSON.stringify(sets)}\nstable-sets=${JSON.stringify(stableSets(sets))}`);
  } else if (cmd === "decide" && rdir) {
    console.log(JSON.stringify(decide(inputs, load(rdir, trusted), loadStable(rdir),
      (names, c) => pairOf(finalReader(cdir, inputs, names), c)), null, 2));
  } else if (cmd === "verdict" && rdir && set && names !== undefined) {
    console.log(JSON.stringify(verdict(inputs, rdir, set, names.split(",").filter(Boolean), trusted), null, 2));
  } else {
    console.error("usage: narrow.ts plan CANDIDATE_DIR RESULTS_DIR [OBS_FILE] | decide CANDIDATE_DIR RESULTS_DIR | verdict CANDIDATE_DIR RESULTS_DIR SET NAMES");
    process.exit(2);
  }
}
