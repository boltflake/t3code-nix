// Turn a run's observations into GitHub issues (the issues job: the only
// writer of issues besides health.yml's issue step; they share a concurrency
// group).
//
//   node issues.ts OBSERVATIONS_JSON... [--run-ok]
//
// Each problem has one issue, found by label and by the key hidden in its
// body (kind/package/channel), never by search. The body also records the
// version and detail it's about, and for watcher issues a count of healthy
// checks.
//   new problem      open an issue
//   same again       nothing, except one reminder comment a day
//   changed problem  a comment (new version or different detail)
//   recovery         close with a comment, only on positive evidence that
//                    proves the fix; errors and skipped checks are "unknown"
//   recurrence       reopen
//
// --run-ok: the run had no infrastructure failure (closes update-failed).
// Environment: RUN_URL, DRY_RUN, SEEN_AT, GITHUB_RUN_ATTEMPT.
//
// Update runs go one at a time, so their news arrives in the order they read
// upstream, except a re-run of an old run's failed jobs, which keeps its
// original reading (and checkout). Neither run IDs (dispatch order) nor
// version order (upstream can roll back) say which news is newer; when a run
// read upstream does. SEEN_AT is that time (the resolve job's, or now for a run
// that never resolved); each issue records the latest it was reported or
// closed with, and an earlier reading never changes it. Except a run's own
// failure (update-failed), which is about that run, not about upstream: it
// always counts, so it can't vanish behind a later-reading run's success.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { SYSTEMS } from "../lib/util.ts";
import { ALL, compareVersions, type Observation } from "../update.ts";
import { client, type Client, type Issue } from "./gh.ts";

export const PROBLEMS = new Set(["test-failed", "combination-failed", "integrity", "no-match", "env-broken",
  "nondeterministic", "update-failed", "latest-mismatch", "resolve-failed", "tag-mismatch",
  "watcher-stalled", "watcher-auth", "update-lag", "guard-review", "bump-waiting",
  "stable-behind", "stable-broken", "stable-unfetchable", "electron-fallback", "downgrade",
  // agent-browser's optional browsers (lib/browserpins.ts, ci/variants.ts).
  "browser-waiting", "browser-failed"]);

// Positive evidence: the problem kinds an observation closes, and the fields
// that must match. Evidence only closes what it proves. A resolver `pass`
// at V means upstream points at V and V's downloads are already pinned on
// main, which passed the suite: it closes the pin's source problems, and a
// test failure at V (main has it) or at another version (superseded).
// `on-main` is the same proof for an input without a resolver (nixpkgs: the
// revision main locks), and only for that exact version, since a newer held
// revision isn't superseded by an older one on main.
// Pin observations carry no channel (see update.ts), so a pin's `pass` only
// closes that pin's problems, never npm's or the release stream's.
// A bump-waiting issue records the revision main was stuck at; `on-main` at
// any other revision means a publish moved flake.lock since, which closes
// it. Routine `on-main` at the same revision doesn't.
// A downgrade issue tracks the version upstream pulled (its `version`) and
// the last move's destination (`to`): a pin's `pass` closes it at or above
// the tracked version, or at one compareVersions can't order against it but
// orders above the destination (a newer nightly of the pulled one's base).
// A browser-failed issue (a pin's or the stable set's chromium or
// google-chrome on the published tree) closes only once every system's
// variant passed in the same run (`browser-ok`, the system as its detail): a
// pass on one system while the other's result is missing proves nothing.
interface Rule { kinds: Set<string>; match: ("package" | "channel")[]; sameVersion?: boolean; otherVersion?: boolean; caughtUp?: boolean;
  allSystems?: boolean }
