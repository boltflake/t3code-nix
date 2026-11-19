// Would anything from nixpkgs have to be built? The nixpkgs bump's cache
// check (update.ts): a bump is only offered once every nixpkgs build the
// flake's packages need is on cache.nixos.org, so users never compile
// nixpkgs themselves.
//
// "Ours" can't be told from a derivation, so it's measured: the same
// working tree is walked twice, at main's nixpkgs (the baseline) and at the
// bumped one. A walk starts at every packages.<system>.* output and asks
// cache.nixos.org for each output it needs; whatever isn't there must be
// built, and its own inputs are walked in turn, the way Nix decides what to
// build. At the baseline, what must be built is the flake's own work
// (vendor downloads, patching, wrappers), plus anything nixpkgs never
// cached there. At the new revision, a derivation that must be built and
// isn't one of those names is a nixpkgs build that isn't cached yet: a new
// version, a missing nested output (stdenv.cc.cc.lib), a build hook, or a
// rebuild that kept its name (cached at the baseline, so not in its list).
// The outputs found cached are then followed through their narinfo
// references, so a library missing further down is caught too.
//
// Store paths are full (/nix/store/...) throughout.
import { Failed, run, SYSTEMS, timing, ROOT, UA } from "./util.ts";

export const CACHE = "https://cache.nixos.org";
/** The whole bump (both evaluations, `nix flake update` and the cache
 * check) gets at most this long (less if reading upstream was slow; see
 * update.ts's BUMP_BY_MS), so a slow cache or a hung Nix declines it rather
 * than running resolve into its job limit. A normal bump takes well under
 * a minute. */
export const BUMP_BUDGET_MS = 15 * 60_000;
/** One Nix command's own limit, within what's left of the budget. */
export const NIX_TIMEOUT_MS = 5 * 60_000;
const LOOKUP_TIMEOUT_MS = 15_000;

/** A deadline shared by every step of one bump. */
export class Budget {
  readonly deadline: number;
  readonly now: () => number;
  constructor(ms: number, now: () => number = Date.now) {
    this.now = now;
    this.deadline = now() + ms;
  }
  get over() { return this.now() > this.deadline; }
  /** A timeout for the next step: at most `cap`, never past the deadline. */
  left(cap: number): number {
    const ms = Math.min(cap, this.deadline - this.now());
    if (ms <= 0) throw new Failed("the bump ran out of time");
    return ms;
  }
}
const unlimited = () => new Budget(Number.MAX_SAFE_INTEGER / 2);
const STORE = "/nix/store/";
const full = (p: string) => (p.startsWith(STORE) ? p : STORE + p);
/** The name part of a store path (after the hash). */
export const nameOf = (p: string) => full(p).slice(STORE.length + 33).replace(/\.drv$/, "");

export interface Drv {
  name: string;
  /** Output name -> store path (null: not known before building). */
  outputs: Record<string, string | null>;
  /** Input derivation -> the outputs of it this one uses. */
  inputs: Record<string, string[]>;
  /** A fixed-output derivation (a download): always fetched by whoever
   * builds, never looked up. Format 4 gives such outputs no path. */
  fixed?: boolean;
  /** A fixed output's hash, as SRI (sha256-…): matched against the pins'. */
  hash?: string;
  /** Never substituted (allowSubstitutes = false: the trivial builders):
   * always built locally, so never a cache question. */
  local?: boolean;
}
export type Show = (drvPaths: string[]) => Map<string, Drv> | Promise<Map<string, Drv>>;
export type Narinfo =
  | { status: "cached"; references: string[] }
  | { status: "missing" }
  | { status: "unknown"; error: string };
export type FetchNarinfo = (storePath: string) => Promise<Narinfo>;

/** Derivations as `nix derivation show` prints them: format 4 (store paths
 * without /nix/store/, inputs.drvs) and the older layout (inputDrvs, full
 * paths) both read. */
