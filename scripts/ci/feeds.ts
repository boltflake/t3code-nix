// The hourly check of the desktop app's update notice files (health.yml):
// does each version file on t3code-nix's site answer as the app reads it
// (pkgs/t3code/update-notice.cjs: no redirect, a 2xx, JSON with a SemVer
// `version` and a `providers` object of strings), with the versions main
// pins for T3 Code and the bundled providers?
//
//   node feeds.ts SITE_URL [REF]
//
// REF (default HEAD; health.yml passes main's tip, fetched just before) is
// where main's pins are read, and when each pin's version last changed.
// Prints {observations} for issues.ts, one per file at most:
//   update-feed     the file is missing, redirects, isn't JSON or isn't a
//                   version file the app reads (at once; no answer at all,
//                   twice 30 s apart); main pins a provider version the app
//                   can't compare (at once); or an entry differs from main
//                   (T3 Code's version, a provider missing, different, or
//                   still there after its pin left main or its name left
//                   provider-names.json), once that change has been on
//                   main for over GRACE_MS (for a provider still bundled,
//                   the later of its pin's version change and its name's
//                   addition; for one gone, its pin's deletion or its
//                   name's removal; the site
//                   rebuilds about hourly and is cached for 10 minutes).
//                   Every such entry is listed.
//   update-feed-ok  every entry is main's (closes the issue)
// Differences still within the grace period say nothing either way. A file
// whose pin isn't on main (a package gone) is skipped.
import { createRequire } from "node:module";
import { basename, dirname } from "node:path";
import { tryRun } from "../lib/util.ts";
import { obs, type Observation } from "../update.ts";
import { PROVIDER_NAMES, UPDATE_FEEDS } from "../status.ts";

const require = createRequire(import.meta.url);
const { parseLoose, validateFeed } = require("../../pkgs/t3code/update-notice.cjs");

export const GRACE_MS = 2 * 60 * 60_000;
/** The bundled providers' names (status.ts reads them from here too). */
const NAMES_FILE = "pkgs/t3code/provider-names.json";
export const MAX_BYTES = 4096;
export const RETRY_MS = 30_000;
/** The app's own limit (update-notice.cjs): slower is no answer for it. */
export const TIMEOUT_MS = 15_000;

/** The package and channel an observation is about: the NixOS-stable set's
 * file is the t3code package's, on channel `stable`. */
export const subject = (file: string) => {
  const name = file.slice("updates/".length, -".json".length);
  return name.startsWith("stable/") ? { pkg: name.slice("stable/".length), channel: "stable" } : { pkg: name, channel: null };
};

/** What one fetch found: the body's text, or why there is none. */
export type Answer = { ok: true; text: string } | { ok: false; error: string };

/** A pin on main: its version and when that version last changed there. */
export type PinTime = { version: string; since: string | null };
/** What main has for one file: T3 Code's pin, the set's provider pins
 * (`since`: the later of the version's change and the name's addition to
 * provider-names.json), and for each other name, when it stopped being a
 * bundled provider: its pin's deletion, or its name's removal while the pin
 * stays (null: never one, or unknown). */
export type FilePins = PinTime & { providers: Record<string, PinTime>; removed: Record<string, string | null> };

