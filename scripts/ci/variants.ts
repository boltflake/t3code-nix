// agent-browser with its optional browsers (chromium, google-chrome): the
// report-only smokes. They never
// hold a pin or fail a candidate: update.yml runs them in a job of its own
// after publish, on the published tree, and their results become
// browser-failed and browser-ok observations, only for that tree.
//
//   node variants.ts args NAMES RETEST_JSON HEAD PUBLISHED_TREE
//     What to run for a publish: the variants of each browser pin it changed
//     (both pins' when it changed agent-browser or nixpkgs), and of each pin
//     with an open browser-failed issue (RETEST_JSON, from held.ts); the
//     NixOS-stable set's (its snapshot's browser-stable pin) when the publish
//     moved its browser-stable or agent-browser pin, changed nixpkgs-stable
//     (which the stable set builds on directly), or its issue is open. HEAD
//     is the commit the run started from. Prints run's arguments, or nothing.
//   node variants.ts run SYSTEM OUT_JSON --tree=TREE [--pins=P,...] [--stable]
//     Those variants, built from TREE.
//   node variants.ts branch SYSTEM OUT_JSON --parent=REV
//     Branch CI: both pins' variants on HEAD; a failure fails the branch only
//     when the branch made it fail (the parent's same variant passes, gives
//     no result, or doesn't exist). Exit 1 then.
//   node variants.ts observations PUBLISHED_TREE FILE...
//     The issues job: each file's results for the published tree, as
//     observations. The files come from a job that runs vendor code, so only
//     these kinds, scopes, browsers and systems are accepted.
//
// Each variant: a browser marked unavailable on this system (the pin moved
// without it) is a failure, "not available"; otherwise its build (Chrome's
// .deb comes from Google: a 404 or 410 is "couldn't download", any other
// download error no result), the wrapper's default browser checked against
// the pin's store path, and the smoke with the browser's brands, full
// version and (Chrome on x86_64) Widevine, tried twice. A build or smoke that
// runs out of time is no result. The workflow step's own timeout is the
// budget: a missing or partial OUT_JSON is no evidence.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentBrowserRun, type Expect } from "../agent-browser-smoke.ts";
import { run, SYSTEMS, tryRun, writeJson } from "../lib/util.ts";
import { obs, type Observation } from "../update.ts";
import { provenFailure, unpack } from "./stable.ts";

export const OPTIONAL = ["chromium", "google-chrome"] as const;
type Browser = (typeof OPTIONAL)[number];
export const SCOPES = ["browser-unstable", "browser-stable", "stable-browser-stable"] as const;
type Scope = (typeof SCOPES)[number];
const PROGRAM: Record<Browser, string> = { chromium: "chromium", "google-chrome": "google-chrome-stable" };
/** One variant's build (Chrome's download included). */
export const BUILD_MS = 25 * 60_000;
const DETAIL_MAX = 1500;

/** `rev`: the browser pin's nixpkgs revision the variant was built from. */
export interface Result { scope: Scope; browser: Browser; system: string; tree: string; rev: string | null; outcome: "pass" | "fail" | "none"; detail: string }

/** Nix and the smoke; tests replace them. */
export const io = {
  build(src: string, attr: string): { status: number; out: string | null; log: string } {
    const r = tryRun("nix", ["build", "--no-link", "--print-out-paths", "-L", `path:${src}#${attr}`], { timeout: BUILD_MS, maxBuffer: 64 << 20 });
    const out = r.status === 0 ? r.stdout.trim().split("\n").pop() ?? null : null;
    return { status: r.status ?? -1, out, log: `${r.stderr ?? ""}` };
  },
  read: (path: string) => readFileSync(path, "utf8"),
  smoke: (pkg: string, expect: Expect) => agentBrowserRun(pkg, expect),
  /** Whether the attribute exists in that source (a parent may not have it). */
  has: (src: string, attr: string) => tryRun("nix", ["eval", `path:${src}#${attr}.name`]).status === 0,
};

const tail = (text: string, n = 600) => text.trim().split("\n").slice(-8).join("\n").slice(-n);

/** Why a build gave no output: a failure ("fail"), or nothing proven
 * ("none": a timeout, a download that didn't answer, the daemon). A 404 or
 * 410 from Google is a failure (the .deb is gone), and so is an evaluation
 * error (a missing attribute, an assertion: the variant is broken). */
export function buildOutcome(status: number, log: string): { outcome: "fail" | "none"; detail: string } {
  if (/HTTP error (404|410)\b/.test(log)) return { outcome: "fail", detail: `couldn't download: ${tail(log)}` };
  if (/ETIMEDOUT|SIGTERM|SIGKILL|timed out|unable to download|cannot download|Could not resolve|Connection (refused|reset)|daemon/i.test(log)) {
    return { outcome: "none", detail: `no result: ${tail(log)}` };
  }
  if (provenFailure(status)) return { outcome: "fail", detail: `build failed: ${tail(log)}` };
  if (status === 1 && /^error:|\berror: /m.test(log)) return { outcome: "fail", detail: `evaluation failed: ${tail(log)}` };
  return { outcome: "none", detail: `no result: ${tail(log)}` };
}

