// agent-browser's Chromium pins (scripts/lib/browserpins.ts), with the
// channels, Nix and the cache faked, and the release helpers they share with
// the watcher (shared/sources.ts).
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bp from "../scripts/lib/browserpins.ts";
import { Report, retryNames } from "../scripts/update.ts";
import { isReleased, latestRelease, nextRelease, previousRelease } from "../shared/sources.ts";
import type { Narinfo } from "../scripts/lib/nixcache.ts";

const NOW = new Date("2026-11-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const rev = (c: string) => c.repeat(40);
let dir: string;

interface World {
  revs: Record<string, string>;
  released: Set<string>;
  chromium: Record<string, string>; // rev -> version
  cached: Record<string, Narinfo["status"]>; // out path -> status
  ages: Record<string, number | null>; // pin -> ms
  evaluated: string[];
  /** rev -> an optional browser's version there (default: ungoogled's), or
   * null when it doesn't evaluate. */
  optional: Record<string, Partial<Record<bp.Optional, string | null>>>;
  debs: Record<string, "ok" | "missing" | "unknown">; // url -> HEAD answer
}
let w: World;
const real = { ...bp.io };
const out = (r: string, s: string) => `/nix/store/${r.slice(0, 32)}-ungoogled-chromium-${w.chromium[r]}-${s}`;
const SYS = { "x86_64-linux": "x86", "aarch64-linux": "arm" } as const;
const optVersion = (r: string, b: bp.Optional) => (b in (w.optional[r] ?? {}) ? w.optional[r][b]! : w.chromium[r]);
const optOut = (r: string, b: bp.Optional, s: string) => `/nix/store/${r.slice(0, 32)}-${b}-${optVersion(r, b)}-${s}`;
const debUrl = (r: string, s: string) => `https://dl.google.com/${r.slice(0, 8)}/google-chrome-${optVersion(r, "google-chrome")}-${s}.deb`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browserpins-test-"));
  w = { revs: { "nixos-unstable": rev("a"), "nixos-26.05": rev("s") }, released: new Set(), chromium: { [rev("a")]: "158.0.1", [rev("s")]: "157.0.9" },
    cached: {}, ages: {}, evaluated: [], optional: {}, debs: {} };
  Object.assign(bp.io, {
    rev: async (c: string) => w.revs[c] ?? (() => { throw new Error(`no channel ${c}`); })(),
    released: async (c: string) => w.released.has(c),
    prefetch: async (r: string) => `sha256-${r.slice(0, 8)}`,
    evaluate: async (r: string) => {
      w.evaluated.push(r);
      if (!w.chromium[r]) throw new Error(`error: attribute 'ungoogled-chromium' missing at ${r}`);
      return { version: w.chromium[r], outPaths: { "x86_64-linux": out(r, "x86"), "aarch64-linux": out(r, "arm") } };
    },
    evaluateOptional: async (r: string) => bp.optionalOf(Object.fromEntries(Object.entries(SYS).map(([s, short]) => [s, {
      chromium: optVersion(r, "chromium") ? { version: optVersion(r, "chromium"), out: optOut(r, "chromium", short) } : null,
      "google-chrome": optVersion(r, "google-chrome") ? { version: optVersion(r, "google-chrome"), out: optOut(r, "google-chrome", short) } : null,
      deb: optVersion(r, "google-chrome") ? { url: debUrl(r, short), hash: "sha256-deb" } : null,
    }]))),
    head: async (url: string) => {
      const st = w.debs[url] ?? "ok";
      return st === "unknown" ? { unknown: "HTTP 503" } : st;
    },
    narinfo: async (p: string): Promise<Narinfo> => {
      const st = w.cached[p] ?? "cached";
      return st === "cached" ? { status: "cached", references: [] } : st === "missing" ? { status: "missing" } : { status: "unknown", error: "HTTP 503" };
    },
    fileAge: (name: string) => (name in w.ages ? w.ages[name] : 2 * DAY),
  });
});
afterEach(() => {
  Object.assign(bp.io, real);
  rmSync(dir, { recursive: true, force: true });
});

