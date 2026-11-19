// Resolve every package's newest upstream version and report what changed.
//
//   node scripts/update.ts [--write] [--only NAME,...] [--held FILE]
//
// Prints a JSON report:
//   {"checkedAt", "changed": [{name, from, to, why}], "observations": [{kind, package, channel, version, detail}]}
//
// With --write, changed pins are written to versions/; otherwise nothing on
// disk changes. The update workflow runs this in its read-only resolve job
// and turns the observations into issues. Needs GH_TOKEN: t3code's releases
// come from GitHub's GraphQL API, which requires a token.
//
// Observation kinds:
//   no-match         a t3code release newer than GitHub's latest release fits
//                    no channel rule,
//                    or has been missing files for more than an hour
//   incomplete       a release still missing files (checked again next run)
//   integrity        upstream changed a file without changing the version;
//                    the new bytes are pinned only when a published checksum
//                    vouches for them (every vendor except grok)
//   downgrade        a vendor's pointer moved back (followed; an issue tracks
//                    it until the pin is back at the pulled version)
//   held             an open issue holds this exact version (skipped while
//                    anything else is new; see retryNames)
//   latest-mismatch  npm's `latest`, which t3code's update notice uses, differs
//                    from what upstream points at
//   latest-match     npm agrees (lets a latest-mismatch issue close)
//   npm-ok           npm answered (lets an npm resolve-failed issue close)
//   releases-ok      t3code's releases were read (lets the release stream's
//                    no-match and resolve-failed close; one seen again in the
//                    same run stays open)
//   on-main          the nixpkgs revision main locks (lets a nixpkgs test
//                    failure at exactly that revision close, and a
//                    bump-waiting issue opened at another revision)
//   waiting          a nixpkgs bump was due but isn't offered yet: something
//                    from nixpkgs isn't on cache.nixos.org, or couldn't be
//                    checked (a note in the run's summary)
//   bump-waiting     the same, with flake.lock unchanged on main for more
//                    than 14 days (an issue)
//   waiting          also a browser pin declining a move (lib/browserpins.ts;
//                    closes only resolve-failed)
//   browser-waiting  a browser pin's move held by chromium or google-chrome
//                    (an issue, whose start is the three-day clock)
//   browsers-ready   nothing optional holds that pin's move (closes it)
//   note             something the run's summary should say (a t3code pin
//                    keeping an earlier speech model; see lib/speech.ts)
//   resolve-failed   a source couldn't be read or a pin couldn't be built
//   pass             resolved cleanly; the pin is current
//
// Channels: an observation about a pin carries no channel (the pin's name,
// e.g. t3code-nightly, already says which). `channel` is only used for the
// t3code release stream (latest/nightly), npm, and systems.
//
// The nixpkgs bump (with --write, and without --only): due with each new
// T3 Code on the latest channel, and at least weekly (bumpDue). It goes to the newest
// nixos-unstable, but only once nothing from nixpkgs would need building
// (lib/nixcache.ts); otherwise flake.lock is put back and the run says why.
// It's decided after the first pass, so a run's own new T3 Code counts, and
// before the retry check, where a new nixpkgs revision is something new.
//
// Held versions come from --held (or HELD_JSON): [{package, version}], and
// browser pins' waits as [{package, since, from}] (lib/browserpins.ts). A run
// retries them only when nothing else is new: then the packages that
// reported `held` are resolved once more without skipping, and that second
// pass replaces the first's report for them (candidate.ts still drops held
// inputs if upstream moved something new in between).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { appendPage, classify, decisive, fillRules, isComplete, select, type Repository } from "../shared/channels.ts";
import { BOAT, fillAssets, GITHUB, highestTag, RECENT, T3_MAX_PAGES, T3_RELEASE, t3Releases, versionOfTag } from "../shared/sources.ts";
import { browserPin } from "./lib/browser.ts";
import { io as channels, newestStable, PINS as BROWSER_PINS, resolveBrowserPins, type Wait } from "./lib/browserpins.ts";
import { allTops, Budget, BUMP_BUDGET_MS, compare, NIX_TIMEOUT_MS } from "./lib/nixcache.ts";
import { current as snapshotCurrent, downloads as snapshotDownloads } from "./lib/snapshot.ts";
import { speechPin } from "./lib/speech.ts";
import { electronPin } from "./lib/electron.ts";
import { activeChannels, CHANNELS, pairOf, type Reader } from "./lib/electron-fallback.ts";
import { buildGithubPin } from "./lib/pin-github.ts";
import { buildVendorPin, Skip, VENDORS } from "./lib/vendors.ts";
import { currentPin, fail, Failed, getJson, nixpkgsRev, ROOT, run, sameBytes, settleReleased, tryRun, UA, UNVERIFIED, VERSIONS, writeJson, type FetchJson, type Pin } from "./lib/util.ts";

export const INCOMPLETE_GRACE_MS = 60 * 60 * 1000;

const DEB = { "x86_64-linux": "T3-Code-{version}-amd64.deb", "aarch64-linux": "T3-Code-{version}-arm64.deb" };
const CLI = { "x86_64-linux": "t3-{version}-linux-x64.tar.gz", "aarch64-linux": "t3-{version}-linux-arm64.tar.gz" };
export const T3CODE: Record<string, { channel: "latest" | "nightly"; wanted: Record<string, string> }> = {
  t3code: { channel: "latest", wanted: DEB },
  t3: { channel: "latest", wanted: CLI },
  "t3code-nightly": { channel: "nightly", wanted: DEB },
  "t3-nightly": { channel: "nightly", wanted: CLI },
};

export const VENDOR = Object.keys(VENDORS);
/** The agent tools with resolvers of their own (agent-browser is in GITHUB). */
export const TOOLS = ["boat"];
/** agent-browser's Chromium pins (lib/browserpins.ts). */
export const BROWSERS = Object.keys(BROWSER_PINS);
export const ALL = [...Object.keys(GITHUB), ...Object.keys(T3CODE), ...VENDOR, ...TOOLS, ...BROWSERS];