export const CLOSES: Record<string, Rule | Rule[]> = {
  pass: [{ kinds: new Set(["integrity", "no-match", "resolve-failed"]), match: ["package", "channel"] },
    { kinds: new Set(["downgrade"]), match: ["package", "channel"], caughtUp: true }],
  "on-main": [{ kinds: new Set(["test-failed", "combination-failed"]), match: ["package"], sameVersion: true },
    { kinds: new Set(["bump-waiting"]), match: ["package"], otherVersion: true },
    // A browser pin's wait is about the main revision it started from: main
    // moving on ends it.
    { kinds: new Set(["browser-waiting"]), match: ["package"], otherVersion: true }],
  // The release stream (package "t3code-releases"), not the t3code pins.
  "releases-ok": { kinds: new Set(["no-match", "resolve-failed"]), match: ["package"] },
  "npm-ok": { kinds: new Set(["resolve-failed"]), match: ["package", "channel"] },
  // A browser pin (or the nixpkgs bump) declining a move read its source:
  // only that is proven, never a test failure at another revision.
  waiting: { kinds: new Set(["resolve-failed"]), match: ["package", "channel"] },
  "test-passed": { kinds: new Set(["test-failed", "combination-failed"]), match: ["package"] },
  "latest-match": { kinds: new Set(["latest-mismatch"]), match: ["package"] },
  "env-ok": { kinds: new Set(["env-broken"]), match: [] },
  // A held version emits `held`, not `pass`: the pin's source works.
  held: { kinds: new Set(["resolve-failed"]), match: ["package", "channel"] },
  // Infrastructure failures carry no channel; the cache job's (licence
  // checks, per system) close only on that system's cache-ok.
  "run-ok": { kinds: new Set(["update-failed"]), match: ["channel"] },
  "cache-ok": { kinds: new Set(["nondeterministic", "update-failed"]), match: ["channel"] },
  "tag-ok": { kinds: new Set(["tag-mismatch"]), match: [] },
  "watcher-healthy": { kinds: new Set(["watcher-stalled", "watcher-auth"]), match: [] },
  "lag-ok": { kinds: new Set(["update-lag"]), match: ["package"] },
  // A published set whose guard checks noted nothing for the package.
  "guard-reviewed": { kinds: new Set(["guard-review"]), match: ["package"] },
  // NixOS stable: the snapshot equals main's pins (publish, or resolve's
  // file comparison); a complete pass of main's stable set on both systems;
  // every download the snapshot pins answered.
  "stable-current": { kinds: new Set(["stable-behind"]), match: [] },
  "stable-ok": { kinds: new Set(["stable-broken"]), match: [] },
  fetchable: { kinds: new Set(["stable-unfetchable"]), match: [] },
  // The desktop app's Electron: no active fallback for that channel (resolve,
  // from main's file), or a published set whose nixpkgs runtime passed.
  "electron-ok": { kinds: new Set(["electron-fallback"]), match: ["package"] },
  // A browser pin with nothing holding its move on the optional browsers
  // (lib/browserpins.ts): ends its three-day wait.
  "browsers-ready": { kinds: new Set(["browser-waiting"]), match: ["package"] },
  "browser-ok": { kinds: new Set(["browser-failed"]), match: ["package", "channel"], allSystems: true },
};
// A resolver `pass` closes test failures of its package too (see above).
const CLOSED_BY_PASS = new Set(["test-failed", "combination-failed"]);
// Issue kinds about one package; only these close when the package is gone.
const PACKAGE_SCOPED = new Set(["test-failed", "combination-failed", "integrity", "latest-mismatch", "resolve-failed", "update-lag",
  "guard-review", "no-match", "bump-waiting", "downgrade", "browser-waiting"]);
// Valid inputs that aren't packages in versions/.
const NON_PACKAGE_INPUTS = new Set(["nixpkgs", "t3code-releases"]);
const WATCHER = new Set(["watcher-stalled", "watcher-auth"]);
// About the run itself, not about what it read upstream.
const RUN_SCOPED = new Set(["update-failed"]);
export const WATCHER_CLEAN_CHECKS = 3;
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;
const META = /<!-- t3code-nix: (\{.*?\}) -->/s;

interface Meta {
  key: string;
  version: string | null;
  detail: string;
  clean: number;
  reminded: string | null;
  /** When the latest run that reported or closed it read upstream, or null. */
  seen: string | null;
  /** A downgrade's last move (`version` is the tracked, pulled version). */
  from?: string;
  to?: string;
  /** A browser-waiting issue's start: written when it opens, kept while it
   * stays open (whatever browser or revision it's about), the clock for
   * the pin's three-day wait. */
  since?: string;
}

