// The weekly check of the project's own CI tooling (tooling.yml): what no
// other update covers. The flake's input (nixpkgs, and with it actionlint,
// zizmor, shellcheck and the rest of the CI's Nix tools) moves with the
// update runs, and the pinned actions (Nix's installer among them) with
// Dependabot. Left are:
//   runner-image       a newer GitHub-hosted Ubuntu image (not a preview)
//                      than any runs-on label in the workflows, x64 and arm
//                      apart
//   nodejs             a newer Node LTS line than the Node CI installs
//                      (the setup action, lib/checks.nix) or package.json's
//                      engines ask for
//   actionlint-labels  .github/actionlint.yaml names runner labels for an
//                      actionlint that didn't know them: the pinned one now
//                      does, so the file can go
//
//   node tooling.ts [ACTIONLINT_PROBE_RESULT]
//
// Prints {observations, unknown}: tooling-outdated (package: the item) when
// there's something to do, tooling-ok (closing it) when there isn't, for
// issues.ts; and for each item it couldn't decide, why (nothing opens or
// closes for it; the workflow then fails, so a check that stops working
// shows). ACTIONLINT_PROBE_RESULT: a file the workflow writes: "known" (the
// pinned actionlint passes the workflows without the config), "unknown"
// (it fails on runner labels only) or anything else (it failed otherwise).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, UA } from "../lib/util.ts";
import { obs, type Observation } from "../update.ts";

export const RUNNER_IMAGES = "https://raw.githubusercontent.com/actions/runner-images/main/README.md";
export const NODE_RELEASES = "https://nodejs.org/dist/index.json";

/** One attempt with a time limit: a source that's down is unknown this
 * week, never a reason to hold the job. */
export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export interface Result { observations: Observation[]; unknown: { item: string; why: string }[] }
type Arch = "x64" | "arm";
const archOf = (arm: string | undefined): Arch => (arm ? "arm" : "x64");
const label = (v: number, arch: Arch) => `ubuntu-${v.toFixed(2)}${arch === "arm" ? "-arm" : ""}`;

/** Every Ubuntu runs-on label the workflows use (comments left out), by
 * architecture: the oldest decides. */
export function usedUbuntu(workflowsDir: string): Record<Arch, number[]> {
  const used: Record<Arch, number[]> = { x64: [], arm: [] };
  for (const f of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(workflowsDir, f), "utf8").split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
    for (const m of text.matchAll(/\bubuntu-(\d{2}\.\d{2})(-arm)?\b/g)) used[archOf(m[2])].push(Number(m[1]));
  }
  return used;
}

/** The newest Ubuntu image GitHub offers per architecture: the YAML Label
 * column of the README's Available Images table, rows marked preview or
 * beta left out. Null for an architecture the table doesn't show. */
export function offeredUbuntu(readme: string): Record<Arch, number | null> {
  const offered: Record<Arch, number | null> = { x64: null, arm: null };
  const lines = readme.split("\n");
  const head = lines.findIndex((l) => l.startsWith("|") && /\|\s*YAML Label\s*\|/i.test(l));
  if (head < 0) return offered;
  const col = lines[head].split("|").findIndex((c) => /YAML Label/i.test(c));
  for (const row of lines.slice(head + 2)) {
    if (!row.startsWith("|")) break;
    if (/preview|beta/i.test(row)) continue;
    for (const m of (row.split("|")[col] ?? "").matchAll(/`ubuntu-(\d{2}\.\d{2})(-arm)?`/g)) {
      const a = archOf(m[2]), v = Number(m[1]);
      offered[a] = Math.max(offered[a] ?? v, v);
    }
  }
  return offered;
}

export function runnerImage(workflowsDir: string, readme: string): Result {
  const used = usedUbuntu(workflowsDir), offered = offeredUbuntu(readme);
  const behind: { target: string; text: string }[] = [], unknown: Result["unknown"] = [];
  for (const arch of ["x64", "arm"] as const) {
    if (!used[arch].length) continue;
    const newest = offered[arch];
    if (newest === null) { unknown.push({ item: "runner-image", why: `the README's table shows no ${arch} Ubuntu image` }); continue; }
    const old = [...new Set(used[arch].filter((v) => v < newest))].sort((a, b) => a - b);
    if (old.length) behind.push({ target: label(newest, arch), text: `${label(newest, arch)} (the workflows use ${old.map((v) => label(v, arch)).join(", ")})` });
  }
  if (unknown.length) return { observations: [], unknown };
  return {
    observations: [behind.length
      ? obs("tooling-outdated", "runner-image", behind.map((b) => b.target).join(" "),
        `GitHub offers ${behind.map((b) => b.text).join(" and ")}: move every workflow's runs-on to it (https://github.com/actions/runner-images#available-images).`)
      : obs("tooling-ok", "runner-image")],
    unknown: [],
  };
}

