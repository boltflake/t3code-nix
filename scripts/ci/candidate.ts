// Candidates: the base commit plus a set of inputs, moved between jobs as an
// artifact so every architecture tests exactly the same thing. An input is
// one changed pin (versions/<name>.json) or the nixpkgs bump (flake.lock,
// input name "nixpkgs").
//
//   node candidate.ts make DIR [OBS]     save the working tree's changed pins
//                                         and nixpkgs bump (after `update.ts
//                                         --write`) into DIR; see make() for
//                                         held inputs, reported `held` in OBS
//   node candidate.ts apply DIR [NAMES] [--electron=CHANNELS]
//                                         copy the inputs (all, or NAMES) into
//                                         the working tree
//   node candidate.ts tree DIR [NAMES] [--electron=CHANNELS]
//                                         the tree hash of the base commit plus
//                                         exactly those inputs' files
//
// --electron (a final candidate with an Electron fallback, from decide):
// ci/electron-fallback.json is generated from that tree for those channels
// (scripts/lib/electron-fallback.ts), the same bytes in every job; without
// it the base's file is left as it is.
//   node candidate.ts names DIR          the input names, comma-separated
//   node candidate.ts checkout DIR NAMES TARGET
//                                         the base tree plus exactly those
//                                         inputs' files ("": none), unpacked into TARGET
//                                         for Nix to evaluate (as a path:
//                                         flake); no record written
//
// apply and tree also write ci/electron-runtime.json for the tree they make,
// from DIR/electron-runtime-table.json (scripts/ci/electron-runtime.ts):
// runtimeRecord in scripts/lib/electron-fallback.ts, a pure function of the
// inputs' files over the base, so every job writes the same bytes.
//
// DIR holds inputs.json ({base, inputs: [{name, files, from, to}]}),
// files/<path> for every changed file, and the table when one was made.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { detailsOnly, Failed, git, nixpkgsRev, readJson, run, shownVersion, tryRun, writeJson } from "../lib/util.ts";
import type { Observation } from "../update.ts";
import { FALLBACK_FILE, generated, parseChannels, RUNTIME_FILE, runtimeRecord, validRows, type Channel, type Reader } from "../lib/electron-fallback.ts";

export const TABLE_FILE = "electron-runtime-table.json";

export interface Input {
  name: string;
  files: string[];
  from: string | null;
  to: string | null;
  /** What `to` means to people, when the version doesn't say: a browser
   * pin's Chromium version and channel (its version is a revision). */
  note?: string;
}
export interface Candidate {
  base: string;
  inputs: Input[];
}

const showJson = (rev: string, path: string): any => {
  try {
    return JSON.parse(git("show", `${rev}:${path}`));
  } catch {
    return null;
  }
};

/** The held versions (HELD_JSON), as "name\0version". */
function heldVersions(): Set<string> {
  const file = process.env.HELD_JSON;
  if (!file || !existsSync(file)) return new Set();
  // Browser pins' waits ({package, since}) aren't holds.
  return new Set(readJson<{ package: string; version?: string }[]>(file).filter((h) => typeof h.version === "string").map((h) => `${h.package}\0${h.version}`));
}

/** Save the candidate. An input is held when an open issue holds its exact
 * version, except a details-only change (the updater's rule: never held).
 * A candidate tests held inputs only when all its inputs are held (a run
 * with nothing new retries them); if any isn't, every held one is left out,
 * reverted in the working tree, and reported `held` in obsFile. This is the
 * final word: the updater's second pass may have met a new release, and it
 * doesn't weigh a held nixpkgs bump. */