/** One attempt: build, the wrapper's browser, the smoke. */
async function attempt(src: string, attr: string, entry: any, browser: Browser, system: string): Promise<{ outcome: Result["outcome"]; detail: string }> {
  const b = io.build(src, attr);
  if (b.status !== 0 || !b.out) return buildOutcome(b.status, b.log);
  // The wrapper's default browser is exactly the pin's (when it says).
  const want = entry?.outPaths?.[system] ? `${entry.outPaths[system]}/bin/${PROGRAM[browser]}` : null;
  const wrapper = io.read(join(b.out, "bin", "agent-browser"));
  const set = /AGENT_BROWSER_EXECUTABLE_PATH=\$\{AGENT_BROWSER_EXECUTABLE_PATH-'([^']+)'\}/.exec(wrapper)?.[1] ?? null;
  if (!set) return { outcome: "fail", detail: "the wrapper sets no default browser" };
  if (want && set !== want) return { outcome: "fail", detail: `the wrapper runs ${set}, not the pin's ${want}` };
  const expect: Expect = { brand: browser === "google-chrome" ? "chrome" : "chromium", version: typeof entry?.version === "string" ? entry.version : null,
    widevine: browser === "google-chrome" && system === "x86_64-linux" };
  const r = await io.smoke(b.out, expect);
  if (r.timedOut) return { outcome: "none", detail: `no result: the smoke ran out of time (${r.problems.join("; ")})` };
  return r.problems.length ? { outcome: "fail", detail: r.problems.join("; ") } : { outcome: "pass", detail: "" };
}

/** One variant of one scope on one system. `pin` is the browser pin it's
 * built from (null: unreadable). A failure is tried once more, whole; the
 * second attempt decides (no result there is no result). */
export async function variant(src: string, attr: string, pin: any, browser: Browser, system: string): Promise<{ outcome: Result["outcome"]; detail: string }> {
  const entry = pin?.browsers?.[browser];
  const gone = entry?.unavailable?.[system];
  if (typeof gone === "string") return { outcome: "fail", detail: `not available: ${gone}` };
  const first = await attempt(src, attr, entry, browser, system);
  return first.outcome === "fail" ? attempt(src, attr, entry, browser, system) : first;
}

const readPin = (src: string, path: string) => {
  try { return JSON.parse(io.read(join(src, path))); } catch { return null; }
};

/** The variants to run: [scope, attr, pin, browser], built from `src`. */
export function plan(system: string, src: string, pins: string[], stable: boolean): [Scope, string, any, Browser][] {
  const out: [Scope, string, any, Browser][] = [];
  for (const p of pins) {
    if (p !== "browser-unstable" && p !== "browser-stable") continue;
    for (const b of OPTIONAL) out.push([p, `legacyPackages.${system}.agentBrowserVariants."${p}-${b}"`, readPin(src, `versions/${p}.json`), b]);
  }
  if (stable) {
    for (const b of OPTIONAL) {
      out.push(["stable-browser-stable", `legacyPackages.${system}.stableAgentBrowserVariants.${b}`, readPin(src, "versions/stable/browser-stable.json"), b]);
    }
  }
  return out;
}

/** `args`: what a publish of `names` asks for, with these scopes' issues
 * open; `snapshotChanged`: the publish moved the stable set's browser-stable
 * or agent-browser pin. */
export function argsFor(names: string[], retest: string[], snapshotChanged: boolean): string[] {
  const pins = new Set<string>();
  for (const n of names) {
    if (n === "agent-browser" || n === "nixpkgs") { pins.add("browser-unstable"); pins.add("browser-stable"); }
    if (n === "browser-unstable" || n === "browser-stable") pins.add(n);
  }
  for (const r of retest) if (r === "browser-unstable" || r === "browser-stable") pins.add(r);
  const stable = snapshotChanged || names.includes("nixpkgs-stable") || retest.includes("stable-browser-stable");
  if (!pins.size && !stable) return [];
  return [...(pins.size ? [`--pins=${[...pins].sort().join(",")}`] : []), ...(stable ? ["--stable"] : [])];
}

/** Branch CI: a variant that fails on the branch is the branch's doing
 * unless the parent's same variant fails too (it passes, gives no result,
 * or doesn't exist: the branch's). */
export const madeByBranch = (theirs: { outcome: Result["outcome"] } | null) => !theirs || theirs.outcome !== "fail";

/** The issues job's observations from variant results: only the published
 * tree's, and only well-formed ones. */