const entries = (v: string, extra: Partial<Record<bp.Optional, object>> = {}) => ({
  chromium: { version: v, outPaths: { "x86_64-linux": "/c", "aarch64-linux": "/d" }, ...extra.chromium },
  "google-chrome": { version: v, outPaths: { "x86_64-linux": "/g", "aarch64-linux": "/h" },
    assets: { "x86_64-linux": { url: "https://x/1.deb", hash: "sha256-1" }, "aarch64-linux": { url: "https://x/2.deb", hash: "sha256-2" } }, ...extra["google-chrome"] },
});
/** A pin on disk; `browsers` false writes one from before they were recorded. */
const pin = (name: string, r: string, channel: string, chromium: string, browsers: object | false = entries(chromium)) =>
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ name, version: r, assets: {}, channel, rev: r, narHash: "sha256-x", chromium,
    outPaths: { "x86_64-linux": "/x", "aarch64-linux": "/y" }, released: { at: "2026-11-01T00:00:00.000Z", kind: "seen" },
    ...(browsers ? { browsers } : {}) }));
/** `waits`: a start time (the wait began at main's current revision), or a
 * full Wait. */
async function resolve(names = ["browser-unstable", "browser-stable"], held: string[][] = [], retry = false, waits: Record<string, string | bp.Wait> = {}, now = NOW) {
  const r = new Report(dir, now);
  const mainRev = (n: string) => { try { return JSON.parse(readFileSync(join(dir, `${n}.json`), "utf8")).rev; } catch { return null; } };
  const full = new Map(Object.entries(waits).map(([n, w]) => [n, typeof w === "string" ? { since: w, from: mainRev(n) } : w]));
  await bp.resolveBrowserPins(r, new Set(names), new Set(held.map(([p, v]) => `${p}\0${v}`)), retry, now, full);
  return r;
}
const kinds = (r: Report, name: string) => r.observations.filter((o) => o.package === name).map((o) => o.kind);

test("browser pins: a new Chromium version, cached on both systems, is proposed with its revision", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  const r = await resolve(["browser-unstable"]);
  assert.deepEqual(r.changed, [{ name: "browser-unstable", from: rev("0"), to: rev("a"), why: "new version" }]);
  const p: any = r.pins.get("browser-unstable");
  assert.deepEqual([p.channel, p.rev, p.chromium, p.narHash, p.outPaths["x86_64-linux"]], ["nixos-unstable", rev("a"), "158.0.1", `sha256-${"a".repeat(8)}`, out(rev("a"), "x86")]);
  assert.deepEqual(p.assets, {});
  assert.deepEqual(kinds(r, "browser-unstable"), ["on-main"], "main's revision is reported too; a proposed move ends no wait");
});

test("browser pins: the channel at the pin's revision is a pass, without evaluating anything", async () => {
  pin("browser-unstable", rev("a"), "nixos-unstable", "158.0.1");
  const r = await resolve(["browser-unstable"]);
  assert.deepEqual([r.changed, kinds(r, "browser-unstable"), w.evaluated], [[], ["on-main", "pass", "browsers-ready"], []]);
});

test("browser pins: a move not cached yet waits (a 404 or a failed lookup); after 14 days it's an issue", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  w.cached[out(rev("a"), "arm")] = "missing";
  let r = await resolve(["browser-unstable"]);
  assert.deepEqual([r.changed, kinds(r, "browser-unstable")], [[], ["on-main", "waiting", "browsers-ready"]]);
  assert.match(r.observations.find((o) => o.kind === "waiting")!.detail, /aarch64-linux: not on cache\.nixos\.org yet/);
  w.cached[out(rev("a"), "arm")] = "unknown";
  r = await resolve(["browser-unstable"]);
  assert.match(r.observations.find((o) => o.kind === "waiting")!.detail, /couldn't check \(HTTP 503\)/);
  w.ages["browser-unstable"] = 15 * DAY;
  r = await resolve(["browser-unstable"]);
  const issue = r.observations.find((o) => o.kind === "bump-waiting")!;
  assert.deepEqual([issue.version, issue.package], [rev("0"), "browser-unstable"], "named by main's revision");
});