export function make(out: string, obsFile?: string): string[] {
  const held = heldVersions();
  const changed = new Set([
    ...git("diff", "--name-only", "HEAD", "--", "versions", "flake.lock").split("\n"),
    ...git("ls-files", "--others", "--exclude-standard", "--", "versions").split("\n"),
  ].filter(Boolean));
  const found: { input: Input; held: boolean }[] = [];
  for (const path of [...changed].sort()) {
    let input: Input, isHeld: boolean;
    if (path.startsWith("versions/stable/")) {
      // The NixOS-stable snapshot: only the publish job moves it.
      throw new Failed(`${path} changed: versions/stable/ (the NixOS-stable snapshot) is written only by the publish job`);
    }
    if (path === "flake.lock") {
      input = { name: "nixpkgs", files: [path], from: nixpkgsRev(showJson("HEAD", path)), to: nixpkgsRev(readJson(path)) };
      isHeld = held.has(`nixpkgs\0${input.to}`);
    } else if (path.startsWith("versions/") && path.endsWith(".json")) {
      const old = showJson("HEAD", path), next = readJson<any>(path);
      input = { name: basename(path, ".json"), files: [path], from: old?.version ?? null, to: next.version ?? null,
        ...(typeof next.chromium === "string" ? { note: next.browsers ? shownVersion(next) : `Chromium ${shownVersion(next)}` } : {}) };
      isHeld = held.has(`${input.name}\0${input.to}`) && !detailsOnly(old, next);
    } else {
      throw new Failed(`unexpected changed file ${path}`);
    }
    found.push({ input, held: isHeld });
  }
  const retry = found.every((f) => f.held);
  const inputs: Input[] = [];
  const left: Observation[] = [];
  for (const { input, held: isHeld } of found) {
    if (isHeld && !retry) {
      console.error(`candidate: ${input.name} ${input.to} is held by an open issue; left out`);
      for (const path of input.files) {
        if (tryRun("git", ["cat-file", "-e", `HEAD:${path}`]).status === 0) git("checkout", "-q", "HEAD", "--", path);
        else rmSync(path);
      }
      left.push({ kind: "held", package: input.name, channel: null, version: input.to, detail: "an open issue holds this version" });
      continue;
    }
    for (const path of input.files) {
      mkdirSync(dirname(join(out, "files", path)), { recursive: true });
      copyFileSync(path, join(out, "files", path));
    }
    inputs.push(input);
  }
  mkdirSync(out, { recursive: true });
  writeJson(join(out, "inputs.json"), { base: git("rev-parse", "HEAD"), inputs } satisfies Candidate);
  if (obsFile) writeJson(obsFile, { observations: left });
  return inputs.map((i) => i.name);
}

export const load = (dir: string): Candidate => readJson<Candidate>(join(dir, "inputs.json"));

function chosen(c: Candidate, names?: string | null): Input[] {
  const wanted = new Set(names ? names.split(",").filter(Boolean) : c.inputs.map((i) => i.name));
  const unknown = [...wanted].filter((n) => !c.inputs.some((i) => i.name === n));
  if (unknown.length) throw new Failed(`no such input(s) ${unknown.sort().join(", ")}`);
  return c.inputs.filter((i) => wanted.has(i.name));
}

/** The candidate's evaluated table (rows that aren't well-formed dropped;
 * [] without one, or with one that doesn't parse: the step is best effort). */
export function table(dir: string) {
  try {
    return existsSync(join(dir, TABLE_FILE)) ? validRows(readJson(join(dir, TABLE_FILE))) : [];
  } catch {
    return [];
  }
}

/** A file of the base commit (null when absent). */
const fromBase = (base: string): Reader => (path) => {
  const r = tryRun("git", ["show", `${base}:${path}`]);
  return r.status === 0 ? r.stdout + "\n" : null;
};

/** The tree of the base plus the inputs' files, file by file. */
function readerOf(dir: string, c: Candidate, inputs: Input[]): Reader {
  const ours = new Map(inputs.flatMap((i) => i.files.map((p) => [p, join(dir, "files", p)] as const)));
  const base = fromBase(c.base);
  return (path) => (ours.has(path) ? readFileSync(ours.get(path)!, "utf8") : base(path));
}

/** readerOf for the named inputs (none: the base). */
export const reader = (dir: string, names: string[]): Reader => {
  const c = load(dir);
  return readerOf(dir, c, names.length ? chosen(c, names.join(",")) : []);
};

/** The generated files of the tree of the base plus the inputs: the
 * fallback file (with channels) and the record. A file maps to its text,
 * null to remove it; one left out stays the base's. */
