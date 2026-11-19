// agent-browser's browsers: ungoogled-chromium, chromium and google-chrome
// from nixpkgs, followed on their own schedule, not the flake's nixpkgs bump
// (README, "Agent tools"). Two pins,
// versions/browser-unstable.json (nixos-unstable) and
// versions/browser-stable.json (the newest released NixOS), each a nixpkgs
// revision with its narHash, fetched by fetchTarball (lib/versions.nix's
// `browsers`).
//
// Only ungoogled-chromium (the default) gates a pin. A pin moves when any of
// the three browsers' versions changes, and at least weekly (counted from
// its own file on main), to the channel's current revision, but only once
// ungoogled's builds for both systems are on cache.nixos.org. The stable pin
// follows a new NixOS release once it's out of beta. A held revision's
// ungoogled version isn't proposed again on the next channel move, except on
// retry runs and at the weekly floor.
//
// chromium and google-chrome are evaluated in their own error boundary and
// checked for availability (chromium on cache.nixos.org, Chrome's .deb at
// Google). While one isn't available the pin waits, at most WAIT_MS for the
// whole pin, counted from the `waiting since` its browser-waiting issue
// records (passed in as `waits`, with the main revision it started from:
// a wait that started at another main revision is over, and a new one
// starts); then it moves with that browser marked unavailable for that
// system. A pin without `browsers` (from before) gets
// them filled in at its own revision, a details-only change, and so does a
// pin whose unavailable browser has since become available.
//
// What it reports per pin: `pass` only when the channel is at the pin's
// revision (nothing to move); `waiting` when it declines a move (closes only
// resolve-failed); `bump-waiting` when it declines for ungoogled's cache and
// the pin's file is more than 14 days old; `on-main` for the revision main
// pins (closes a bump-waiting opened at another revision); `browser-waiting`
// while the optional browsers hold the move; `browsers-ready` otherwise
// (closes browser-waiting).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { channelUrl, isReleased, nextRelease, NIXOS_UNSTABLE } from "../../shared/sources.ts";
import { fetchNarinfo, type FetchNarinfo } from "./nixcache.ts";
import { currentPin, fail, getText, ROOT, SYSTEMS, tryRun, UA, type Pin } from "./util.ts";

export const PINS: Record<string, "unstable" | "stable"> = { "browser-unstable": "unstable", "browser-stable": "stable" };
export const UNSTABLE = NIXOS_UNSTABLE;
export { nextRelease };
/** Where the stable pin starts when there is none yet. */
export const FIRST_STABLE = "nixos-26.05";
const DAY = 24 * 60 * 60 * 1000;
export const FLOOR_MS = 7 * DAY;
export const ISSUE_MS = 14 * DAY;
/** A pin's open wait: since when, and main's revision when it started
 * (its browser-waiting issue's version; null when main had no pin). */
export interface Wait { since: string; from: string | null }
/** How long a pin waits for chromium and google-chrome, in all. */
export const WAIT_MS = 3 * DAY;
/** The browsers that don't gate a pin. */
export const OPTIONAL = ["chromium", "google-chrome"] as const;
export type Optional = (typeof OPTIONAL)[number];
const NIX_TIMEOUT_MS = 5 * 60_000;

/** An optional browser at a pin's revision. `version` is null when it
 * couldn't be evaluated; `unavailable` names the systems the pin moved
 * without it, and why. */
export interface BrowserEntry {
  version: string | null;
  outPaths?: Record<string, string>;
  /** google-chrome's .deb per system. */
  assets?: Record<string, { url: string; hash: string }>;
  unavailable?: Record<string, string>;
}
export interface ChannelPin extends Pin {
  channel: string;
  rev: string;
  narHash: string;
  /** ungoogled-chromium's version and store paths (the default browser). */
  chromium: string;
  outPaths: Record<string, string>;
  browsers?: Record<Optional, BrowserEntry>;
}
/** An optional browser as evaluated: its entry, or why it couldn't be. */
type Evaluated = { version: string; outPaths: Record<string, string>; assets?: Record<string, { url: string; hash: string }> } | { error: string };