test("browser pins: the same Chromium on a moved channel waits for the weekly floor, counted from the pin's own file", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "158.0.1");
  let r = await resolve(["browser-unstable"]);
  assert.deepEqual([r.changed, kinds(r, "browser-unstable")], [[], ["on-main", "waiting", "browsers-ready"]]);
  assert.match(r.observations.find((o) => o.kind === "waiting")!.detail, /weekly move isn't due/);
  w.ages["browser-unstable"] = 8 * DAY;
  r = await resolve(["browser-unstable"]);
  assert.equal(r.changed[0]?.to, rev("a"), "at the floor, the channel's revision even with the same Chromium");
});

test("browser pins: the stable pin follows a new release once it's out of beta", async () => {
  pin("browser-stable", rev("s"), "nixos-26.05", "157.0.9");
  let r = await resolve(["browser-stable"]);
  assert.deepEqual(kinds(r, "browser-stable"), ["on-main", "pass", "browsers-ready"], "26.11 not out yet");
  w.released.add("nixos-26.11");
  w.revs["nixos-26.11"] = rev("n");
  w.chromium[rev("n")] = "157.0.9";
  r = await resolve(["browser-stable"]);
  const p: any = r.pins.get("browser-stable");
  assert.deepEqual([p?.channel, p?.rev], ["nixos-26.11", rev("n")], "a new channel moves even with the same Chromium");
  // With no pin yet, it starts from FIRST_STABLE and walks forward.
  rmSync(join(dir, "browser-stable.json"));
  r = await resolve(["browser-stable"]);
  assert.equal((r.pins.get("browser-stable") as any)?.channel, "nixos-26.11");
});

test("browser pins: an evaluation failure is resolve-failed for that pin only", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  delete w.chromium[rev("a")];
  const r = await resolve();
  assert.deepEqual(kinds(r, "browser-unstable"), ["on-main", "resolve-failed"]);
  assert.match(r.observations.find((o) => o.kind === "resolve-failed")!.detail, /ungoogled-chromium' missing/);
  assert.equal(r.changed.find((c) => c.name === "browser-stable")?.to, rev("s"), "the other pin carries on");
});

test("browser pins: a held Chromium version isn't proposed again on the next move, but on a retry and at the floor", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  w.chromium[rev("b")] = "158.0.1"; // the held revision had the same Chromium
  const held = [["browser-unstable", rev("b")]];
  let r = await resolve(["browser-unstable"], held);
  assert.deepEqual(r.changed, []);
  assert.match(r.observations.find((o) => o.kind === "waiting")!.detail, /Chromium 158\.0\.1 is held/);
  r = await resolve(["browser-unstable"], held, true);
  assert.equal(r.changed[0]?.to, rev("a"), "a retry tries it");
  w.ages["browser-unstable"] = 8 * DAY;
  r = await resolve(["browser-unstable"], held);
  assert.equal(r.changed[0]?.to, rev("a"), "so does the floor");
  // A different Chromium than the held one is proposed as usual.
  w.ages["browser-unstable"] = 2 * DAY;
  w.chromium[rev("b")] = "158.0.0";
  r = await resolve(["browser-unstable"], held);
  assert.equal(r.changed[0]?.to, rev("a"));
});

test("browser pins: the held revision itself stays out unless it's a retry (the updater's usual rule)", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  w.ages["browser-unstable"] = 8 * DAY;
  const r = await resolve(["browser-unstable"], [["browser-unstable", rev("a")]]);
  assert.deepEqual([r.changed, kinds(r, "browser-unstable")], [[], ["on-main", "held"]], "a held move ends no wait");
});

