// The status page (pages.yml): for every pin on `main`, its version, when
// upstream released it (and what kind of time that is), when t3code-nix
// published it, and the gap between the two; plus a shields.io endpoint
// badge per package, and, with the live reads, each pin's state
// (status-live.ts). The page itself is status-page.ts.
//
//   node scripts/status.ts OUT_DIR [REF] [--health FILE --reads FILE] [--site FILE]
//
// Reads the pins and their history at REF (default HEAD) from git, and the
// watcher's /health reply and the live job's reads (status-reads.ts) when
// given. Writes OUT_DIR/index.html, OUT_DIR/status.json, OUT_DIR/live.json,
// OUT_DIR/social-card.png (the link preview's image) and
// OUT_DIR/badges/<package>.json, and prints {digest, live, error, deploy,
// fail} as JSON: `live` false when the reads were missing or unusable, with
// why, and whether to deploy against the live site's status.json (--site;
// see decide()). The output is deterministic (no generation time; the clock
// only decides which watcher keys are fresh enough to use), and status.json
// carries a digest of everything written, so the workflow deploys only when
// something changed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { git, releaseNotes, tryRun, type Pin, type Released, shownVersion } from "./lib/util.ts";
import { REPO } from "./ci/gh.ts";
import { html, KIND, median, PREVIEW } from "./status-page.ts";
import { liveView, type OpenIssue, type Run } from "./status-live.ts";
import { differing, SNAPSHOT } from "./lib/snapshot.ts";
import { CHANNELS, electronNote, type Channel, type Reader } from "./lib/electron-fallback.ts";
import { T3 } from "./lib/packages.ts";
import { OPTIONAL } from "./lib/browserpins.ts";
import { compareVersions } from "./update.ts";

/** A commit's files, for the Electron note. */
const atRef = (ref: string): Reader => (path) => {
  const r = tryRun("git", ["show", `${ref}:${path}`]);
  return r.status === 0 ? `${r.stdout}\n` : null;
};

export interface Row {
  name: string;
  version: string;
  released: Released | null;
  published: { at: string; commit: string } | null;
  /** Seconds from the release to the publish; null when either is unknown
   * or it would be negative. */
  gap: number | null;
  /** The upstream release page, when the pin has a GitHub tag. */
  notes: string | null;
  /** true when the version shown is a delivery, or why it isn't. */
  counted: Counted;
  /** The package's 10 latest deliveries, newest first. */
  history: Delivery[];
  /** The desktop apps only: what git says about their Electron
   * (scripts/lib/electron-fallback.ts electronNote). */
  electron?: string | null;
  /** The browser pins only: their browsers, ungoogled-chromium (the
   * default, the one that gates the pin) first, and the NixOS channel they
   * come from (the page shows it as the pin's version, the browsers under it). */
  browsers?: Browser[];
  channel?: string;
}

/** One of a browser pin's browsers: its version (null: not recorded, as in
 * a pin from before the pins recorded each browser, or not evaluated) and the
 * systems the pin moved without it. */
export interface Browser { name: string; version: string | null; unavailable: string[] }
export function browsersOf(pin: { chromium: string; browsers?: Record<string, { version?: string | null; unavailable?: Record<string, string> } | undefined> }): Browser[] {
  return [{ name: "ungoogled-chromium", version: pin.chromium, unavailable: [] },
    ...OPTIONAL.map((name) => {
      const b = pin.browsers?.[name];
      return { name, version: typeof b?.version === "string" ? b.version : null, unavailable: Object.keys(b?.unavailable ?? {}).sort() };
    })];
}

/** NixOS stable at REF: whether its snapshot has main's pins, and where
 * not, the snapshot's version and main's of each package that differs (null:
 * not there); and the open stable-behind issue, from the live reads. */
export interface StableView {
  current: boolean;
  differing: { name: string; stable: string | null; main: string | null }[];
  issue: number | null;
}
export function stableView(ref = "HEAD", issues: OpenIssue[] | null = null): StableView {
  const tree = git("rev-parse", `${ref}^{tree}`);
  const version = (path: string) => {
    const r = tryRun("git", ["show", `${tree}:${path}`]);
    try { return r.status === 0 ? shownVersion(JSON.parse(r.stdout)) : null; } catch { return null; }
  };
  const list = differing(tree).map((name) => ({ name, stable: version(`${SNAPSHOT}/${name}.json`), main: version(`versions/${name}.json`) }));
  const issue = issues?.find((i) => i.key.startsWith("stable-behind/"))?.number ?? null;
  return { current: list.length === 0, differing: list, issue };
}