/** Problem kinds that hold the exact version they name: the updater skips
 * that version until a run with nothing else new retries it, or the issue
 * closes.
 * Only test failures: the others never name a version the updater would
 * propose again (an unverified integrity change keeps the old pin anyway). */
export const HOLD_KINDS = new Set(["test-failed", "combination-failed"]);

/** The start of each browser pin's open wait (browser-waiting) and the main
 * revision it started from, as the updater reads them (HELD_JSON, entries
 * with `since`). */
export function waitingStarts(issues: Issue[]): { package: string; since: string; from: string | null }[] {
  const starts: { package: string; since: string; from: string | null }[] = [];
  for (const issue of issues) {
    if (issue.state !== "open") continue;
    const meta = metaOf(issue);
    const [kind, pkg] = meta?.key.split("/") ?? [];
    if (kind === "browser-waiting" && pkg !== "-" && meta?.since) starts.push({ package: pkg, since: meta.since, from: meta.version });
  }
  return starts;
}

/** The scopes (browser pins, or the stable set's) with an open
 * browser-failed issue: their variants run again at the next publish
 * (ci/variants.ts args). */
export function retestScopes(issues: Issue[]): string[] {
  const scopes = new Set<string>();
  for (const issue of issues) {
    if (issue.state !== "open") continue;
    const [kind, pkg] = metaOf(issue)?.key.split("/") ?? [];
    if (kind === "browser-failed" && pkg && pkg !== "-") scopes.add(pkg);
  }
  return [...scopes].sort();
}

/** The versions held by open issues, as the updater reads them (HELD_JSON). */
export function heldVersions(issues: Issue[]): { package: string; version: string }[] {
  const held: { package: string; version: string }[] = [];
  for (const issue of issues) {
    if (issue.state !== "open") continue;
    const meta = metaOf(issue);
    if (!meta?.version) continue;
    const [kind, pkg] = meta.key.split("/");
    if (HOLD_KINDS.has(kind) && pkg !== "-") held.push({ package: pkg, version: meta.version });
  }
  return held;
}

export const keyOf = (o: Observation) => `${o.kind}/${o.package ?? "-"}/${o.channel ?? "-"}`;
/** The metadata hidden in an issue body, or null if there's none or it's
 * malformed (issue bodies can be edited by hand). Malformed ones are skipped
 * with a warning; they never stop the run. */
export const metaOf = (i: Issue): Meta | null => {
  const m = META.exec(i.body ?? "");
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]);
    const str = (v: unknown) => typeof v === "string";
    const ok = str(raw?.key) && raw.key.split("/").length === 3
      && (raw.version === null || str(raw.version))
      && (raw.detail == null || str(raw.detail))
      && (raw.reminded == null || (str(raw.reminded) && !Number.isNaN(Date.parse(raw.reminded))))
      && (raw.clean == null || (Number.isInteger(raw.clean) && raw.clean >= 0 && raw.clean <= WATCHER_CLEAN_CHECKS))
      && (raw.seen == null || (str(raw.seen) && !Number.isNaN(Date.parse(raw.seen))))
      && (raw.from == null || str(raw.from)) && (raw.to == null || str(raw.to))
      && (raw.since == null || (str(raw.since) && !Number.isNaN(Date.parse(raw.since))));
    // Only known, checked fields are kept (a downgrade's move only when set).
    if (ok) {
      return { key: raw.key, version: raw.version, detail: raw.detail ?? "", clean: raw.clean ?? 0, reminded: raw.reminded ?? null, seen: raw.seen ?? null,
        ...(raw.from != null ? { from: raw.from } : {}), ...(raw.to != null ? { to: raw.to } : {}),
        ...(raw.since != null ? { since: raw.since } : {}) };
    }
  } catch { /* fall through */ }
  console.warn(`issues: #${i.number} has malformed t3code-nix metadata; skipped`);
  return null;
};
// `<` and `>` escaped, so text from upstream can't end the comment early
// (JSON.parse reads the escapes back).
const sorted = (m: Meta) => JSON.stringify(Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b))))
  .replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
