// The NixOS-stable groups for one set and system, apart from the default
// checks: their own evaluation, their own workflow step and time limit (a step
// that runs out leaves no result file, which narrowing reads as incomplete).
// The update runs run them after the default checks, in the same job; branch
// CI, in jobs of their own (its parts) beside them.
//
//   node stable.ts SET SYSTEM OUT_DIR [--next] [--branch] [--tree=HASH] [--parent=REV] [--part=PART]
//
// With --part (branch CI), only that part's checks (scripts/lib/parts.ts: a,
// with the runner smokes and the check on the default checks, or b) are
// built, in both groups, and its result is OUT_DIR/stable-SET-SYSTEM-PART.json;
// `branch` then covers that part's checks.
// The tested tree is HASH (the update workflow's candidate tree, exactly what
// publish would commit), or else HEAD plus the working tree's changes.
//
// Writes OUT_DIR/stable-SET-SYSTEM.json:
//   stable      {complete, failed}: legacyPackages.<system>.stableChecks (the
//               snapshot on nixpkgs-stable) plus the stable runner smokes
//   behind      whether the tree's snapshot differs from its pins
//   stableNext  the same for .stableNextChecks (with --next: the sets that can
//               publish, and branch CI); its smokes only when the snapshot
//               would move
//   drvs, base  a digest of the stable group's derivations, and of the base
//               commit's (so a set whose stable derivations are main's is
//               evidence about main's stable set)
//   move        with --next and without --branch, when the snapshot would
//               move and stable-next passed: the equivalence step (every
//               default check the same on the moved tree, each
//               stable-<check> equal to the tested stable-next-<check>,
//               default.nix without flakes giving the flake's stable t3 on
//               the moved tree, and nothing the stable-next set needs from
//               nixpkgs missing from cache.nixos.org): {ok, tree, reason}
//   branch      with --branch: the failures the branch made (fail branch CI):
//               a failing stable check whose derivation differs from the
//               parent's (REV or HEAD~1) and whose parent build doesn't
//               fail (passes, or has no result: then unproven); a failing
//               smoke whose parent run, with the parent's own smoke script,
//               package and tools, doesn't fail; an incomplete group; and,
//               when the snapshot is behind, a default check that moving it
//               would change (whatever stable-next's result)
//   nixCalls    every Nix call it made (util.ts's NixCall)
//
// The runner smokes run with xvfb-run, dbus, xdotool and util-linux from the tree's
// nixpkgs-stable pin (legacyPackages.<system>.stableSmokeTools), the stable
// harness. The trees are evaluated as `path:` flakes from `git archive`,
// both the same way, so the comparison is between equals.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBrowserSmoke } from "../agent-browser-smoke.ts";
import { desktopSmoke } from "../desktop-smoke.ts";
import { compare } from "../lib/nixcache.ts";
import { current, moved, pinHashes } from "../lib/snapshot.ts";
import { nixCalls, run, tryRun, writeJson } from "../lib/util.ts";
import { partArg, STABLE_PARTS, stablePart, type StablePart } from "../lib/parts.ts";

/** `notApplicable`: forced Electron twins (and their smokes) with no usable
 * nixpkgs Electron, which built a placeholder or weren't started: neither
 * passes nor failures, never evidence. */
export interface Group { complete: boolean; failed: string[]; notApplicable?: string[] }
type Drv = { out: string; drv: string; na?: boolean };
type Drvs = Record<string, Drv>;
export type Outcome = "pass" | "fail" | "incomplete";
export type Prefix = "stable-" | "stable-next-";

/** The runner smokes' names: [desktop, agent-browser]. */
export const smokeNames = (prefix: Prefix) => [`${prefix}desktop-smoke`, `${prefix}set-agent-browser-smoke`] as const;
/** Every runner smoke: name -> the package it runs and how. Beside
 * those two, the desktop smoke on the forced Electron twins (bundled and
 * nixpkgs; a "not applicable" twin isn't started). */