/** One stay of a package on `main`: consecutive first-parent commits in
 * which it has the same version (see `identity`). */
export interface Stay {
  name: string;
  /** What's compared: the shown version, or a browser pin's browsers. */
  identity: string;
  /** The pin at the stay's last commit, and at its first. */
  pin: Pin;
  first: Pin;
  /** Its first commit: when it reached `main`. */
  published: { at: string; commit: string };
  released: Released | null;
  /** Seconds from the release to the publish (null: not known). */
  gap: number | null;
  /** true for a delivery, or why it isn't one. */
  counted: Counted;
}
export type Counted = true | "added" | "re-added" | "returned" | "older";

/** A pin's version for telling stays apart: what the page shows, except that
 * a browser pin (a nixpkgs revision that moves at least weekly) is its three
 * browsers' versions only, without the channel or the availability notes. */
const isBrowser = (pin: any) => typeof pin.channel === "string" && typeof pin.chromium === "string";
export function identity(pin: Pin & { chromium?: string; browsers?: Record<string, any> }): string {
  if (!isBrowser(pin)) return shownVersion(pin);
  const b = pin.browsers ?? {};
  return [pin.chromium, b.chromium?.version ?? "", b["google-chrome"]?.version ?? ""].join(" ");
}

/** A release time the page can use, and the gap to a publish; a time that
 * doesn't parse, a kind this page doesn't know, or one after the publish
 * (checked before rounding, so 0.4 s after isn't a gap of -0) is unknown. */
function timing(r: Released | undefined, published: { at: string }): { released: Released | null; gap: number | null } {
  if (!r || !Number.isFinite(Date.parse(r.at)) || !Object.hasOwn(KIND, r.kind)) return { released: null, gap: null };
  const ms = Date.parse(published.at) - Date.parse(r.at);
  return ms >= 0 ? { released: r, gap: Math.round(ms / 1000) } : { released: null, gap: null };
}

/** Every package's stays at REF, oldest first, from one walk of `main`'s
 * first-parent history of the pins directly in versions/ (not NixOS
 * stable's copies in versions/stable/, which share their names). Every
 * option that changes the result is given, so git's configuration can't:
 * the root commit's files (`--root`), a merge as one change against its
 * first parent, no rename detection. Packages are followed by name, so a
 * file renamed in one commit is one change. */