export function parseShow(json: string): Map<string, Drv> {
  const doc = JSON.parse(json);
  const drvs: Record<string, any> = doc?.derivations ?? doc;
  const out = new Map<string, Drv>();
  for (const [path, d] of Object.entries(drvs)) {
    const outputs: Record<string, string | null> = {};
    let fixed = false, hash: string | undefined;
    for (const [o, v] of Object.entries<any>(d.outputs ?? {})) {
      outputs[o] = typeof v?.path === "string" ? full(v.path) : null;
      if (v?.hash) {
        fixed = true;
        // Format 4: SRI; the older layout: hex, with hashAlgo ("sha256" or "r:sha256").
        if (typeof v.hash === "string" && /^sha256-/.test(v.hash)) hash = v.hash;
        else if (typeof v.hash === "string" && /sha256$/.test(String(v.hashAlgo ?? "")) && /^[0-9a-f]{64}$/.test(v.hash)) {
          hash = `sha256-${Buffer.from(v.hash, "hex").toString("base64")}`;
        }
      }
    }
    const local = d.env?.allowSubstitutes === "" || d.structuredAttrs?.allowSubstitutes === false;
    const raw: Record<string, any> = d.inputs?.drvs ?? d.inputDrvs ?? {};
    const inputs: Record<string, string[]> = {};
    for (const [i, v] of Object.entries<any>(raw)) inputs[full(i)] = Array.isArray(v) ? v : (v?.outputs ?? []);
    out.set(full(path), { name: typeof d.name === "string" ? d.name : nameOf(path), outputs, inputs, ...(fixed ? { fixed } : {}),
      ...(hash ? { hash } : {}), ...(local ? { local } : {}) });
  }
  return out;
}

/** `nix derivation show` for these .drv files (no recursion), a few hundred
 * at a time, within the budget. */
export const showWith = (budget: Budget): Show => (paths) => {
  const out = new Map<string, Drv>();
  for (let i = 0; i < paths.length; i += 300) {
    const json = run("nix", ["derivation", "show", ...paths.slice(i, i + 300)], { cwd: ROOT, timeout: budget.left(NIX_TIMEOUT_MS) });
    for (const [k, v] of parseShow(json)) out.set(k, v);
  }
  return out;
};

/** Which outputs a check covers: the flake's packages, or the NixOS-stable
 * set (legacyPackages.<system>.stable). */
export type Tops = "packages" | "stable";
const attrOf = (system: string, tops: Tops) => (tops === "packages" ? `.#packages.${system}` : `.#legacyPackages.${system}.stable`);

/** The .drv of every output of that set of the flake in ROOT, as it is on
 * disk now (flake.lock and versions/ included). Evaluating writes them to
 * the store. */
export function topsOf(system: string, dir = ROOT, budget = unlimited(), tops: Tops = "packages"): string[] {
  const json = run("nix", ["eval", "--json", attrOf(system, tops), "--apply", "ps: map (p: p.drvPath) (builtins.attrValues ps)"],
    { cwd: dir, timeout: budget.left(NIX_TIMEOUT_MS) });
  return [...new Set<string>(JSON.parse(json))].sort();
}

/** Ask cache.nixos.org for a store path's narinfo. 404 is missing; other
 * failures are retried (network errors, 429, 5xx), then unknown. */
export const fetchNarinfo: FetchNarinfo = async (storePath) => {
  const url = `${CACHE}/${full(storePath).slice(STORE.length, STORE.length + 32)}.narinfo`;
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      if (res.status === 404) { await res.body?.cancel(); return { status: "missing" }; }
      if (res.ok) {
        const refs = /^References:(.*)$/m.exec(await res.text())?.[1].trim() ?? "";
        return { status: "cached", references: refs ? refs.split(/\s+/).map(full) : [] };
      }
      await res.body?.cancel();
      last = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (e: any) {
      last = e?.message ?? String(e);
    }
    if (attempt < 3) await timing.sleep(timing.backoffMs * 2 ** (attempt - 1));
  }
  return { status: "unknown", error: `${url}: ${last}` };
};

/** At most `limit` lookups at once, each path asked once per check. One
 * failed lookup already declines the bump, so after it, and after the
 * deadline, the rest answer unknown without asking: an unreachable cache
 * costs one lookup's retries, not one per path. */