const run = promisify(execFile);
const tarball = (rev: string) => `https://github.com/NixOS/nixpkgs/archive/${rev}.tar.gz`;

/** The network, Nix and git; tests replace them. */
export const io = {
  /** The channel's current nixpkgs revision. */
  async rev(channel: string): Promise<string> {
    const rev = (await getText(`${channelUrl(channel)}/git-revision`)).trim();
    if (!/^[0-9a-f]{40}$/.test(rev)) fail(`${channel}: git-revision is ${JSON.stringify(rev.slice(0, 60))}`);
    return rev;
  },
  /** Is the release channel out (its redirect target has no "beta")? A 404
   * is "not yet"; anything else unexpected is an error. */
  async released(channel: string): Promise<boolean> {
    const res = await fetch(channelUrl(channel), { method: "HEAD", redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return false;
    const to = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !to) fail(`${channel}: HTTP ${res.status} without a redirect`);
    return isReleased(res.status, to);
  },
  /** The narHash of the revision's source tree, as fetchTarball checks it. */
  async prefetch(rev: string, timeout = NIX_TIMEOUT_MS): Promise<string> {
    const { stdout } = await run("nix", ["flake", "prefetch", "--json", tarball(rev)], { cwd: ROOT, timeout, maxBuffer: 16 << 20 });
    const hash = JSON.parse(stdout)?.hash;
    if (typeof hash !== "string" || !hash.startsWith("sha256-")) fail(`nix flake prefetch gave no hash for ${rev}`);
    return hash;
  },
  /** ungoogled-chromium's version and store path for each system at the
   * revision; both systems must agree on the version. */
  async evaluate(rev: string, narHash: string): Promise<{ version: string; outPaths: Record<string, string> }> {
    const expr = `let src = builtins.fetchTarball { url = ${JSON.stringify(tarball(rev))}; sha256 = ${JSON.stringify(narHash)}; };
      at = system: let c = (import src { inherit system; config = { }; overlays = [ ]; }).ungoogled-chromium; in { version = c.version; out = c.outPath; };
      in builtins.listToAttrs (map (s: { name = s; value = at s; }) ${JSON.stringify(SYSTEMS).replaceAll(",", " ")})`;
    const { stdout } = await run("nix", ["eval", "--json", "--expr", expr], { cwd: ROOT, timeout: NIX_TIMEOUT_MS, maxBuffer: 16 << 20 });
    const doc = JSON.parse(stdout);
    const versions = new Set(SYSTEMS.map((s) => doc?.[s]?.version));
    if (versions.size !== 1 || typeof [...versions][0] !== "string") fail(`${rev}: ungoogled-chromium's versions differ by system: ${JSON.stringify(doc)}`);
    return { version: [...versions][0], outPaths: Object.fromEntries(SYSTEMS.map((s) => [s, String(doc[s].out)])) };
  },
  /** chromium and google-chrome at the revision, each in its own error
   * boundary (tryEval, and `?` for a missing attribute, which tryEval can't
   * catch): a throw, a missing attribute or versions that differ by system
   * make that browser an error, never the pin's. Chrome's .deb URL and hash
   * come from its `src`. */
  async evaluateOptional(rev: string, narHash: string, only: readonly Optional[] = OPTIONAL): Promise<Record<Optional, Evaluated>> {
    const expr = `let src = builtins.fetchTarball { url = ${JSON.stringify(tarball(rev))}; sha256 = ${JSON.stringify(narHash)}; };
      pkgsOf = system: import src { inherit system; config.allowUnfreePredicate = p: (p.pname or "") == "google-chrome"; overlays = [ ]; };
      one = system: name: let ps = pkgsOf system; p = ps.\${name}; v = { version = p.version; out = p.outPath; }; r = builtins.tryEval (builtins.deepSeq v v); in if ps ? \${name} && r.success then r.value else null;
      sri = s: if builtins.substring 0 7 s.outputHash == "sha256-" then s.outputHash else builtins.convertHash { hash = s.outputHash; hashAlgo = if (s.outputHashAlgo or null) == null then "sha256" else s.outputHashAlgo; toHashFormat = "sri"; };
      deb = system: let ps = pkgsOf system; s = ps.google-chrome.src; v = { url = builtins.head (s.urls or [ s.url ]); hash = sri s; }; r = builtins.tryEval (builtins.deepSeq v v); in if ps ? google-chrome && r.success then r.value else null;
      want = ${JSON.stringify(only).replaceAll(",", " ")};
      has = n: builtins.elem n want;
      in builtins.listToAttrs (map (s: { name = s; value = { chromium = if has "chromium" then one s "chromium" else null;
        google-chrome = if has "google-chrome" then one s "google-chrome" else null; deb = if has "google-chrome" then deb s else null; }; }) ${JSON.stringify(SYSTEMS).replaceAll(",", " ")})`;
    const { stdout } = await run("nix", ["eval", "--json", "--expr", expr], { cwd: ROOT, timeout: NIX_TIMEOUT_MS, maxBuffer: 16 << 20 });
    return optionalOf(JSON.parse(stdout));
  },
  /** Whether a download answers: a HEAD with 200 is "ok", 404 or 410
   * "missing", anything else (or no answer) "unknown". */
  async head(url: string): Promise<"ok" | "missing" | { unknown: string }> {
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
      return res.status === 200 ? "ok" : res.status === 404 || res.status === 410 ? "missing" : { unknown: `HTTP ${res.status}` };
    } catch (e: any) {
      return { unknown: String(e?.message ?? e) };
    }
  },
  narinfo: fetchNarinfo as FetchNarinfo,
  /** How long ago versions/<name>.json last changed on main, or null if it
   * never did. */
  fileAge(name: string, now: Date): number | null {
    const r = tryRun("git", ["-C", ROOT, "log", "-1", "--format=%ct", "HEAD", "--", `versions/${name}.json`]);
    return r.status === 0 && r.stdout ? now.getTime() - Number(r.stdout) * 1000 : null;
  },
};

