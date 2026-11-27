// Run the full test suite for one system and record the result as data (the
// test, narrow and final jobs, and branch CI).
//
//   node test.ts SET SYSTEM OUT_DIR [--desktop] [--agent-browser] [--strict-guards] [--part=PART]
//
// With --part (branch CI, and the update runs' test and final jobs), only
// that part of the suite (scripts/lib/parts.ts: desktop, rest1 or rest2),
// its result files named SET-SYSTEM-PART (merge-parts.ts joins them).
// The flake is evaluated once: one `nix eval` gives every check's output and
// .drv (in a part, two: the names, then its own checks' and the few it
// reads; evaluateChecks).
// All checks then build from their .drv paths in one `nix build
// --keep-going` (builds in parallel, no second evaluation: with a candidate
// applied the tree is dirty, so Nix's evaluation cache doesn't help). Checks
// whose output didn't appear are built once more before they count, so one
// flaky run doesn't block anything. With --desktop, scripts/desktop-smoke.ts
// also starts both desktop apps (needs a real runner: user namespaces,
// xvfb-run, dbus-run-session, xdotool, unshare); the workflow passes it only when a t3code
// package or nixpkgs changed. The apps are the checks t3code and
// t3code-nightly, already built: one whose output isn't there fails its
// smoke. With --agent-browser, scripts/agent-browser-smoke.ts drives
// agent-browser with each browser pin's Chromium (also a real runner); the
// workflow passes it when agent-browser, a browser pin or nixpkgs changed.
//
// Writes OUT_DIR/SET-SYSTEM.json ({set, system, passed, failed, checked,
// notes}: the guard checks' notes, which hold no release; see lib/checks.nix
// `notes`, narrow.ts and failedOnNotes; and nixCalls, every Nix call it made,
// util.ts's NixCall) and
// OUT_DIR/manifest-SET-SYSTEM.json (store path and narHash of every package in
// ci/cache-allowlist.json, which the cache job compares before uploading).
// Exits 0 whatever the tests say; only a broken runner or Nix fails it.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { narHashes, nixCalls, readJson, rewriteJson, ROOT, run, tryRun } from "../lib/util.ts";
import { desktopSmoke } from "../desktop-smoke.ts";
import { partArg, TEST_PARTS, testPart } from "../lib/parts.ts";
import { agentBrowserSmoke } from "../agent-browser-smoke.ts";
import { nix as stableNix, smokesOf, unpack, workingTree } from "./stable.ts";
import { activeChannels, bundledList, CHANNELS, generate, pairOf, ROLES, runtimeList, type Channel, type Pair } from "../lib/electron-fallback.ts";

function valid(path: string): boolean {
  return tryRun("nix-store", ["--check-validity", path]).status === 0;
}

/** A check's output and .drv; for the desktop apps also their Electron
 * choice, and whether a forced variant is "not applicable". */
export interface Check { out: string; drv: string; electron?: string | null; na?: boolean }

export interface Note { package: string; detail: string }

/** The desktop apps whose build says whether the update notice fitted
 * (share/t3code-nix/<package>/update-notice: `on`, or `off: <why>`). */
export const NOTICE_PACKAGES = ["t3code", "t3code-nightly"] as const;

/** Each built desktop app's notice line, read from its output. */
export function noticeOf(outs: Record<string, string>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const p of NOTICE_PACKAGES) {
    const out = outs[p];
    const file = out && join(out, "share/t3code-nix", p, "update-notice");
    if (file && existsSync(file)) found[p] = readFileSync(file, "utf8").split("\n")[0];
  }
  return found;
}

/** What the guard checks among `outs` (directories with `checked` and
 * `notes`; other checks' outputs are files) compared, and what they noted. */
export function notesOf(outs: string[]): { checked: string[]; notes: Note[] } {
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
  const checked = new Set<string>();
  const notes: Note[] = [];
  for (const out of outs) {
    for (const p of lines(join(out, "checked"))) checked.add(p);
    for (const l of lines(join(out, "notes"))) {
      const tab = l.indexOf("\t");
      if (tab > 0) notes.push({ package: l.slice(0, tab), detail: l.slice(tab + 1) });
    }
  }
  return { checked: [...checked].sort(), notes };
}