/** How much of a detail (often upstream's text) is kept; a run's details
 * for one key, joined, three times that. */
export const DETAIL_MAX = 2000;
/** Text inside an inline code span, so Markdown, HTML and @mentions in it
 * do nothing: the fence is one backtick longer than any run inside, and
 * padded with spaces so a backtick at either end can't join it. */
const inline = (text: string) => {
  const fence = "`".repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence} ${text.replace(/\n/g, " ")} ${fence}`;
};
/** A detail as shown: in a code block, so Markdown and @mentions in
 * upstream's text do nothing. */
const shown = (text: string) => {
  if (!text) return "";
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}\n${text}\n${fence}`;
};

function render(o: Observation, meta: Meta): string {
  if (o.kind === "downgrade") return renderDowngrade(o, meta);
  let who = o.package ?? "all packages";
  if (o.channel) who += ` (${o.channel})`;
  return [`<!-- t3code-nix: ${sorted(meta)} -->`,
    `**${o.kind}** for ${who}${o.version ? `, version ${inline(o.version)}` : ""}`, "", shown(o.detail ?? ""), "",
    "Opened and closed by t3code-nix's update workflow."].join("\n");
}
/** A downgrade's body: the move, the version it waits for, what to expect. */
function renderDowngrade(o: Observation, meta: Meta): string {
  const pkg = o.package ?? "-";
  return [`<!-- t3code-nix: ${sorted(meta)} -->`,
    `**downgrade** for ${pkg}: upstream moved it back from ${inline(meta.from ?? "?")} to ${inline(meta.to ?? o.version ?? "?")}.`,
    "", shown(o.detail ?? ""), "",
    `\`main\` follows once ${inline(meta.to ?? o.version ?? "?")} passes the tests (or has it already); nothing is held back. `
      + `This closes once ${pkg} is back at ${inline(meta.version ?? "?")} or higher.`, "",
    "Opened and closed by t3code-nix's update workflow."].join("\n");
}
const title = (o: Observation, meta?: Meta) => o.kind === "downgrade"
  ? `downgrade: ${o.package ?? "all"} (${meta?.version ?? o.from ?? o.version} pulled)`
  : `${o.kind}: ${o.package ?? "all"}${o.channel ? ` (${o.channel})` : ""}`;
/** Whether a pin at `at` (its `pass`) is back from a downgrade: at or above
 * the tracked version, or not orderable against it but above the last
 * move's destination. */
const caughtUp = (at: string | null, meta: Meta) => {
  if (!at || !meta.version) return false;
  const order = compareVersions(at, meta.version);
  return order === null ? !!meta.to && compareVersions(at, meta.to) === 1 : order >= 0;
};
/** The version a downgrade issue tracks after this move: the higher of the
 * old tracked one and the pulled one; a pair that can't be ordered keeps
 * the old. */
const tracked = (old: string | null, pulled: string) => old === null || compareVersions(old, pulled) === -1 ? pulled : old;
// A function, not a replacement string: `$&` and the like in a detail stay.
const withMeta = (body: string, meta: Meta) => body.replace(META, () => `<!-- t3code-nix: ${sorted(meta)} -->`);