function memo(fetch: FetchNarinfo, budget: Budget, limit = 32): FetchNarinfo {
  const seen = new Map<string, Promise<Narinfo>>();
  let active = 0;
  let failed = false;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    while (active >= limit) await new Promise<void>((r) => waiting.push(r));
    active++;
  };
  const skip = (): Narinfo | null => failed ? { status: "unknown", error: "not asked: an earlier lookup failed" }
    : budget.over ? { status: "unknown", error: "not asked: the bump ran out of time" } : null;
  return (p) => {
    let got = seen.get(p);
    if (!got) {
      got = slot().then(async () => {
        const skipped = skip();
        if (skipped) return skipped;
        const info = await fetch(p);
        if (info.status === "unknown") failed = true;
        return info;
      }).finally(() => { active--; waiting.shift()?.(); });
      seen.set(p, got);
    }
    return got;
  };
}

export interface Walk {
  /** Derivations that must be built: path -> name. */
  build: Map<string, string>;
  /** Builds that aren't the flake's own (only when `ours` is given). */
  missing: string[];
  /** Lookups that failed, or outputs with no known path. */
  unknown: string[];
  /** Outputs found on the cache. */
  cached: Set<string>;
}

/** Walk from the top derivations the way Nix would decide what to build.
 * With `ours`, a derivation to build whose name isn't in it is reported
 * missing and not walked further (its own inputs are nixpkgs' business).
 * It stops at the first lookup that fails: that declines the bump anyway. */
/** Which derivations to build are the flake's own (for `walk`): the names
 * of the baseline's own builds, and, for a set on the same nixpkgs as the
 * baseline (the snapshot move), the pins' download hashes. Then a build is
 * the flake's own when it's a top, never substituted (local), a baseline
 * name, one of those downloads itself, or built on one (directly, or
 * through other builds); anything else to build is a nixpkgs build the
 * cache lacks. */
export interface Ours { names: Set<string>; pinHashes?: Set<string> }

export async function walk(tops: string[], show: Show, narinfo: FetchNarinfo, ours: Set<string> | Ours | null = null): Promise<Walk> {
  const result: Walk = { build: new Map(), missing: [], unknown: [], cached: new Set() };
  const drvs = new Map<string, Drv>();
  const load = async (paths: string[]) => {
    const want = paths.filter((p) => !drvs.has(p));
    if (want.length) for (const [k, v] of await show(want)) drvs.set(k, v);
    for (const p of paths) if (!drvs.has(p)) throw new Error(`nix derivation show gave nothing for ${p}`);
  };
  /** Must this derivation be built to get these outputs? */
  const needed = async (drv: Drv, outs: string[]): Promise<boolean> => {
    if (drv.fixed) return true;
    let build = false;
    await Promise.all(outs.map(async (o) => {
      const path = drv.outputs[o];
      if (!path) { result.unknown.push(`${drv.name}: output ${o} has no known path`); build = true; return; }
      const info = await narinfo(path);
      if (info.status === "cached") result.cached.add(path);
      else {
        if (info.status === "unknown") result.unknown.push(info.error);
        build = true;
      }
    }));
    return build;
  };
  const own = ours instanceof Set ? { names: ours } : ours;
  const topSet = new Set(tops);
  // Built on one of the pins' downloads, through builds only: memoised.
  const onPins = new Map<string, Promise<boolean>>();
  const builtOnPins = (p: string): Promise<boolean> => {
    if (!onPins.has(p)) {
      onPins.set(p, (async () => {
        const entries = Object.entries(drvs.get(p)!.inputs);
        await load(entries.map(([i]) => i));
        for (const [i, outs] of entries) {
          const d = drvs.get(i)!;
          if (d.fixed) {
            if (d.hash && own!.pinHashes!.has(d.hash)) return true;
          } else if (await needed(d, outs) && await builtOnPins(i)) return true;
        }
        return false;
      })());
    }
    return onPins.get(p)!;
  };
  const isOurs = async (p: string, d: Drv) => !own || own.names.has(d.name)
    || (!!own.pinHashes && (topSet.has(p) || !!d.local || (!!d.fixed && !!d.hash && own.pinHashes.has(d.hash)) || await builtOnPins(p)));
  await load(tops);
  const top = await Promise.all(tops.map((t) => needed(drvs.get(t)!, Object.keys(drvs.get(t)!.outputs))));
  let level = tops.filter((_, i) => top[i]);
  while (level.length && !result.unknown.length) {
    const next = new Set<string>();
    const expand: string[] = [];
    for (const p of level) {
      if (result.build.has(p)) continue;
      const d = drvs.get(p)!;
      result.build.set(p, d.name);
      if (!(await isOurs(p, d))) { result.missing.push(d.name); continue; }
      expand.push(p);
    }
    const inputs = expand.flatMap((p) => Object.entries(drvs.get(p)!.inputs));
    await load([...new Set(inputs.map(([i]) => i))]);
    await Promise.all(inputs.map(async ([i, outs]) => {
      if (result.build.has(i)) return;
      if (await needed(drvs.get(i)!, outs)) next.add(i);
    }));
    level = [...next];
  }
  result.missing = [...new Set(result.missing)].sort();
  result.unknown = [...new Set(result.unknown)].sort();
  return result;
}

