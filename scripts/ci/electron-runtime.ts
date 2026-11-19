// The Electron record, ci/electron-runtime.json (its rules are in
// scripts/lib/electron-fallback.ts): which Electron each Desktop app pin's
// `auto` picks on each system, without the fallback, as Nix evaluates the
// package itself (the unwrapped app with electronFallback = false, its
// passthru.electron), so the choice is never worked out twice.
//
//   node electron-runtime.ts table DIR   the update run's resolve job, after
//                                         candidate.ts make: evaluate every
//                                         (bundled version, nixpkgs revision)
//                                         a tree of this candidate can end up
//                                         with, into DIR's table, which
//                                         candidate.ts writes records from.
//                                         Best effort: a tree that still fails
//                                         after a retry is left out and named
//                                         on stdout (the step summary), and
//                                         its trees keep their earlier record.
//                                         Never exits non-zero for that.
//   node electron-runtime.ts write       by hand (needs Nix): the record for
//                                         this checkout, after a hand change to
//                                         flake.lock, a Desktop app pin's
//                                         electron, flake.nix or the Electron
//                                         code.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Failed, run, SYSTEMS } from "../lib/util.ts";
import { bundledOf, CHANNELS, fromDir, pinOf, revOf, RUNTIME_FILE, runtimeRecord, validRuntime, type Channel, type Reader, type Row } from "../lib/electron-fallback.ts";
import { checkout, load, reader, TABLE_FILE } from "./candidate.ts";

/** Evaluate a flake (a flake reference) within a time limit: the parsed
 * result of APPLY over its packages. Throws on failure. */
export type Evaluate = (flake: string, timeoutMs: number) => unknown;

/** { <system>: { <pin>: { choice, version } | null } }, for both systems. */
const APPLY = `ps: builtins.listToAttrs (map (system: {
  name = system;
  value = builtins.mapAttrs (pin: attr:
    let p = ps.\${system}; in
    if p ? \${attr} then
      let e = (p.\${attr}.override { electronFallback = false; }).passthru.electron; in { inherit (e) choice version; }
    else null) { t3code = "t3code-unwrapped"; t3code-nightly = "t3code-unwrapped-nightly"; };
}) [ ${SYSTEMS.map((s) => `"${s}"`).join(" ")} ])`;

// --no-update-lock-file: the tree's own flake.lock, never one Nix works out.
export const nixEval: Evaluate = (flake, timeoutMs) =>
  JSON.parse(run("nix", ["eval", "--json", "--no-update-lock-file", `${flake}#packages`, "--apply", APPLY], { timeout: timeoutMs, maxBuffer: 1 << 24 }));

const pins = (read: Reader): { pin: Channel; bundled: string | null }[] =>
  CHANNELS.flatMap((pin) => {
    const p = pinOf(read, pin);
    return p ? [{ pin, bundled: bundledOf(p) }] : [];
  });
/** The (pin, bundled, rev) a tree has, as keys. */
const pairsOf = (read: Reader) => pins(read).map((p) => `${p.pin} ${p.bundled} ${revOf(read)}`);

/** An evaluation's rows for a tree: every Desktop app pin it has, on every
 * system. Throws when one is missing or doesn't make sense. */
export function rowsFrom(result: any, read: Reader): Row[] {
  const rev = revOf(read);
  return pins(read).flatMap(({ pin, bundled }) => SYSTEMS.map((system) => {
    const v = result?.[system]?.[pin];
    // A bundled choice runs the pin's `electron` as it is ("unknown", say):
    // anything but X.Y.Z is null, as bundledOf has it.
    const e = { choice: v?.choice, version: v?.choice === "bundled" ? bundled : (v?.version ?? null), bundled, rev };
    if (!v || !validRuntime(e)) throw new Failed(`${pin} on ${system}: unexpected ${JSON.stringify(v ?? null)}`);
    return { pin, system, ...e };
  }));
}

/** The trees a final tree of this candidate can be, as input names: the
 * base's and the candidate's Desktop app pins, times the base's and the
 * candidate's flake.lock, the whole candidate first (the likeliest final),
 * the base last. None when the candidate changes neither (its trees all keep
 * the base's record). */
