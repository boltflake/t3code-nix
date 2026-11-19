// Push the allowlisted free packages to Cachix after checking each matches
// what the tests built (the cache job).
//
//   node cache.ts MANIFEST_JSON SYSTEM
//
// Runs in a checkout of the published tree, with Cachix configured. For
// every package in ci/cache-allowlist.json it builds the package (vendor
// code runs only inside the Nix build sandbox, in install checks) and
// compares the store path and narHash with the test job's manifest. One
// `nix eval` gives every package's details, its .drv included, and the
// build uses the .drv paths, so the flake is evaluated once. Every input is
// pinned and fixed-output, so they should be identical; if one isn't,
// nothing is pushed and `nondeterministic` is observed. Otherwise the paths
// are pushed (`cachix push`) and `cache-ok` is observed. With DRY_RUN=true,
// what would be pushed is recorded instead.
//
// Before pushing it also checks the licenses: every allowlisted package must
// be free (meta.license), and the closure being pushed must not contain any
// unfree package (pkgs/unfree.nix) or its source download, or Google Chrome
// (agent-browser's `browser = "google-chrome"`, from any nixpkgs, matched by
// name: see chromeLike). Either failing pushes nothing and observes
// `update-failed`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { narHashes, readJson, ROOT, run } from "../lib/util.ts";
import { obs, type Observation } from "../update.ts";

/** The names in pkgs/unfree.nix (a plain list of strings), read without
 * another nix call. */
export function unfreeNames(text: string): string[] {
  const names = [...text.replace(/#.*$/gm, "").matchAll(/"([A-Za-z0-9._+-]+)"/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error("pkgs/unfree.nix lists no packages");
  return names;
}

export type Runner = (cmd: string, args: string[]) => string;

/** Google Chrome in a store path, whichever nixpkgs built it: nixpkgs'
 * google-chrome output (`<hash>-google-chrome-<version>`) or its .deb
 * (`<hash>-google-chrome-stable_<version>_<arch>.deb`). It isn't one of
 * this flake's packages, so it's matched by name, not by evaluating every
 * nixpkgs that could have it. */
export const chromeLike = (path: string) => /^\/nix\/store\/[0-9a-z]{32}-google-chrome-(\d[^/]*|stable_[^/]*\.deb)$/.test(path);

interface Info { free: boolean; out: string; drv: string; srcs: string[] }

/** One evaluation for every package involved: is it free, its output, its
 * downloads. Evaluating unfree packages is fine (nothing is built). */
const apply = (names: string[]) => `ps: builtins.mapAttrs (_: p: let
  l = p.meta.license or [ ]; ls = if builtins.isList l then l else [ l ];
in {
  free = ls != [ ] && builtins.all (x: x.free or false) ls;
  out = p.outPath;
  drv = p.drvPath;
  srcs = (if p ? src then [ p.src.outPath ] else [ ]) ++ map (s: s.outPath) (p.srcs or [ ]);
}) (builtins.intersectAttrs (builtins.listToAttrs (map (name: { inherit name; value = null; }) ${JSON.stringify(names).replaceAll(",", " ")})) ps)`;

/** What the cache job would push, and what it observed. */
export function plan(manifest: Record<string, { path: string; narHash: string }>, allowlist: string[], unfree: string[],
  system: string, sh: Runner = run): { paths: string[]; observations: Observation[] } {
  const observations: Observation[] = [];
  const no = (o: Observation) => ({ paths: [] as string[], observations: [...observations, o] });
  const info: Record<string, Info> = JSON.parse(sh("nix", ["eval", "--json", `.#packages.${system}`, "--apply", apply([...allowlist, ...unfree])]));
  // Only packages.<system> is cached: a name that isn't there (a NixOS-stable
  // package, legacyPackages.<system>.stable, or one that's gone) is refused
  // as such, not as unfree.
  const absent = allowlist.filter((p) => !info[p]);
  if (absent.length) {
    return no(obs("update-failed", null, null,
      `on the cache allowlist but not in packages.${system} (only the default packages are cached, never NixOS stable's): ${absent.join(", ")}; nothing pushed`, system));
  }
  const notFree = allowlist.filter((p) => unfree.includes(p) || !info[p]?.free);
  if (notFree.length) return no(obs("update-failed", null, null, `on the cache allowlist but not free: ${notFree.join(", ")}; nothing pushed`, system));
  // Checked before anything is built.
  const forbidden = new Map<string, string>();
  for (const pkg of unfree) {
    if (!info[pkg]) throw new Error(`pkgs/unfree.nix names ${pkg}, which isn't a package`);
    for (const p of [info[pkg].out, ...info[pkg].srcs]) forbidden.set(p, pkg);
  }

  sh("nix", ["build", "--no-link", ...allowlist.map((p) => `${info[p].drv}^*`)]);
  const paths = allowlist.map((p) => info[p].out);
  const narHash = narHashes(sh("nix", ["path-info", "--json", ...paths]));
  for (const pkg of allowlist) {
    const built = info[pkg].out;
    const tested = manifest[pkg];
    if (!tested || tested.path !== built || tested.narHash !== narHash.get(built)) {
      observations.push(obs("nondeterministic", pkg, null, `built ${built} (${narHash.get(built)}), tested ${JSON.stringify(tested)}; nothing pushed`, system));
    }
  }
  if (observations.length) return { paths: [], observations };

  const bad = sh("nix", ["path-info", "--recursive", ...paths]).split("\n").filter((p) => forbidden.has(p) || chromeLike(p));
  if (bad.length) {
    return no(obs("update-failed", null, null, `the cache closure contains unfree ${bad.map((p) => `${forbidden.get(p) ?? "google-chrome"} (${p})`).join(", ")}; nothing pushed`, system));
  }
  return { paths, observations };
}

if (import.meta.main) {
  const [manifestFile, system] = process.argv.slice(2);
  if (!manifestFile || !system) {
    console.error("usage: cache.ts MANIFEST_JSON SYSTEM");
    process.exit(2);
  }
  const manifest = readJson<Record<string, { path: string; narHash: string }>>(manifestFile);
  const allowlist = readJson<string[]>(join(ROOT, "ci", "cache-allowlist.json"));
  const unfree = unfreeNames(readFileSync(join(ROOT, "pkgs", "unfree.nix"), "utf8"));
  const { paths, observations } = plan(manifest, allowlist, unfree, system);
  let dryRun: unknown = null;
  if (observations.length === 0) {
    if (process.env.DRY_RUN === "true") {
      dryRun = [{ action: "cachix_push", paths }];
    } else {
      if (paths.length) run("cachix", ["push", process.env.CACHIX_CACHE!, ...paths], { stdio: ["ignore", "inherit", "inherit"] });
      observations.push(obs("cache-ok", null, null, `pushed ${paths.length} paths`, system));
    }
  }
  console.log(JSON.stringify({ observations, dryRun }, null, 2));
}