/** Checks only branch CI builds: they're about the repository's own files,
 * not a candidate, so a version or nixpkgs bump never fails on them (a new
 * nixfmt reformatting a file, or a stricter linter, would otherwise hold
 * the bump). */
export const BRANCH_ONLY = new Set(["nix-format", "nix-lint"]);

/** The checks a set builds: all for branch CI, the rest for candidates. */
export const checkNames = (all: string[], set: string) =>
  all.filter((n) => set === "branch" || !BRANCH_ONLY.has(n)).sort();

/** Build these checks (one nix invocation, no evaluation); the names whose
 * output is missing. */
function buildChecks(names: string[], checks: Record<string, Check>): string[] {
  if (names.length === 0) return [];
  // Exit status is ignored: which outputs exist says which checks passed.
  tryRun("nix", ["build", "--no-link", "--keep-going", "-L", ...names.map((n) => `${checks[n].drv}^*`)],
    { stdio: ["ignore", "inherit", "inherit"] });
  return names.filter((n) => !valid(checks[n].out));
}

export type SmokeState = "pass" | "fail" | "not-run" | "not-applicable";

/** The desktop smoke of each channel's apps, built already: what `auto`
 * picks (t3code, t3code-nightly) and the forced Electron variants (the
 * checks <channel>-electron-bundled and -electron-nixpkgs), tried twice. It
 * runs once per distinct output path and its result goes to every name that
 * shares it, so a flaky smoke can't make two names of one app disagree; a
 * "not applicable" variant isn't started. An app whose output isn't there
 * fails without starting. The names that failed, and every smoke's state in
 * `states`. */
export async function desktopFailures(checks: Record<string, Check>, smoke = desktopSmoke, isValid = valid,
  states: Record<string, SmokeState> = {}): Promise<string[]> {
  const failed: string[] = [];
  const byOut = new Map<string, Promise<boolean>>();
  for (const channel of CHANNELS) {
    for (const [attr, name] of Object.entries(ROLES[channel].smokes)) {
      const c = checks[attr];
      if (!c) continue;
      if (c.na) { states[name] = "not-applicable"; continue; }
      const out = c.out;
      if (!byOut.has(out)) {
        byOut.set(out, (async () => {
          const once = async () => isValid(out) && smoke(out, channel);
          return (await once()) || (await once());
        })());
      }
      const ok = await byOut.get(out)!;
      states[name] = ok ? "pass" : "fail";
      if (!ok) failed.push(name);
    }
  }
  return failed;
}

/** What the fallback rules need from this set on this system
 * (scripts/lib/electron-fallback.ts), per channel: its runtime list here (the
 * auto apps only where auto picks nixpkgs, the forced check unless it's "not
 * applicable"), its bundled twins, which of both lists passed, whether the
 * forced check is "not applicable", the tree's pair and whether an entry is
 * active for it; and which failures outside the lists depend on a listed app
 * (provisional). */
