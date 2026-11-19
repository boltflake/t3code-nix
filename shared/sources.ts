// Where each package's releases come from, shared by the watcher (Cloudflare
// Worker) and the updater, so both look at the same things. Pure data and
// string helpers: no Node or Worker APIs, so either can bundle it.

/** GitHub-released packages: the repo and the asset each system needs.
 * `tags`, for a repo that releases more than one line: the release with the
 * highest version among its last RECENT whose tag matches, instead of the
 * one GitHub marks latest. */
export const GITHUB: Record<string, { repo: string; wanted: Record<string, string>; licenses?: string[]; tags?: RegExp }> = {
  codex: {
    repo: "openai/codex",
    wanted: {
      "x86_64-linux": "codex-package-x86_64-unknown-linux-musl.tar.zst",
      "aarch64-linux": "codex-package-aarch64-unknown-linux-musl.tar.zst",
    },
    licenses: ["LICENSE", "NOTICE"],
  },
  fx: { repo: "vercel-labs/fx", wanted: { "x86_64-linux": "fx-linux-x86_64.tar.gz", "aarch64-linux": "fx-linux-aarch64.tar.gz" } },
  opencode: {
    repo: "anomalyco/opencode",
    wanted: { "x86_64-linux": "opencode-linux-x64.tar.gz", "aarch64-linux": "opencode-linux-arm64.tar.gz" },
    // 2.x and later, as t3code drives them (its opencode probe: major >= 2
    // is "v2"): upstream marks its 1.x line latest while 2.x moves ahead,
    // and 1.x maintenance releases must never pull the pin back. The repo
    // also releases process-daemon-v* tags.
    tags: /^v([2-9]|[1-9]\d+)\.(\d+)\.(\d+)$/,
  },
  pi: { repo: "earendil-works/pi", wanted: { "x86_64-linux": "pi-linux-x64.tar.gz", "aarch64-linux": "pi-linux-arm64.tar.gz" } },
  // An agent tool. The musl builds are static; the glibc ones would need
  // patching. The names hold no version, so the watcher checks them exactly.
  "agent-browser": {
    repo: "vercel-labs/agent-browser",
    wanted: { "x86_64-linux": "agent-browser-linux-musl-x64", "aarch64-linux": "agent-browser-linux-musl-arm64" },
  },
};

/** How many of a repo's newest releases `tags` looks at. */
export const RECENT = 100;

/** The tag among `tags` that matches `re` with the highest version (its
 * capture groups, compared as numbers), or null. */
export function highestTag(tags: string[], re: RegExp): string | null {
  let best: { tag: string; parts: number[] } | null = null;
  for (const tag of tags) {
    const m = re.exec(tag);
    if (!m) continue;
    const parts = m.slice(1).map(Number);
    const i = best ? parts.findIndex((n, k) => n !== best!.parts[k]) : 0;
    if (!best || (i >= 0 && parts[i] > best.parts[i])) best = { tag, parts };
  }
  return best?.tag ?? null;
}

/** A pin's version from its release tag ("v1.2.3", "rust-v0.1.0"). */
export const versionOfTag = (tag: string) => tag.replace(/^(rust-)?v/, "");

/** One page of t3code's releases, newest first (the channel rules need the
 * asset names to tell a complete release). Assets come 100 at a time with
 * their page info: a release with more is filled by fillAssets, so a
 * required file past the first page is never missed. */
const ASSETS = "pageInfo { hasNextPage endCursor } nodes { name }";
export const T3_RELEASE = `tagName isPrerelease isDraft createdAt releaseAssets(first: 100) { ${ASSETS} }`;
export const ASSET_MAX_PAGES = 10;
export const t3AssetPage = (tag: string, after: string) =>
  `query { repository(owner: "pingdotgg", name: "t3code") { release(tagName: ${JSON.stringify(tag)}) { releaseAssets(first: 100, after: ${JSON.stringify(after)}) { ${ASSETS} } } } }`;

/** Fetch the rest of each release's assets (up to ASSET_MAX_PAGES pages;
 * GitHub allows 1000 assets): only for releases `matters` keeps (the ones a
 * channel could pick, not skipped previews), each tag once, and at most
 * `budget` requests (the watcher's per-run request limit). `run` sends one
 * GraphQL query and returns its data. A page that doesn't come back, or a
 * budget that runs out, is an error (the caller decides what it costs),
 * never a release that silently looks incomplete. */