// The npm package t3code's update notice compares against, per our package
// (opencode 2.x's is @opencode/cli; 1.x's was opencode-ai).
export const NPM: Record<string, string> = {
  codex: "@openai/codex",
  "claude-code": "@anthropic-ai/claude-code",
  opencode: "@opencode/cli",
  pi: "@earendil-works/pi-coding-agent",
};

/** One page of t3code's releases (GitHub's latest release included), after a cursor. */
const t3Query = (after: string | null) =>
  `query { repository(owner: "pingdotgg", name: "t3code") { latestRelease { ${T3_RELEASE} } ${t3Releases(after)} } }`;

export interface Observation {
  kind: string;
  package: string | null;
  channel: string | null;
  version: string | null;
  detail: string;
  /** A downgrade's move: the version upstream moved back from (the pulled
   * one) and to (also `version`). Only on `downgrade`. */
  from?: string;
  to?: string;
}

export const obs = (kind: string, pkg: string | null = null, version: string | null = null, detail = "", channel: string | null = null): Observation =>
  ({ kind, package: pkg, channel, version, detail });

// Version ordering, for spotting downgrades. Numeric parts first, then a
// release sorts above its own prerelease (1.0.0 > 1.0.0-rc.1). Vendor suffixes
// that aren't prerelease markers (cursor's 2026.11.11-b912975, muse's
// 1.4.15-R8339.1) can't be ordered: then null, and nothing is said.
const PRERELEASE = /^(alpha|beta|rc|pre|preview|nightly|canary|dev)\b/i;
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (v: string) => {
    const m = /^v?(\d+(?:\.\d+)*)(?:-([^+]*))?(?:\+.*)?$/.exec(v);
    return m ? { nums: m[1].split(".").map(Number), pre: m[2] ?? null } : null;
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return null;
  const width = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < width; i++) {
    const x = pa.nums[i] ?? 0, y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null && pb.pre && PRERELEASE.test(pb.pre)) return 1;
  if (pb.pre === null && pa.pre && PRERELEASE.test(pa.pre)) return -1;
  return null;
}

/** A new version lower than the pinned one (a vendor pointer moved back). */
export const movedBack = (next: Pin, old: Pin | null) => !!old && compareVersions(next.version, old.version) === -1;

const deepEqual = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export class Report {
  changed: { name: string; from: string | null; to: string; why: string }[] = [];
  observations: Observation[] = [];
  pins = new Map<string, Pin>();
  resolved = new Map<string, string>(); // name -> version upstream points at (even if held)

  readonly versionsDir: string;
  /** The run's time: `released` for sources that give none. */
  readonly now: Date;

  constructor(versionsDir = VERSIONS, now = new Date()) {
    this.versionsDir = versionsDir;
    this.now = now;
  }

  observe(o: Observation) {
    this.observations.push(o);
  }

  /** Take a second pass's report for every package it said something about:
   * the retried pins, and the t3code release stream if it read it again (a
   * newer reading, failures included). The rest keep the first pass's. */
  merge(second: Report) {
    const names = new Set([...second.observations.flatMap((o) => (o.package === null ? [] : [o.package])),
      ...second.changed.map((c) => c.name)]);
    for (const name of names) {
      const said = second.observations.filter((o) => o.package === name);
      const changed = second.changed.filter((c) => c.name === name);
      this.observations = this.observations.filter((o) => o.package !== name).concat(said);
      this.changed = this.changed.filter((c) => c.name !== name).concat(changed);
      const pin = second.pins.get(name); // never one from the first pass, which changed nothing
      if (pin) this.pins.set(name, pin);
      if (second.resolved.has(name)) this.resolved.set(name, second.resolved.get(name)!);
    }
  }

  /** Compare a freshly built pin with the current one. */
  candidate(built: Pin, held: Set<string>, retry: boolean) {
    const name = built.name;
    this.resolved.set(name, built.version);
    const old = currentPin(name, this.versionsDir);
    const back = movedBack(built, old);
    // Before comparing: an unchanged version keeps its `released`.
    const next = settleReleased(built, old, this.now, back);
    if (old && deepEqual(old, next)) return this.observe(obs("pass", name, next.version));
    let why = "new version";
    if (old && old.version === next.version) {
      if (!sameBytes(old, next)) {
        const unverified = Object.values(next.assets).some((a) => (a.checksumSource ?? "").startsWith("none"));
        if (unverified) {
          return this.observe(obs("integrity", name, next.version, UNVERIFIED));
        }
        this.observe(obs("integrity", name, next.version,
          "files changed without a new version; the published checksum vouches for the new bytes, so they are pinned"));
        why = "same version, new bytes";
      } else {
        // Same bytes, different details (URL, asset ID, grok's MD5): keep the
        // pin current so the details aren't lost.
        this.observe(obs("pass", name, next.version));
        why = "details only";
      }
    }
    // A held version stays out whatever changed about it (a new version, or
    // new bytes for the same one), except details that don't change bytes.
    // A retry lets it in, still reported `held`: that proves its source
    // resolves (closing a resolve-failed from an earlier retry).
    if (why !== "details only" && held.has(`${name}\0${next.version}`)) {
      this.observe(obs("held", name, next.version, "an open issue holds this version"));
      if (!retry) return;
    }
    if (back) {
      // NixOS stable's snapshot moves only at a publish that passes the
      // stable checks: say so when it still has the pulled version.
      const snap = currentPin(name, join(this.versionsDir, "stable"));
      const stable = snap?.version === old!.version
        ? ` NixOS stable's set (versions/stable/) keeps ${old!.version} until its snapshot next moves; a stable-behind issue tracks that.` : "";
      this.observe({ ...obs("downgrade", name, next.version, `upstream moved ${name} back from ${old!.version} to ${next.version}.${stable}`),
        from: old!.version, to: next.version });
    }
    this.changed.push({ name, from: old?.version ?? null, to: next.version, why });
    this.pins.set(name, next);
  }
}