export interface ChannelEvidence {
  runtime: string[];
  bundled: string[];
  passed: string[];
  forcedNotApplicable: boolean;
  active: boolean;
  pair: Pair | null;
}
export interface ElectronEvidence {
  channels: Partial<Record<Channel, ChannelEvidence>>;
  smokes: Record<string, SmokeState>;
  /** Failure name -> every channel whose listed app it depends on (a check
   * can build on both channels' apps). */
  dependsOn: Record<string, Channel[]>;
  /** Of those, the ones that passed when built on bundled Electron (the
   * tree with the fallback for their channel): only these can count as the
   * nixpkgs runtime's (confirmProvisional). */
  confirmed: string[];
  smokeRan: boolean;
}
export function electronEvidence(checks: Record<string, Check>, failed: string[], smokes: Record<string, SmokeState>,
  dir = ROOT, requisites = (drv: string) => run("nix-store", ["--query", "--requisites", drv]).split("\n"),
  ran?: Set<string>): ElectronEvidence {
  const active = activeChannels(dir);
  const channels: ElectronEvidence["channels"] = {};
  const listed = new Map<string, Channel>(); // listed apps' .drv -> channel
  for (const channel of CHANNELS) {
    const r = ROLES[channel];
    if (!checks[r.auto[0]]) continue; // not in this set (the NixOS stable set has no nightly)
    const autoIsNixpkgs = checks[r.auto[0]].electron === "nixpkgs";
    const forcedApplicable = !!checks[r.forced] && !checks[r.forced].na;
    const runtime = runtimeList(channel, autoIsNixpkgs, forcedApplicable).filter((n) => checks[n] || Object.values(r.smokes).includes(n));
    const bundled = bundledList(channel);
    // A part vouches only for the checks it ran.
    const ok = (n: string) => (n in smokes ? smokes[n] === "pass" : !!checks[n] && (ran?.has(n) ?? true) && !failed.includes(n));
    channels[channel] = {
      runtime,
      bundled,
      passed: [...runtime, ...bundled].filter(ok).sort(),
      forcedNotApplicable: !forcedApplicable,
      active: active.includes(channel),
      pair: pairOf(dir, channel),
    };
    for (const n of runtime) if (checks[n] && !(n in smokes)) listed.set(checks[n].drv, channel);
  }
  const inLists = new Set(Object.values(channels).flatMap((c) => [...c!.runtime, ...c!.bundled]));
  const dependsOn: Record<string, Channel[]> = {};
  for (const f of failed) {
    if (inLists.has(f) || !checks[f]) continue;
    let closure: string[] = [];
    try { closure = requisites(checks[f].drv); } catch { continue; }
    const found = [...new Set(closure.filter((d) => listed.has(d)).map((d) => listed.get(d)!))].sort();
    if (found.length) dependsOn[f] = found;
  }
  return { channels, smokes, dependsOn, confirmed: [], smokeRan: Object.values(smokes).some((s) => s === "pass" || s === "fail") };
}

/** A failure that only depends on a listed app is the nixpkgs runtime's
 * only if it passes on bundled Electron: build it on a copy of the tested
 * tree with the fallback for its channel (as decide would make the final).
 * The names that passed there; any other failure stays ordinary. */
