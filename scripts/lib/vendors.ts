// Pins for the providers that aren't released on GitHub. The hash comes
// from the vendor's own checksum where it publishes one (see
// docs/acceptance-matrix.md). grok publishes none: its files are downloaded
// and pinned as downloaded, only for a new version (or by hand, with
// pin.ts); an unchanged storage MD5 reuses the old hash.
import { cursorVersion, plausibleVersion, VENDOR_URLS } from "../../shared/sources.ts";
import { allInOrder, checksumsFor, early, fail, getJson, getResponse, getText, request, sha256Hex, sri, SYSTEMS, UNVERIFIED, type Asset, type Pin, type Released } from "./util.ts";

const CLAUDE = VENDOR_URLS.claude;
const GROK = VENDOR_URLS.grok;
const ANTIGRAVITY = VENDOR_URLS.antigravity;
const KIRO = VENDOR_URLS.kiro;
const MUSE_CHANNEL = VENDOR_URLS.museChannel;
const MUSE = "https://lookaside.facebook.com/lookaside/muse/download/";

/** How the updater calls a resolver; pin.ts (by hand) passes none. */
export interface Auto {
  /** True if an open issue holds this version (and this isn't a retry). */
  held: (version: string) => boolean;
}
/** A resolver found nothing to pin and says why, without downloading. */
export class Skip extends Error {
  kind: "held" | "integrity";
  version: string;
  constructor(kind: "held" | "integrity", version: string, detail: string) {
    super(detail);
    this.kind = kind;
    this.version = version;
  }
}

export type Resolver = (version: string | null, previous: Pin | null, auto?: Auto) =>
  Promise<{ version: string; assets: Record<string, Asset>; released?: Released }>;

export function checkVersion(v: string | null | undefined): string {
  if (!v || plausibleVersion(v) !== v) fail(`unexpected version string ${JSON.stringify(v)}`);
  return v;
}

/** The one SHA-256 a checksum file gives for `asset`: a bare hash, or
 * "<hash>  <name>" lines. Missing or conflicting entries are an error. */
export function checksumFromFile(text: string, asset: string): string {
  const matches = checksumsFor(text, asset, true);
  if (new Set(matches).size !== 1) fail(`checksum file has ${matches.length ? "conflicting" : "no"} entries for ${asset}`);
  return matches[0];
}

/** What a HEAD request (about 740 bytes) says about a Google Cloud Storage
 * object: its MD5 (x-goog-hash; grok's cheap change detector) and its
 * Last-Modified, each or null. */
export async function gcsHead(url: string): Promise<{ md5: string | null; lastModified: string | null }> {
  let hash = "", lastModified: string | null = null;
  await request(url, { method: "HEAD", onHeaders: (h) => { hash = h.get("x-goog-hash") ?? ""; lastModified = h.get("last-modified"); } });
  let md5: string | null = null;
  for (const part of hash.split(",")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "md5") md5 = v.join("=");
  }
  return { md5, lastModified };
}

/** An HTTP date ("Mon, 23 Nov 2026 21:34:39 GMT") as ISO, or null when it
 * isn't one: it must read back the same, so "31 Feb" isn't 3 March. */
const httpDate = (s: string | null) => {
  const d = new Date(s ? Date.parse(s) : NaN);
  return Number.isFinite(d.getTime()) && d.toUTCString() === s ? d.toISOString() : null;
};

/** A file's Last-Modified, from a HEAD request (one 20 s deadline for
 * every attempt and the waits between them), or null. The time is only for
 * the status page, so a failed request never stops a pin: it counts as no
 * header. */
async function lastModified(url: string): Promise<string | null> {
  let at: string | null = null;
  try {
    await request(url, { method: "HEAD", timeoutMs: 20_000, onHeaders: (h) => { at = h.get("last-modified"); } });
  } catch {
    return null;
  }
  return at;
}

/** A file's Last-Modified as an upload time. No header means "seen"; one
 * that isn't an HTTP date becomes "unreadable", which settleReleased can't
 * parse, so the time is unknown (the header itself isn't passed on:
 * Date.parse would find a date in "2026-11-13" or "31 Feb"). */
function uploaded(lastModified: string | null): Released | undefined {
  if (lastModified === null) return undefined;
  return { at: httpDate(lastModified) ?? "unreadable", kind: "uploaded" };
}

/** The SRI hash of a download (the same flat SHA-256 `nix store
 * prefetch-file` gives), with request()'s retries. No Nix needed. */
export async function prefetch(url: string): Promise<string> {
  return sri("sha256", sha256Hex(await request(url, { timeoutMs: 10 * 60 * 1000 })));
}

/** Indirection so tests can stand in for the download. */
export const io = { prefetch };