/** The watcher's rule for `tags`: the highest-versioned stable release
 * with every wanted asset. */
export function pickRelease(list: any[], wanted: Record<string, string>, tags: RegExp): any {
  const complete = list.filter((r) => typeof r?.tag_name === "string" && !r.draft && !r.prerelease
    && Object.values(wanted).every((a) => r.assets?.some((x: any) => x?.name === a)));
  const tag = highestTag(complete.map((r) => r.tag_name), tags);
  return complete.find((r) => r.tag_name === tag) ?? null;
}

export async function resolveGithub(report: Report, name: string, held: Set<string>, retry: boolean) {
  const { repo, wanted, licenses, tags } = GITHUB[name];
  let latest: any;
  if (tags) {
    const list = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=${RECENT}`);
    if (!Array.isArray(list)) throw new Failed(`unexpected reply for ${repo}'s releases`);
    latest = pickRelease(list, wanted, tags) ?? fail(`${repo}: no complete release matching ${tags} among the last ${RECENT}`);
    // The highest version wins here. One below the pin is either the pinned
    // release crowded out of a full window by other tags (keep the pin: it's
    // still upstream's), or upstream withdrawing it (deleted, a prerelease,
    // an asset gone: follow upstream back, a downgrade, as for any source).
    const pinned = currentPin(name, report.versionsDir);
    const crowded = list.length >= RECENT && !list.some((r: any) => r?.tag_name === pinned?.tag);
    if (pinned && crowded && compareVersions(versionOfTag(latest.tag_name), pinned.version) === -1) {
      // `waiting`: the source was read (closes a resolve-failed), nothing moves.
      report.observe(obs("waiting", name, pinned.version,
        `the highest complete release among ${repo}'s last ${RECENT} is ${latest.tag_name}, below the pin; the pinned ${pinned.tag} is past the window, so the pin stays`));
      return;
    }
  } else {
    latest = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
    if (typeof latest?.tag_name !== "string") throw new Failed(`unexpected reply for ${repo}'s latest release`);
  }
  report.candidate(await buildGithubPin(name, repo, latest.tag_name, wanted,
    { licenses, previous: currentPin(name, report.versionsDir), release: latest }), held, retry);
}

/** t3code's releases, paging until a complete nightly turns up (previews
 * can fill whole pages), at most T3_MAX_PAGES pages. */
export async function fetchT3code(fetchJson: FetchJson = getJson): Promise<Repository> {
  if (!process.env.GH_TOKEN) throw new Failed("GH_TOKEN is not set; GitHub's GraphQL API needs a token");
  let repository: Repository | null = null;
  let after: string | null = null;
  const gql = async (query: string) => {
    const d: any = await fetchJson("https://api.github.com/graphql", { query });
    if (d?.errors || !d?.data) throw new Failed(`GraphQL errors: ${JSON.stringify(d?.errors ?? d)}`);
    return d.data;
  };
  for (let page = 0; page < T3_MAX_PAGES; page++) {
    const data: any = await gql(t3Query(after));
    const repo: any = data?.repository;
    if (!repo) throw new Failed(`GraphQL errors: ${JSON.stringify(data)}`);
    if (!repository) repository = repo;
    else appendPage(repository, repo.releases?.nodes ?? []);
    const info: { hasNextPage: boolean; endCursor: string | null } | undefined = repo.releases?.pageInfo;
    // Nightly versions only go up, so the newest complete nightly listed is
    // the highest; nothing on later pages can matter.
    const nightly = repository!.releases!.nodes.some((r) => classify(r) === "nightly" && isComplete(r));
    if (nightly || !info?.hasNextPage) break;
    after = info.endCursor;
  }
  // The deciding releases' assets past the first page, before the channel
  // rules look for the required files.
  await fillAssets(decisive(repository!), gql, fillRules(repository!));
  return repository!;
}

/** The t3code release stream as a whole (channel rules, listing it), apart
 * from the t3code and t3code-nightly pins. */
export const RELEASES = "t3code-releases";

export async function resolveT3code(report: Report, held: Set<string>, retry: boolean, wanted: Set<string>,
  now = new Date(), fetchJson: FetchJson = getJson) {
  const picked = select(await fetchT3code(fetchJson));
  for (const r of picked.unknown) {
    report.observe(obs("no-match", RELEASES, r.tagName, "release fits no channel rule (latest, nightly, or skipped preview/android)"));
  }
  for (const r of picked.incomplete) {
    const age = now.getTime() - (r.createdAt ? Date.parse(r.createdAt) : now.getTime());
    // The detail stays the same from run to run, so the issue isn't
    // commented on every time; only a changed problem is.
    report.observe(age > INCOMPLETE_GRACE_MS
      ? obs("no-match", RELEASES, r.tagName, "release still missing files more than an hour after it was created", r.channel)
      : obs("incomplete", RELEASES, r.tagName, "release is missing files; checked again next run", r.channel));
  }
  // The stream was read. Problems seen in this same run stay open anyway
  // (issues.ts never closes a key it was just told about).
  report.observe(obs("releases-ok", RELEASES));
  // The pins in parallel; they share files, which are fetched once.
  await Promise.all(Object.entries(T3CODE).filter(([name]) => wanted.has(name)).map(async ([name, { channel, wanted: assets }]) => {
    const tag = picked[channel];
    if (!tag) {
      if (!picked.incomplete.some((r) => r.channel === channel)) {
        report.observe(obs("no-match", name, null, `no complete release found on the ${channel} channel`));
      }
      return;
    }
    try {
      const previous = currentPin(name, report.versionsDir);
      const pin = await buildGithubPin(name, "pingdotgg/t3code", tag, assets,
        { prerelease: tag.includes("-nightly."), partialSums: true, previous });
      // The license URL names the tag's commit (see buildGithubPin).
      const commit = /^https:\/\/raw\.githubusercontent\.com\/pingdotgg\/t3code\/([0-9a-f]{40})\/LICENSE$/.exec(pin.licenses?.LICENSE?.url ?? "")?.[1]
        ?? fail(`${name} ${tag}: can't tell the release's commit`);
      pin.browser = await browserPin("pingdotgg/t3code", commit, previous?.browser);
      const speech = await speechPin("pingdotgg/t3code", commit, previous?.speech);
      pin.speech = speech.pin;
      if (speech.note) report.observe(obs("note", name, tag, speech.note));
      const electron = await electronPin("pingdotgg/t3code", commit);
      pin.electron = electron.version;
      if (electron.note) report.observe(obs("note", name, tag, electron.note));
      report.candidate(pin, held, retry);
    } catch (e: any) {
      report.observe(obs("resolve-failed", name, tag, String(e?.message ?? e)));
    }
  }));
}