test("NixOS releases: next, previous, the newest by date, and released means no beta", () => {
  assert.deepEqual([nextRelease("nixos-26.05"), nextRelease("nixos-26.11"), previousRelease("nixos-27.05"), previousRelease("nixos-26.11")],
    ["nixos-26.11", "nixos-27.05", "nixos-26.11", "nixos-26.05"]);
  assert.throws(() => nextRelease("nixos-unstable"), /not a NixOS release channel/);
  assert.deepEqual([latestRelease(new Date("2026-04-30T00:00:00Z")), latestRelease(new Date("2026-05-01T00:00:00Z")), latestRelease(new Date("2026-11-14T00:00:00Z"))],
    ["nixos-25.11", "nixos-26.05", "nixos-26.11"]);
  assert.equal(isReleased(302, "https://releases.nixos.org/nixos/26.05/nixos-26.05.14234.f1e5c356f35d"), true);
  assert.equal(isReleased(302, "https://releases.nixos.org/nixos/26.11-beta/nixos-26.11beta123.abcdef"), false);
  assert.equal(isReleased(404, null), false);
});

test("browser pins: a held Chromium on a moved channel reports held, so a quiet run retries it for real", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  w.chromium[rev("b")] = "158.0.1";
  const first = await resolve(["browser-unstable"], [["browser-unstable", rev("b")]]);
  assert.deepEqual([...retryNames(first, false)], ["browser-unstable"], "the updater's own retry selection picks it");
  assert.deepEqual([...retryNames(first, true)], [], "never beside something new");
});

test("browser pins: a released next stable channel whose Chromium isn't cached waits on the old channel", async () => {
  pin("browser-stable", rev("s"), "nixos-26.05", "157.0.9");
  w.released.add("nixos-26.11");
  w.revs["nixos-26.11"] = rev("n");
  w.chromium[rev("n")] = "158.0.1";
  w.cached[out(rev("n"), "x86")] = "missing";
  const r = await resolve(["browser-stable"]);
  assert.deepEqual([r.changed, kinds(r, "browser-stable")], [[], ["on-main", "waiting", "browsers-ready"]]);
});

// The optional browsers (chromium, google-chrome): only ungoogled gates.
const obsOf = (r: Report, kind: string) => r.observations.find((o) => o.kind === kind);

test("browser pins: a move records all three browsers, with Chrome's .deb per system", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  w.optional[rev("a")] = { chromium: "158.0.2", "google-chrome": "158.0.3" };
  const r = await resolve(["browser-unstable"]);
  const p: any = r.pins.get("browser-unstable");
  assert.deepEqual([p.chromium, p.browsers.chromium.version, p.browsers["google-chrome"].version], ["158.0.1", "158.0.2", "158.0.3"]);
  assert.deepEqual(p.browsers["google-chrome"].assets["aarch64-linux"], { url: debUrl(rev("a"), "arm"), hash: "sha256-deb" });
  assert.equal(p.browsers.chromium.outPaths["x86_64-linux"], optOut(rev("a"), "chromium", "x86"));
  assert.ok(!p.browsers.chromium.unavailable && !p.browsers["google-chrome"].unavailable);
});

test("browser pins: a version change in only chromium, or only google-chrome, moves the pin", async () => {
  for (const b of bp.OPTIONAL) {
    pin("browser-unstable", rev("0"), "nixos-unstable", "158.0.1");
    w.optional[rev("a")] = { [b]: "158.0.9" };
    const r = await resolve(["browser-unstable"]);
    assert.equal(r.changed[0]?.to, rev("a"), b);
  }
});

test("browser pins: an optional browser not available holds the move, at most 3 days, then it moves without it", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  w.debs[debUrl(rev("a"), "x86")] = "missing";
  let r = await resolve(["browser-unstable"]);
  assert.deepEqual([r.changed, kinds(r, "browser-unstable")], [[], ["on-main", "browser-waiting", "waiting"]]);
  assert.match(obsOf(r, "browser-waiting")!.detail, /google-chrome on x86_64-linux: its download answers 404/);
  // Two days into the wait: still waiting.
  r = await resolve(["browser-unstable"], [], false, { "browser-unstable": new Date(NOW.getTime() - 2 * DAY).toISOString() });
  assert.deepEqual(r.changed, []);
  // Past three days: it moves, Chrome marked unavailable on that system only,
  // and the wait stays an open problem until the pin has moved.
  r = await resolve(["browser-unstable"], [], false, { "browser-unstable": new Date(NOW.getTime() - 4 * DAY).toISOString() });
  assert.equal(r.changed[0]?.to, rev("a"));
  const p: any = r.pins.get("browser-unstable");
  assert.deepEqual(p.browsers["google-chrome"].unavailable, { "x86_64-linux": "its download answers 404 (not at Google)" });
  assert.equal(p.browsers.chromium.unavailable, undefined);
  assert.deepEqual(kinds(r, "browser-unstable"), ["on-main", "browser-waiting"]);
  assert.match(obsOf(r, "browser-waiting")!.detail, /3-day wait is over/);
});