export async function confirmProvisional(dependsOn: Record<string, Channel[]>, system: string,
  build: (channels: Channel[], names: string[]) => Promise<string[]> = bundledBuild(system)): Promise<string[]> {
  const names = Object.keys(dependsOn);
  if (!names.length) return [];
  const channels = [...new Set(Object.values(dependsOn).flat())].sort();
  return (await build(channels, names)).filter((n) => names.includes(n)).sort();
}
export const bundledBuild = (system: string, tree: () => string = workingTree) => async (channels: Channel[], names: string[]) => {
  const dir = unpack(tree());
  try {
    generate(dir, channels);
    const drvs = stableNix.drvs(dir, `checks.${system}`);
    if (!drvs) return [];
    return names.filter((n) => drvs[n] && stableNix.outcome(drvs[n]) === "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Branch CI under an active Electron fallback: a failure in an active
 * channel's runtime list is reported, not failed, unless the branch changed
 * it (its derivation differs from the parent's, or the parent has none) and
 * the parent's version of it passes (built, or for a smoke run, only then).
 * The names to report. */
export async function branchElectronReported(e: ElectronEvidence, failed: string[], checks: Record<string, Check>,
  parent: Record<string, Check> | null, parentPasses: (name: string) => Promise<boolean>): Promise<string[]> {
  const reported: string[] = [];
  for (const [channel, c] of Object.entries(e.channels) as [Channel, ChannelEvidence][]) {
    if (!c.active) continue;
    for (const f of failed) {
      if (!c.runtime.includes(f)) continue;
      // A smoke's identity is its app's derivation.
      const app = Object.entries(ROLES[channel].smokes).find(([, s]) => s === f)?.[0] ?? f;
      const mine = checks[app]?.drv, theirs = parent?.[app]?.drv;
      const changed = !theirs || mine !== theirs;
      if (!changed || !(await parentPasses(f))) reported.push(f);
    }
  }
  return reported.sort();
}

/** agent-browser's smoke with each browser pin's Chromium (the checks
 * agent-browser and agent-browser-stable-chromium, the latter its
 * browserChannel = "stable" override, built already), tried
 * twice: the names that failed. */
export async function agentBrowserFailures(checks: Record<string, Check>, smoke = agentBrowserSmoke, isValid = valid): Promise<string[]> {
  const failed: string[] = [];
  for (const [attr, name] of [["agent-browser", "agent-browser-smoke"], ["agent-browser-stable-chromium", "agent-browser-smoke-stable"]]) {
    const once = async () => {
      const out = checks[attr]?.out;
      if (!out || !isValid(out)) return false;
      return smoke(out);
    };
    if (!(await once()) && !(await once())) failed.push(name);
  }
  return failed;
}

/** default.nix with the flakes feature off (`nix-instantiate`, which can't
 * run in the sandbox): agent-browser, whose browser pin is fetched with
 * fetchTarball, and t3code, whose Electron choice reads flake.lock and the
 * fallback file, must instantiate and be the flake's own derivations. The
 * names that failed: ["default-nix-no-flakes"] or none. */
export const NO_FLAKES_ATTRS = ["agent-browser", "t3code"];
export function noFlakesFailures(system: string, checks: Record<string, Check>,
  instantiate = (sys: string, attr: string) => tryRun("nix-instantiate", ["--option", "experimental-features", "", join(ROOT, "default.nix"), "--argstr", "system", sys, "-A", attr])): string[] {
  const bad: string[] = [];
  for (const attr of NO_FLAKES_ATTRS) {
    if (!checks[attr]) continue; // nothing to compare with
    const r = instantiate(system, attr);
    const drv = r.status === 0 ? r.stdout.trim().split("\n").pop() : null;
    if (drv && drv === checks[attr].drv) continue;
    bad.push(`${attr}: ${r.status === 0 ? `${drv} isn't the flake's ${checks[attr].drv}` : r.stderr.slice(-800)}`);
  }
  if (!bad.length) return [];
  console.error(`default.nix without flakes: ${bad.join("; ")}`);
  return ["default-nix-no-flakes"];
}

/** default-nix-no-flakes's NixOS-stable part: default.nix (flakes off) and
 * the flake must agree on the stable t3. Both failing to evaluate is the
 * stable set's problem (the stable checks report it), never the default's,
 * and so is either side running out of time (fetching NixOS stable can
 * stall): only a real disagreement fails the default. main runs it after
 * the default's result is saved. */
export const STABLE_EVAL_MS = 5 * 60_000;
const timedOut = (r: { stderr: string }) => /\((ETIMEDOUT|SIGTERM)\b/.test(r.stderr);
export function stableNoFlakesFailures(system: string,
  viaFlake = (sys: string) => tryRun("nix", ["eval", "--raw", `.#legacyPackages.${sys}.stable.t3.drvPath`], { cwd: ROOT, timeout: STABLE_EVAL_MS }),
  viaDefault = (sys: string) => tryRun("nix-instantiate", ["--option", "experimental-features", "", join(ROOT, "default.nix"), "--argstr", "system", sys, "-A", "stable.t3"],
    { timeout: STABLE_EVAL_MS })): string[] {
  const f = viaFlake(system), d = viaDefault(system);
  if (timedOut(f) || timedOut(d)) {
    console.error("default.nix without flakes: the stable t3's evaluation ran out of time; not compared");
    return [];
  }
  const a = f.status === 0 ? f.stdout.trim() : null, b = d.status === 0 ? d.stdout.trim().split("\n").pop() ?? null : null;
  if (a === b) return [];
  console.error(`default.nix without flakes: stable.t3 is ${b ?? `unevaluable (${d.stderr.slice(-400)})`}, the flake's ${a ?? `unevaluable (${f.stderr.slice(-400)})`}`);
  return ["default-nix-no-flakes"];
}

/** default-nix-lazy: `nix-env -qa -f default.nix` with the stable nixpkgs
 * replaced by an abort (flake.nix's stableSrc, in a copy of the tree), so
 * listing the packages never fetches or evaluates NixOS stable: the stable
 * set stays an attribute set whose names need nothing from it. An abort, not
 * a throw: nix-env skips an attribute that throws, as it would not skip a
 * failed fetch. A flake.nix whose stableSrc isn't found fails it too, so it
 * can't pass vacuously. */
export function lazyFailures(system: string, copy = () => unpack(workingTree()),
  list = (dir: string, sys: string) => tryRun("nix-env", ["--option", "experimental-features", "", "-qa", "-f", join(dir, "default.nix"), "--argstr", "system", sys])): string[] {
  let dir: string;
  try {
    dir = copy();
  } catch (e: any) {
    console.error(`default-nix-lazy: couldn't copy the tree: ${e?.message ?? e}`);
    return ["default-nix-lazy"];
  }
  try {
    const flake = readFileSync(join(dir, "flake.nix"), "utf8");
    const swapped = flake.replace(/stableSrc = builtins\.fetchTarball \{[\s\S]*?\n\s*\};/, 'stableSrc = abort "default-nix-lazy: NixOS stable was evaluated";');
    if (swapped === flake) {
      console.error("default-nix-lazy: flake.nix has no `stableSrc = builtins.fetchTarball { … };` to swap");
      return ["default-nix-lazy"];
    }
    writeFileSync(join(dir, "flake.nix"), swapped);
    const r = list(dir, system);
    if (r.status === 0) return [];
    console.error(`default-nix-lazy: ${r.stderr.slice(-800)}`);
    return ["default-nix-lazy"];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the probe reads: CI's own CHECKS_APPLY for every check but the hm-*
 * ones, which are listed as null (never evaluated). */
export const hmLazyApply = () => `cs: let hm = builtins.filter (n: builtins.substring 0 3 n == "hm-") (builtins.attrNames cs); in
      (${CHECKS_APPLY}) (builtins.removeAttrs cs hm) // builtins.listToAttrs (map (n: { name = n; value = null; }) hm)`;
/** The abort the probe swaps in for Home Manager's source. */
export const HM_LAZY_ABORT = "home-manager-lazy: Home Manager was evaluated";
/** home-manager-lazy: with Home Manager's source replaced by an abort
 * (flake.nix's homeManagerSrc, in a copy of the tree; exactly one such
 * binding, in a flake.nix that isn't a link), the check list and every check
 * but the hm-* ones read as CI reads them (hmLazyApply), so only the hm-*
 * checks fetch or evaluate Home Manager, and a store path already present
 * can't hide a fetch some other check forces. A control then evaluates an
 * hm-* check, which must reach the abort: the binding swapped is the live
 * one. A list without hm-* checks, or without another check read, fails it
 * too, so it can't pass vacuously. */
export function homeManagerLazyFailures(system: string, copy = () => unpack(workingTree()),
  evaluate = (dir: string, sys: string) => tryRun("nix", ["eval", "--json", `path:${dir}#checks.${sys}`, "--apply", hmLazyApply()]),
  // A positive control: an hm-* check, evaluated, must reach the abort, so the
  // binding swapped is the live one (not a copy in a comment).
  control = (dir: string, sys: string, name: string) => tryRun("nix", ["eval", "--raw", `path:${dir}#checks.${sys}.${name}.drvPath`])): string[] {
  let dir: string;
  try {
    dir = copy();
  } catch (e: any) {
    console.error(`home-manager-lazy: couldn't copy the tree: ${e?.message ?? e}`);
    return ["home-manager-lazy"];
  }
  try {
    let flake: string, swapped: string;
    // The one live binding: a copy elsewhere (in a comment) makes it unclear
    // which is swapped, so that fails too.
    const binding = /homeManagerSrc = builtins\.fetchTarball \{[\s\S]*?\n\s*\};/g;
    try {
      // Read and written as the copy's own file, never through a link out of it.
      if (lstatSync(join(dir, "flake.nix")).isSymbolicLink()) {
        console.error("home-manager-lazy: the copied flake.nix is a symbolic link");
        return ["home-manager-lazy"];
      }
      flake = readFileSync(join(dir, "flake.nix"), "utf8");
      const found = flake.match(binding) ?? [];
      if (found.length !== 1) {
        console.error(`home-manager-lazy: flake.nix has ${found.length} \`homeManagerSrc = builtins.fetchTarball { … };\` bindings, not exactly one to swap`);
        return ["home-manager-lazy"];
      }
      swapped = flake.replace(binding, `homeManagerSrc = abort "${HM_LAZY_ABORT}";`);
      writeFileSync(join(dir, "flake.nix"), swapped);
    } catch (e: any) {
      console.error(`home-manager-lazy: couldn't prepare the copied flake: ${e?.message ?? e}`);
      return ["home-manager-lazy"];
    }
    const r = evaluate(dir, system);
    if (r.status !== 0) {
      console.error(`home-manager-lazy: ${r.stderr.slice(-800)}`);
      return ["home-manager-lazy"];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`home-manager-lazy: the evaluation printed no check list (${r.stdout.slice(0, 200)})`);
      return ["home-manager-lazy"];
    }
    const listed = Object.entries(parsed as Record<string, { drv?: unknown } | null>);
    if (!listed.some(([n]) => n.startsWith("hm-"))) {
      console.error("home-manager-lazy: no hm-* checks were listed");
      return ["home-manager-lazy"];
    }
    // Some other check was read, so the abort was in reach.
    if (!listed.some(([n, c]) => !n.startsWith("hm-") && typeof c?.drv === "string" && c.drv.endsWith(".drv"))) {
      console.error("home-manager-lazy: no other check's drvPath was evaluated");
      return ["home-manager-lazy"];
    }
    const hm = listed.find(([n]) => n.startsWith("hm-"))![0];
    const c = control(dir, system, hm);
    if (c.status === 0 || !c.stderr.includes(HM_LAZY_ABORT)) {
      console.error(`home-manager-lazy: ${hm}, evaluated, didn't reach the swapped-in abort (${c.status === 0 ? "it evaluated" : `exit ${c.status}: ${c.stderr.slice(-800)}`}): the binding swapped may not be the live homeManagerSrc`);
      return ["home-manager-lazy"];
    }
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The checks' outputs and .drvs, plus the desktop apps' Electron choice
 * and the forced variants' "not applicable" marker. */
export const CHECKS_APPLY = `builtins.mapAttrs (_: c: { out = c.outPath; drv = c.drvPath;
  na = c.electronNotApplicable or false;
  electron = let e = c.electron or null; in if builtins.isAttrs e then e.choice or null else null; })`;

/** branchElectronReported against the parent commit (HEAD~1): its checks
 * evaluated from a copy, a failing one built (or for a smoke, its app built
 * and the parent's own smoke script run) only when asked. */
async function branchReported(e: ElectronEvidence, failed: string[], checks: Record<string, Check>, system: string): Promise<string[]> {
  const parentSrc = unpack(run("git", ["rev-parse", "HEAD~1^{tree}"]));
  try {
    const parent = stableNix.drvs(parentSrc, `checks.${system}`);
    return await branchElectronReported(e, failed, checks, parent, async (name) => {
      for (const ch of CHANNELS) {
        const app = Object.entries(ROLES[ch].smokes).find(([, s]) => s === name)?.[0];
        if (!app) continue;
        const p = parent?.[app];
        if (!p || stableNix.outcome(p) !== "pass") return false;
        const s = await smokesOf(parentSrc);
        return (await s.desktop(p.out, ch)) || (await s.desktop(p.out, ch));
      }
      const p = parent?.[name];
      return !!p && stableNix.outcome(p) === "pass";
    });
  } finally {
    rmSync(parentSrc, { recursive: true, force: true });
  }
}

/** With --strict-guards (branch CI, for a commit that changes lib/guard.nix)
 * a check that wrote a note fails: the change leaves the lists wrong.
 * Otherwise a note fails nothing: a release's become guard-review issues,
 * and one main already has blocks no unrelated branch. */
export const failedOnNotes = (strict: boolean, names: string[], out: (name: string) => string) =>
  strict ? names.filter((n) => notesOf([out(n)]).notes.length > 0) : [];

/** Whether the desktop smoke runs for this result: in the whole suite or
 * the desktop part, whether it ran; in another part, whether the run asked
 * for it (--desktop), since the desktop part runs it. Each part then
 * confirms its own provisional failures, as the whole suite would: on the
 * channels its own failures depend on rather than every part's, which
 * always includes each failure's own (a check could differ only if it also
 * read another channel's fallback entry). */
export const smokeRuns = (part: string | undefined, ran: boolean, desktop: boolean) =>
  part === undefined || part === "desktop" ? ran : desktop;

/** The checks a part reads, evaluated (all of them without a part): its
 * own, the desktop apps' (the Electron evidence lists them, and finds which
 * failures depend on them) and, in rest2, those default.nix is compared
 * with. Only its own are built. */
export function evaluateChecks(system: string, part: (typeof TEST_PARTS)[number] | undefined, nix = run): Record<string, Check> {
  if (part === undefined) return JSON.parse(nix("nix", ["eval", "--json", `.#checks.${system}`, "--apply", CHECKS_APPLY]));
  const all: string[] = JSON.parse(nix("nix", ["eval", "--json", `.#checks.${system}`, "--apply", "builtins.attrNames"]));
  const apps = new Set(CHANNELS.flatMap((ch) => [...ROLES[ch].auto, ROLES[ch].forced, ROLES[ch].bundled, ...Object.keys(ROLES[ch].smokes)]));
  const wanted = all.filter((n) => testPart(n) === part || apps.has(n) || (part === "rest2" && NO_FLAKES_ATTRS.includes(n)));
  // Plain names go into the expression quoted, with no escaping; anything
  // else (never the case today) evaluates everything instead.
  const odd = wanted.filter((n) => !/^[a-z0-9][a-z0-9-]*$/.test(n));
  if (odd.length) {
    console.log(`evaluating every check: ${odd.join(", ")} can't be named in the expression`);
    return evaluateChecks(system, undefined, nix);
  }
  return JSON.parse(nix("nix", ["eval", "--json", `.#checks.${system}`, "--apply",
    `cs: (${CHECKS_APPLY}) { inherit (cs) ${wanted.map((n) => `"${n}"`).join(" ")}; }`]));
}

export async function main(argv: string[]): Promise<void> {
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length !== 3) {
    console.error("usage: test.ts SET SYSTEM OUT_DIR [--desktop] [--agent-browser] [--strict-guards] [--part=PART]");
    process.exit(2);
  }
  const [set, system, outDir] = positional;
  mkdirSync(outDir, { recursive: true });

  const part = partArg(argv, TEST_PARTS);
  const checks = evaluateChecks(system, part);
  const has = (p: (typeof TEST_PARTS)[number]) => part === undefined || part === p;
  const names = checkNames(Object.keys(checks), set).filter((n) => part === undefined || testPart(n) === part);
  const firstFail = buildChecks(names, checks);
  const failed = buildChecks(firstFail, checks); // one retry, failures only

  const smokes: Record<string, SmokeState> = {};
  if (argv.includes("--desktop") && has("desktop")) failed.push(...await desktopFailures(checks, desktopSmoke, valid, smokes));
  else for (const ch of CHANNELS) for (const name of Object.values(ROLES[ch].smokes)) smokes[name] = "not-run";
  if (argv.includes("--agent-browser") && has("rest1")) failed.push(...await agentBrowserFailures(checks));
  if (has("rest2")) {
    failed.push(...noFlakesFailures(system, checks));
    failed.push(...lazyFailures(system));
    failed.push(...homeManagerLazyFailures(system));
  }

  // Packages are checks too, so their store paths are already known; the
  // built ones (not failed) get their narHash in one call.
  const allowlist = readJson<string[]>(join(ROOT, "ci", "cache-allowlist.json"));
  const built = allowlist.filter((p) => checks[p] && names.includes(p) && !failed.includes(p));
  const manifest: Record<string, { path: string; narHash: string }> = {};
  const info = built.length ? tryRun("nix", ["path-info", "--json", ...built.map((p) => checks[p].out)]) : null;
  if (info?.status === 0) {
    const hashes = narHashes(info.stdout);
    for (const p of built) if (hashes.has(checks[p].out)) manifest[p] = { path: checks[p].out, narHash: hashes.get(checks[p].out)! };
  }
  const { checked, notes } = notesOf(names.filter((n) => !failed.includes(n)).map((n) => checks[n].out));
  const updateNotice = noticeOf(Object.fromEntries(names.filter((n) => !failed.includes(n)).map((n) => [n, checks[n].out])));
  for (const n of notes) console.log(`note for ${n.package}: ${n.detail.replaceAll("\t", " | ")}`);
  failed.push(...failedOnNotes(set === "branch" && argv.includes("--strict-guards"), names.filter((n) => !failed.includes(n)), (n) => checks[n].out));
  const electron = electronEvidence(checks, failed, smokes, ROOT, undefined, part === undefined ? undefined : new Set(names));
  // Only where it can matter: a fallback needs the smoke to have run, and
  // branch CI never uses one.
  if (set !== "branch" && smokeRuns(part, electron.smokeRan, argv.includes("--desktop"))) electron.confirmed = await confirmProvisional(electron.dependsOn, system);
  if (Object.keys(electron.dependsOn).length) {
    console.log(`depend on the desktop app: ${Object.keys(electron.dependsOn).join(", ")}; pass on bundled Electron: ${electron.confirmed.join(", ") || "none"}`);
  }
  // Branch CI: runtime failures under an active fallback the branch didn't make.
  let reported: string[] = [];
  if (set === "branch" && Object.values(electron.channels).some((c) => c?.active)) {
    reported = await branchReported(electron, failed, checks, system);
    for (const r of reported) failed.splice(failed.indexOf(r), 1);
    if (reported.length) console.log(`reported, not failed (an active Electron fallback the branch didn't change): ${reported.join(", ")}`);
  }
  // Written again after NixOS stable's evaluations below: atomically.
  const suffix = part === undefined ? "" : `-${part}`;
  const write = () => rewriteJson(join(outDir, `${set}-${system}${suffix}.json`),
    { set, system, passed: failed.length === 0, failed, checked, notes, ...(Object.keys(updateNotice).length ? { updateNotice } : {}), electron,
      ...(reported.length ? { reported } : {}), nixCalls });
  // The manifest first: a saved result always has its manifest beside it
  // (the cache job needs both).
  rewriteJson(join(outDir, `manifest-${set}-${system}${suffix}.json`), manifest);
  write();
  // Last, once the default's result is saved: the one runner step that
  // evaluates NixOS stable (bounded; a stall changes nothing).
  if (has("rest2") && !failed.includes("default-nix-no-flakes")) {
    const disagree = stableNoFlakesFailures(system);
    failed.push(...disagree);
    // Again, with this step's Nix calls (and its failures, if any).
    write();
  }
  console.log(`${set} on ${system}: ${failed.length ? `FAILED ${failed.join(", ")}` : "passed"}`);
}

if (import.meta.main) await main(process.argv.slice(2));
