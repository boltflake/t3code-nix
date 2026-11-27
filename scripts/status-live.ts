// The status page's live view: each pin's state, from the watcher's /health,
// the unfinished update runs' candidates and the open issues. Pure: the reads
// happen in pages.yml (the runs and issues in a job without secrets, see
// status-reads.ts).
//
// First match wins: up to date, testing, held, found, not checked. A run is
// a fact and an issue is history, so testing comes before held.
import { GITHUB, versionOfTag } from "../shared/sources.ts";
import { CRON_KEYS, pinsOf, readEntry, STALE_MS } from "./ci/health.ts";
import { compareVersions } from "./update.ts";
import type { Pin } from "./lib/util.ts";
import { releaseNotes } from "./lib/util.ts";

/** An unfinished update run and what its candidate tests (validated). */
export interface Run {
  id: number;
  /** When it was created: with several runs testing a pin, the newest wins. */
  created: string;
  /** GitHub's status for it: "requested" when just made, "pending" while
   * it waits behind another run in the update group (it has no jobs yet);
   * then "in_progress", or "queued" whenever one of its jobs waits for a
   * runner (other jobs may be done), or "waiting" for an approval. A Run
   * built without one (in tests) counts as started. */
  status?: string;
  inputs: { name: string; version: string }[];
}
/** An open t3code-nix issue's number and the key and version it is about. */
export interface OpenIssue {
  number: number;
  key: string;
  version: string | null;
}
export type StateName = "up-to-date" | "testing" | "held" | "found" | "not-checked";
export interface PinState {
  state: StateName;
  /** The version being tested, held or found. */
  version?: string;
  /** Held only: why, in a few plain words. */
  reason?: string;
  /** Found only: what the version is waiting for, in a few plain words
   * (see `waitFor`). */
  wait?: string;
  /** The state's own time: the run's creation (testing), the watcher's
   * first sight of the version (held, found). Not an issue's opening: one
   * issue can outlive several versions. */
  since?: string;
  /** The run (testing), the issue (held) or upstream's release notes (found). */
  link?: string;
}
export interface Live {
  /** The older heartbeat of the watcher's usable keys. */
  checked: string;
  states: Record<string, PinState>;
}

/** A key may run this far ahead of our clock and still count. */
export const SKEW_MS = 5 * 60_000;

// Why an issue explains a version, most specific first, in words.
const KIND_ORDER = ["test-failed", "combination-failed", "no-match", "latest-mismatch", "integrity", "resolve-failed"];
const WORDS: Record<string, string> = {
  "test-failed": "tests failed",
  "combination-failed": "failed together with another update",
  "no-match": "no matching release",
  "latest-mismatch": "behind npm's latest tag",
  integrity: "files changed without a new version",
  "resolve-failed": "couldn't read upstream",
  "env-broken": "build environment broken",
  "browser-waiting": "waiting for Chromium or Chrome",
};
const words = (kind: string) => WORDS[kind] ?? kind.replace(/-/g, " ");

/** The usable watcher entries: pin -> version and when the watcher first
 * saw it, and the "checked" time. */
export function upstream(health: any, now: Date): { versions: Map<string, string>; firstSeen: Map<string, string>; checked: string } | null {
  const t = now.getTime();
  const keys: Record<string, any> = health?.keys ?? {};
  const usable = CRON_KEYS.map((k) => keys[k]).filter((k) => {
    const at = Date.parse(k?.written ?? "");
    return Number.isFinite(at) && at <= t + SKEW_MS && t - at <= STALE_MS;
  });
  if (!usable.length) return null;
  const versions = new Map<string, string>(), firstSeen = new Map<string, string>();
  for (const k of usable) {
    for (const [entry, value] of Object.entries<any>(k.entries ?? {})) {
      // Entries a failing source couldn't read may be old: skipped, as the
      // backstop does (a partly failing one keeps the entries it did read).
      if (!readEntry(k, entry)) continue;
      if (typeof value?.version !== "string") continue;
      for (const pin of pinsOf(entry)) {
        versions.set(pin, value.version);
        if (Number.isFinite(Date.parse(value.firstSeen ?? ""))) firstSeen.set(pin, new Date(Date.parse(value.firstSeen)).toISOString());
      }
    }
  }
  const checked = usable.map((k) => new Date(Date.parse(k.written)).toISOString()).sort()[0];
  return { versions, firstSeen, checked };
}

/** The issue that explains `version` of `pin`, as the backstop's lag check
 * decides, picked the same way every time; or null. */