/** boat: the prod version from boat's own update endpoint, for both
 * platforms, then the GitHub release it names. Accepted only when both
 * platforms name the same plain X.Y.Z (never a staging or region build),
 * with the tag boat-cli-v<version> and the download URL boat itself would
 * use; never a tag from the list. A rollout in progress (platforms
 * disagreeing, or the release still missing a file, its digest or
 * SHA256SUMS) is `incomplete` for an hour after the newer release was
 * published, then a problem. Every observation names the plain version. */
export async function resolveBoat(report: Report, held: Set<string>, retry: boolean, now = new Date(), fetchJson: FetchJson = getJson) {
  const { repo, platforms, endpoint } = BOAT;
  const releaseOf = async (tag: string): Promise<any | null> => {
    try {
      const r = await fetchJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
      return r && !r.draft ? r : null;
    } catch (e: any) {
      if (/HTTP 404/.test(String(e?.message))) return null;
      throw e;
    }
  };
  const replies = await Promise.all(Object.entries(platforms).map(async ([system, platform]) => {
    const r = await fetchJson(endpoint(platform));
    const version = typeof r?.version === "string" ? r.version : "";
    if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`boat's ${platform} prod version is ${JSON.stringify(r?.version)}, not a plain X.Y.Z`);
    const tag = `boat-cli-v${version}`;
    if (r.tag !== tag) fail(`boat's ${platform} reply names tag ${JSON.stringify(r.tag)} for ${version}`);
    const url = `https://github.com/${repo}/releases/download/${tag}/boat-${platform}`;
    if (r.downloadUrl !== url) fail(`boat's ${platform} download URL is ${JSON.stringify(r.downloadUrl)}, not ${url}`);
    return { system, platform, version, tag };
  }));
  const versions = [...new Set(replies.map((r) => r.version))];
  const version = versions.length === 1 ? versions[0] : versions.sort((a, b) => compareVersions(b, a) ?? 0)[0];
  try {
    const tags = [...new Set(replies.map((r) => r.tag))];
    const releases = await Promise.all(tags.map(releaseOf));
    const published = releases.map((r) => Date.parse(r?.published_at ?? "")).filter(Number.isFinite);
    const graceLeft = published.length > 0 && now.getTime() - Math.max(...published) <= INCOMPLETE_GRACE_MS;
    const rollout = (what: string) => {
      if (graceLeft) return report.observe(obs("incomplete", "boat", version, `${what}; checked again next run`));
      if (!published.length) fail(`${what}, and no published release to wait for`);
      report.observe(obs("no-match", "boat", version, `${what} more than an hour after the release`));
    };
    if (versions.length > 1) return rollout(`boat's platforms name different versions (${replies.map((r) => `${r.platform} ${r.version}`).join(", ")})`);
    const release = releases[0];
    if (!release) fail(`boat ${version}: no published release for ${tags[0]}`);
    const names = new Map<string, any>((release.assets ?? []).map((a: any) => [a?.name, a]));
    const missing = [...replies.map((r) => `boat-${r.platform}`).filter((n) => !/^sha256:[0-9a-f]{64}$/.test(names.get(n)?.digest ?? "")),
      ...(names.has("SHA256SUMS") ? [] : ["SHA256SUMS"])];
    if (missing.length) {
      if (graceLeft) return rollout(`boat ${version}'s release is missing ${missing.join(", ")}`);
      fail(`boat ${version}'s release is missing ${missing.join(", ")}`);
    }
    const wanted = Object.fromEntries(replies.map((r) => [r.system, `boat-${r.platform}`]));
    const pin = await buildGithubPin("boat", repo, tags[0], wanted, { previous: currentPin("boat", report.versionsDir), release });
    report.candidate({ ...pin, version }, held, retry);
  } catch (e: any) {
    report.observe(obs("resolve-failed", "boat", version, String(e?.message ?? e)));
  }
}

export async function resolveVendor(report: Report, name: string, held: Set<string>, retry: boolean) {
  const auto = { held: (v: string) => !retry && held.has(`${name}\0${v}`) };
  try {
    report.candidate(await buildVendorPin(name, null, currentPin(name, report.versionsDir), auto), held, retry);
  } catch (e) {
    if (!(e instanceof Skip)) throw e;
    report.resolved.set(name, e.version);
    report.observe(obs(e.kind, name, e.version, e.message));
  }
}

type NpmLatest = Map<string, Promise<{ ok: true; version: string | null } | { ok: false; error: any }>>;

/** Start fetching npm's `latest` for the wanted packages, so it runs alongside
 * the source resolves; never rejects. */
export function startNpm(wanted: Set<string>, fetchJson: FetchJson = getJson): NpmLatest {
  return new Map(Object.entries(NPM).filter(([name]) => wanted.has(name)).map(([name, pkg]) =>
    [name, Promise.resolve().then(() => fetchJson(`https://registry.npmjs.org/${pkg}/latest`)).then(
      (r) => ({ ok: true as const, version: r?.version ?? null }), (error) => ({ ok: false as const, error }))]));
}

/** Compare npm's `latest` with what upstream points at (not our pin, which may
 * be held back on purpose). Only for packages that resolved; a fetch for one
 * that didn't is ignored, as if it had never been made. */