/** The newest released stable channel, from `start` on. */
export async function newestStable(start: string): Promise<string> {
  let channel = start;
  for (let i = 0; i < 4; i++) {
    const next = nextRelease(channel);
    if (!(await io.released(next))) break;
    channel = next;
  }
  return channel;
}

export type Report = {
  observe: (o: { kind: string; package: string | null; channel: string | null; version: string | null; detail: string }) => void;
  candidate: (pin: Pin, held: Set<string>, retry: boolean) => void;
  resolved: Map<string, string>;
  /** The pins this run proposes. */
  pins: Map<string, Pin>;
  versionsDir: string;
};
const obs = (kind: string, pkg: string, version: string | null, detail = "") => ({ kind, package: pkg, channel: null, version, detail });
const short = (rev: string) => rev.slice(0, 12);

/** `nix eval`'s answer for the optional browsers, per system, as entries:
 * a browser whose evaluation failed on a system, or whose versions differ
 * by system, is an error. */
export function optionalOf(doc: any): Record<Optional, Evaluated> {
  const one = (name: Optional): Evaluated => {
    const per = SYSTEMS.map((s) => doc?.[s]?.[name]);
    const failed = SYSTEMS.filter((_, i) => typeof per[i]?.version !== "string" || typeof per[i]?.out !== "string");
    if (failed.length) return { error: `${name} didn't evaluate on ${failed.join(", ")}` };
    const versions = new Set(per.map((p) => p.version));
    if (versions.size !== 1) return { error: `${name}'s versions differ by system: ${[...versions].join(", ")}` };
    const entry: Evaluated = { version: per[0].version, outPaths: Object.fromEntries(SYSTEMS.map((s, i) => [s, String(per[i].out)])) };
    if (name === "google-chrome") {
      const debs = SYSTEMS.map((s) => doc?.[s]?.deb);
      const bad = SYSTEMS.filter((_, i) => typeof debs[i]?.url !== "string" || !/^sha256-/.test(debs[i]?.hash ?? ""));
      if (bad.length) return { error: `google-chrome's download didn't evaluate on ${bad.join(", ")}` };
      entry.assets = Object.fromEntries(SYSTEMS.map((s, i) => [s, { url: debs[i].url, hash: debs[i].hash }]));
    }
    return entry;
  };
  return { chromium: one("chromium"), "google-chrome": one("google-chrome") };
}