export function trees(dir: string): string[][] {
  const names = load(dir).inputs.map((i) => i.name);
  const desktop = names.filter((n) => (CHANNELS as readonly string[]).includes(n));
  const lock = names.includes("nixpkgs") ? ["nixpkgs"] : [];
  if (!desktop.length && !lock.length) return [];
  const out: string[][] = [];
  for (const p of desktop.length ? [desktop, []] : [[]]) for (const l of lock.length ? [lock, []] : [[]]) out.push([...p, ...l]);
  return out;
}

export interface TableOptions { evaluate?: Evaluate; attemptMs?: number; budgetMs?: number; now?: () => number }

/** Evaluate the candidate's trees into DIR's table. Each tree is one
 * evaluation, tried twice within its limit and the whole budget; a tree
 * whose pairs are all covered already is skipped. Returns the summary. */
export function makeTable(dir: string, { evaluate = nixEval, attemptMs = 4 * 60e3, budgetMs = 10 * 60e3, now = Date.now }: TableOptions = {}): string[] {
  const deadline = now() + budgetMs;
  const rows = new Map<string, Row>();
  const covered = new Set<string>();
  const summary: string[] = [];
  for (const names of trees(dir)) {
    const read = reader(dir, names);
    const pairs = pairsOf(read);
    if (pairs.every((p) => covered.has(p))) continue;
    const label = names.length ? `main with ${names.join(", ")}` : "main";
    if (deadline - now() <= 0) {
      summary.push(`Electron record: couldn't evaluate ${label} (out of time); a tree like it keeps its earlier record.`);
      continue;
    }
    let why = "", tmp = "";
    try {
      tmp = mkdtempSync(join(tmpdir(), "electron-runtime-"));
      const target = join(tmp, "tree");
      checkout(dir, names, target);
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = deadline - now();
        if (left <= 0) { why ||= "out of time"; break; }
        try {
          for (const r of rowsFrom(evaluate(`path:${target}`, Math.min(attemptMs, left)), read)) rows.set(`${r.pin} ${r.system} ${r.bundled} ${r.rev}`, r);
          pairs.forEach((p) => covered.add(p));
          why = "";
          break;
        } catch (e: any) {
          why = String(e?.message ?? e).split("\n").filter(Boolean).slice(-1)[0] ?? "failed";
        }
      }
    } catch (e: any) {
      why = String(e?.message ?? e).split("\n")[0];
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
    if (why) summary.push(`Electron record: couldn't evaluate ${label} (${why}); a tree like it keeps its earlier record.`);
    else summary.push(`Electron record: evaluated ${label}.`);
  }
  // Whole or not at all: a step stopped mid-write leaves no table.
  writeFileSync(join(dir, `${TABLE_FILE}.tmp`), `${JSON.stringify([...rows.values()], null, 2)}\n`);
  renameSync(join(dir, `${TABLE_FILE}.tmp`), join(dir, TABLE_FILE));
  return summary;
}

/** The record for the checkout at `dir` (its root). Throws when it has no
 * Desktop app pin or the evaluation fails. */
export function write(evaluate: Evaluate = nixEval, dir = "."): void {
  const read = fromDir(dir);
  if (!pins(read).length) throw new Failed(`no Desktop app pin under ${dir}/versions; run this from the repository's root`);
  const text = runtimeRecord(read, () => null, rowsFrom(evaluate(dir === "." ? "." : `path:${dir}`, 10 * 60e3), read));
  if (!text) throw new Failed("no record to write");
  mkdirSync(join(dir, "ci"), { recursive: true });
  writeFileSync(join(dir, RUNTIME_FILE), text);
}

if (import.meta.main) {
  const [cmd, dir] = process.argv.slice(2);
  try {
    if (cmd === "table" && dir) console.log(makeTable(dir).join("\n"));
    // From anywhere in the checkout: the record is the root's. --show-cdup
    // is only "../" steps (empty at the root), safe to trim.
    else if (cmd === "write") { process.chdir(run("git", ["rev-parse", "--show-cdup"]) || "."); write(); }
    else throw new Failed("usage: electron-runtime.ts table DIR | write");
  } catch (e: any) {
    console.error(`electron-runtime: ${e.message}`);
    process.exit(1);
  }
}