export async function checkNpm(report: Report, wanted: Set<string>, fetchJson: FetchJson = getJson, started = startNpm(wanted, fetchJson)) {
  await Promise.all(Object.entries(NPM).map(async ([name, pkg]) => {
    if (!wanted.has(name) || !report.resolved.has(name)) return;
    const ours = report.resolved.get(name)!;
    const latest = await started.get(name)!;
    if (!latest.ok) {
      const e = latest.error;
      report.observe(obs("resolve-failed", name, null, `npm ${pkg}: ${e?.message ?? e}`, "npm"));
      return;
    }
    const npm = latest.version;
    report.observe(obs("npm-ok", name, null, "", "npm"));
    report.observe(npm === ours
      ? obs("latest-match", name, ours, `npm's \`latest\` for ${pkg} agrees`, "npm")
      : obs("latest-mismatch", name, ours,
        `npm's \`latest\` for ${pkg} is ${npm}, upstream points at ${ours}; t3code's update notice compares against npm, so it may be stale or missing`, "npm"));
  }));
}

/** Is the working tree's flake.lock (after the bump) a nixpkgs revision
 * that's new and not held? Something new, like a changed pin. */
export function nixpkgsBump(head: string | null, work: string | null, held: Set<string>): boolean {
  const to = nixpkgsRev(work);
  return to !== null && to !== nixpkgsRev(head) && !held.has(`nixpkgs\0${to}`);
}

/** The packages to resolve again without skipping holds: those that
 * reported `held`, but only when nothing else is new (no changed pin, no
 * new nixpkgs revision). A new release is never tested beside a held
 * version, and the hourly backstop's quiet runs do the retries. */
export function retryNames(report: Report, nixpkgsNew: boolean): Set<string> {
  if (report.changed.length || nixpkgsNew) return new Set();
  return new Set(report.observations.filter((o) => o.kind === "held" && o.package).map((o) => o.package!));
}

/** flake.lock on main and in the working tree (after the bump), as text or
 * null; tests replace read(). */
export const locks = {
  read(): { head: string | null; work: string | null } {
    const head = tryRun("git", ["-C", ROOT, "show", "HEAD:flake.lock"]);
    const work = join(ROOT, "flake.lock");
    return { head: head.status === 0 ? head.stdout : null, work: existsSync(work) ? readFileSync(work, "utf8") : null };
  },
};

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The floor: a bump is due when flake.lock is this old on main. */
export const BUMP_FLOOR_MS = 7 * DAY_MS;
/** A bump declined for the cache opens an issue once flake.lock is this old. */
export const BUMP_ISSUE_MS = 14 * DAY_MS;
/** The bump has to be done this long after update.ts starts, so reading
 * upstream (which can be slow) and the bump together leave resolve time
 * for a retry pass and its other steps (its job limit is in update.yml).
 * It gets what's left, up to BUMP_BUDGET_MS; with less than MIN_BUMP_MS
 * left it waits for the next run. */
export const BUMP_BY_MS = 20 * 60_000;
export const MIN_BUMP_MS = 3 * 60_000;
/** How many of the uncached builds a note names. */
const MISSING_SHOWN = 30;

export interface LockHistory {
  /** When flake.lock last changed on main (ms), or null if it never did. */
  lockChangedAt: number | null;
  /** The latest channel's t3code version of the first commit on main after that
   * change whose version differs from its parent's, or null. */
  latestChannelSince: string | null;
}

/** main's history, so no state is kept between runs; tests replace read(). */
export const history = {
  /** For `file`: flake.lock (the main bump) or versions/nixpkgs-stable.json. */
  read(dir = ROOT, file = "flake.lock"): LockHistory {
    const g = (...args: string[]) => tryRun("git", ["-C", dir, ...args]);
    const last = g("log", "-1", "--format=%H %ct", "HEAD", "--", file);
    if (last.status !== 0) throw new Failed(`git log: ${last.stderr}`);
    const [sha, ct] = last.stdout.split(" ");
    const version = (rev: string) => {
      const r = g("show", `${rev}:versions/t3code.json`);
      try { return r.status === 0 ? String(JSON.parse(r.stdout).version ?? "") || null : null; } catch { return null; }
    };
    const commits = g("log", "--reverse", "--format=%H", sha ? `${sha}..HEAD` : "HEAD", "--", "versions/t3code.json");
    if (commits.status !== 0) throw new Failed(`git log: ${commits.stderr}`);
    let latestChannelSince: string | null = null;
    for (const c of commits.stdout.split("\n").filter(Boolean)) {
      const v = version(c);
      if (v !== null && v !== version(`${c}^`)) { latestChannelSince = v; break; }
    }
    return { lockChangedAt: sha ? Number(ct) * 1000 : null, latestChannelSince };
  },
};

/** Why a nixpkgs bump is due, or null: a new T3 Code on the latest channel in this run's
 * first pass (a changed version, not new bytes for the same one; held
 * versions never get here), one on main since flake.lock last changed, or
 * the weekly floor. */
export function bumpDue(h: LockHistory, report: Report, now: Date): string | null {
  const own = report.changed.find((c) => c.name === "t3code" && c.from !== c.to);
  if (own) return `new T3 Code ${own.to} on the latest channel`;
  if (h.latestChannelSince) return `T3 Code ${h.latestChannelSince} on the latest channel reached main after the last nixpkgs bump`;
  if (h.lockChangedAt === null || now.getTime() - h.lockChangedAt > BUMP_FLOOR_MS) return "a week since the last nixpkgs bump";
  return null;
}

export interface BumpResult {
  from: string | null;
  to: string | null;
  /** flake.lock now holds the bump. */
  offered: boolean;
  /** "<system>: <name>" for nixpkgs builds not on cache.nixos.org. */
  missing: string[];
  /** What couldn't be checked. */
  unknown: string[];
  note?: string;
}

/** Bump flake.lock to the newest nixos-unstable and check the cache; put
 * the lock back unless the bump is offered. Tests replace run(), or its
 * three steps. */