test("browser pins: a missing Chromium build, an unanswered .deb and a Chrome that won't evaluate each wait; none is resolve-failed or bump-waiting", async () => {
  const cases: [string, () => void, RegExp][] = [
    ["narinfo", () => { w.cached[optOut(rev("a"), "chromium", "arm")] = "missing"; }, /chromium on aarch64-linux: not on cache\.nixos\.org yet/],
    ["deb error", () => { w.debs[debUrl(rev("a"), "arm")] = "unknown"; }, /google-chrome on aarch64-linux: couldn't check its download \(HTTP 503\)/],
    ["eval", () => { w.optional[rev("a")] = { "google-chrome": null }; }, /google-chrome on x86_64-linux: google-chrome didn't evaluate/],
  ];
  for (const [what, set, why] of cases) {
    w.cached = {}; w.debs = {}; w.optional = {};
    pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
    w.ages["browser-unstable"] = 15 * DAY;
    set();
    const r = await resolve(["browser-unstable"]);
    assert.deepEqual([r.changed, kinds(r, "browser-unstable")], [[], ["on-main", "browser-waiting", "waiting"]], what);
    assert.match(obsOf(r, "browser-waiting")!.detail, why, what);
  }
  // Past the wait, a Chrome that didn't evaluate is recorded without a version.
  const r = await resolve(["browser-unstable"], [], false, { "browser-unstable": new Date(NOW.getTime() - 4 * DAY).toISOString() });
  const p: any = r.pins.get("browser-unstable");
  assert.equal(p.browsers["google-chrome"].version, null);
  assert.deepEqual(Object.keys(p.browsers["google-chrome"].unavailable).sort(), ["aarch64-linux", "x86_64-linux"]);
});

test("browser pins: optional versions that differ by system are an error for that browser only", () => {
  const e = bp.optionalOf({
    "x86_64-linux": { chromium: { version: "1", out: "/a" }, "google-chrome": { version: "2", out: "/g" }, deb: { url: "u", hash: "sha256-x" } },
    "aarch64-linux": { chromium: { version: "1b", out: "/b" }, "google-chrome": { version: "2", out: "/h" }, deb: { url: "v", hash: "sha256-y" } },
  });
  assert.match((e.chromium as any).error, /versions differ by system: 1, 1b/);
  assert.equal((e["google-chrome"] as any).version, "2");
});

test("browser pins: ungoogled not cached waits as today, whatever the others; that isn't a browser wait", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  w.cached[out(rev("a"), "x86")] = "missing";
  w.debs[debUrl(rev("a"), "x86")] = "missing";
  const r = await resolve(["browser-unstable"]);
  assert.deepEqual(kinds(r, "browser-unstable"), ["on-main", "waiting", "browsers-ready"]);
});

test("browser pins: a pin from before `browsers`, at the channel's revision, gets them as a details-only change", async () => {
  pin("browser-unstable", rev("a"), "nixos-unstable", "158.0.1", false);
  const r = await resolve(["browser-unstable"]);
  assert.deepEqual(r.changed, [{ name: "browser-unstable", from: rev("a"), to: rev("a"), why: "details only" }]);
  const p: any = r.pins.get("browser-unstable");
  assert.equal(p.browsers["google-chrome"].version, "158.0.1");
  assert.equal(p.narHash, "sha256-x", "the pin's own revision and hash");
});

test("browser pins: an unavailable browser at main's revision comes back as a details-only change; still missing is a pass", async () => {
  pin("browser-unstable", rev("a"), "nixos-unstable", "158.0.1",
    entries("158.0.1", { "google-chrome": { unavailable: { "x86_64-linux": "its download answers 404 (not at Google)" } } }));
  w.debs[debUrl(rev("a"), "x86")] = "missing";
  let r = await resolve(["browser-unstable"]);
  assert.deepEqual([r.changed, kinds(r, "browser-unstable")], [[], ["on-main", "pass", "browsers-ready"]]);
  w.debs = {};
  r = await resolve(["browser-unstable"]);
  assert.equal(r.changed[0]?.why, "details only");
  assert.equal((r.pins.get("browser-unstable") as any).browsers["google-chrome"].unavailable, undefined);
});

test("browser pins: a Chrome-only move waits while ungoogled's version is held, and goes on a retry", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "158.0.1");
  w.chromium[rev("b")] = "158.0.1";
  w.optional[rev("a")] = { "google-chrome": "158.0.7" };
  const held = [["browser-unstable", rev("b")]];
  let r = await resolve(["browser-unstable"], held);
  assert.deepEqual(r.changed, []);
  assert.match(obsOf(r, "waiting")!.detail, /is held/);
  r = await resolve(["browser-unstable"], held, true);
  assert.equal(r.changed[0]?.to, rev("a"));
});