/** Each optional browser's entry at a revision, and what's missing: per
 * browser and system, why it isn't available (an evaluation error, a build
 * not on cache.nixos.org, a .deb that doesn't answer, or one that couldn't
 * be checked). */
/** evaluateOptional, never throwing, one Nix process per browser: a failed
 * evaluation (a Nix error tryEval can't catch, a timeout) makes that browser
 * an error, never the other one, and it can't stop ungoogled's move. */
async function optionalAt(rev: string, narHash: string): Promise<Record<Optional, Evaluated>> {
  const each = await Promise.all(OPTIONAL.map(async (b): Promise<[Optional, Evaluated]> => {
    try {
      return [b, (await io.evaluateOptional(rev, narHash, [b]))[b]];
    } catch (e: any) {
      return [b, { error: `couldn't evaluate: ${String(e?.message ?? e).split("\n").filter(Boolean).slice(-1)[0] ?? "unknown error"}` }];
    }
  }));
  return Object.fromEntries(each) as Record<Optional, Evaluated>;
}

async function availability(opt: Record<Optional, Evaluated>): Promise<{ entries: Record<Optional, BrowserEntry>; missing: { browser: Optional; system: string; why: string }[] }> {
  const missing: { browser: Optional; system: string; why: string }[] = [];
  const entries = {} as Record<Optional, BrowserEntry>;
  await Promise.all(OPTIONAL.map(async (b) => {
    const e = opt[b];
    if ("error" in e) {
      for (const system of SYSTEMS) missing.push({ browser: b, system, why: e.error });
      entries[b] = { version: null };
      return;
    }
    entries[b] = { ...e };
    await Promise.all(SYSTEMS.map(async (system) => {
      if (b === "chromium") {
        const i = await io.narinfo(e.outPaths[system]);
        if (i.status !== "cached") missing.push({ browser: b, system, why: i.status === "missing" ? "not on cache.nixos.org yet" : `couldn't check the cache (${(i as any).error})` });
      } else {
        const h = await io.head(e.assets![system].url);
        if (h !== "ok") missing.push({ browser: b, system, why: h === "missing" ? "its download answers 404 (not at Google)" : `couldn't check its download (${h.unknown})` });
      }
    }));
  }));
  const order = (m: { browser: string; system: string }) => `${m.browser}\0${m.system}`;
  missing.sort((a, b) => order(a).localeCompare(order(b)));
  return { entries, missing };
}

/** The entries with the still-missing browsers marked unavailable. */
const marked = (entries: Record<Optional, BrowserEntry>, missing: { browser: Optional; system: string; why: string }[]) =>
  Object.fromEntries(OPTIONAL.map((b) => {
    const gone = missing.filter((m) => m.browser === b);
    return [b, gone.length ? { ...entries[b], unavailable: Object.fromEntries(gone.map((m) => [m.system, m.why])) } : entries[b]];
  })) as Record<Optional, BrowserEntry>;
const unavailableIn = (p: ChannelPin) => OPTIONAL.some((b) => p.browsers?.[b]?.unavailable);
const said = (missing: { browser: string; system: string; why: string }[]) => missing.map((m) => `${m.browser} on ${m.system}: ${m.why}`).join("\n");