// The release is the moment the `latest` pointer moves to the version (the
// GitHub release follows within seconds); the files and the manifest's
// buildDate are often hours older. A version asked for by name (pin.ts)
// falls back to buildDate.
const claude: Resolver = async (version) => {
  let movedAt: string | null = null;
  if (version === null) {
    const latest = await getResponse(`${CLAUDE}/latest`);
    version = latest.body.toString("utf8").trim();
    movedAt = latest.headers.get("last-modified");
  }
  const v = checkVersion(version);
  const manifest = await getJson(`${CLAUDE}/${v}/manifest.json`);
  if (manifest?.version !== v) fail(`claude manifest is for ${manifest?.version}, not ${v}`);
  const published = httpDate(movedAt);
  const released: Released | undefined = published ? { at: published, kind: "published" }
    : typeof manifest.buildDate === "string" ? { at: manifest.buildDate, kind: "built" } : undefined;
  const assets: Record<string, Asset> = {};
  for (const [system, plat] of [["x86_64-linux", "linux-x64"], ["aarch64-linux", "linux-arm64"]]) {
    assets[system] = {
      url: `${CLAUDE}/${v}/${plat}/claude`,
      hash: sri("sha256", manifest.platforms?.[plat]?.checksum),
      checksumSource: `${CLAUDE}/${v}/manifest.json`,
    };
  }
  return { version: v, assets, released };
};

// grok's files are ~200 MB each, so the updater downloads only what it could
// pin: never a held version, never changed bytes it would refuse anyway.
const grok: Resolver = async (version, previous, auto) => {
  const v = checkVersion(version ?? (await getText(`${GROK}/stable`)).trim());
  const same = previous?.version === v;
  if (auto && !same && auto.held(v)) throw new Skip("held", v, "an open issue holds this version");
  const files = [["x86_64-linux", "linux-x86_64"], ["aarch64-linux", "linux-aarch64"]].map(([system, plat]) =>
    ({ system, url: `${GROK}/grok-${v}-${plat}`, old: previous?.assets?.[system] }));
  // Both systems' HEADs together; each answer is checked in system order,
  // as one after another, and every check comes before any download.
  const heads = files.map((f) => early(gcsHead(f.url)));
  const md5s: (string | null)[] = [];
  let lastModified: string | null = null;
  for (const [i, { old }] of files.entries()) {
    const head = await heads[i]();
    md5s.push(head.md5);
    lastModified ??= head.lastModified;
    // Same version, different MD5: the bytes changed and nothing vouches for
    // them (pin.ts re-pins by hand after a check).
    if (auto && same && md5s[i] && old?.md5 && old.md5 !== md5s[i]) throw new Skip("integrity", v, UNVERIFIED);
  }
  const hashes = await allInOrder(files.map(({ url, old }, i) =>
    same && md5s[i] && old?.md5 === md5s[i] ? Promise.resolve(old!.hash) : io.prefetch(url)));
  const assets: Record<string, Asset> = {};
  for (const [i, { system, url }] of files.entries()) {
    assets[system] = { url, hash: hashes[i], md5: md5s[i], checksumSource: "none (downloaded)" };
  }
  // The first upload time a file gives.
  const released = uploaded(lastModified);
  return { version: v, assets, ...(released ? { released } : {}) };
};

const cursor: Resolver = async (version, previous) => {
  if (!version) {
    version = cursorVersion(await getText(VENDOR_URLS.cursorInstall)) ?? fail(`no lab/<version> in ${VENDOR_URLS.cursorInstall}`);
  }
  const v = checkVersion(version);
  const layout = [["x86_64-linux", "linux/x64"], ["aarch64-linux", "linux/arm64"]];
  const tarball = (plat: string) => `https://downloads.cursor.com/lab/${v}/${plat}/agent-cli-package.tar.gz`;
  // The x86_64 file's upload time (no release time is published), read
  // alongside the sidecars; a version already pinned keeps its time.
  const head = previous?.version === v ? Promise.resolve(null) : lastModified(tarball(layout[0][1]));
  const found = await allInOrder(layout.map(async ([, plat]) => {
    const url = tarball(plat);
    const hex = checksumFromFile(await getText(`${url}.sha256`), "agent-cli-package.tar.gz");
    return { url, hash: sri("sha256", hex), checksumSource: `${url}.sha256` };
  }));
  const assets: Record<string, Asset> = {};
  for (const [i, [system]] of layout.entries()) assets[system] = found[i];
  const released = uploaded(await head);
  return { version: v, assets, ...(released ? { released } : {}) };
};