test("browser pins: the optional browsers' evaluation failing outright doesn't stop ungoogled's move", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  bp.io.evaluateOptional = async () => { throw new Error("error: attribute 'google-chrome' missing"); };
  let r = await resolve(["browser-unstable"]);
  assert.deepEqual(kinds(r, "browser-unstable"), ["on-main", "browser-waiting", "waiting"]);
  assert.match(obsOf(r, "browser-waiting")!.detail, /couldn't evaluate: error: attribute 'google-chrome' missing/);
  r = await resolve(["browser-unstable"], [], false, { "browser-unstable": new Date(NOW.getTime() - 4 * DAY).toISOString() });
  assert.equal(r.changed[0]?.to, rev("a"), "then it moves without them");
});

test("browser pins: main's unavailable browser comes back even after the channel moved on, one system at a time", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "158.0.1",
    entries("158.0.1", { chromium: { unavailable: { "x86_64-linux": "not on cache.nixos.org yet", "aarch64-linux": "not on cache.nixos.org yet" } } }));
  w.chromium[rev("0")] = "158.0.1";
  // The channel is at rev a with the same browsers: no move is due.
  w.cached[optOut(rev("0"), "chromium", "arm")] = "missing";
  let r = await resolve(["browser-unstable"]);
  assert.equal(r.changed[0]?.why, "details only", "x86_64 is back");
  assert.equal(r.changed[0]?.to, rev("0"), "at main's own revision");
  const p: any = r.pins.get("browser-unstable");
  assert.deepEqual(p.browsers.chromium.unavailable, { "aarch64-linux": "not on cache.nixos.org yet" }, "aarch64 still marked");
  assert.equal(p.browsers.chromium.outPaths["x86_64-linux"], optOut(rev("0"), "chromium", "x86"));
  // Nothing back: nothing changes.
  pin("browser-unstable", rev("0"), "nixos-unstable", "158.0.1", p.browsers);
  r = await resolve(["browser-unstable"]);
  assert.deepEqual(r.changed, []);
});

test("browser pins: an open wait isn't ended by an optional browser that won't evaluate on the next revision", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "158.0.1");
  // Chrome-only change, its .deb missing: the wait starts.
  w.optional[rev("a")] = { "google-chrome": "158.0.7" };
  w.debs[debUrl(rev("a"), "x86")] = "missing";
  let r = await resolve(["browser-unstable"]);
  assert.ok(kinds(r, "browser-unstable").includes("browser-waiting"));
  // Next revision: Chrome doesn't evaluate; ungoogled the same and cached.
  w.revs["nixos-unstable"] = rev("b");
  w.chromium[rev("b")] = "158.0.1";
  w.optional[rev("b")] = { "google-chrome": null };
  const since = new Date(NOW.getTime() - DAY).toISOString();
  r = await resolve(["browser-unstable"], [], false, { "browser-unstable": since });
  assert.deepEqual(kinds(r, "browser-unstable"), ["on-main", "browser-waiting", "waiting"], "still waiting, so the clock is kept");
  // Without an open wait, the same revision is simply not due.
  r = await resolve(["browser-unstable"]);
  assert.ok(kinds(r, "browser-unstable").includes("browsers-ready"));
});