/** The observations for the files' answers, against main's pins. */
export function assess(answers: Record<string, Answer>, pins: Record<string, FilePins>, now: Date): Observation[] {
  const out: Observation[] = [];
  const late = (since: string | null) => {
    const t = since === null ? NaN : Date.parse(since);
    return !Number.isFinite(t) || now.getTime() - t > GRACE_MS;
  };
  for (const { file } of UPDATE_FEEDS) {
    const pin = pins[file];
    if (!pin) continue;
    const { pkg, channel } = subject(file);
    const problem = (version: string | null, detail: string) => out.push(obs("update-feed", pkg, version, `${file}: ${detail}`, channel));
    const a = answers[file];
    if (!a) continue;
    if (!a.ok) {
      problem(null, a.error);
      continue;
    }
    let feed: { version: string; providers: Record<string, string> | null };
    try {
      feed = validateFeed(JSON.parse(a.text));
    } catch (e) {
      problem(null, e instanceof SyntaxError ? "not JSON" : String((e as Error).message));
      continue;
    }
    const wrong: string[] = [];
    let pending = false;
    const differs = (since: string | null, what: string) => (late(since) ? wrong.push(what) : (pending = true));
    if (feed.version !== pin.version) {
      differs(pin.since, `the site has ${feed.version}, main has ${pin.version}${pin.since ? ` (since ${pin.since})` : ""}`);
    }
    const site = feed.providers ?? {};
    for (const [name, p] of Object.entries(pin.providers).sort(([x], [y]) => (x < y ? -1 : 1))) {
      // The app would stay quiet about it for good.
      if (!parseLoose(p.version)) wrong.push(`main's ${name} ${p.version} isn't a version the app can compare`);
      const got = Object.hasOwn(site, name) ? site[name] : null;
      if (got !== p.version) differs(p.since, `${name}: the site has ${got ?? "none"}, main has ${p.version}`);
    }
    for (const name of Object.keys(site).sort()) {
      if (Object.hasOwn(pin.providers, name)) continue;
      differs(pin.removed[name] ?? null, `${name}: the site has ${site[name]}, main has no pin`);
    }
    if (wrong.length) problem(feed.version, wrong.join("; "));
    else if (!pending) out.push(obs("update-feed-ok", pkg, feed.version, "", channel));
  }
  return out;
}

/** Fetches one file as the app does: no redirect, a 2xx, at most
 * MAX_BYTES (read as it comes, and cancelled past it). */
export async function fetchAnswer(url: string, timeoutMs = TIMEOUT_MS): Promise<Answer> {
  try {
    const res = await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      return { ok: false, error: `redirects (HTTP ${res.status}) to ${res.headers.get("location") ?? "nowhere"}` };
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel();
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, error: `more than ${MAX_BYTES} bytes` };
      }
      chunks.push(Buffer.from(value));
    }
    return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
  } catch (e) {
    return { ok: false, error: `no answer: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }
}

/** One pin at REF and when its version last changed there (the newest
 * commit whose diff of that file touches its top-level `version` line; a
 * pin's bundled browser has a version too, and another change to the pin,
 * a hash say, doesn't count), or null when it isn't there. A pin that is
 * there but can't be read fails the probe. */
function pinAt(ref: string, path: string): PinTime | null {
  if (tryRun("git", ["cat-file", "-e", `${ref}:${path}`]).status !== 0) return null;
  const shown = tryRun("git", ["show", `${ref}:${path}`]);
  if (shown.status !== 0) throw new Error(`feeds: couldn't read ${ref}:${path}: ${shown.stderr.trim()}`);
  const version = JSON.parse(shown.stdout).version;
  if (typeof version !== "string") return null;
  const r = tryRun("git", ["log", "-1", "--format=%cI", "-G", '^  "version":', ref, "--", path]);
  return { version, since: r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null };
}

/** When each pin file in DIR at REF was last deleted (newest first wins), by
 * name: any name, so a provider dropped from provider-names.json along with
 * its pin still has its removal's time. */
function deletions(ref: string, dir: string): Record<string, string> {
  // --no-renames: a pin moved to another name is the old name's deletion.
  const r = tryRun("git", ["log", "--no-renames", "--diff-filter=D", "--format=@%cI", "--name-only", ref, "--", `${dir}/`]);
  const out: Record<string, string> = {};
  let at = "";
  for (const line of r.status === 0 ? r.stdout.split("\n") : []) {
    if (line.startsWith("@")) at = line.slice(1);
    else if (line.startsWith(`${dir}/`) && line.endsWith(".json") && !line.slice(dir.length + 1).includes("/")) {
      const name = line.slice(dir.length + 1, -".json".length);
      out[name] ??= at;
    }
  }
  return out;
}

/** The bundled providers' names in provider-names.json at REV, or null
 * when it isn't there. */
function namesAt(rev: string): string[] | null {
  const r = tryRun("git", ["show", `${rev}:${NAMES_FILE}`]);
  if (r.status !== 0) return null;
  return Object.values(JSON.parse(r.stdout) as Record<string, string>).sort();
}

/** When NAME last left provider-names.json on REF's history (the commit
 * that dropped it), or null when it was never in it. */
function droppedAt(ref: string, name: string, cache: Map<string, string[] | null>): string | null {
  const log = tryRun("git", ["log", "--format=%H %cI", ref, "--", NAMES_FILE]);
  let since: string | null = null;
  for (const line of log.status === 0 ? log.stdout.trim().split("\n").filter(Boolean) : []) {
    const [hash, at] = line.split(" ");
    if (!cache.has(hash)) cache.set(hash, namesAt(hash));
    if (cache.get(hash)?.includes(name)) return since;
    since = at;
  }
  return null;
}

/** When NAME last joined provider-names.json on REF's history (the commit
 * that added it, or the file's first), or null when it isn't in it there. */
function addedAt(ref: string, name: string, cache: Map<string, string[] | null>): string | null {
  const log = tryRun("git", ["log", "--format=%H %cI", ref, "--", NAMES_FILE]);
  let since: string | null = null;
  for (const line of log.status === 0 ? log.stdout.trim().split("\n").filter(Boolean) : []) {
    const [hash, at] = line.split(" ");
    if (!cache.has(hash)) cache.set(hash, namesAt(hash));
    if (!cache.get(hash)?.includes(name)) return since;
    since = at;
  }
  return since;
}

/** The later of two times (null: unknown, so the other). */
const later = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : Date.parse(a) >= Date.parse(b) ? a : b);