export async function apply(observations: Observation[], gh: Client, now: Date, runUrl = "", packages: Set<string> | null = null,
  seenAt: string | null = null) {
  // When this run read upstream; an earlier reading never changes an issue
  // (see the top).
  const seen = seenAt !== null && Number.isFinite(Date.parse(seenAt)) ? new Date(Date.parse(seenAt)).toISOString() : null;
  const counts = (meta: Meta) => seen === null || meta.seen === null || Date.parse(seen) >= Date.parse(meta.seen);
  const newest = (meta: Meta) => (seen !== null && counts(meta) ? seen : meta.seen);
  observations = observations.map((o) => ({ ...o, detail: (o.detail ?? "").slice(0, DETAIL_MAX) }));
  // One issue per key. Should two share one (a hand-edited body fixed after
  // a replacement was opened), the open one counts, else the newest; an
  // older open one is closed as a duplicate, so it holds nothing.
  const byKey = new Map<string, { issue: Issue; meta: Meta }>();
  const duplicates: Issue[] = [];
  const better = (a: Issue, b: Issue) => (a.state === "open") !== (b.state === "open") ? a.state === "open" : a.number > b.number;
  for (const issue of await gh.issues()) {
    const meta = metaOf(issue);
    if (!meta) continue;
    const had = byKey.get(meta.key);
    if (!had || better(issue, had.issue)) {
      if (had) duplicates.push(had.issue);
      byKey.set(meta.key, { issue, meta });
    } else {
      duplicates.push(issue);
    }
  }
  for (const issue of duplicates) {
    if (issue.state !== "open") continue;
    const kept = byKey.get(metaOf(issue)!.key)!.issue;
    await gh.comment(issue.number, `Closing: a duplicate of #${kept.number}, which tracks this now.`);
    await gh.editIssue(issue.number, { state: "closed" });
  }
  const stamp = now.toISOString();
  // The run's link after the note; on its own line after a code block.
  const say = (text: string) => (runUrl ? `${text}${text.includes("\n") ? "\n\n" : " "}${runUrl}` : text);
  const close = async (key: string, reason: string) => {
    const { issue, meta } = byKey.get(key)!;
    // The closing reading is recorded too, so an earlier run's late report
    // can't reopen it.
    const closed = { ...meta, seen: newest(meta) };
    const body = withMeta(issue.body, closed);
    await gh.comment(issue.number, say(`Closing: ${reason}.`));
    await gh.editIssue(issue.number, body === issue.body ? { state: "closed" } : { body, state: "closed" });
    byKey.set(key, { issue: { ...issue, body, state: "closed" }, meta: closed });
  };

  if (packages) {
    for (const [key, { issue, meta }] of byKey) {
      const [kind, pkg] = key.split("/");
      // `packages` is this run's checkout: an issue from a later reading may
      // be about a package added since.
      if (issue.state === "open" && PACKAGE_SCOPED.has(kind) && pkg !== "-" && !NON_PACKAGE_INPUTS.has(pkg) && !packages.has(pkg)
        && counts(meta)) {
        await close(key, `${pkg} is no longer packaged`);
      }
    }
  }

  // One observation per problem key: if a run reports the same key more
  // than once (update-failed from several jobs), the last one's version
  // stands and the distinct details are joined, sorted, so the issue's detail
  // doesn't depend on the order the files were read in, and a specific one
  // isn't lost. A lone detail is kept as it is.
  const problems = new Map<string, Observation>();
  const details = new Map<string, Set<string>>();
  for (const o of observations) {
    if (!PROBLEMS.has(o.kind)) continue;
    const key = keyOf(o);
    if (!details.has(key)) details.set(key, new Set());
    if (o.detail) details.get(key)!.add(o.detail);
    const all = [...details.get(key)!];
    problems.set(key, { ...o, detail: all.length > 1 ? all.sort().join("\n\n").slice(0, 3 * DETAIL_MAX) : all[0] ?? "" });
  }

  for (const [key, o] of problems) {
    // A downgrade tracks the version upstream pulled, and its last move.
    const down = o.kind === "downgrade";
    const to = o.to ?? o.version ?? undefined;
    const fresh: Meta = down
      ? { key, version: o.from ?? o.version, detail: o.detail, clean: 0, reminded: stamp, seen, ...(o.from ? { from: o.from } : {}), ...(to ? { to } : {}) }
      : { key, version: o.version, detail: o.detail, clean: 0, reminded: stamp, seen };
    const found = byKey.get(key);
    // A browser wait's clock starts when its issue opens (or reopens), or
    // when main's revision it's about changes, and otherwise stays.
    if (o.kind === "browser-waiting") {
      fresh.since = found?.issue.state === "open" && found.meta.since && found.meta.version === o.version ? found.meta.since : (seen ?? stamp);
    }
    if (!found) {
      const body = render(o, fresh) + (runUrl ? `\n\nFirst seen in ${runUrl}` : "");
      const created = await gh.createIssue(title(o, fresh), body);
      byKey.set(key, { issue: { ...created, state: "open", body }, meta: fresh });
      continue;
    }
    const { issue, meta: old } = found;
    // An earlier reading: nothing changes, not even a reopen. A run's own
    // failure always counts (see the top).
    // Only the run's own failure (no channel) ignores reading order; the
    // cache job's verdicts (a system as channel) are about the published
    // tree at that reading, so a re-run's replay can't reopen a newer fix.
    if (!(RUN_SCOPED.has(o.kind) && o.channel === null) && !counts(old)) continue;
    // A downgrade changes only with a different move (its detail follows
    // the move); then it keeps the higher pulled version.
    const changed = down ? old.from !== fresh.from || old.to !== fresh.to : old.version !== o.version || old.detail !== o.detail;
    let meta: Meta | null = null;
    let state: "open" | undefined;
    let note: string | null = null;
    if (issue.state === "closed") {
      [meta, state, note] = [fresh, "open", `It's back.\n\n${shown(o.detail)}`];
    } else if (changed) {
      [meta, note] = [down ? { ...fresh, version: tracked(old.version, fresh.version!) } : fresh, `Changed:\n\n${shown(o.detail || o.version || "")}`];
    } else if (now.getTime() - Date.parse(old.reminded ?? stamp) >= REMIND_AFTER_MS) {
      [meta, note] = [{ ...old, clean: 0, reminded: stamp }, "Still happening."];
    } else if (old.clean) {
      meta = { ...old, clean: 0 };
    }
    // The latest reading is recorded, so earlier evidence can't close it.
    if (meta) meta = { ...meta, seen: newest(old) };
    else if (newest(old) !== old.seen) meta = { ...old, seen: newest(old) };
    if (meta) {
      // Re-rendered when what it's about changed; otherwise only its hidden
      // metadata moves.
      const body = state || changed ? render(o, meta) : withMeta(issue.body, meta);
      // A downgrade's title names the version it tracks.
      const retitle = down && meta.version !== old.version ? { title: title(o, meta) } : {};
      await gh.editIssue(issue.number, { ...retitle, body, ...(state ? { state } : {}) });
      if (note) await gh.comment(issue.number, say(note));
      byKey.set(key, { issue: { ...issue, body, state: state ?? issue.state }, meta });
    }
  }
  const seenProblems = new Set(problems.keys());

  // Watcher issues close after WATCHER_CLEAN_CHECKS healthy checks in a
  // row: any watcher problem in this run starts every open one's count over.
  if ([...problems.values()].some((o) => WATCHER.has(o.kind))) {
    for (const [key, { issue, meta }] of [...byKey]) {
      // An earlier reading's problem doesn't undo newer healthy checks; a
      // newer one starts the count over and records its reading, so healthy
      // checks from before the interruption can't close it later.
      if (issue.state !== "open" || !WATCHER.has(key.split("/")[0]) || seenProblems.has(key) || !counts(meta)) continue;
      const next = { ...meta, clean: 0, seen: newest(meta) };
      if (next.clean === meta.clean && next.seen === meta.seen) continue;
      const body = withMeta(issue.body, next);
      await gh.editIssue(issue.number, { body });
      byKey.set(key, { issue: { ...issue, body }, meta: next });
    }
  }

  // Which systems passed each browser variant in this run (browser-ok).
  const passedOn = new Map<string, Set<string>>();
  for (const o of observations) {
    if (o.kind !== "browser-ok") continue;
    const k = `${o.package ?? "-"}/${o.channel ?? "-"}`;
    if (!passedOn.has(k)) passedOn.set(k, new Set());
    passedOn.get(k)!.add(o.detail ?? "");
  }
  for (const o of observations) for (const rule of [CLOSES[o.kind] ?? []].flat()) {
    if (rule.allSystems && !SYSTEMS.every((sys) => passedOn.get(`${o.package ?? "-"}/${o.channel ?? "-"}`)?.has(sys))) continue;
    const kinds = new Set(rule.kinds);
    if (o.kind === "pass" && !rule.caughtUp) for (const k of CLOSED_BY_PASS) kinds.add(k);
    for (const [key, { issue, meta }] of [...byKey]) {
      const [kind, pkg, channel] = key.split("/");
      if (issue.state !== "open" || !kinds.has(kind) || seenProblems.has(key)) continue;
      if (rule.match.includes("package") && pkg !== (o.package ?? "-")) continue;
      if (rule.match.includes("channel") && channel !== (o.channel ?? "-")) continue;
      if (rule.sameVersion && meta.version !== o.version) continue;
      // A bump-waiting with no version was stuck at no pin at all: any
      // revision on main is a move.
      if (rule.otherVersion && (!o.version || meta.version === o.version)) continue;
      if (rule.caughtUp && !caughtUp(o.version, meta)) continue;
      // Evidence from an earlier reading (see the top).
      if (!counts(meta)) continue;
      if (WATCHER.has(kind)) {
        // A healthy check counts once: only a strictly newer reading.
        if (seen !== null && meta.seen !== null && Date.parse(seen) <= Date.parse(meta.seen)) continue;
        const clean = (meta.clean ?? 0) + 1;
        if (clean < WATCHER_CLEAN_CHECKS) {
          // The healthy reading is recorded, so an earlier one's late
          // problem can't reset the count.
          const next = { ...meta, clean, seen: newest(meta) };
          await gh.editIssue(issue.number, { body: withMeta(issue.body, next) });
          byKey.set(key, { issue: { ...issue, body: withMeta(issue.body, next) }, meta: next });
          continue;
        }
      }
      const superseded = (o.kind === "pass" || o.kind === "test-passed") && meta.version && o.version && meta.version !== o.version;
      await close(key, rule.caughtUp ? `back at ${o.version}` : superseded ? `superseded by ${o.version}` : rule.otherVersion ? `${pkg} moved on to ${o.version}` : "fixed");
    }
  }
}