export const bumper = {
  tops: (dir: string, budget: Budget) => allTops(dir, budget),
  update: (dir: string, budget: Budget) => { run("nix", ["flake", "update", "nixpkgs"], { cwd: dir, timeout: budget.left(3 * 60_000) }); },
  compare: (base: Record<string, string[]>, next: Record<string, string[]>, budget: Budget) => compare(base, next, null, undefined, budget),
  async run(dir = ROOT, budgetMs = BUMP_BUDGET_MS): Promise<BumpResult> {
    // One deadline for every step (lib/nixcache.ts); running out declines.
    const budget = new Budget(budgetMs);
    const path = join(dir, "flake.lock");
    const before = readFileSync(path, "utf8");
    const from = nixpkgsRev(before);
    const declined = (r: Partial<BumpResult>): BumpResult => {
      writeFileSync(path, before);
      return { from, to: null, offered: false, missing: [], unknown: [], ...r };
    };
    const why = (e: any) => String(e?.stderr || e?.message || e).trim().split("\n").slice(-5).join("\n");
    let base: Record<string, string[]>;
    try {
      base = bumper.tops(dir, budget);
    } catch (e) {
      return declined({ unknown: [`the packages don't evaluate at ${from}: ${why(e)}`] });
    }
    try {
      bumper.update(dir, budget);
    } catch (e) {
      return declined({ unknown: [`nix flake update failed: ${why(e)}`] });
    }
    const to = nixpkgsRev(readFileSync(path, "utf8"));
    if (!to || to === from) return declined({ to });
    let next: Record<string, string[]>;
    try {
      next = bumper.tops(dir, budget);
    } catch (e) {
      // Not offered: passing tests don't show the cache has everything, and
      // the failure may be passing. It waits, said in each run's summary
      // (and in a bump-waiting issue after 14 days).
      return declined({ to, unknown: [`the packages don't evaluate at ${to}: ${why(e)}`] });
    }
    let verdict;
    try {
      verdict = await bumper.compare(base, next, budget);
    } catch (e) {
      return declined({ to, unknown: [`the cache check failed: ${why(e)}`] });
    }
    if (verdict.missing.length || verdict.unknown.length) return declined({ to, ...verdict });
    return { from, to, offered: true, missing: [], unknown: [] };
  },
};

/** The bump, if due: offered as a change (unless that revision is held,
 * which candidate.ts deals with), or a note of why it waits. */
export async function maybeBump(report: Report, held: Set<string>, now: Date, h: LockHistory = history.read(),
  startedAt = now.getTime(), clock = Date.now): Promise<void> {
  const why = bumpDue(h, report, now);
  if (!why) return;
  const left = Math.min(BUMP_BUDGET_MS, startedAt + BUMP_BY_MS - clock());
  const r: BumpResult = left < MIN_BUMP_MS
    ? { from: nixpkgsRev(locks.read().head), to: null, offered: false, missing: [], unknown: ["not enough time left in this run (reading upstream was slow)"] }
    : await bumper.run(ROOT, left);
  if (r.offered) {
    if (!held.has(`nixpkgs\0${r.to}`)) report.changed.push({ name: "nixpkgs", from: r.from, to: r.to!, why: r.note ? `${why}; ${r.note}` : why });
    return;
  }
  if (!r.missing.length && !r.unknown.length) return; // nixos-unstable hasn't moved
  const shown = r.missing.slice(0, MISSING_SHOWN).map((m) => `not on cache.nixos.org yet: ${m}`);
  if (r.missing.length > MISSING_SHOWN) shown.push(`and ${r.missing.length - MISSING_SHOWN} more`);
  const lines = [...shown, ...r.unknown.map((u) => `couldn't check: ${u}`)];
  report.observe(obs("waiting", "nixpkgs", r.to, [`bump due (${why}) waits for the cache; next run tries again`, ...lines].join("\n")));
  // The issue names what's missing, not the revision tried, so it isn't
  // "changed" each time nixos-unstable moves.
  if (h.lockChangedAt === null || now.getTime() - h.lockChangedAt > BUMP_ISSUE_MS) {
    report.observe(obs("bump-waiting", "nixpkgs", r.from,
      ["flake.lock hasn't changed on main for more than 14 days, and the bump waits:", ...lines.map((l) => l.replace(/^couldn't check: .*$/s, "couldn't check the cache"))]
        .filter((l, i, all) => all.indexOf(l) === i).join("\n")));
  }
}

/** NixOS stable's nixpkgs (versions/nixpkgs-stable.json, the stable
 * toggle's libraries): moved by the main bump's rules (each new T3 Code on
 * the latest channel, at least weekly, counted from its own file), and at once when a
 * newer NixOS release is out of beta; to the newest revision of the newest
 * released channel, only once the stable set needs nothing cache.nixos.org
 * lacks. Like the browser pins it reports `on-main` for main's revision and
 * `waiting` when it declines a move, never `pass`; `bump-waiting` after 14
 * days. Its own input, so holds and retries are the usual ones. */
export const STABLE_PIN = "nixpkgs-stable";
type StablePin = Pin & { channel: string; rev: string; narHash: string };
/** The cache check for a move: the stable set at the current pin against
 * the stable set at the proposed one (the pin file swapped in and put back).
 * Tests replace it. */
export const stableBumper = {
  async check(dir: string, budget: Budget, pin: StablePin, current: string) {
    const path = join(dir, "versions", `${STABLE_PIN}.json`);
    const base = allTops(dir, budget, "stable");
    writeFileSync(path, `${JSON.stringify(pin, null, 2)}\n`);
    try {
      return await compare(base, allTops(dir, budget, "stable"), null, undefined, budget);
    } finally {
      writeFileSync(path, current);
    }
  },
};
/** The resolve job's NixOS-stable observations, about main's checkout:
 * `stable-current` when the snapshot equals main's pins (a file
 * comparison); and every download the snapshot pins asked for, a few at
 * once, each with a short timeout, all within the time left (out of time is
 * unknown): any 404 or 410 is `stable-unfetchable` (the missing URLs, each
 * marked when main pins it too), all there is `fetchable`, anything else
 * says nothing. */
export const PROBE = { concurrency: 4, eachMs: 15_000, totalMs: 3 * 60_000 };
export type Probe = (url: string, timeoutMs: number) => Promise<"ok" | "missing" | "unknown">;
export const probeUrl: Probe = async (url, timeoutMs) => {
  // One deadline for both requests (HEAD, then GET where HEAD is refused).
  const signal = AbortSignal.timeout(timeoutMs);
  const ask = async (method: "HEAD" | "GET") => {
    const res = await fetch(url, { method, redirect: "follow", signal, headers: { "user-agent": UA, ...(method === "GET" ? { range: "bytes=0-0" } : {}) } });
    await res.body?.cancel();
    return res.status;
  };
  try {
    let status = await ask("HEAD");
    if (status === 403 || status === 405) status = await ask("GET"); // hosts that refuse HEAD
    return status >= 200 && status < 300 ? "ok" : status === 404 || status === 410 ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
};
export async function stableSnapshotChecks(report: Report, until: number, probe: Probe = probeUrl, clock = Date.now,
  tree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd: ROOT })): Promise<void> {
  if (snapshotCurrent(tree)) report.observe(obs("stable-current", null, null, ""));
  const { urls, alsoMain, unreadable } = snapshotDownloads(tree);
  const missing: string[] = [];
  let unknown = 0;
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const left = until - clock();
      const r = left <= 0 ? "unknown" : await probe(url, Math.min(PROBE.eachMs, left));
      if (r === "missing") missing.push(alsoMain.has(url) ? `${url} (main pins it too)` : url);
      else if (r === "unknown") unknown++;
    }
  };
  await Promise.all(Array.from({ length: PROBE.concurrency }, worker));
  if (missing.length) report.observe(obs("stable-unfetchable", null, null, missing.sort().join("\n")));
  else if (!unknown && !unreadable.length && urls.length) report.observe(obs("fetchable", null, null, ""));
  if (unreadable.length) console.warn(`update: snapshot pins not read, their downloads unknown: ${unreadable.join(", ")}`);
}