export async function fillAssets(releases: any[], run: (query: string) => Promise<any>,
  { matters = () => true, budget = Infinity, until = () => false, enough = () => false }:
  { matters?: (r: any) => boolean; budget?: number; until?: (r: any) => boolean; enough?: (r: any) => boolean } = {}): Promise<void> {
  const done = new Set<string>();
  let used = 0;
  for (const r of releases) {
    if (!matters(r) || done.has(r?.tagName)) continue;
    done.add(r?.tagName);
    let info = r?.releaseAssets?.pageInfo;
    // `enough`: the release is already decided (complete): no more pages.
    for (let page = 1; info?.hasNextPage && !enough(r) && page < ASSET_MAX_PAGES; page++) {
      if (++used > budget) throw new Error(`t3code ${r.tagName}: more asset pages than this run's budget (${budget})`);
      const more = (await run(t3AssetPage(r.tagName, info.endCursor)))?.repository?.release?.releaseAssets;
      if (!more || !Array.isArray(more.nodes)) throw new Error(`t3code ${r.tagName}: its assets past the first page didn't come back`);
      r.releaseAssets.nodes.push(...more.nodes);
      info = more.pageInfo;
      r.releaseAssets.pageInfo = info;
    }
    if (until(r)) return; // the rest can't change the result
  }
}
export const T3_PAGE = 40;
export const T3_MAX_PAGES = 3;
export const t3Releases = (after: string | null) =>
  `releases(first: ${T3_PAGE}${after ? `, after: ${JSON.stringify(after)}` : ""}, orderBy: {field: CREATED_AT, direction: DESC}) {
    pageInfo { hasNextPage endCursor } nodes { ${T3_RELEASE} } }`;

/** The vendors' own version pointers (the updater's resolvers read the same). */
export const VENDOR_URLS = {
  claude: "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases",
  grok: "https://storage.googleapis.com/grok-build-public-artifacts/cli",
  antigravity: "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests",
  kiro: "https://desktop-release.q.us-east-1.amazonaws.com",
  museChannel: "https://api.meta.ai/muse-code/channels/muse-stable",
  cursorInstall: "https://cursor.com/install",
  boat: "https://boat.dev/api/boat/cli/version",
} as const;

/** boat (boat.dev's sandbox CLI, an agent tool): its own update endpoint
 * names the prod version per platform, and the files are GitHub release
 * assets. Its tags mix prod, staging and region builds, so the tag list is
 * never used. */
export const BOAT = {
  repo: "ariana-dot-dev/agent-server",
  platforms: { "x86_64-linux": "linux-x64", "aarch64-linux": "linux-arm64" } as Record<string, string>,
  endpoint: (platform: string) => `${VENDOR_URLS.boat}?platform=${platform}&channel=prod`,
};

/** The version in cursor's install script (its download path). */
export const cursorVersion = (script: string) => /downloads\.cursor\.com\/lab\/([0-9][^/"'\s]*)\//.exec(script)?.[1] ?? null;

/** A version string as a vendor may publish it, or null. */
export const plausibleVersion = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(v.trim()) ? v.trim() : null;

/** NixOS channels, for agent-browser's browser pins (the updater's
 * lib/browserpins.ts and the watcher). Releases are YY.05 and YY.11. */
export const NIXOS_UNSTABLE = "nixos-unstable";
export const channelUrl = (channel: string) => `https://channels.nixos.org/${channel}`;

/** The release after nixos-YY.05 is nixos-YY.11, after YY.11 (YY+1).05. */
export function nextRelease(channel: string): string {
  const m = /^nixos-(\d\d)\.(05|11)$/.exec(channel);
  if (!m) throw new Error(`not a NixOS release channel: ${channel}`);
  return m[2] === "05" ? `nixos-${m[1]}.11` : `nixos-${String(Number(m[1]) + 1).padStart(2, "0")}.05`;
}

/** The release before it. */
export function previousRelease(channel: string): string {
  const m = /^nixos-(\d\d)\.(05|11)$/.exec(channel);
  if (!m) throw new Error(`not a NixOS release channel: ${channel}`);
  return m[2] === "11" ? `nixos-${m[1]}.05` : `nixos-${String(Number(m[1]) - 1).padStart(2, "0")}.11`;
}

/** The newest release whose month has come (it may still be in beta). */
export function latestRelease(now: Date): string {
  const yy = now.getUTCFullYear() % 100, month = now.getUTCMonth() + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  return month >= 11 ? `nixos-${pad(yy)}.11` : month >= 5 ? `nixos-${pad(yy)}.05` : `nixos-${pad(yy - 1)}.11`;
}

/** Released: the channel redirects to a target without "beta" (during the
 * beta it redirects to nixos-YY.MMbeta…; before, it's a 404). */
export const isReleased = (status: number, location: string | null) =>
  status >= 300 && status < 400 && !!location && !/beta/i.test(location.split("/").pop() ?? "");
