// The NixOS-stable snapshot (versions/stable/), as git trees: which pins it
// holds, how a move replaces it, and how far it is behind. Working on trees
// (blobs, not files on disk) keeps a move byte-identical on every runner and
// in the publish job, so the equivalence step's tree hash and the published
// tree agree.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Failed, run } from "./util.ts";

export const SNAPSHOT = "versions/stable";

/** The pins a snapshot holds: every versions/*.json but the nightly ones and
 * nixpkgs-stable itself. */
export const inSnapshot = (name: string) => !name.endsWith("-nightly") && name !== "nixpkgs-stable";

/** name -> blob of versions/<name>.json, and of versions/stable/<name>.json,
 * in a tree. */
export function pinsOf(tree: string, git = (...args: string[]) => run("git", args)): { pins: Map<string, string>; snapshot: Map<string, string> } {
  const list = (path: string) => {
    const out = git("ls-tree", `${tree}:${path}`).trim();
    const m = new Map<string, string>();
    for (const line of out ? out.split("\n") : []) {
      const [, type, blob, file] = /^\d+ (\w+) ([0-9a-f]+)\t(.+)$/.exec(line) ?? [];
      if (type === "blob" && file.endsWith(".json")) m.set(file.slice(0, -5), blob);
    }
    return m;
  };
  let snapshot = new Map<string, string>();
  try {
    snapshot = list(SNAPSHOT);
  } catch {
    // no snapshot in this tree
  }
  return { pins: list("versions"), snapshot };
}

/** The pins a move would copy: name -> blob. */
export const wouldCopy = (pins: Map<string, string>) => new Map([...pins].filter(([n]) => inSnapshot(n)));

/** Whether the snapshot equals what a move would copy (same names, same
 * bytes). */
export function current(tree: string, git?: (...args: string[]) => string): boolean {
  const { pins, snapshot } = pinsOf(tree, git);
  const want = wouldCopy(pins);
  return want.size === snapshot.size && [...want].every(([n, b]) => snapshot.get(n) === b);
}

/** The packages where the snapshot differs from what a move would copy:
 * added, removed or at another version. */
export function differing(tree: string, git?: (...args: string[]) => string): string[] {
  const { pins, snapshot } = pinsOf(tree, git);
  const want = wouldCopy(pins);
  return [...new Set([...want.keys(), ...snapshot.keys()])].filter((n) => want.get(n) !== snapshot.get(n)).sort();
}

/** The tree with the snapshot replaced exactly by the tree's own pins (a
 * move), built in a throwaway index. */
export function moved(tree: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "snapshot-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    const git = (...args: string[]) => run("git", args, { env });
    git("read-tree", tree);
    // Drop every file under versions/stable/, then add the copy.
    const old = git("ls-files", "--", `${SNAPSHOT}/`).split("\n").filter(Boolean);
    if (old.length) git("update-index", "--force-remove", "--", ...old);
    for (const [name, blob] of wouldCopy(pinsOf(tree).pins)) {
      git("update-index", "--add", "--cacheinfo", `100644,${blob},${SNAPSHOT}/${name}.json`);
    }
    return git("write-tree");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every download a pin names: its assets, license files, a t3code pin's
 * preview-browser archives and speech model, and a browser pin's Google
 * Chrome .debs (from Google, never cache.nixos.org). */
export function urlsOf(pin: any): string[] {
  const urls = [
    ...Object.values(pin?.assets ?? {}), ...Object.values(pin?.licenses ?? {}), ...Object.values(pin?.browser?.assets ?? {}),
    ...Object.values(pin?.browsers?.["google-chrome"]?.assets ?? {}),
  ].map((a: any) => a?.url);
  if (pin?.speech?.url) urls.push(pin.speech.url);
  return urls.filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u));
}

/** Every download hash a pin records, as SRI: its assets, license files,
 * and a t3code pin's browser archives and speech model (hex there). */
export function hashesOf(pin: any): string[] {
  const hashes = [...Object.values(pin?.assets ?? {}), ...Object.values(pin?.licenses ?? {}), ...Object.values(pin?.browser?.assets ?? {})]
    .map((a: any) => a?.hash).filter((h): h is string => typeof h === "string" && /^sha256-/.test(h));
  const hex = pin?.speech?.sha256;
  if (typeof hex === "string" && /^[0-9a-f]{64}$/.test(hex)) hashes.push(`sha256-${Buffer.from(hex, "hex").toString("base64")}`);
  return hashes;
}

/** The download hashes of every pin in a tree (versions/ and the snapshot):
 * the flake's own downloads, for the snapshot move's cache check. */
export function pinHashes(tree: string): Set<string> {
  const { pins, snapshot } = pinsOf(tree);
  const all = new Set<string>();
  for (const b of [...pins.values(), ...snapshot.values()]) {
    try { for (const h of hashesOf(JSON.parse(run("git", ["cat-file", "blob", b])))) all.add(h); } catch { /* unreadable: none */ }
  }
  return all;
}

/** The downloads a tree's snapshot pins, each once, and those its own pins
 * (versions/*.json, nightly ones included) name too. `unreadable`: snapshot
 * pins that couldn't be read, whose downloads are then unknown. */
export function downloads(tree: string): { urls: string[]; alsoMain: Set<string>; unreadable: string[] } {
  const { pins, snapshot } = pinsOf(tree);
  const unreadable: string[] = [];
  const read = (blobs: Map<string, string>, note: boolean) => [...blobs].flatMap(([name, b]) => {
    try {
      const pin = JSON.parse(run("git", ["cat-file", "blob", b]));
      if (typeof pin?.assets !== "object" || pin.assets === null) throw new Error("no assets");
      return urlsOf(pin);
    } catch {
      if (note) unreadable.push(name);
      return [];
    }
  });
  return { urls: [...new Set(read(snapshot, true))].sort(), alsoMain: new Set(read(pins, false)), unreadable: unreadable.sort() };
}

/** The cache job's copy: when the published tree is the tested one with
 * the snapshot moved (and only then: moved(tested) must be it), write that
 * snapshot to the checkout, from the published tree's own blobs. */
export function checkout(tested: string, published: string): void {
  if (published === tested) return;
  if (moved(tested) !== published) throw new Failed(`${published} isn't ${tested} with the snapshot moved`);
  run("rm", ["-rf", "--", SNAPSHOT]);
  run("sh", ["-c", `git archive "$1" -- "$2" | tar -x`, "sh", published, SNAPSHOT]);
}

if (import.meta.main) {
  const [cmd, tested, published] = process.argv.slice(2);
  if (cmd === "checkout" && tested && published) checkout(tested, published);
  else {
    console.error("usage: snapshot.ts checkout TESTED_TREE PUBLISHED_TREE");
    process.exit(2);
  }
}