/** The resolve job's Electron fallback observations, from main's
 * ci/electron-fallback.json (not the working tree, which --write changes):
 * `electron-fallback` per channel with an active entry (detail: the entry's
 * short nixpkgs revision, as the verdict reports it), else `electron-ok`.
 * Every run, so a lost observation is repaired. */
export function electronFallbackChecks(report: Report, read: Reader = (path) => {
  const r = tryRun("git", ["-C", ROOT, "show", `HEAD:${path}`]);
  return r.status === 0 ? `${r.stdout}\n` : null;
}): void {
  const active = activeChannels(read);
  for (const c of CHANNELS) {
    if (pairOf(read, c) === null) continue;
    if (active.includes(c)) report.observe(obs("electron-fallback", c, null, `nixpkgs ${pairOf(read, c)!.nixpkgs.slice(0, 12)}`));
    else report.observe(obs("electron-ok", c, null, ""));
  }
}

export async function maybeBumpStable(report: Report, held: Set<string>, now: Date,
  h: LockHistory = history.read(ROOT, `versions/${STABLE_PIN}.json`), startedAt = now.getTime(), clock = Date.now, dir = ROOT,
  retry = false): Promise<void> {
  const path = join(dir, "versions", `${STABLE_PIN}.json`);
  if (!existsSync(path)) return;
  const current = readFileSync(path, "utf8");
  const cur = JSON.parse(current) as StablePin;
  report.observe(obs("on-main", STABLE_PIN, cur.rev));
  const waiting = (to: string | null, why: string, cache = false) => {
    report.observe(obs("waiting", STABLE_PIN, to, why));
    if (cache && (h.lockChangedAt === null || now.getTime() - h.lockChangedAt > BUMP_ISSUE_MS)) {
      report.observe(obs("bump-waiting", STABLE_PIN, cur.rev,
        `versions/${STABLE_PIN}.json hasn't changed on main for more than 14 days, and the move waits: ${why.split("\n")[0]}`));
    }
  };
  // Everything below within what's left of the bump's deadline.
  const left = Math.min(BUMP_BUDGET_MS, startedAt + BUMP_BY_MS - clock());
  if (left < MIN_BUMP_MS) return waiting(null, "not enough time left in this run to look for a move", true);
  const budget = new Budget(left);
  const channel = await newestStable(cur.channel);
  const rev = await channels.rev(channel);
  if (rev === cur.rev && channel === cur.channel) return;
  // A retry (a held revision, nothing else new) needs no new reason.
  const why = channel !== cur.channel ? `NixOS ${channel.replace("nixos-", "")} is out`
    : retry ? "retrying a held revision" : bumpDue(h, report, now)?.replace("nixpkgs bump", "nixpkgs-stable move");
  if (!why) return waiting(rev, `${channel} moved; a move isn't due yet (with the next T3 Code on the latest channel, or a week after the last one)`);
  try {
    const narHash = await channels.prefetch(rev, budget.left(NIX_TIMEOUT_MS));
    const pin: StablePin = { name: STABLE_PIN, version: rev, assets: {}, channel, rev, narHash, released: { at: now.toISOString(), kind: "seen" } };
    const verdict = await stableBumper.check(dir, budget, pin, current);
    if (verdict.missing.length || verdict.unknown.length) {
      const lines = [...verdict.missing.slice(0, MISSING_SHOWN).map((m) => `not on cache.nixos.org yet: ${m}`), ...verdict.unknown.map((u) => `couldn't check: ${u}`)];
      return waiting(rev, [`move due (${why}) waits for the cache`, ...lines].join("\n"), true);
    }
    report.candidate(pin, held, retry);
    const c = report.changed.find((x) => x.name === STABLE_PIN);
    if (c) c.why = why;
  } catch (e: any) {
    return waiting(rev, `couldn't check the move: ${String(e?.message ?? e).split("\n").slice(-3).join(" ")}`, true);
  }
}