/** One pin: move it, decline (saying why), or report it current. Says
 * `browsers-ready` (ending a wait) only when no move is pending: the pin is
 * current, no move is due, or ungoogled itself isn't ready. A proposed or
 * held move keeps a wait open until the pin has moved on main (then it's
 * current), so a candidate that fails can't restart the clock. */
export async function resolvePin(report: Report, name: string, held: Set<string>, retry: boolean, now: Date,
  waits: Map<string, Wait> = new Map()): Promise<void> {
  const state = await resolveOne(report, name, held, retry, now, waits);
  if (state === "ready") report.observe(obs("browsers-ready", name, null));
  // Nothing moved: main's own pin may have an unavailable browser back.
  // (By name: both pins resolve at once, into the same report.)
  if (!report.pins.has(name)) await recover(report, name, held, retry);
}

/** At main's own revision, whatever the channel did: an optional browser
 * marked unavailable that's available again (on any system) is a
 * details-only change, keeping the marks still true. */
async function recover(report: Report, name: string, held: Set<string>, retry: boolean): Promise<void> {
  const cur = currentPin(name, report.versionsDir) as ChannelPin | null;
  if (!cur?.browsers || !unavailableIn(cur)) return;
  const { entries, missing } = await availability(await optionalAt(cur.rev, cur.narHash));
  const back = OPTIONAL.some((b) => Object.keys(cur.browsers![b].unavailable ?? {}).some((sys) => !missing.some((m) => m.browser === b && m.system === sys)));
  if (!back) return;
  const next: ChannelPin = { ...cur, browsers: marked(entries, missing) };
  report.candidate(next, held, retry);
}

/** resolvePin's work: "ready" (no move pending), "pending" (a move proposed
 * or held), "waiting" (the optional browsers hold it). */