export function stays(ref = "HEAD"): Map<string, Stay[]> {
  const log = git("log", "--first-parent", "--diff-merges=first-parent", "--root", "--reverse", "--no-renames", "--raw", "--no-abbrev",
    "-z", "--format=%x01%H %cI", ref, "--", ":(glob)versions/*.json");
  // NUL-separated tokens: a commit's header ("\x01<hash> <date>"), then
  // ":old-mode new-mode old-blob new-blob status" and the path, by turns
  // (the first after a newline). A path is always taken as a path.
  const commits: { commit: string; at: string; changes: { blob: string; status: string; path: string }[] }[] = [];
  const tokens = log.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/^\n/, "");
    if (t.startsWith("\x01")) {
      const [commit, at] = t.slice(1).split(" ");
      commits.push({ commit, at: new Date(at).toISOString(), changes: [] });
    } else if (t.startsWith(":") && commits.length && i + 1 < tokens.length) {
      const meta = t.split(" ");
      commits.at(-1)!.changes.push({ blob: meta[3], status: meta[4], path: tokens[++i] });
    }
  }
  const blobs = readBlobs(commits.flatMap((c) => c.changes.filter((x) => x.status !== "D").map((x) => x.blob)));

  const out = new Map<string, Stay[]>();
  const files = new Map<string, Pin>(); // path -> its pin now
  const gone = new Set<string>(); // names deleted since their last stay
  /** Each name's pin, from the first of its files by path. */
  const byName = () => {
    const m = new Map<string, Pin>();
    for (const path of [...files.keys()].sort()) {
      const pin = files.get(path)!;
      if (!m.has(pin.name)) m.set(pin.name, pin);
    }
    return m;
  };
  for (const c of commits) {
    // Each commit's changes together, so a rename (a delete and an add of the
    // same name) is one change.
    const before = new Set(byName().keys());
    for (const x of c.changes) {
      files.delete(x.path);
      if (x.status === "D") continue;
      try {
        const pin = JSON.parse(blobs.get(x.blob) ?? "");
        if (typeof pin?.name === "string" && typeof pin.version === "string") files.set(x.path, pin);
      } catch {
        // Not a pin: as if the file weren't there.
      }
    }
    const present = byName();
    for (const name of before) if (!present.has(name)) gone.add(name);
    for (const [name, pin] of present) {
      const list = out.get(name) ?? [];
      const last = list.at(-1);
      const id = identity(pin);
      if (last && !gone.has(name) && last.identity === id) {
        last.pin = pin;
        continue;
      }
      const counted: Counted = !last ? "added" : gone.has(name) ? "re-added"
        : list.some((s) => s.identity === id) ? "returned"
        : compareVersions(shownVersion(pin), shownVersion(last.pin)) === -1 ? "older" : true;
      gone.delete(name);
      list.push({ name, identity: id, pin, first: pin, published: { at: c.at, commit: c.commit }, released: null, gap: null, counted });
      out.set(name, list);
    }
  }
  // Release times: the stay's newest metadata; a browser pin's from its
  // first commit, since each weekly move records a fresh `seen` time.
  for (const list of out.values()) {
    for (const s of list) {
      Object.assign(s, timing((isBrowser(s.pin) ? s.first : s.pin).released, s.published));
    }
  }
  return out;
}
/** Blob contents by id, read in one `git cat-file --batch`. */
function readBlobs(ids: string[]): Map<string, string> {
  const unique = [...new Set(ids)];
  const map = new Map<string, string>();
  if (!unique.length) return map;
  const buf = execFileSync("git", ["cat-file", "--batch"], { input: unique.join("\n") + "\n", maxBuffer: 1 << 30 });
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    const [id, type, size] = buf.subarray(at, nl).toString("utf8").split(" ");
    if (type === "missing" || size === undefined) {
      at = nl + 1;
      continue;
    }
    const start = nl + 1, end = start + Number(size);
    map.set(id, buf.subarray(start, end).toString("utf8"));
    at = end + 1;
  }
  return map;
}

/** The pins at REF, by file name. */
export function pinsAt(ref = "HEAD"): { path: string; pin: Pin }[] {
  const files = git("ls-tree", "--name-only", ref, "versions/").split("\n").filter((f) => f.endsWith(".json")).sort();
  return files.map((path) => ({ path, pin: JSON.parse(git("show", `${ref}:${path}`)) as Pin }));
}

/** A delivery as status.json lists it. */
export interface Delivery {
  version: string;
  shown: string;
  published: { at: string; commit: string };
  released: Released | null;
  gap: number | null;
}
// The stay's first pin: a browser pin's later weekly moves (same browsers)
// mustn't change what status.json says about it.
const delivery = (s: Stay): Delivery => ({ version: s.first.version, shown: shownVersion(s.first), published: s.published, released: s.released, gap: s.gap });

export function rows(ref = "HEAD", all = stays(ref)): Row[] {
  return pinsAt(ref).map(({ pin }) => {
    const list = all.get(pin.name) ?? [];
    const now = list.at(-1);
    const published = now?.published ?? null;
    const { released, gap } = now ? { released: now.released, gap: now.gap } : { released: null, gap: null };
    const history = list.filter((s) => s.counted === true).slice(-10).reverse().map(delivery);
    const electron = (CHANNELS as readonly string[]).includes(pin.name) ? electronNote(atRef(ref), pin.name as Channel) : undefined;
    return { name: pin.name, version: shownVersion(pin), released, published, gap, notes: releaseNotes(pin), counted: now?.counted ?? "added", history,
      ...(electron ? { electron } : {}), ...(isBrowser(pin) ? { browsers: browsersOf(pin as any), channel: (pin as any).channel } : {}) };
  });
}

