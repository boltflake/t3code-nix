// Channel rules for T3 Code releases, shared by the watcher (Cloudflare
// Worker) and the updater (scripts/update.ts). Both must agree on what
// counts as a new latest-channel release or nightly, so the rules live in one place.
//
// Every release is one of:
//   latest   vX.Y.Z, not a prerelease (the latest channel, upstream's
//            desktop update channel name)
//   nightly  vX.Y.Z-nightly.<yyyymmdd>.<n>, a prerelease
//   skip     on purpose: -preview. (maintainer test builds), android-*, drafts,
//            and update-feed (the desktop app's update feed, a prerelease
//            holding only a JSON file, first seen 2026-11-12)
//   unknown  anything else; a newer unknown release raises a no-match issue,
//            so a renamed channel can't freeze updates silently
//
// The nightly channel is whichever is newer of the newest nightly and the
// latest channel's release. A nightly sorts below its own vX.Y.Z version.

export interface Release {
  tagName: string;
  isPrerelease?: boolean;
  isDraft?: boolean;
  createdAt?: string | null;
  releaseAssets?: { nodes: { name: string }[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
}

export interface Repository {
  latestRelease?: Release | null;
  releases?: { nodes: Release[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
}

export type Kind = "latest" | "nightly" | "skip" | "unknown";

export interface Picked {
  latest: string | null;
  nightly: string | null;
  unknown: { tagName: string; createdAt?: string | null }[];
  incomplete: { tagName: string; createdAt?: string | null; channel: "latest" | "nightly" }[];
}

const LATEST_CHANNEL_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const NIGHTLY = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/;
const SKIP = [/-preview\./, /^android-/, /^update-feed$/];

export function classify({ tagName, isPrerelease, isDraft }: Release): Kind {
  if (isDraft) return "skip";
  if (LATEST_CHANNEL_TAG.test(tagName)) return isPrerelease ? "unknown" : "latest";
  if (NIGHTLY.test(tagName)) return isPrerelease ? "nightly" : "unknown";
  if (SKIP.some((r) => r.test(tagName))) return "skip";
  return "unknown";
}

// A sortable key for a latest-channel or nightly tag, or null.
export function versionKey(tagName: string): number[] | null {
  const n = NIGHTLY.exec(tagName);
  if (n) return [+n[1], +n[2], +n[3], 0, +n[4], +n[5]];
  const s = LATEST_CHANNEL_TAG.exec(tagName);
  if (s) return [+s[1], +s[2], +s[3], 1, 0, 0];
  return null;
}

export function compareTags(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  if (!ka || !kb) throw new Error(`not a latest-channel or nightly tag: ${!ka ? a : b}`);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

// The release files t3code-nix needs. A release counts only once all are listed.
export function requiredAssets(tagName: string): string[] {
  const v = tagName.replace(/^v/, "");
  return [
    `t3-${v}-linux-x64.tar.gz`,
    `t3-${v}-linux-arm64.tar.gz`,
    `T3-Code-${v}-amd64.deb`,
    `T3-Code-${v}-arm64.deb`,
    "SHA256SUMS",
  ];
}

export function isComplete(release: Release): boolean {
  const names = new Set((release.releaseAssets?.nodes ?? []).map((a) => a.name));
  return requiredAssets(release.tagName).every((n) => names.has(n));
}

// From GitHub GraphQL data ({ latestRelease, releases: { nodes } }), pick the
// latest-channel and nightly tags. Returns { latest, nightly, unknown,
// incomplete }:
//   latest      GitHub's latestRelease, the authoritative pointer for the
//               latest channel, so a rollback upstream is followed; null if
//               it's still missing files
//   nightly     the newest complete nightly, or the latest channel's release
//               if that's newer
//   unknown     [{ tagName, createdAt }] releases fitting no rule that are
//               newer than GitHub's latest release, so a renamed channel is
//               noticed even while nightlies keep coming
//   incomplete  [{ tagName, createdAt, channel }] latest/nightly releases
//               still missing files, newer than what was picked for their
//               channel (older ones no longer matter)
/** Append a list page's releases, leaving out tags already listed (a
 * release created between two pages moves everything down one, so the next
 * page repeats an entry). */
export function appendPage(repository: Repository, nodes: Release[]): void {
  const have = new Set((repository.releases?.nodes ?? []).map((r) => r.tagName));
  repository.releases!.nodes.push(...nodes.filter((r) => !have.has(r.tagName)));
}

export function select(repository: Repository): Picked {
  const githubLatest = repository.latestRelease ?? null;
  const nodes = [githubLatest, ...(repository.releases?.nodes ?? [])].filter((r): r is Release => Boolean(r));
  const seen = new Set<string>();
  const all: Release[] = [];
  for (const r of nodes) {
    if (seen.has(r.tagName)) continue;
    seen.add(r.tagName);
    all.push(r);
  }

  let latestChannel: string | null = null;
  const incomplete: Picked["incomplete"] = [];
  if (githubLatest && classify(githubLatest) === "latest") {
    if (isComplete(githubLatest)) latestChannel = githubLatest.tagName;
    else incomplete.push({ tagName: githubLatest.tagName, createdAt: githubLatest.createdAt, channel: "latest" });
  }

  let nightly: string | null = null;
  for (const r of all) {
    if (classify(r) !== "nightly" || !isComplete(r)) continue;
    if (!nightly || compareTags(r.tagName, nightly) > 0) nightly = r.tagName;
  }
  if (latestChannel && (!nightly || compareTags(latestChannel, nightly) > 0)) nightly = latestChannel;
  // Only incomplete nightlies newer than the final pick (the latest channel's included) matter.
  for (const r of all) {
    if (classify(r) !== "nightly" || isComplete(r)) continue;
    if (!nightly || compareTags(r.tagName, nightly) > 0) {
      incomplete.push({ tagName: r.tagName, createdAt: r.createdAt, channel: "nightly" });
    }
  }

  // GitHub's latest release always counts; others only if newer than it.
  const githubLatestCreated = githubLatest?.createdAt ?? null;
  const unknown = all
    .filter((r) => classify(r) === "unknown")
    .filter((r) => r === githubLatest || !githubLatestCreated || !r.createdAt || r.createdAt > githubLatestCreated)
    .map((r) => ({ tagName: r.tagName, createdAt: r.createdAt }));
  return { latest: latestChannel, nightly, unknown, incomplete };
}

/** The releases that decide select()'s picks, in the order to look at their
 * assets: GitHub's latest release (the latest channel), then the nightlies from the highest
 * version down; once a complete nightly is found, older ones can't matter
 * (lastDecisive). Assets past the first page are fetched only for these. */
export function decisive(repository: Repository): Release[] {
  const githubLatest = repository.latestRelease ?? null;
  // The first copy of a tag, as select() judges it (a release created between
  // two list pages repeats one entry; the fetchers drop repeats too).
  const nightlies = (repository.releases?.nodes ?? [])
    .filter((r, i, all) => classify(r) === "nightly" && all.findIndex((x) => x.tagName === r.tagName) === i)
    .sort((a, b) => compareTags(b.tagName, a.tagName));
  return [...(githubLatest && classify(githubLatest) === "latest" ? [githubLatest] : []), ...nightlies];
}
export const lastDecisive = (r: Release) => classify(r) === "nightly" && isComplete(r);

/** fillAssets' rules for decisive(repository): a complete release needs no
 * more pages (enough); nightlies at or below a complete latest-channel
 * release can't change the picks (it wins both channels), so they're skipped
 * (matters is asked when the loop reaches each one, after that release was
 * filled); and
 * the first complete nightly ends it (until). */
export function fillRules(repository: Repository) {
  const githubLatest = repository.latestRelease ?? null;
  return {
    enough: (r: Release) => isComplete(r),
    until: lastDecisive,
    matters: (r: Release) => !(classify(r) === "nightly" && githubLatest && classify(githubLatest) === "latest" && isComplete(githubLatest)
      && compareTags(r.tagName, githubLatest.tagName) <= 0),
  };
}
