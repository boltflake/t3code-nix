// The hourly backstop's checks (health.yml): is the watcher alive, can it
// still authenticate, and has every version it saw reached main?
//
//   node health.ts HEALTH_JSON_OR_ERROR_FILE
//
// Reads the watcher's /health reply (or, if fetching it failed, a file whose
// content is the error), the pins in versions/ and the open issues, and
// prints {observations} for issues.ts:
//   watcher-stalled  no reply, a cron key's heartbeat older than 30 min, or
//                    a source, the dispatch or a timed send (pages.yml,
//                    health.yml) failing for over 6 hours
//   watcher-auth     GitHub, the dispatch or a timed send reports an auth
//                    error (a 401, or a 403 that isn't a rate limit)
//   watcher-healthy  none of these (three in a row close watcher-* issues)
//   update-lag       a version the watcher saw over 60 minutes ago isn't on
//                    main, its source isn't failing (its entry may be old),
//                    no open pin issue names that package and version,
//                    env-broken isn't open, and it isn't still on its way:
//                    an update run is going on main (or waiting for a runner
//                    just after one finished) and no run that read upstream
//                    since the watcher saw it has finished its work (a
//                    replaced or gate re-dispatched one did none). Runs go
//                    one at a time, so a release can wait behind a long one.
//                    A queue that never starts (the runs it replaces
//                    hand over nothing), a run in progress for over 12
//                    hours, or a run that finished without it, still lags; health.yml's own dispatch
//                    excuses nothing once that run is done
//   lag-ok           the package is on the watcher's version, or an open
//                    lag issue's version is on main or upstream moved past it
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB, versionOfTag } from "../../shared/sources.ts";
import { CRONS } from "../../watcher/src/watcher.ts";
import { VERSIONS } from "../lib/util.ts";
import { compareVersions, obs, type Observation } from "../update.ts";
import { client, type Issue, type UpdateRun } from "./gh.ts";
import { metaOf } from "./issues.ts";

export const STALE_MS = 30 * 60_000;
export const STUCK_MS = 6 * 60 * 60_000;
export const LAG_MS = 60 * 60_000;
/** How long a waiting run counts as going after a real run finished: the
 * next one waits for a runner, not a stuck queue. */
export const HANDOVER_MS = 15 * 60_000;
/** Whether key state S's ENTRY is a fresh reading: entries of a failing
 * source may be old; of a partly failing one (error.unread), only those it
 * couldn't read. Vendor entries are named after their source; the rest come
 * from `github`. */
export function readEntry(s: any, entry: string): boolean {
  const error = (s?.sources?.[entry] ?? s?.sources?.github)?.error;
  return !error || (typeof error.unread === "string" && !entry.startsWith(error.unread));
}

export const CRON_KEYS = Object.values(CRONS).map((c) => c.key);

/** The pins each watcher entry stands for. */
const PINS: Record<string, string[]> = {
  "t3code/latest": ["t3code", "t3"],
  "t3code/nightly": ["t3code-nightly", "t3-nightly"],
};
export const pinsOf = (entry: string) => PINS[entry] ?? (entry.includes("/") ? [] : [entry]);