async function resolveAll(report: Report, wanted: Set<string>, held: Set<string>, retry: boolean, waits: Map<string, Wait> = new Map()) {
  const jobs: [string, () => Promise<void>][] = [
    ...Object.keys(GITHUB).filter((n) => wanted.has(n)).map((n) => [n, () => resolveGithub(report, n, held, retry)] as [string, () => Promise<void>]),
    ...(Object.keys(T3CODE).some((n) => wanted.has(n)) ? [[RELEASES, () => resolveT3code(report, held, retry, wanted)] as [string, () => Promise<void>]] : []),
    ...VENDOR.filter((n) => wanted.has(n)).map((n) => [n, () => resolveVendor(report, n, held, retry)] as [string, () => Promise<void>]),
    ...(wanted.has("boat") ? [["boat", () => resolveBoat(report, held, retry)] as [string, () => Promise<void>]] : []),
    ...(BROWSERS.some((n) => wanted.has(n)) ? [["browser pins", () => resolveBrowserPins(report, wanted, held, retry, report.now, waits)] as [string, () => Promise<void>]] : []),
  ];
  // Sources are independent: resolve them in parallel, each with its own
  // error boundary, so one bad source never stops the others.
  await Promise.all(jobs.map(async ([name, job]) => {
    try {
      await job();
    } catch (e: any) {
      report.observe(obs("resolve-failed", name, null, `${e?.constructor?.name ?? "Error"}: ${e?.message ?? e}`));
    }
  }));
}

export async function main(argv: string[]): Promise<number> {
  const startedAt = Date.now();
  let args;
  try {
    const { values } = parseArgs({ args: argv, strict: true, options: {
      write: { type: "boolean", default: false }, only: { type: "string" }, held: { type: "string" },
    } });
    args = { write: values.write, only: values.only ?? null, held: values.held ?? process.env.HELD_JSON ?? null };
  } catch (e: any) {
    console.error(`update: ${e.message}`);
    return 2;
  }
  let wanted = new Set(ALL);
  if (args.only) {
    wanted = new Set(args.only.split(","));
    const unknown = [...wanted].filter((n) => !ALL.includes(n));
    if (unknown.length) { console.error(`update: unknown package(s) ${unknown.sort().join(", ")}; known: ${ALL.join(", ")}`); return 2; }
  }
  const held = new Set<string>();
  // A browser pin's wait for its optional browsers: since when (held.ts).
  const waits = new Map<string, Wait>();
  if (args.held && existsSync(args.held)) {
    for (const h of JSON.parse(readFileSync(args.held, "utf8"))) {
      if (typeof h?.since === "string") waits.set(h.package, { since: h.since, from: typeof h.from === "string" ? h.from : null });
      else held.add(`${h.package}\0${h.version}`);
    }
  }

  const report = new Report();
  // npm's answers are only compared once the resolves are done.
  const npmLatest = startNpm(wanted);
  await resolveAll(report, wanted, held, false, waits);
  if (args.write && !args.only) {
    // The pins first, so the bump's cache check sees the candidate's
    // packages; written again at the end, after any second pass.
    for (const [name, pin] of report.pins) writeJson(join(VERSIONS, `${name}.json`), pin);
    try {
      await maybeBump(report, held, new Date(), undefined, startedAt);
    } catch (e: any) {
      report.observe(obs("waiting", "nixpkgs", null, `couldn't decide the nixpkgs bump: ${e?.message ?? e}`));
    }
    try {
      await maybeBumpStable(report, held, new Date(), undefined, startedAt);
    } catch (e: any) {
      report.observe(obs("waiting", STABLE_PIN, null, `couldn't decide the nixpkgs-stable move: ${e?.message ?? e}`));
    }
  }
  const lock = locks.read();
  const retry = retryNames(report, nixpkgsBump(lock.head, lock.work, held));
  if (retry.size) {
    const second = new Report();
    await resolveAll(second, retry, held, true, waits);
    // nixpkgs-stable has no resolver of its own: its move is retried here.
    if (retry.has(STABLE_PIN)) {
      try {
        await maybeBumpStable(second, held, new Date(), undefined, startedAt, Date.now, ROOT, true);
      } catch (e: any) {
        second.observe(obs("waiting", STABLE_PIN, null, `couldn't retry the nixpkgs-stable move: ${e?.message ?? e}`));
      }
    }
    report.merge(second);
  }
  // The nixpkgs revision main locks passed the suite (see issues.ts, on-main).
  const onMain = nixpkgsRev(lock.head);
  if (onMain) report.observe(obs("on-main", "nixpkgs", onMain));
  // A whole run's only (`--only` resolves some sources by hand).
  if (!args.only) {
    try {
      electronFallbackChecks(report);
    } catch (e: any) {
      console.warn(`update: couldn't read the Electron fallback: ${e?.message ?? e}`);
    }
    try {
      await stableSnapshotChecks(report, Math.min(Date.now() + PROBE.totalMs, startedAt + 20 * 60_000));
    } catch (e: any) {
      console.warn(`update: couldn't check the NixOS-stable snapshot: ${e?.message ?? e}`);
    }
  }
  await checkNpm(report, wanted, getJson, npmLatest);

  if (args.write) for (const [name, pin] of report.pins) writeJson(join(VERSIONS, `${name}.json`), pin);
  // Sources finish in network order; sort so equal runs give equal reports.
  const order = (n: string | null) => (n === null ? -1 : ALL.indexOf(n));
  report.changed.sort((a, b) => order(a.name) - order(b.name));
  const key = (o: Observation) => [o.package ?? "", o.channel ?? "", o.kind, o.version ?? "", o.detail].join("\0");
  report.observations.sort((a, b) => order(a.package) - order(b.package) || key(a).localeCompare(key(b)));
  console.log(JSON.stringify({ checkedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"), changed: report.changed, observations: report.observations }, null, 2));
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