test("browser pins: one pin's move doesn't stop the other pin's recovery (they share a report)", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  pin("browser-stable", rev("s"), "nixos-26.05", "157.0.9",
    entries("157.0.9", { "google-chrome": { unavailable: { "x86_64-linux": "its download answers 404 (not at Google)" } } }));
  const r = await resolve();
  assert.deepEqual(r.changed.map((c) => [c.name, c.why]).sort(), [["browser-stable", "details only"], ["browser-unstable", "new version"]]);
});

test("browser pins: a wait ends only once the pin has moved on main, not when a move is proposed", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  const waits = { "browser-unstable": new Date(NOW.getTime() - 2 * DAY).toISOString() };
  // Chrome is available again: the move is proposed, and the wait stays open.
  let r = await resolve(["browser-unstable"], [], false, waits);
  assert.equal(r.changed[0]?.to, rev("a"));
  assert.ok(!kinds(r, "browser-unstable").includes("browsers-ready"));
  // The candidate failed and is held: still no end to the wait.
  r = await resolve(["browser-unstable"], [["browser-unstable", rev("a")]], false, waits);
  assert.deepEqual([r.changed, kinds(r, "browser-unstable").includes("browsers-ready")], [[], false]);
  // Published: main is at the channel's revision, and the wait ends.
  pin("browser-unstable", rev("a"), "nixos-unstable", "158.0.1");
  r = await resolve(["browser-unstable"], [], false, waits);
  assert.deepEqual(kinds(r, "browser-unstable"), ["on-main", "pass", "browsers-ready"]);
});

test("browser pins: a wait from before main last moved is over; the next move waits afresh", async () => {
  // main moved to rev 0 after an earlier wait (started at rev 9), and the
  // channel is already at rev a with Chrome missing.
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  w.debs[debUrl(rev("a"), "x86")] = "missing";
  const old = { since: new Date(NOW.getTime() - 4 * DAY).toISOString(), from: rev("9") };
  let r = await resolve(["browser-unstable"], [], false, { "browser-unstable": old });
  assert.deepEqual(r.changed, [], "not moved at once on the old clock");
  const waiting = obsOf(r, "browser-waiting")!;
  assert.equal(waiting.version, rev("0"), "the new wait is about main's current revision");
  // Nothing about the browsers changed, and the old wait doesn't make a move due.
  w.debs = {};
  pin("browser-unstable", rev("0"), "nixos-unstable", "158.0.1");
  r = await resolve(["browser-unstable"], [], false, { "browser-unstable": old });
  assert.deepEqual(r.changed, []);
  assert.match(obsOf(r, "waiting")!.detail, /weekly move isn't due/);
});

test("browser pins: each optional browser is evaluated on its own: an uncatchable Chrome error doesn't take Chromium with it", async () => {
  pin("browser-unstable", rev("0"), "nixos-unstable", "157.0.9");
  const fake = bp.io.evaluateOptional;
  const asked: string[][] = [];
  bp.io.evaluateOptional = async (r, h, only = bp.OPTIONAL) => {
    asked.push([...only]);
    if (only.includes("google-chrome")) throw new Error("error: attribute 'src' missing");
    return fake(r, h, only);
  };
  const r = await resolve(["browser-unstable"], [], false, { "browser-unstable": new Date(NOW.getTime() - 4 * DAY).toISOString() });
  assert.deepEqual(asked.map((a) => a.join()).sort(), ["chromium", "google-chrome"], "one evaluation per browser");
  const p: any = r.pins.get("browser-unstable");
  assert.equal(p.browsers.chromium.version, "158.0.1");
  assert.equal(p.browsers.chromium.unavailable, undefined, "Chromium stays available");
  assert.match(p.browsers["google-chrome"].unavailable["x86_64-linux"], /couldn't evaluate: error: attribute 'src' missing/);
});
