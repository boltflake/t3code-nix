// Pins for GitHub releases, from GitHub's own metadata: each asset's `digest`
// (computed by GitHub on upload), checked against any checksum file the
// release publishes. Nothing large is downloaded.
import { versionOfTag } from "../../shared/sources.ts";
import { allInOrder, checksumsFor, fail, getJson, getText, getBytes, sri, sha256Hex, SYSTEMS, type Pin, type Asset } from "./util.ts";

const SAFE = /^[A-Za-z0-9._+-]+$/;

export interface GithubPinOptions {
  /** Repository files to pin as the package's license notices (default LICENSE). */
  licenses?: string[];
  /** Allow a prerelease (t3code's nightly channel); otherwise it's refused. */
  prerelease?: boolean;
  /** Accept a SHA256SUMS that doesn't list the asset (t3code's covers only its
   * CLI archives). An entry that is there must still agree. */
  partialSums?: boolean;
  /** The current pin: if the tag still points at the same commit, its license
   * hashes are reused instead of downloading the files again. */
  previous?: Pin | null;
  /** The release, if the caller already has it (from /releases/latest or
   * /releases). */
  release?: any;
}

interface GhAsset {
  id: number;
  name: string;
  digest?: string | null;
  browser_download_url: string;
}

/** Every SHA-256 the release publishes for `asset`, from SHA256SUMS and
 * `<asset>.sha256`. A checksum file that exists but has no (or conflicting)
 * entries for the asset is an error, never a silent fallback. */
export async function publishedChecksums(
  byName: Map<string, GhAsset>,
  asset: string,
  partialSums = false,
  fetchText: (url: string) => Promise<string> = getText,
): Promise<{ source: string; hex: string }[]> {
  const found: { source: string; hex: string }[] = [];
  for (const file of ["SHA256SUMS", `${asset}.sha256`]) {
    const a = byName.get(file);
    if (!a) continue;
    // Only a .sha256 sidecar may give a bare hash.
    const matches = checksumsFor(await fetchText(a.browser_download_url), asset, file !== "SHA256SUMS");
    if (matches.length === 0 && partialSums && file === "SHA256SUMS") continue;
    if (new Set(matches).size !== 1) {
      fail(`${file} is published but has ${matches.length ? "conflicting" : "no"} entries for ${asset}`);
    }
    found.push({ source: file, hex: matches[0] });
  }
  return found;
}

export async function buildGithubPin(
  name: string,
  repo: string,
  tag: string,
  wanted: Record<string, string>,
  opts: GithubPinOptions = {},
): Promise<Pin> {
  if (!SAFE.test(name)) fail(`bad package name ${JSON.stringify(name)}`);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) fail(`bad repository ${JSON.stringify(repo)}`);
  if (!SAFE.test(tag)) fail(`bad tag ${JSON.stringify(tag)}`);
  for (const system of Object.keys(wanted)) {
    if (!(SYSTEMS as readonly string[]).includes(system)) fail(`unknown system ${JSON.stringify(system)}`);
  }
  // Every input is checked before the first request.
  const paths = opts.licenses ?? ["LICENSE"];
  for (const path of paths) {
    if (!path.split("/").every((part) => SAFE.test(part) && part !== "." && part !== "..")) fail(`bad license path ${JSON.stringify(path)}`);
  }
  const files = paths.map((p) => p.split("/").pop());
  if (new Set(files).size !== files.length) fail("license files must have different file names; they're installed side by side");

  const version = versionOfTag(tag);
  // The release (and each system's checksum files) and the tag's commit are
  // independent lookups, done together; a problem with the release is still
  // the one reported first.
  const fromRelease = async () => {
    const release = opts.release ?? await getJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
    if (release?.tag_name !== tag) fail(`${repo}: release for ${tag} has tag ${release?.tag_name}`);
    if (release?.draft) fail(`${repo} ${tag} is a draft`);
    if (Boolean(release?.prerelease) !== Boolean(opts.prerelease)) {
      fail(`${repo} ${tag} is ${opts.prerelease ? "not " : ""}a prerelease`);
    }
    const byName = new Map<string, GhAsset>((release.assets as GhAsset[]).map((a) => [a.name, a]));
    const systems = Object.entries(wanted);
    const found = await allInOrder(systems.map(async ([, template]) => {
      const assetName = template.replaceAll("{version}", version);
      if (!SAFE.test(assetName)) fail(`bad asset name ${JSON.stringify(assetName)}`);
      const a = byName.get(assetName) ?? fail(`${repo} ${tag}: no asset ${assetName}`);
      const [algo, hex] = (a.digest ?? "").split(":");
      if (algo !== "sha256" || !/^[0-9a-f]{64}$/.test(hex ?? "")) fail(`${repo} ${tag}: ${assetName} has no sha256 digest`);
      for (const { source, hex: published } of await publishedChecksums(byName, assetName, opts.partialSums)) {
        if (published !== hex) fail(`${assetName}: ${source} says ${published}, GitHub's digest says ${hex}`);
      }
      const url = `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
      if (a.browser_download_url !== url) fail(`unexpected download URL ${a.browser_download_url}`);
      return { url, hash: sri("sha256", hex), assetId: a.id, digest: a.digest! };
    }));
    const assets: Record<string, Asset> = {};
    for (const [i, [system]] of systems.entries()) assets[system] = found[i];
    return { assets, publishedAt: typeof release.published_at === "string" ? release.published_at : null };
  };

  // License files come from the commit the tag points at (a tag can be
  // moved; a commit can't), so they are reused only while it's unchanged.
  const tagCommit = async () => {
    const ref = await getJson(`https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
    let object = ref?.object ?? fail(`${repo}: no tag ${tag}`);
    // An annotated tag can point at another tag; peel until a commit.
    for (let depth = 0; object?.type === "tag"; depth++) {
      if (depth >= 5) fail(`${repo} ${tag}: tag nested too deeply`);
      object = (await getJson(`https://api.github.com/repos/${repo}/git/tags/${object.sha}`))?.object;
    }
    const commit: string = object?.type === "commit" ? object.sha : "";
    if (!/^[0-9a-f]{40}$/.test(commit)) fail(`${repo} ${tag}: can't resolve the tag's commit`);
    return commit;
  };

  const [{ assets, publishedAt }, commit] = await allInOrder<any>([fromRelease(), tagCommit()]) as
    [{ assets: Record<string, Asset>; publishedAt: string | null }, string];
  const hashes = await allInOrder(paths.map(async (path) => {
    const url = `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
    const reuse = opts.previous?.licenses?.[path];
    return reuse?.url === url ? reuse : { url, hash: sri("sha256", sha256Hex(await getBytes(url))) };
  }));
  const licenses: Record<string, { url: string; hash: string }> = {};
  for (const [i, path] of paths.entries()) licenses[path] = hashes[i];
  return { name, version, tag, assets, licenses, ...(publishedAt ? { released: { at: publishedAt, kind: "published" as const } } : {}) };
}