const antigravity: Resolver = async (version, previous) => {
  if (version) fail("antigravity only publishes its current version; pin without VERSION");
  const layout: [string, string, string, string][] = [
    ["x86_64-linux", "linux_amd64", "linux-x64", "cli_linux_x64.tar.gz"],
    ["aarch64-linux", "linux_arm64", "linux-arm", "cli_linux_arm64.tar.gz"],
  ];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = await allInOrder(layout.map(async ([system, plat, folder, file]) => {
    const m = await getJson(`${ANTIGRAVITY}/${plat}.json`);
    const v = checkVersion(m?.version);
    // A versioned file in Google's bucket, for this architecture only.
    const expected = new RegExp(`^https://storage\\.googleapis\\.com/antigravity-public/antigravity-cli/${esc(v)}-[0-9]+/${esc(folder)}/${esc(file)}$`);
    if (!expected.test(m.url ?? "")) fail(`unexpected antigravity URL for ${system}: ${m.url}`);
    return { v, asset: { url: m.url, hash: sri("sha512", m.sha512), checksumSource: `${ANTIGRAVITY}/${plat}.json` } };
  }));
  const assets: Record<string, Asset> = {};
  const versions = new Set<string>();
  for (const [i, [system]] of layout.entries()) {
    versions.add(found[i].v);
    assets[system] = found[i].asset;
  }
  if (versions.size !== 1) fail(`antigravity manifests disagree on the version: ${[...versions].sort().join(", ")}`);
  // The manifests give no release time: the x86_64 file's upload time (a
  // version already pinned keeps its time).
  const v = [...versions][0];
  const released = previous?.version === v ? undefined : uploaded(await lastModified(assets["x86_64-linux"].url));
  return { version: v, assets, ...(released ? { released } : {}) };
};

const kiro: Resolver = async (version) => {
  if (version) checkVersion(version);
  // The release is when the `latest` manifest was written (its
  // Last-Modified), as with claude's `latest`.
  const res = await getResponse(`${KIRO}/${version ?? "latest"}/manifest.json`);
  const m = JSON.parse(res.body.toString("utf8"));
  const v = checkVersion(m?.version);
  if (version && v !== version) fail(`kiro manifest for ${version} names version ${v}`);
  const assets: Record<string, Asset> = {};
  for (const [system, arch] of [["x86_64-linux", "x86_64"], ["aarch64-linux", "aarch64"]]) {
    const name = `${v}/kirocli-${arch}-linux.tar.gz`;
    const pkg = (m.packages ?? []).filter((p: any) => p.os === "linux" && p.download === name);
    if (pkg.length !== 1) fail(`kiro manifest has ${pkg.length} entries for ${name}`);
    assets[system] = { url: `${KIRO}/${name}`, hash: sri("sha256", pkg[0].sha256), checksumSource: `${KIRO}/${v}/manifest.json` };
  }
  const published = version ? null : httpDate(res.headers.get("last-modified"));
  return { version: v, assets, ...(published ? { released: { at: published, kind: "published" as const } } : {}) };
};

const muse: Resolver = async (version) => {
  const v = checkVersion(version ?? (await getJson(MUSE_CHANNEL))?.version);
  const q = (file: string) => `${MUSE}?${new URLSearchParams({ channel: "muse", version: v, file })}`;
  const m = await getJson(q("manifest.json"));
  if (m?.version !== v || m?.checksum_algorithm !== "sha256") fail(`unexpected muse manifest for ${v}`);
  const assets: Record<string, Asset> = {};
  for (const [system, key, file] of [["x86_64-linux", "x86_linux", "muse-x86-linux"], ["aarch64-linux", "aarch64_linux", "muse-aarch64-linux"]]) {
    const art = m.artifacts?.[key];
    if (art?.url !== q(file)) fail(`unexpected muse URL ${art?.url}`);
    assets[system] = { url: art.url, hash: sri("sha256", art.checksum), checksumSource: q("manifest.json") };
  }
  return { version: v, assets };
};

export const VENDORS: Record<string, Resolver> = {
  "claude-code": claude,
  grok,
  "cursor-agent": cursor,
  antigravity,
  "kiro-cli": kiro,
  muse,
};

export async function buildVendorPin(name: string, version: string | null, previous: Pin | null, auto?: Auto): Promise<Pin> {
  const resolver = VENDORS[name] ?? fail(`unknown vendor ${name}`);
  const { version: v, assets, released } = await resolver(version, previous, auto);
  const systems = Object.keys(assets).sort();
  if (systems.join() !== [...SYSTEMS].sort().join()) fail(`${name}: expected assets for ${SYSTEMS.join(", ")}, got ${systems.join(", ")}`);
  return { name, version: v, assets, ...(released ? { released } : {}) };
}
