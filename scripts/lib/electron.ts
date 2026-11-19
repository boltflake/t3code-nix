// The Electron version a t3code release bundles, for the desktop package's
// `electron = "auto"`: the exact
// version in upstream's apps/desktop/package.json at the release's commit
// (the commit the browser pin and speech catalog are read from).
//
// Anything but a plain X.Y.Z (a pre-release, a range, `catalog:`, no field)
// is recorded as null, never held: the release still updates, auto picks
// bundled, and the resolve job notes why.
import { getText } from "./util.ts";

export const PATH = "apps/desktop/package.json";
export const packageUrl = (repo: string, commit: string) => `https://raw.githubusercontent.com/${repo}/${commit}/${PATH}`;

/** The version in a package.json's dependencies or devDependencies, or why
 * there's none. */
export function parseElectron(text: string, source: string): { version: string | null; note: string | null } {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return { version: null, note: `${source} isn't JSON; the bundled Electron version is unknown, so auto uses bundled Electron` };
  }
  const raw = json?.devDependencies?.electron ?? json?.dependencies?.electron;
  if (typeof raw === "string" && /^\d+\.\d+\.\d+$/.test(raw)) return { version: raw, note: null };
  const what = raw === undefined ? "no electron dependency" : `electron is ${JSON.stringify(raw)}, not a plain X.Y.Z`;
  return { version: null, note: `${source}: ${what}; the bundled Electron version is unknown, so auto uses bundled Electron` };
}

/** A missing file (404) is "unknown" too; other fetch errors fail the pin's
 * resolve, which the next run retries, as for the speech catalog. */
export async function electronPin(repo: string, commit: string): Promise<{ version: string | null; note: string | null }> {
  const source = packageUrl(repo, commit);
  let text: string;
  try {
    text = await getText(source);
  } catch (e: any) {
    if (/HTTP 404\b/.test(String(e?.message ?? e))) {
      return { version: null, note: `${source} is missing; the bundled Electron version is unknown, so auto uses bundled Electron` };
    }
    throw e;
  }
  return parseElectron(text, source);
}