/** Follow the cached outputs' narinfo references: every path their
 * substitution needs must be on the cache too. Returns the paths that
 * aren't (missing) and the lookups that failed (unknown). */
export async function closure(cached: Set<string>, narinfo: FetchNarinfo): Promise<{ missing: string[]; unknown: string[] }> {
  const missing: string[] = [], unknown: string[] = [];
  const seen = new Set<string>(cached);
  let level = [...cached];
  while (level.length) {
    const next: string[] = [];
    await Promise.all(level.map(async (p) => {
      const info = await narinfo(p);
      if (info.status === "missing") { missing.push(p); return; }
      if (info.status === "unknown") { unknown.push(info.error); return; }
      for (const r of info.references) if (!seen.has(r)) { seen.add(r); next.push(r); }
    }));
    level = next;
  }
  return { missing: missing.sort(), unknown: unknown.sort() };
}

export interface Verdict {
  /** "<system>: <name>" for each nixpkgs build not on the cache. */
  missing: string[];
  unknown: string[];
}

/** Compare the bumped revision with the baseline, per system. It stops at
 * the first lookup that fails, which already declines the bump. */
/** pinHashes: for two package sets on the same nixpkgs (the snapshot
 * move), the pins' download hashes, so a pin's new version or a new package
 * is still the flake's own work (see Ours); the nixpkgs bump, where the
 * packages stay and nixpkgs moves, matches the baseline's exact names. */
export async function compare(base: Record<string, string[]>, bumped: Record<string, string[]>,
  show: Show | null = null, narinfo: FetchNarinfo = fetchNarinfo, budget = new Budget(BUMP_BUDGET_MS), pinHashes: Set<string> | null = null): Promise<Verdict> {
  const ask = memo(narinfo, budget);
  const read = show ?? showWith(budget);
  const verdict: Verdict = { missing: [], unknown: [] };
  for (const system of Object.keys(bumped)) {
    // A failed lookup at the baseline counts too: it made that derivation
    // look like the flake's own, which could let a same-name miss through.
    const before = await walk(base[system] ?? [], read, ask);
    if (before.unknown.length) { verdict.unknown.push(...before.unknown); break; }
    const names = new Set(before.build.values());
    const after = await walk(bumped[system], read, ask, pinHashes ? { names, pinHashes } : names);
    verdict.missing.push(...after.missing.map((n) => `${system}: ${n}`));
    if (after.unknown.length) { verdict.unknown.push(...after.unknown); break; }
    const deep = await closure(after.cached, ask);
    verdict.missing.push(...deep.missing.map((p) => `${system}: ${nameOf(p)} (needed by a cached path)`));
    if (deep.unknown.length) { verdict.unknown.push(...deep.unknown); break; }
  }
  verdict.missing = [...new Set(verdict.missing)].sort();
  verdict.unknown = [...new Set(verdict.unknown)].sort();
  return verdict;
}

/** Every system's top derivations, as the flake in ROOT is now. */
export const allTops = (dir = ROOT, budget = unlimited(), tops: Tops = "packages") =>
  Object.fromEntries(SYSTEMS.map((s) => [s, topsOf(s, dir, budget, tops)]));