/** The Node majors the project is on, from every place that pins one:
 * package.json's engines floor, the setup action's nixpkgs#nodejs_N (or
 * nodejs-slim_N) and setup-node version, lib/checks.nix's nodejs_N. The
 * oldest decides; a place that's there but names no version is a reason the
 * check can't decide (never a silent pass). */
export function nodeMajors(root: string): { majors: number[]; missing: string[] } {
  // Comment lines left out (YAML's and Nix's #).
  const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n") : null);
  let engines: string | null = null;
  try { engines = String(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.engines?.node ?? ""); } catch { /* no file or no JSON */ }
  const sources: [string, string | null, RegExp][] = [
    ["package.json's engines", engines, /^[^0-9]*(\d+)/g],
    ["the setup action's nixpkgs Node", read(".github/actions/setup/action.yml"), /nodejs(?:-slim)?_(\d+)/g],
    ["the setup action's setup-node version", read(".github/actions/setup/action.yml"), /node-version:\s*["']?(\d+)/g],
    ["lib/checks.nix's Node", read("lib/checks.nix"), /nodejs(?:-slim)?_(\d+)/g],
  ];
  const majors: number[] = [], missing: string[] = [];
  for (const [name, text, re] of sources) {
    const found = text === null ? [] : [...text.matchAll(re)].map((m) => Number(m[1]));
    if (found.length) majors.push(...found);
    else missing.push(name);
  }
  return { majors, missing };
}

export function nodejs(root: string, index: string): Result {
  const { majors: ours, missing } = nodeMajors(root);
  if (missing.length) return { observations: [], unknown: [{ item: "nodejs", why: `no Node version found in ${missing.join(", ")}` }] };
  let list: unknown;
  try { list = JSON.parse(index); } catch { list = null; }
  // An LTS line: a release that carries its LTS name.
  const lts = Array.isArray(list)
    ? list.filter((r: any) => typeof r?.lts === "string" && typeof r?.version === "string").map((r: any) => Number(/^v(\d+)\./.exec(r.version)?.[1])).filter(Number.isFinite)
    : [];
  if (!lts.length) return { observations: [], unknown: [{ item: "nodejs", why: "nodejs.org's index lists no LTS release" }] };
  const newest = Math.max(...lts), oldest = Math.min(...ours);
  return {
    observations: [newest > oldest
      ? obs("tooling-outdated", "nodejs", String(newest),
        `Node ${newest} is an LTS line; the project is on Node ${[...new Set(ours)].sort((a, b) => a - b).join(", ")}: package.json's engines, the setup action (nixpkgs#nodejs_N and setup-node's node-version) and lib/checks.nix's nodejs_N. Move them all to ${newest} once nixpkgs has nodejs_${newest}.`)
      : obs("tooling-ok", "nodejs", String(oldest))],
    unknown: [],
  };
}

export function actionlintLabels(root: string, probe: string | null): Result {
  // Without the file there's nothing to remove (and an old issue closes).
  if (!existsSync(join(root, ".github", "actionlint.yaml"))) return { observations: [obs("tooling-ok", "actionlint-labels")], unknown: [] };
  if (probe !== "known" && probe !== "unknown") return { observations: [], unknown: [{ item: "actionlint-labels", why: `the actionlint probe gave ${probe === null ? "no result" : "an error"}` }] };
  return {
    observations: [probe === "known"
      ? obs("tooling-outdated", "actionlint-labels", null,
        "The pinned actionlint passes the workflows without .github/actionlint.yaml now: delete it, and in lib/checks.nix the unit check's copy of it and its -config-file arguments. The next weekly check then finds no file and closes this issue.")
      : obs("tooling-ok", "actionlint-labels")],
    unknown: [],
  };
}

export async function tooling(root = ROOT, probe: string | null = null, get = fetchText): Promise<Result> {
  const out: Result = { observations: [], unknown: [] };
  const add = (r: Result) => { out.observations.push(...r.observations); out.unknown.push(...r.unknown); };
  const read = async (item: string, url: string, then: (text: string) => Result) => {
    try { add(then(await get(url))); } catch (e: any) { out.unknown.push({ item, why: `${url}: ${e?.message ?? e}` }); }
  };
  await read("runner-image", RUNNER_IMAGES, (t) => runnerImage(join(root, ".github", "workflows"), t));
  await read("nodejs", NODE_RELEASES, (t) => nodejs(root, t));
  add(actionlintLabels(root, probe));
  return out;
}

if (import.meta.main) {
  const file = process.argv[2];
  const probe = file && existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  console.log(JSON.stringify(await tooling(ROOT, probe), null, 2));
}