function generatedFiles(dir: string, c: Candidate, inputs: Input[], electron: Channel[]): Map<string, string | null> {
  const base = fromBase(c.base);
  const read = readerOf(dir, c, inputs);
  const out = new Map<string, string | null>();
  if (electron.length) out.set(FALLBACK_FILE, generated(read, electron));
  const record = runtimeRecord(read, base, table(dir));
  if (record !== undefined) out.set(RUNTIME_FILE, record);
  return out;
}

export function apply(dir: string, names?: string | null, electron: Channel[] = []): void {
  const c = load(dir);
  const inputs = chosen(c, names);
  const files = inputs.flatMap((i) => i.files);
  for (const path of files) copyFileSync(join(dir, "files", path), path);
  const made = generatedFiles(dir, c, inputs, electron);
  for (const [path, text] of made) {
    if (text === null) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
  // Staged, so the flake's evaluation (git-tracked files only) sees a new
  // pin and the generated files too, created or removed, as the published
  // tree will have them. A generated file removed that was never there is
  // nothing to stage.
  for (const path of [...files, ...made.keys()]) {
    if (!existsSync(path) && tryRun("git", ["ls-files", "--error-unmatch", "--", path]).status !== 0) continue;
    git("add", "-A", "--", path);
  }
}

/** The tree hash of the candidate's base commit plus exactly the given
 * inputs' files (and, unless `bare`, the generated files), built in a
 * throwaway index. Untracked files in the checkout (artifacts, logs) can't
 * get in, and every job applying the same inputs to the same base gets the
 * same hash. */
export function tree(dir: string, names?: string | null, electron: Channel[] = []): string {
  const c = load(dir);
  return treeOf(dir, c, chosen(c, names), electron, false);
}

function treeOf(dir: string, c: Candidate, inputs: Input[], electron: Channel[], bare: boolean): string {
  const tmp = mkdtempSync(join(tmpdir(), "candidate-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    run("git", ["read-tree", c.base], { env });
    for (const path of inputs.flatMap((i) => i.files)) {
      const blob = git("hash-object", "-w", join(dir, "files", path));
      run("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    }
    if (!bare) {
      for (const [path, text] of generatedFiles(dir, c, inputs, electron)) {
        if (text === null) {
          tryRun("git", ["update-index", "--force-remove", "--", path], { env });
        } else {
          const blob = run("git", ["hash-object", "-w", "--stdin"], { input: text });
          run("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
        }
      }
    }
    return run("git", ["write-tree"], { env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The base plus exactly those inputs' files (none: the base), nothing
 * generated, unpacked into TARGET (created; must not exist) for Nix to read
 * as a path: flake. */
export function checkout(dir: string, names: string[], target: string): void {
  const c = load(dir);
  const t = treeOf(dir, c, names.length ? chosen(c, names.join(",")) : [], [], true);
  mkdirSync(target);
  // Through a file of its own, so a failing git archive can't hide behind tar.
  const tmp = mkdtempSync(join(tmpdir(), "checkout-"));
  try {
    run("git", ["archive", "-o", join(tmp, "tree.tar"), t]);
    run("tar", ["-x", "-f", join(tmp, "tree.tar"), "-C", target]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [cmd, dir, arg] = args.filter((a) => !a.startsWith("--"));
  const electron = parseChannels(args.find((a) => a.startsWith("--electron="))?.slice(11));
  try {
    if (cmd === "make" && dir) console.log(make(dir, arg).join(","));
    else if (cmd === "apply" && dir) apply(dir, arg, electron);
    else if (cmd === "tree" && dir) console.log(tree(dir, arg, electron));
    else if (cmd === "names" && dir) console.log(load(dir).inputs.map((i) => i.name).join(","));
    else if (cmd === "checkout" && dir && args.filter((a) => !a.startsWith("--")).length === 4) {
      checkout(dir, arg.split(",").filter(Boolean), args.filter((a) => !a.startsWith("--"))[3]);
    }
    else throw new Failed("usage: candidate.ts make DIR [OBS] | apply|tree DIR [NAMES] [--electron=CHANNELS] | names DIR | checkout DIR NAMES TARGET");
  } catch (e: any) {
    console.error(`candidate: ${e.message}`);
    process.exit(1);
  }
}