export function explaining(pin: string, version: string, issues: OpenIssue[]): OpenIssue & { kind: string } | null {
  const ranked = issues.flatMap((i) => {
    const [kind, p, channel] = i.key.split("/");
    if (kind === "env-broken") return [{ ...i, kind, tier: 2 }];
    // A lag, a guard review (the version shipped anyway), a downgrade (it
    // holds nothing) or the update notice's issues (they hold nothing
    // either) explain nothing.
    if (p !== pin || channel !== "-" || ["update-lag", "guard-review", "downgrade", "update-feed", "update-notice-off"].includes(kind)) return [];
    if (i.version !== null && versionOfTag(i.version) === version) return [{ ...i, kind, tier: 0 }];
    if (kind === "resolve-failed" && i.version === null) return [{ ...i, kind, tier: 1 }];
    return [];
  });
  const order = (k: string) => (KIND_ORDER.includes(k) ? KIND_ORDER.indexOf(k) : KIND_ORDER.length);
  ranked.sort((a, b) => a.tier - b.tier || order(a.kind) - order(b.kind) || a.number - b.number);
  const best = ranked[0];
  return best ? { number: best.number, key: best.key, version: best.version, kind: best.kind } : null;
}

/** Upstream's release notes for another version of a GitHub pin: its tag
 * with the version swapped, when the tag holds the version. */
function notesFor(pin: Pin, version: string): string | undefined {
  const notes = releaseNotes(pin);
  if (!notes || !pin.tag?.includes(pin.version)) return undefined;
  return notes.replace(encodeURIComponent(pin.tag), encodeURIComponent(pin.tag.replace(pin.version, version)));
}

/** Whether a run has started: anything but just made or behind another run.
 * A run with a candidate has resolved, so it has started whatever its status
 * says (a job of its own waiting in a job-level concurrency group, such as
 * `issues`, might leave the run reported as pending). */
const started = (r: Run) => (r.status !== "requested" && r.status !== "pending") || r.inputs.length > 0;

/** What a found version is waiting for, given the unfinished update runs
 * (none of which tests it, or it would be testing):
 * - a run waits (GitHub keeps one waiting behind the run in progress, and
 *   it reads upstream afresh): "queued for next run";
 * - a run just made, and none running: "run starting";
 * - the run in progress has a candidate without it, and none waits: "not in
 *   this run";
 * - the run in progress has no candidate we can read (not uploaded yet, or
 *   unreadable): "run in progress";
 * - no run at all: "waiting for the next run" (health.yml starts one
 *   every hour). */
export function waitFor(runs: Run[]): string {
  const running = runs.filter(started), waiting = runs.filter((r) => !started(r));
  if (running.length && waiting.length) return "queued for next run";
  if (waiting.length) return "run starting";
  if (running.some((r) => r.inputs.length)) return "not in this run";
  if (running.length) return "run in progress";
  return "waiting for the next run";
}

/** `{since}` for a valid time, normalised; nothing otherwise. */
const since = (at: string | undefined): { since?: string } => {
  const t = Date.parse(at ?? "");
  return Number.isFinite(t) ? { since: new Date(t).toISOString() } : {};
};

/** Every pin's state, or null when the watcher has no usable key. */
export function liveView(pins: Pin[], health: any, runs: Run[], issues: OpenIssue[], repo: string, now: Date): Live | null {
  const up = upstream(health, now);
  if (!up) return null;
  const newestFirst = [...runs].sort((a, b) => b.created.localeCompare(a.created) || b.id - a.id);
  const states: Record<string, PinState> = {};
  for (const pin of pins) {
    const seen = up.versions.get(pin.name);
    if (seen === pin.version) {
      states[pin.name] = { state: "up-to-date" };
      continue;
    }
    const tested = (r: Run) => r.inputs.find((i) => i.name === pin.name && i.version !== pin.version);
    const run = newestFirst.find(tested);
    if (run) {
      const version = tested(run)!.version;
      states[pin.name] = { state: "testing", version, ...since(run.created), link: `https://github.com/${repo}/actions/runs/${run.id}` };
      continue;
    }
    if (seen === undefined && typeof (pin as any).channel === "string") {
      // A browser pin follows a NixOS channel on its own schedule, so the
      // watcher has no version for it: current unless an issue holds it or
      // its next revision can't be resolved.
      const issue = issues.find((i) => i.key.split("/")[1] === pin.name
        && ["test-failed", "combination-failed", "bump-waiting", "browser-waiting", "resolve-failed"].includes(i.key.split("/")[0]));
      states[pin.name] = issue
        ? { state: "held", version: issue.version ?? pin.version, reason: words(issue.key.split("/")[0]), link: `https://github.com/${repo}/issues/${issue.number}` }
        : { state: "up-to-date" };
      continue;
    }
    if (seen === undefined) {
      states[pin.name] = { state: "not-checked" };
      continue;
    }
    // A `tags` package's reading below the pin is the window's (other tags
    // crowding the pinned one out; the updater keeps the pin), not a release.
    if (GITHUB[pin.name]?.tags && compareVersions(seen, pin.version) === -1) {
      states[pin.name] = { state: "up-to-date" };
      continue;
    }
    const issue = explaining(pin.name, seen, issues);
    if (issue) {
      states[pin.name] = { state: "held", version: seen, reason: words(issue.kind), ...since(up.firstSeen.get(pin.name)), link: `https://github.com/${repo}/issues/${issue.number}` };
      continue;
    }
    const link = notesFor(pin, seen);
    states[pin.name] = { state: "found", version: seen, wait: waitFor(runs), ...since(up.firstSeen.get(pin.name)), ...(link ? { link } : {}) };
  }
  return { checked: up.checked, states };
}
