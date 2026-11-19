// The headless browser t3code pins for HTML previews (Chrome for Testing's
// chrome-headless-shell), read from t3code's own source at the release's
// commit: apps/server/src/preview/PreviewBrowser.ts holds the version and
// each archive's SHA-256. t3code downloads that archive into
// <base>/tools/chrome-headless-shell/<platform>/<version>/; ours is the same
// archive, patched to run on NixOS (pkgs/chrome-headless-shell), and the
// wrapper links it there (pkgs/t3code/preview-browser.sh).
import { fail, getText, sri, type BrowserPin } from "./util.ts";

const PATH = "apps/server/src/preview/PreviewBrowser.ts";
/** Chrome for Testing's platform name per system. */
const PLATFORMS: Record<string, string> = { "x86_64-linux": "linux64", "aarch64-linux": "linux-arm64" };

export const sourceUrl = (repo: string, commit: string) => `https://raw.githubusercontent.com/${repo}/${commit}/${PATH}`;

/** The one complete record the file pins; anything unexpected fails, so a
 * changed layout can never mix entries. */
export function parseBrowser(text: string, source: string): BrowserPin {
  const versions = [...text.matchAll(/^const VERSION = "([0-9]+(?:\.[0-9]+){3})";$/gm)].map((m) => m[1]);
  if (versions.length !== 1) fail(`${source}: expected one VERSION, found ${versions.length}`);
  const version = versions[0];
  // The download URL must be the one these assets describe.
  if (!text.includes("https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${chrome}/chrome-headless-shell-${chrome}.zip")) {
    fail(`${source}: the archive URL changed`);
  }
  const assets: BrowserPin["assets"] = {};
  for (const [system, platform] of Object.entries(PLATFORMS)) {
    const key = platform.includes("-") ? `"${platform}"` : platform;
    const re = new RegExp(`^ *${key}: \\{\\n *bytes: [0-9_]+,\\n *sha256: "([0-9a-f]{64})",\\n *\\},$`, "gm");
    const found = [...text.matchAll(re)].map((m) => m[1]);
    if (found.length !== 1) fail(`${source}: expected one ${platform} archive, found ${found.length}`);
    assets[system] = {
      url: `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-headless-shell-${platform}.zip`,
      hash: sri("sha256", found[0]),
    };
  }
  return { version, source, assets };
}

/** The browser record for a t3code release at `commit`; the previous one is
 * kept, without a request, while the commit is unchanged. */
export async function browserPin(repo: string, commit: string, previous?: BrowserPin): Promise<BrowserPin> {
  const source = sourceUrl(repo, commit);
  if (previous?.source === source) return previous;
  return parseBrowser(await getText(source), source);
}