export function assess(health: any, error: string | null, pins: Record<string, string>, issues: Issue[], now: Date,
  runs: UpdateRun[] = []): Observation[] {
  const t = now.getTime();
  const out: Observation[] = [];
  const keys: Record<string, any> = health?.keys ?? {};
  // Both cron keys, each with a valid heartbeat no older than 30 minutes;
  // anything less is no evidence of health.
  const stale = CRON_KEYS.filter((k) => {
    const at = Date.parse(keys[k]?.written ?? "");
    return !Number.isFinite(at) || t - at > STALE_MS;
  });
  if (error !== null || !health || stale.length) {
    out.push(obs("watcher-stalled", null, null, error !== null ? `/health: ${error}`
      : `no valid heartbeat in the last 30 minutes: ${stale.join(", ")}`));
    return out; // nothing else in it can be trusted
  }
  const states = CRON_KEYS.map((k) => keys[k]);
  const failing = states.flatMap((s) => [
    ...Object.entries<any>(s.sources ?? {}).filter(([, v]) => v?.error).map(([name, v]) => ({ name, ...v.error })),
    ...(s.dispatch?.error ? [{ name: "dispatch", ...s.dispatch.error }] : []),
    ...Object.entries<any>(s.timed ?? {}).filter(([, v]) => v?.error).map(([name, v]) => ({ name, timed: true, ...v.error })),
  ]);
  const auth = failing.filter((f) => f.kind === "auth" && (f.name === "github" || f.name === "dispatch" || f.timed));
  const stuck = failing.filter((f) => t - Date.parse(f.since) > STUCK_MS);
  if (auth.length) out.push(obs("watcher-auth", null, null, auth.map((f) => `${f.name}: ${f.message}`).sort().join("; ")));
  if (stuck.length) out.push(obs("watcher-stalled", null, null, `failing for over 6 hours: ${stuck.map((f) => f.name).sort().join(", ")}`));
  if (!auth.length && !stuck.length) out.push(obs("watcher-healthy", null, null, ""));

  // Only fresh readings count (readEntry).
  const entries: [string, { version: string; firstSeen: string }][] = states.flatMap((s) =>
    Object.entries<any>(s.entries ?? {}).filter(([entry]) => readEntry(s, entry)));
  const upstream = new Map<string, string>(); // package -> the version the watcher selects
  for (const [entry, { version }] of entries) for (const pkg of pinsOf(entry)) upstream.set(pkg, version);

  const open = issues.filter((i) => i.state === "open").map(metaOf).filter((m) => m !== null);
  const envBroken = open.some((m) => m.key.startsWith("env-broken/"));
  // An open update-lag issue about a version that is now on main, or that
  // upstream has moved past, is over (a lag for the newer version, once it
  // is late, opens its own).
  for (const m of open) {
    const [kind, pkg] = m.key.split("/");
    if (kind !== "update-lag" || !(pkg in pins)) continue;
    if (pins[pkg] === m.version || (upstream.has(pkg) && upstream.get(pkg) !== m.version)) out.push(obs("lag-ok", pkg, pins[pkg], ""));
  }
  // What explains a lag: an open issue about that package's pin (no
  // channel) and that version, or a resolve failure (it may name no version).
  // Not a guard review: that version ships anyway. Not a downgrade: it
  // holds nothing, so a pin still on the pulled version lags as usual.
  const explained = (pkg: string, version: string) => open.some((m) => {
    const [kind, p, channel] = m.key.split("/");
    return p === pkg && channel === "-" && kind !== "update-lag" && kind !== "guard-review" && kind !== "downgrade"
      && ((m.version !== null && versionOfTag(m.version) === version) || (kind === "resolve-failed" && m.version === null));
  });
  // Still on its way: a run is going (or waiting just after one that ran
  // finished: handed over, or waiting for a runner), and none that read
  // upstream since the watcher saw it has finished its work.
  const going = runs.some((r) => r.running) || (runs.some((r) => r.waiting)
    && runs.some((r) => r.ran && r.finished !== null && t - Date.parse(r.finished) <= HANDOVER_MS));
  const onItsWay = (firstSeen: string) => going && !runs.some((r) => r.done && Date.parse(r.read) > Date.parse(firstSeen));
  for (const [entry, { version, firstSeen }] of entries) {
    for (const pkg of pinsOf(entry)) {
      if (!(pkg in pins)) continue;
      if (pins[pkg] === version) {
        out.push(obs("lag-ok", pkg, version, ""));
        continue;
      }
      // A `tags` package's watcher reading below the pin is the window's
      // (other tags crowding it; the updater keeps the pin), never a lag.
      if (GITHUB[pkg]?.tags && compareVersions(version, pins[pkg]) === -1) continue;
      if (t - Date.parse(firstSeen) <= LAG_MS || envBroken || onItsWay(firstSeen) || explained(pkg, version)) continue;
      out.push(obs("update-lag", pkg, version, `the watcher saw ${version} at ${firstSeen}; main has ${pins[pkg]}`));
    }
  }
  return out;
}

/** A fetch error as one stable line, so the same failure reads the same
 * every hour (curl puts elapsed times in its messages). */
export const errorLine = (text: string) =>
  (text.trim().split("\n")[0] || "no reply").replace(/\d+ (milli)?seconds?/g, "the time limit").slice(0, 300);

if (import.meta.main) {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error("usage: health.ts HEALTH_JSON_OR_ERROR_FILE");
    process.exit(2);
  }
  const text = existsSync(file) ? readFileSync(file, "utf8") : "no reply";
  let health: any = null;
  let error: string | null = null;
  try {
    health = JSON.parse(text);
  } catch {
    error = errorLine(text);
  }
  const pins = Object.fromEntries(readdirSync(VERSIONS).filter((f) => f.endsWith(".json"))
    .map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(VERSIONS, f), "utf8")).version]));
  const gh = client();
  // Unknown counts as no run going: a lag then shows rather than hides.
  const runs = await gh.updateRuns().catch((e) => {
    console.warn(`health: couldn't list update runs: ${e?.message ?? e}`);
    return [];
  });
  const observations = assess(health, error, pins, await gh.issues(), new Date(), runs);
  console.log(JSON.stringify({ observations }, null, 2));
}