export const smokesOfGroup = (prefix: Prefix): Record<string, { pkg: string; kind: "desktop" | "browser" }> => ({
  [`${prefix}desktop-smoke`]: { pkg: `${prefix}t3code`, kind: "desktop" },
  [`${prefix}desktop-smoke-electron-bundled`]: { pkg: `${prefix}t3code-electron-bundled`, kind: "desktop" },
  [`${prefix}desktop-smoke-electron-nixpkgs`]: { pkg: `${prefix}t3code-electron-nixpkgs`, kind: "desktop" },
  [`${prefix}set-agent-browser-smoke`]: { pkg: `${prefix}agent-browser`, kind: "browser" },
});

/** The tested tree: HEAD plus the working tree's changes (the candidate
 * applied), in a throwaway index. */
export function workingTree(): string {
  const tmp = mkdtempSync(join(tmpdir(), "stable-tree-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    run("git", ["read-tree", "HEAD"], { env });
    run("git", ["add", "-A"], { env });
    return run("git", ["write-tree"], { env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A tree unpacked into a throwaway folder, to evaluate as a path: flake. */
export function unpack(tree: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stable-src-"));
  run("sh", ["-c", `git archive "$1" | tar -x -C "$2"`, "sh", tree, dir]);
  return dir;
}

/** Nix's build-failure exit status (100, plus 2 hash mismatch, 4 failed),
 * without its timeout bit (1). */
export const provenFailure = (status: number) => status >= 100 && status <= 107 && !(status & 1);

const json = (args: string[]) => {
  const r = tryRun("nix", args);
  return r.status === 0 ? JSON.parse(r.stdout) : null;
};

/** Nix, as stable.ts uses it; tests replace it. */
export const nix = {
  /** {name: {out, drv}} of an attribute set of derivations, or null if it
   * doesn't evaluate. */
  drvs: (src: string, attr: string): Drvs | null =>
    json(["eval", "--json", `path:${src}#${attr}`, "--apply",
      "builtins.mapAttrs (_: c: { out = c.outPath; drv = c.drvPath; na = c.electronNotApplicable or false; })"]),
  names: (src: string, attr: string): string[] | null => json(["eval", "--json", `path:${src}#${attr}`, "--apply", "builtins.attrNames"]),
  one: (src: string, attr: string): Drv | null =>
    json(["eval", "--json", `path:${src}#${attr}`, "--apply", "c: { out = c.outPath; drv = c.drvPath; na = c.electronNotApplicable or false; }"]),
  /** Build these .drv files (keep going): the ones whose output is missing,
   * and whether they're proven failures (Nix's build-failure status without
   * its timeout bit), not lost to a timeout or an infrastructure error. */
  build(checks: Drvs, names: string[]): { missing: string[]; proven: boolean } {
    if (!names.length) return { missing: [], proven: true };
    const r = tryRun("nix", ["build", "--no-link", "--keep-going", "-L", ...names.map((n) => `${checks[n].drv}^*`)], { stdio: ["ignore", "inherit", "inherit"] });
    const missing = names.filter((n) => !nix.valid(checks[n].out));
    return { missing, proven: !missing.length || provenFailure(r.status) };
  },
  /** One build's outcome: a proven failure (Nix's build-failure status,
   * 100 to 107, without its timeout bit), or no result (a timeout, an
   * evaluation or daemon error). */
  outcome(d: Drv): Outcome {
    if (nix.valid(d.out)) return "pass";
    const r = tryRun("nix", ["build", "--no-link", "--keep-going", "-L", `${d.drv}^*`], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status === 0 && nix.valid(d.out)) return "pass";
    return provenFailure(r.status) ? "fail" : "incomplete";
  },
  valid: (out: string) => tryRun("nix-store", ["--check-validity", out]).status === 0,
  /** The .drv of every package in a set (the cache check's tops). */
  tops(src: string, attr: string): string[] | null {
    const r = json(["eval", "--json", `path:${src}#${attr}`, "--apply", "ps: map (p: p.drvPath) (builtins.attrValues ps)"]);
    return r ? [...new Set<string>(r)].sort() : null;
  },
  /** default.nix's NixOS-stable t3 with the flakes feature off: its .drv,
   * or null. */
  noFlakes(src: string, system: string): string | null {
    const r = tryRun("nix-instantiate", ["--option", "experimental-features", "", join(src, "default.nix"), "--argstr", "system", system, "-A", "stable.t3"]);
    return r.status === 0 ? r.stdout.trim().split("\n").pop() ?? null : null;
  },
  /** The smoke tools from a tree's nixpkgs-stable, as a PATH prefix; or,
   * when they don't build, whether that's a proven failure (the stable
   * harness is broken) or no result (a timeout, the daemon). */
  tools(src: string, system: string): { path: string } | { outcome: "fail" | "incomplete" } {
    const r = tryRun("nix", ["build", "--no-link", "--json", ...["xvfb-run", "dbus", "xdotool"].map((t) => `path:${src}#legacyPackages.${system}.stableSmokeTools.${t}`)]);
    if (r.status !== 0) return { outcome: provenFailure(r.status) ? "fail" : "incomplete" };
    // unshare (util-linux) for the desktop smoke's PID namespace; a tree from
    // before it was listed has none, and the system's is used then (only
    // then: any other failure counts as one).
    const u = tryRun("nix", ["build", "--no-link", "--json", `path:${src}#legacyPackages.${system}.stableSmokeTools.util-linux`]);
    if (u.status !== 0 && !/does not provide attribute|attribute 'util-linux' missing/.test(`${u.stderr ?? ""}`)) return { outcome: provenFailure(u.status) ? "fail" : "incomplete" };
    const extra = u.status === 0 ? JSON.parse(u.stdout).map((b: any) => `${b.outputs.bin ?? b.outputs.out}/bin`) : [];
    return { path: [...JSON.parse(r.stdout).map((b: any) => `${b.outputs.out}/bin`), ...extra].join(":") };
  },
};

/** The smoke scripts: this checkout's, or (branch CI) the parent tree's. */
export interface Smokes { desktop(pkg: string, bin: string): Promise<boolean>; agentBrowser(pkg: string): Promise<boolean> }
export const smokes: Smokes = { desktop: desktopSmoke, agentBrowser: agentBrowserSmoke };
export async function smokesOf(src: string): Promise<Smokes> {
  const [d, a] = await Promise.all([import(join(src, "scripts", "desktop-smoke.ts")), import(join(src, "scripts", "agent-browser-smoke.ts"))]);
  return { desktop: d.desktopSmoke, agentBrowser: a.agentBrowserSmoke };
}

/** Run one smoke (tried twice) with the tree's stable tools on PATH. */
async function smokeRun(f: () => Promise<boolean>, tools: string): Promise<boolean> {
  const path = process.env.PATH;
  process.env.PATH = `${tools}:${path}`;
  try {
    return (await f()) || (await f());
  } finally {
    process.env.PATH = path;
  }
}

/** Evaluate a group, falling back to one check at a time when the whole
 * doesn't evaluate: a check that doesn't evaluate is that check's failure. */
export function evaluate(src: string, attr: string): { drvs: Drvs; failed: string[]; complete: boolean } {
  const all = nix.drvs(src, attr);
  if (all) return { drvs: all, failed: [], complete: true };
  const names = nix.names(src, attr);
  if (!names) return { drvs: {}, failed: [], complete: false };
  const drvs: Drvs = {};
  const failed: string[] = [];
  for (const n of names) {
    const one = nix.one(src, `${attr}.${n}`);
    if (one) drvs[n] = one;
    else failed.push(n);
  }
  return { drvs, failed, complete: true };
}

const groupAttr = (system: string, prefix: Prefix) => `legacyPackages.${system}.${prefix === "stable-" ? "stableChecks" : "stableNextChecks"}`;

/** Evaluate, build (failures once more) and smoke-test a group. */
export async function runGroup(src: string, system: string, prefix: Prefix, withSmokes: boolean, part?: StablePart): Promise<{ group: Group; drvs: Drvs }> {
  const e = evaluate(src, groupAttr(system, prefix));
  if (!e.complete) return { group: { complete: false, failed: [] }, drvs: {} };
  // A part builds its own checks (all of them evaluated: `drvs` stays whole);
  // the smokes are part a's.
  const names = Object.keys(e.drvs).sort().filter((n) => part === undefined || stablePart(n) === part);
  if (part === "b") withSmokes = false;
  // Failures once more; what's still missing must be a proven failure, or
  // the group has no complete result (nothing held, no evidence).
  const second = nix.build(e.drvs, nix.build(e.drvs, names).missing);
  if (!second.proven) return { group: { complete: false, failed: [] }, drvs: e.drvs };
  const failed = [...e.failed.filter((n) => part === undefined || stablePart(n) === part), ...second.missing];
  if (withSmokes) {
    const s = await smokeFailures(src, system, prefix, e.drvs, smokes);
    if (s === null) return { group: { complete: false, failed: [] }, drvs: e.drvs };
    failed.push(...s);
  }
  const all = smokesOfGroup(prefix);
  const notApplicable = Object.keys(e.drvs).filter((n) => e.drvs[n].na && (part === undefined || stablePart(n) === part))
    .flatMap((n) => [n, ...Object.keys(all).filter((sm) => all[sm].pkg === n)]).sort();
  return { group: { complete: true, failed: [...new Set(failed)].sort(), ...(notApplicable.length ? { notApplicable } : {}) }, drvs: e.drvs };
}

/** The runner smokes that fail: the desktop smoke on <prefix>t3code and the
 * agent-browser smoke on <prefix>agent-browser (built already), with the
 * tree's stable tools. A package whose output isn't there fails without
 * starting, and so does everything when the tools fail to build; null when
 * the tools have no result (no smoke result either). */
export async function smokeFailures(src: string, system: string, prefix: Prefix, drvs: Drvs, s: Smokes): Promise<string[] | null> {
  const all = smokesOfGroup(prefix);
  // The forced twins only where the group has them ("not applicable" ones
  // aren't started); the two runner smokes always.
  const names = Object.keys(all).filter((n) => smokeNames(prefix).includes(n as any) || (drvs[all[n].pkg] && !drvs[all[n].pkg].na));
  const tools = nix.tools(src, system);
  if ("outcome" in tools) return tools.outcome === "fail" ? names : null;
  const ok = (d?: Drv) => !!d && nix.valid(d.out);
  const byOut = new Map<string, Promise<boolean>>(); // once per distinct output
  const failed: string[] = [];
  for (const n of names) {
    const { pkg, kind } = all[n];
    const d = drvs[pkg];
    if (!ok(d)) { failed.push(n); continue; }
    if (!byOut.has(d.out)) byOut.set(d.out, smokeRun(() => (kind === "desktop" ? s.desktop(d.out, "t3code") : s.agentBrowser(d.out)), tools.path));
    if (!(await byOut.get(d.out)!)) failed.push(n);
  }
  return failed;
}

export const digest = (drvs: Drvs) =>
  createHash("sha256").update(Object.keys(drvs).sort().map((n) => `${n} ${drvs[n].drv}`).join("\n")).digest("hex");

/** The default checks a snapshot move changes (all, when either tree's
 * checks don't evaluate). */
export function defaultsChanged(testedSrc: string, movedSrc: string, system: string): string[] {
  const a = nix.drvs(testedSrc, `checks.${system}`), b = nix.drvs(movedSrc, `checks.${system}`);
  if (!a || !b) return ["(the checks don't evaluate)"];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((n) => a[n]?.drv !== b[n]?.drv).sort();
}

/** default.nix without flakes and the flake agree on a tree's stable t3:
 * null when they do, else why not. */
export function noFlakesDisagree(src: string, system: string): string | null {
  const viaFlake = nix.one(src, `legacyPackages.${system}.stable.t3`)?.drv ?? null;
  const viaDefault = nix.noFlakes(src, system);
  if (viaFlake && viaFlake === viaDefault) return null;
  return `default.nix without flakes gives ${viaDefault ?? "nothing"} for the stable t3, the flake ${viaFlake ?? "nothing"}`;
}

/** The equivalence step for a move: the moved tree's default checks equal
 * the tested tree's, and each of its stable-<check> the tested
 * stable-next-<check>; default.nix without flakes agrees with the flake on
 * it; and the stable-next set needs nothing cache.nixos.org lacks. */
export async function equivalence(tested: string, testedSrc: string, system: string, nextDrvs: Drvs,
  cache: (base: Record<string, string[]>, next: Record<string, string[]>) => Promise<{ missing: string[]; unknown: string[] }> = (b, n) => compare(b, n, null, undefined, undefined, pinHashes(tested))):
  Promise<{ ok: boolean; tree: string; reason: string }> {
  const tree = moved(tested);
  const src = unpack(tree);
  try {
    const changed = defaultsChanged(testedSrc, src, system);
    if (changed.length) return { ok: false, tree, reason: `moving the snapshot changes default checks: ${changed.join(", ")}` };
    const moved_ = nix.drvs(src, groupAttr(system, "stable-"));
    if (!moved_) return { ok: false, tree, reason: "the moved tree's stable checks don't evaluate" };
    const strip = (d: Drvs, p: string) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k.slice(p.length), v.drv]));
    const s = strip(moved_, "stable-"), n = strip(nextDrvs, "stable-next-");
    const pairs = [...new Set([...Object.keys(s), ...Object.keys(n)])].filter((k) => s[k] !== n[k]);
    if (pairs.length) return { ok: false, tree, reason: `stable checks of the moved tree don't match the tested stable-next ones: ${pairs.sort().join(", ")}` };
    const disagree = noFlakesDisagree(src, system);
    if (disagree) return { ok: false, tree, reason: `on the moved tree, ${disagree}` };
    const base = nix.tops(testedSrc, `legacyPackages.${system}.stable`), next = nix.tops(testedSrc, `legacyPackages.${system}.stableNext`);
    if (!base || !next) return { ok: false, tree, reason: "incomplete: the stable sets' packages don't evaluate for the cache check" };
    const v = await cache({ [system]: base }, { [system]: next });
    if (v.missing.length) return { ok: false, tree, reason: `the stable-next set needs nixpkgs builds cache.nixos.org lacks: ${v.missing.slice(0, 10).join(", ")}` };
    if (v.unknown.length) return { ok: false, tree, reason: "incomplete: the cache couldn't be checked" };
    return { ok: true, tree, reason: "" };
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}

/** Branch CI: of a group's failures, those the branch made. A check whose
 * derivation is the parent's fails there too (reported, not counted); any
 * other failure (a changed check, a new one, a smoke, or one with no parent
 * derivation) counts unless the parent's run of it is a proven failure: a
 * parent result that passes or that couldn't be had (out of time) counts.
 * An incomplete group counts whole. */
export async function branchFailures(group: Group, drvs: Drvs, parent: Drvs | null, parentOutcome: (name: string) => Promise<Outcome>): Promise<string[]> {
  if (!group.complete) return ["stable (incomplete)"];
  const counted: string[] = [];
  for (const n of group.failed) {
    const p = parent?.[n];
    if (p && drvs[n] && p.drv === drvs[n].drv) continue; // the parent's own derivation: fails there too
    if ((await parentOutcome(n)) !== "fail") counted.push(n);
  }
  return counted;
}

/** The parent's outcome of one failing check or smoke (branch CI). A smoke
 * runs on the parent's package with the parent's own smoke script and stable
 * tools; a check builds the parent's derivation; a check (or a smoke's
 * package) that doesn't evaluate on the parent either (`parentFailed`) fails
 * there too; neither there: "pass" (counted: no proof the parent fails too). */
export function parentOutcomes(parentSrc: string, system: string, prefix: Prefix, parent: Drvs | null,
  loadSmokes: (src: string) => Promise<Smokes> = smokesOf, parentFailed: string[] = []): (name: string) => Promise<Outcome> {
  const all = smokesOfGroup(prefix);
  return async (n) => {
    if (all[n]) {
      if (parentFailed.includes(all[n].pkg)) return "fail";
      const pkg = parent?.[all[n].pkg];
      if (!pkg || pkg.na) return "pass";
      const built = nix.outcome(pkg);
      if (built !== "pass") return built; // the parent's package itself fails (or has no result)
      const tools = nix.tools(parentSrc, system);
      if ("outcome" in tools) return tools.outcome; // the parent's harness fails too, or has no result
      const s = await loadSmokes(parentSrc);
      const ok = await smokeRun(() => (all[n].kind === "desktop" ? s.desktop(pkg.out, "t3code") : s.agentBrowser(pkg.out)), tools.path);
      return ok ? "pass" : "fail";
    }
    if (parentFailed.includes(n)) return "fail";
    const p = parent?.[n];
    return p ? nix.outcome(p) : "pass";
  };
}

export async function main(argv: string[]): Promise<void> {
  const [set, system, outDir] = argv.filter((a) => !a.startsWith("--"));
  if (!set || !system || !outDir) {
    console.error("usage: stable.ts SET SYSTEM OUT_DIR [--next] [--branch] [--tree=HASH] [--parent=REV] [--part=PART]");
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const part = partArg(argv, STABLE_PARTS);
  const tested = argv.find((a) => a.startsWith("--tree="))?.slice(7) || workingTree();
  const src = unpack(tested);
  const result: Record<string, unknown> = { set, system, tree: tested };
  try {
    const stable = await runGroup(src, system, "stable-", true, part);
    result.stable = stable.group;
    result.drvs = digest(stable.drvs);
    if (set !== "main") {
      const base = unpack(run("git", ["rev-parse", "HEAD^{tree}"]));
      try {
        const b = nix.drvs(base, groupAttr(system, "stable-"));
        result.base = b ? digest(b) : null;
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
    let next: { group: Group; drvs: Drvs } | null = null;
    const behind = !current(tested);
    result.behind = behind;
    if (argv.includes("--next")) {
      next = await runGroup(src, system, "stable-next-", behind, part);
      result.stableNext = next.group;
      // Only for a set that can publish: nothing reads branch CI's move, and
      // its own check on the default checks is below.
      if (behind && !argv.includes("--branch") && next.group.complete && !next.group.failed.length) result.move = await equivalence(tested, src, system, next.drvs);
    }
    if (argv.includes("--branch")) {
      const parentSrc = unpack(run("git", ["rev-parse", `${argv.find((a) => a.startsWith("--parent="))?.slice(9) || "HEAD~1"}^{tree}`]));
      try {
        // One check at a time where the whole group doesn't evaluate, as for
        // the branch: one check main can't evaluate mustn't count every
        // failure as the branch's.
        const pe = evaluate(parentSrc, groupAttr(system, "stable-")), pne = evaluate(parentSrc, groupAttr(system, "stable-next-"));
        const ps = pe.complete ? pe.drvs : null, pn = pne.complete ? pne.drvs : null;
        // A default check that reads the snapshot shows up here, whatever
        // stable-next's result (the move's own step only runs after a pass).
        let changed: string[] = [];
        if (behind && part !== "b") {
          const m = unpack(moved(tested));
          try { changed = defaultsChanged(src, m, system); } finally { rmSync(m, { recursive: true, force: true }); }
        }
        result.branch = [
          ...await branchFailures(stable.group, stable.drvs, ps, parentOutcomes(parentSrc, system, "stable-", ps, smokesOf, pe.failed)),
          ...(next ? await branchFailures(next.group, next.drvs, pn, parentOutcomes(parentSrc, system, "stable-next-", pn, smokesOf, pne.failed)) : []),
          ...(changed.length ? [`equivalence (moving the snapshot changes ${changed.join(", ")})`] : []),
        ];
      } finally {
        rmSync(parentSrc, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
  writeJson(join(outDir, `stable-${set}-${system}${part === undefined ? "" : `-${part}`}.json`), { ...result, nixCalls });
  console.log(`stable on ${system} (${set}): ${JSON.stringify(result.stable)}${result.stableNext ? ` next ${JSON.stringify(result.stableNext)}` : ""}`);
  if (result.branch) console.log(`branch: ${JSON.stringify(result.branch)}`);
}

if (import.meta.main) await main(process.argv.slice(2));