type State = "ready" | "pending" | "waiting";
async function resolveOne(report: Report, name: string, held: Set<string>, retry: boolean, now: Date, waits: Map<string, Wait>): Promise<State> {
  const kind = PINS[name] ?? fail(`not a browser pin: ${name}`);
  const cur = currentPin(name, report.versionsDir) as ChannelPin | null;
  // Only a wait that started at main's current revision counts: once the pin
  // has moved on main, an older wait is over (on-main closes its issue).
  const wait = waits.get(name);
  const since = wait && wait.from === (cur?.rev ?? null) ? wait.since : undefined;
  if (cur) report.observe(obs("on-main", name, cur.rev));
  const channel = kind === "unstable" ? UNSTABLE : await newestStable(cur?.channel ?? FIRST_STABLE);
  const rev = await io.rev(channel);
  report.resolved.set(name, rev);
  const current = !!cur && cur.rev === rev && cur.channel === channel;
  // At the channel's revision with browsers recorded: nothing to move
  // (recover() handles an unavailable one).
  if (current && cur!.browsers) return (report.observe(obs("pass", name, rev)), "ready");
  const pinOf = (at: { version: string; outPaths: Record<string, string> }, narHash: string, browsers: Record<Optional, BrowserEntry>): ChannelPin => ({
    name, version: rev, assets: {}, released: { at: now.toISOString(), kind: "seen" },
    channel, rev, narHash, chromium: at.version, outPaths: at.outPaths, browsers,
  });

  // A pin from before `browsers`, at the channel's revision, gets them
  // below, like a move.
  const age = io.fileAge(name, now);
  const floor = age === null || age > FLOOR_MS;
  const narHash = current ? cur!.narHash : await io.prefetch(rev);
  const at = await io.evaluate(rev, narHash);
  const opt = await optionalAt(rev, narHash);
  const waiting = (why: string) => report.observe(obs("waiting", name, rev, why));
  const optionalMoved = !cur?.browsers || OPTIONAL.some((b) => {
    const e = opt[b];
    return !("error" in e) && e.version !== cur!.browsers![b].version;
  });
  // An open wait means a move was due: an optional browser that doesn't
  // evaluate on this revision must not end it (its clock would restart).
  const moved = !cur || channel !== cur.channel || at.version !== cur.chromium || optionalMoved || since !== undefined;
  if (!moved && !floor) return (waiting(`${channel} still has the same browsers (Chromium ${at.version}); the weekly move isn't due`), "ready");
  // A held revision's Chromium isn't retested on every channel move.
  if (!retry && !floor && !current) {
    for (const key of held) {
      const [pkg, heldRev] = key.split("\0");
      if (pkg !== name || !/^[0-9a-f]{40}$/.test(heldRev)) continue;
      const heldVersion = (await io.evaluate(heldRev, await io.prefetch(heldRev))).version;
      if (heldVersion === at.version) {
        // `held` too, so a run with nothing else new retries it (update.ts's
        // retryNames), as for any held version.
        report.observe(obs("held", name, heldRev, `Chromium ${at.version} is held`));
        waiting(`Chromium ${at.version} is held (at ${short(heldRev)}); not tried again until a retry or the weekly move`);
        return "pending";
      }
    }
  }
  const infos = await Promise.all(SYSTEMS.map(async (s) => [s, await io.narinfo(at.outPaths[s])] as const));
  const notCached = infos.filter(([, i]) => i.status !== "cached");
  if (notCached.length) {
    const what = notCached.map(([s, i]) => `${s}: ${i.status === "missing" ? "not on cache.nixos.org yet" : `couldn't check (${(i as any).error})`}`);
    waiting(`Chromium ${at.version} at ${short(rev)} waits for the cache: ${what.join("; ")}`);
    if (age === null || age > ISSUE_MS) {
      report.observe(obs("bump-waiting", name, cur?.rev ?? null,
        [cur ? `versions/${name}.json hasn't changed on main for more than 14 days, and the move waits for the cache:`
          : `versions/${name}.json isn't on main yet, and its first pin waits for the cache:`,
          ...notCached.map(([s, i]) => `${s}: ungoogled-chromium ${at.version} ${i.status === "missing" ? "not on cache.nixos.org yet" : "couldn't be checked"}`)].join("\n")));
    }
    return "ready";
  }

  // ungoogled is ready: the optional browsers can hold the move, but only for
  // WAIT_MS in all, counted from the browser-waiting issue's start.
  const { entries, missing } = await availability(opt);
  if (missing.length) {
    const start = since && Number.isFinite(Date.parse(since)) ? Date.parse(since) : now.getTime();
    if (now.getTime() - start < WAIT_MS) {
      report.observe(obs("browser-waiting", name, cur?.rev ?? null,
        `ungoogled-chromium ${at.version} at ${short(rev)} is ready; the move waits for these, at most 3 days in all:\n${said(missing)}`));
      waiting(`the move waits for chromium or google-chrome (at most 3 days): ${said(missing).replaceAll("\n", "; ")}`);
      return "waiting";
    }
    // Still an open problem until the pin moves (then `pass` and
    // browsers-ready close it), so its start isn't lost if this move fails.
    report.observe(obs("browser-waiting", name, cur?.rev ?? null,
      `the 3-day wait is over; ${short(rev)} moves without these, marked unavailable:\n${said(missing)}`));
    report.candidate(pinOf(at, narHash, marked(entries, missing)), held, retry);
    return "waiting";
  }
  report.candidate(pinOf(at, narHash, entries), held, retry);
  return "pending";
}

/** The pins in `wanted`, each with its own error boundary. */
export async function resolveBrowserPins(report: Report, wanted: Set<string>, held: Set<string>, retry: boolean, now = new Date(),
  waits: Map<string, Wait> = new Map()): Promise<void> {
  await Promise.all(Object.keys(PINS).filter((n) => wanted.has(n)).map(async (name) => {
    try {
      await resolvePin(report, name, held, retry, now, waits);
    } catch (e: any) {
      report.observe(obs("resolve-failed", name, null, String(e?.message ?? e).split("\n").slice(-5).join("\n")));
    }
  }));
}