export function observationsOf(results: unknown[], published: string): Observation[] {
  const list: Observation[] = [];
  for (const r of results as any[]) {
    if (!r || typeof r !== "object" || r.tree !== published || !/^[0-9a-f]{40}$/.test(published)) continue;
    if (!SCOPES.includes(r.scope) || !OPTIONAL.includes(r.browser) || !(SYSTEMS as readonly string[]).includes(r.system)) continue;
    const detail = typeof r.detail === "string" ? r.detail.slice(0, DETAIL_MAX) : "";
    const rev = typeof r.rev === "string" && /^[0-9a-f]{40}$/.test(r.rev) ? r.rev : null;
    if (r.outcome === "pass") list.push({ ...obs("browser-ok", r.scope, null, r.system), channel: r.browser });
    else if (r.outcome === "fail") list.push({ ...obs("browser-failed", r.scope, rev, `${r.system}: ${detail}`), channel: r.browser });
  }
  return list;
}

async function main(argv: string[]): Promise<number> {
  const [mode, ...rest] = argv;
  const flag = (name: string) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const positional = rest.filter((a) => !a.startsWith("--"));
  if (mode === "args") {
    const [names, retestFile, head, published] = positional;
    let retest: string[] = [];
    try { retest = JSON.parse(readFileSync(retestFile, "utf8")); } catch { /* none */ }
    const show = (rev: string, path: string) => tryRun("git", ["show", `${rev}:${path}`]).stdout;
    const snapshotChanged = !!published && ["versions/stable/browser-stable.json", "versions/stable/agent-browser.json"]
      .some((f) => show(head, f) !== show(published, f));
    console.log(argsFor((names ?? "").split(",").filter(Boolean), retest.filter((r) => typeof r === "string"), snapshotChanged).join(" "));
    return 0;
  }
  if (mode === "observations") {
    const [published, ...files] = positional;
    const results = files.flatMap((f) => {
      try { return JSON.parse(readFileSync(f, "utf8")).results ?? []; } catch { console.warn(`variants: ${f} unreadable; skipped`); return []; }
    });
    console.log(JSON.stringify({ observations: observationsOf(results, published ?? "") }, null, 2));
    return 0;
  }
  const [system, outFile] = positional;
  if ((mode !== "run" && mode !== "branch") || !system || !outFile) {
    console.error("usage: variants.ts args NAMES RETEST_JSON HEAD PUBLISHED_TREE\n"
      + "       variants.ts run SYSTEM OUT_JSON --tree=TREE [--pins=P,...] [--stable]\n"
      + "       variants.ts branch SYSTEM OUT_JSON --parent=REV\n       variants.ts observations PUBLISHED_TREE FILE...");
    return 2;
  }
  const results: Result[] = [];
  const cleanup: string[] = [];
  // Written after each variant, so a step that runs out of time keeps what it has.
  const save = () => writeJson(outFile, { results });
  try {
    if (mode === "run") {
      const tree = flag("tree") ?? "";
      if (!/^[0-9a-f]{40}$/.test(tree)) { console.error("variants: --tree=TREE (a git tree) is required"); return 2; }
      const src = unpack(tree);
      cleanup.push(src);
      const pins = (flag("pins") ?? "").split(",").filter(Boolean);
      for (const [scope, attr, pin, browser] of plan(system, src, pins, rest.includes("--stable"))) {
        const r = await variant(src, attr, pin, browser, system);
        console.log(`variants: ${scope} ${browser} (${system}): ${r.outcome}${r.detail ? `: ${r.detail}` : ""}`);
        results.push({ scope, browser, system, tree, rev: pin?.rev ?? null, ...r });
        save();
      }
      save();
      return 0;
    }
    // branch
    const parentRev = flag("parent") ?? "HEAD~1";
    const head = run("git", ["rev-parse", "HEAD^{tree}"]);
    const src = unpack(head);
    cleanup.push(src);
    let parentSrc: string | null = null;
    let broke = false;
    for (const [scope, attr, pin, browser] of plan(system, src, ["browser-unstable", "browser-stable"], false)) {
      const r = await variant(src, attr, pin, browser, system);
      let note = "";
      if (r.outcome === "fail") {
        if (!parentSrc) { parentSrc = unpack(run("git", ["rev-parse", `${parentRev}^{tree}`])); cleanup.push(parentSrc); }
        const theirs = io.has(parentSrc, attr) ? await variant(parentSrc, attr, readPin(parentSrc, `versions/${scope}.json`), browser, system) : null;
        const mine = madeByBranch(theirs);
        if (mine) broke = true;
        note = mine ? " (this branch made it fail)" : ` (fails on ${parentRev} too: reported only)`;
      }
      console.log(`variants: ${scope} ${browser} (${system}): ${r.outcome}${r.detail ? `: ${r.detail}` : ""}${note}`);
      results.push({ scope, browser, system, tree: head, rev: pin?.rev ?? null, ...r });
      save();
    }
    save();
    return broke ? 1 : 0;
  } finally {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