/** The median delivery over upstream releases in the 30 days up to the
 * newest stay start of any package: the desktop app and the CLI of one T3
 * Code channel at one version are one release, at the earlier publish; a
 * release counts when a member has an exact release time and its delivery
 * isn't negative. Null with fewer than 5. */
export function medianDelivery(all: Map<string, Stay[]>): { median: number; count: number; since: string; until: string } | null {
  const starts = [...all.values()].flat().map((s) => Date.parse(s.published.at));
  if (!starts.length) return null;
  const until = Math.max(...starts), since = until - 30 * 86400e3;
  const pairOf = new Map<string, string>();
  for (let i = 0; i < T3[0].channels.length; i++) {
    const [a, b] = [T3[0].channels[i][1], T3[1]?.channels[i]?.[1]];
    if (b) { pairOf.set(a, a); pairOf.set(b, a); }
  }
  const releases = new Map<string, Stay[]>();
  for (const [name, list] of all) {
    for (const s of list) {
      if (s.counted !== true) continue;
      const key = `${pairOf.get(name) ?? name}\0${shownVersion(s.pin)}`;
      releases.set(key, [...(releases.get(key) ?? []), s]);
    }
  }
  const gaps: number[] = [];
  for (const members of releases.values()) {
    const publish = Math.min(...members.map((m) => Date.parse(m.published.at)));
    if (publish < since || publish > until) continue;
    const exact = members.map((m) => m.released).filter((r): r is Released => r?.kind === "published").map((r) => Date.parse(r.at));
    if (!exact.length) continue;
    const ms = publish - Math.min(...exact);
    if (ms < 0) continue;
    gaps.push(ms / 1000);
  }
  if (gaps.length < 5) return null;
  return { median: median(gaps), count: gaps.length, since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

export function badge(row: Row): { schemaVersion: 1; label: string; message: string; color: string } {
  let color = "lightgrey";
  // A version that isn't a delivery (added, returned, older) has no delay
  // to colour, as on the page.
  if (row.gap !== null && row.released && row.counted === true) {
    // Only exact times are coloured by the gap.
    if (row.released.kind !== "published") color = "blue";
    else color = row.gap < 3600 ? "brightgreen" : row.gap < 6 * 3600 ? "yellow" : "red";
  }
  return { schemaVersion: 1, label: row.name, message: row.version, color };
}


/** SHA-256 over every file but status.json, sorted by name, each as
 * name\0length\0bytes, then status.json without its digest, the same way. */
export function digest(files: Record<string, string | Buffer>, status: unknown): string {
  const h = createHash("sha256");
  const add = (name: string, text: string | Buffer) => {
    const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
    h.update(`${name}\0${bytes.length}\0`);
    h.update(bytes);
  };
  for (const name of Object.keys(files).sort()) add(name, files[name]);
  add("status.json", JSON.stringify(status));
  return h.digest("hex");
}

/** The id of the data a page shows: SHA-256 of status.json's content
 * without its `id`, its `digest` and `live.checked`. The page carries it, so
 * an open tab can tell when the site has newer data; a rebuild that only
 * moves the check time keeps it (the tab takes that time in place). */
export const dataId = (status: Record<string, any>) => {
  const { id: _id, digest: _digest, ...rest } = status;
  const live = rest.live ? { ...rest.live, checked: undefined } : rest.live;
  return createHash("sha256").update(JSON.stringify({ ...rest, live })).digest("hex");
};

/** The live reads, as pages.yml hands them over. */
export interface LiveReads {
  health: any;
  runs: Run[];
  issues: OpenIssue[];
}

export function build(out: string, ref = "HEAD", repo = REPO, reads: LiveReads | null = null, now = new Date()): { digest: string; live: boolean } {
  const all = stays(ref);
  const list = rows(ref, all);
  // `now` only decides which watcher keys are fresh enough to use; nothing
  // written depends on it otherwise.
  const live = reads ? liveView(pinsAt(ref).map((p) => p.pin), reads.health, reads.runs, reads.issues, repo, now) : null;
  const stable = stableView(ref, reads?.issues ?? null);
  const base = { packages: list, live, stable, delivery: medianDelivery(all) };
  const id = dataId(base);
  const files: Record<string, string | Buffer> = { "index.html": html(list, repo, live, id, stable, base.delivery) };
  // The link preview's image, from this checkout like the page's code
  // (scripts/social-card.sh renders it).
  files[PREVIEW.image] = readFileSync(new URL("../docs/social-card.png", import.meta.url));
  for (const r of list) files[`badges/${r.name}.json`] = `${JSON.stringify(badge(r))}\n`;
  // All an open tab checks for (see status-page.ts SCRIPT): the page's id and
  // the check time, in a few bytes instead of the whole status.json.
  files["live.json"] = `${JSON.stringify({ id, checked: live?.checked ?? null })}\n`;
  const status = { ...base, id };
  const d = digest(files, status);
  // Badges of packages that are gone mustn't survive a rebuild in place.
  rmSync(join(out, "badges"), { recursive: true, force: true });
  mkdirSync(join(out, "badges"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
  writeFileSync(join(out, "status.json"), `${JSON.stringify({ ...status, digest: d }, null, 2)}\n`);
  return { digest: d, live: live !== null };
}

/** Whether to deploy what was built, against the live site's status.json
 * (null when it couldn't be read: then deploy). Nothing changed: no. The
 * live reads were expected but failed, and the packages are as on the
 * site: no, and the run fails, so a passing outage doesn't flip the site to
 * the plain view and back (the site's `live.checked` ages into its
 * out-of-date note). Before the watcher exists no live reads are expected. */
export function decide(built: { digest: string; packages: Row[]; stable?: StableView; delivery?: unknown }, site: any, liveFailed: boolean): { deploy: boolean; fail: boolean } {
  if (!site || typeof site !== "object") return { deploy: true, fail: false };
  // The git-derived part of the page: the pins and the stable snapshot (its
  // issue number comes from the live reads, so an outage alone can't move it).
  // A browser pin's browsers and channel are also in its version, so they're
  // left out: a site from before they were added still compares equal.
  const pins = (list: any) => (Array.isArray(list) ? list.map(({ browsers, channel, ...r }: any) => r) : list);
  const pinned = (s: any) => JSON.stringify({ packages: pins(s?.packages), current: s?.stable?.current, differing: s?.stable?.differing, delivery: s?.delivery });
  if (liveFailed && pinned(site) === pinned(built)) return { deploy: false, fail: true };
  if (site.digest === built.digest) return { deploy: false, fail: false };
  return { deploy: true, fail: false };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { health: { type: "string" }, reads: { type: "string" }, site: { type: "string" } } });
  const [out, ref] = positionals;
  if (!out) {
    console.error("usage: status.ts OUT_DIR [REF] [--health FILE --reads FILE] [--site FILE]");
    process.exit(2);
  }
  let reads: LiveReads | null = null, error: string | null = null;
  const expected = !!(values.health || values.reads);
  if (expected) {
    // Fixed reasons: the job summary is public, and must never quote the
    // watcher's reply.
    const json = (file: string | undefined, why: string) => {
      try {
        return JSON.parse(readFileSync(file ?? "", "utf8"));
      } catch {
        throw new Error(why);
      }
    };
    try {
      const health = json(values.health, "the watcher's reply is missing or isn't JSON");
      const r = json(values.reads, "the live job's reads are missing or aren't JSON");
      if (!Array.isArray(r?.runs) || !Array.isArray(r?.issues)) throw new Error("the live job's reads have no runs or issues");
      reads = { health, runs: r.runs, issues: r.issues };
    } catch (e: any) {
      reads = null;
      error = e instanceof Error ? e.message : "the live reads failed";
    }
  } else {
    error = "no live reads given";
  }
  const result = build(out, ref ?? "HEAD", REPO, reads);
  if (reads && !result.live) error = "the watcher has no usable key";
  let site: any = null;
  try {
    site = values.site ? JSON.parse(readFileSync(values.site, "utf8")) : null;
  } catch {
    site = null;
  }
  const built = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
  console.log(JSON.stringify({ digest: result.digest, live: result.live, error: result.live ? null : error, ...decide(built, site, expected && !result.live) }));
}