/** When this run read upstream: SEEN_AT (update.yml's resolve job), or
 * now for a run that never did (health.yml, a resolve that failed early). */
export const seenAt = (env: NodeJS.ProcessEnv, now: Date) => {
  if (env.SEEN_AT && !Number.isFinite(Date.parse(env.SEEN_AT))) {
    console.warn(`issues: SEEN_AT ${JSON.stringify(env.SEEN_AT)} isn't a time; news isn't ordered this run`);
  }
  return env.SEEN_AT || now.toISOString();
};

/** The packages in this run's checkout (its pins, and the updater's list,
 * which names a new package before its first pin lands), for closing issues
 * about packages gone; null (no such closing) unless the run read upstream
 * (SEEN_AT), and never in a re-run (GITHUB_RUN_ATTEMPT above 1, not the
 * `attempt` input): either may have checked out a main from before a
 * package was added. */
export function packagesFor(env: NodeJS.ProcessEnv, dir = "versions", known: string[] = ALL): Set<string> | null {
  if (!env.SEEN_AT || Number(env.GITHUB_RUN_ATTEMPT ?? "1") > 1 || !existsSync(dir)) return null;
  return new Set([...readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)), ...known]);
}

/** The observations in these files. An empty one is what a script that
 * crashed leaves behind: skipped with a warning (its job failed, which the
 * workflow reports as update-failed), so the rest still apply. */
export function readObservations(files: string[], warn = console.warn): Observation[] {
  const observations: Observation[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (!text.trim()) {
      warn(`issues: ${f} is empty; skipped`);
      continue;
    }
    const data = JSON.parse(text);
    observations.push(...(Array.isArray(data) ? data : data.observations ?? []));
  }
  return observations;
}

if (import.meta.main) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const observations = readObservations(files);
  if (process.argv.includes("--run-ok")) observations.push({ kind: "run-ok", package: null, channel: null, version: null, detail: "" });
  const gh = client();
  const at = new Date();
  await apply(observations, gh, at, process.env.RUN_URL ?? "", packagesFor(process.env), seenAt(process.env, at));
  console.log(JSON.stringify({ dryRun: gh.actions ?? null }, null, 2));
}