/** Main's pins for each file at REF: T3 Code's, the set's provider pins
 * (`versions/` or `versions/stable/`; the names from provider-names.json at
 * REF), and when any other name left the bundled providers: its pin's
 * deletion, or for a pin still there (a package no longer bundled) the
 * commit that dropped its name; null when it was never one. */
export function pinsOnMain(ref = "HEAD"): Record<string, FilePins> {
  // A ref git can't read is a failed probe, not "no pins".
  if (tryRun("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status !== 0) throw new Error(`feeds: no commit ${ref}`);
  const out: Record<string, FilePins> = {};
  // The names as main has them (an older main without the file: this
  // checkout's).
  const names = namesAt(ref) ?? PROVIDER_NAMES;
  const cache = new Map<string, string[] | null>();
  for (const { file, pin } of UPDATE_FEEDS) {
    // A package gone: skipped.
    const t3 = pinAt(ref, pin);
    if (!t3) continue;
    const providers: Record<string, PinTime> = {};
    for (const name of names) {
      const p = pinAt(ref, `${dirname(pin)}/${name}.json`);
      // A pin that just became a bundled provider's gets its grace too.
      if (p) providers[name] = { ...p, since: later(p.since, addedAt(ref, name, cache)) };
    }
    const removed: Record<string, string | null> = {};
    for (const [name, at] of Object.entries(deletions(ref, dirname(pin)))) if (!providers[name]) removed[name] = at;
    // A pin still there but no longer a bundled provider's: when its name
    // left the list.
    const present = tryRun("git", ["ls-tree", "--name-only", `${ref}`, `${dirname(pin)}/`]).stdout.split("\n");
    for (const path of present) {
      const name = path.slice(dirname(pin).length + 1, -".json".length);
      if (path.endsWith(".json") && !providers[name] && name !== basename(pin, ".json")) removed[name] = droppedAt(ref, name, cache);
    }
    out[file] = { ...t3, providers, removed };
  }
  return out;
}

if (import.meta.main) {
  const [site, ref = "HEAD"] = process.argv.slice(2);
  if (!site) {
    console.error("usage: feeds.ts SITE_URL [REF]");
    process.exit(2);
  }
  const base = site.endsWith("/") ? site : `${site}/`;
  const answers: Record<string, Answer> = {};
  for (const { file } of UPDATE_FEEDS) {
    const url = new URL(file, base).href;
    let a = await fetchAnswer(url);
    // No answer at all (the runner's network, a timeout): once more, a little
    // later, before it counts. An answer that's wrong counts at once.
    if (!a.ok && a.error.startsWith("no answer")) {
      await new Promise((r) => setTimeout(r, RETRY_MS));
      a = await fetchAnswer(url);
    }
    answers[file] = a;
  }
  console.log(JSON.stringify({ observations: assess(answers, pinsOnMain(ref), new Date()) }, null, 2));
}
