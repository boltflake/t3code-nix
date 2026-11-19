// The status page's delivery history (scripts/status.ts stays(),
// medianDelivery()), against scratch git repositories.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { badge, build, dataId, decide, digest, medianDelivery, rows, stays } from "../scripts/status.ts";

Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
let tmp: string;
const cwd = process.cwd();
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "status-history-"));
  execFileSync("git", ["init", "-q", "-b", "main", tmp]);
  mkdirSync(join(tmp, "versions", "stable"), { recursive: true });
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

const env = (at: string) => ({ ...process.env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const g = (args: string[], at = "2026-11-01T00:00:00Z") => execFileSync("git", args, { env: env(at), encoding: "utf8" });
/** Write pins (by file name; the pin's name is the file's unless given). */
function put(pins: Record<string, object>, dir = "versions") {
  for (const [file, p] of Object.entries(pins)) writeFileSync(join(tmp, dir, `${file}.json`), JSON.stringify({ name: file, assets: {}, ...p }));
}
function commit(at: string, pins: Record<string, object> = {}, dir = "versions") {
  put(pins, dir);
  g(["add", "-A"], at);
  g(["commit", "-q", "--allow-empty", "-m", at], at);
}
const exact = (at: string) => ({ at, kind: "published" });
const seen = (at: string) => ({ at, kind: "seen" });
const of = (name: string) => stays().get(name)!.map((s) => [s.pin.version, s.counted, s.published.at.slice(0, 16)]);

test("history: stays, re-pins, returns, older versions and a pulled release", () => {
  commit("2026-11-01T00:00:00Z", { x: { version: "1.0" } });
  commit("2026-11-02T00:00:00Z", { x: { version: "1.0", tag: "v1.0" } }); // same version, new details
  commit("2026-11-03T00:00:00Z", { x: { version: "2.0" } });
  commit("2026-11-04T00:00:00Z", { x: { version: "1.0" } }); // 2.0 pulled: back to 1.0
  commit("2026-11-05T00:00:00Z", { x: { version: "0.9" } }); // older, never had
  commit("2026-11-06T00:00:00Z", { x: { version: "2.1" } });
  assert.deepEqual(of("x"), [
    ["1.0", "added", "2026-11-01T00:00"],
    ["2.0", true, "2026-11-03T00:00"],
    ["1.0", "returned", "2026-11-04T00:00"],
    ["0.9", "older", "2026-11-05T00:00"],
    ["2.1", true, "2026-11-06T00:00"],
  ]);
  // The pulled 2.0 keeps its delivery; history is newest first.
  const [row] = rows();
  assert.deepEqual(row.history.map((h) => h.version), ["2.1", "2.0"]);
  assert.equal(row.counted, true);
  assert.equal(row.published!.at, "2026-11-06T00:00:00.000Z");
});

test("history: a return is spotted however far back the earlier stay is", () => {
  commit("2026-01-01T00:00:00Z", { x: { version: "1.0.0" } });
  for (let i = 1; i <= 12; i++) commit(`2026-03-${String(i).padStart(2, "0")}T00:00:00Z`, { x: { version: `1.0.${i}` } });
  commit("2026-06-01T00:00:00Z", { x: { version: "1.0.0" } });
  const list = stays().get("x")!;
  assert.equal(list.at(-1)!.counted, "returned");
  // The strip keeps the 10 latest deliveries.
  assert.deepEqual(rows()[0].history.map((h) => h.version), Array.from({ length: 10 }, (_, i) => `1.0.${12 - i}`));
});

test("history: a merged branch's own commits are not deliveries; the merge counts at its time", () => {
  commit("2026-11-01T00:00:00Z", { x: { version: "1" } });
  g(["checkout", "-q", "-b", "side"]);
  commit("2026-11-02T00:00:00Z", { x: { version: "2-rc" } });
  commit("2026-11-03T00:00:00Z", { x: { version: "2" } });
  g(["checkout", "-q", "main"]);
  commit("2026-11-04T00:00:00Z", { other: { version: "1" } });
  g(["merge", "-q", "--no-ff", "side", "-m", "merge"], "2026-11-05T00:00:00Z");
  assert.deepEqual(of("x"), [["1", "added", "2026-11-01T00:00"], ["2", true, "2026-11-05T00:00"]]);
});

test("history: the order is the history's, whatever the commit dates say", () => {
  commit("2026-11-05T00:00:00Z", { x: { version: "1" } });
  commit("2026-11-01T00:00:00Z", { x: { version: "2" } }); // a clock behind
  commit("2026-11-03T00:00:00Z", { x: { version: "3" } });
  assert.deepEqual(of("x").map(([v, c]) => [v, c]), [["1", "added"], ["2", true], ["3", true]]);
});

test("history: delete and re-add, a renamed file and a renamed pin", () => {
  commit("2026-11-01T00:00:00Z", { x: { version: "1" }, y: { version: "1" }, z: { version: "1" } });
  rmSync(join(tmp, "versions", "x.json"));
  commit("2026-11-02T00:00:00Z");
  commit("2026-11-03T00:00:00Z", { x: { version: "2" } });
  // y's file renamed, its name kept: it carries on.
  // (to a path that sorts after the old one, so a leftover old entry would win)
  renameSync(join(tmp, "versions", "y.json"), join(tmp, "versions", "zz-y.json"));
  commit("2026-11-04T00:00:00Z");
  commit("2026-11-05T00:00:00Z", { "zz-y": { name: "y", version: "2" } });
  // z renamed as a pin: a new package.
  rmSync(join(tmp, "versions", "z.json"));
  commit("2026-11-06T00:00:00Z", { zz: { version: "1" } });
  assert.deepEqual(of("x").map(([v, c]) => [v, c]), [["1", "added"], ["2", "re-added"]]);
  assert.deepEqual(of("y").map(([v, c]) => [v, c]), [["1", "added"], ["2", true]]);
  assert.deepEqual(of("zz").map(([v, c]) => [v, c]), [["1", "added"]]);
  // The same with git's rename detection on (it's off in the walk anyway).
  g(["config", "diff.renames", "true"]);
  g(["config", "log.showRoot", "false"]);
  assert.deepEqual(of("y").map(([v, c]) => [v, c]), [["1", "added"], ["2", true]]);
  assert.deepEqual(of("x").map(([v, c]) => [v, c]), [["1", "added"], ["2", "re-added"]], "the root's files still count with log.showRoot off");
});

test("history: NixOS stable's copies are never main's", () => {
  commit("2026-11-01T00:00:00Z", { x: { version: "1" } });
  commit("2026-11-02T00:00:00Z", { x: { version: "9" } }, "versions/stable"); // only the snapshot
  put({ x: { version: "8" } }, "versions/stable");
  commit("2026-11-03T00:00:00Z", { x: { version: "2" } }); // both
  assert.deepEqual(of("x").map(([v, c]) => [v, c]), [["1", "added"], ["2", true]]);
});

test("history: release times, exact and approximate, and a release after the publish", () => {
  commit("2026-11-01T00:00:00Z", { a: { version: "1" }, b: { version: "1" }, c: { version: "1" } });
  commit("2026-11-02T01:00:00Z", {
    a: { version: "2", released: exact("2026-11-02T00:50:00Z") },
    b: { version: "2", released: { at: "2026-11-02T00:00:00Z", kind: "uploaded" } },
    c: { version: "2", released: exact("2026-11-02T02:00:00Z") }, // after the publish
  });
  const all = stays();
  const now = (n: string) => all.get(n)!.at(-1)!;
  assert.deepEqual([now("a").gap, now("a").released?.kind], [600, "published"]);
  assert.deepEqual([now("b").gap, now("b").released?.kind], [3600, "uploaded"]);
  assert.deepEqual([now("c").gap, now("c").released], [null, null]);
});

test("history: a browser pin's weekly move with no new browser isn't a delivery", () => {
  const browser = (rev: string, chromium: string, at: string, chrome = chromium, unavailable?: object) => ({
    version: rev, rev, channel: "nixos-unstable", chromium, released: seen(at),
    browsers: { chromium: { version: chromium }, "google-chrome": { version: chrome, ...(unavailable ? { unavailable } : {}) } },
  });
  commit("2026-11-01T00:00:00Z", { "browser-unstable": browser("a".repeat(40), "150.0", "2026-11-01T00:00:00Z") });
  commit("2026-11-02T00:00:00Z", { "browser-unstable": browser("b".repeat(40), "151.0", "2026-11-01T23:00:00Z") });
  commit("2026-11-09T00:00:00Z", { "browser-unstable": browser("c".repeat(40), "151.0", "2026-11-08T23:00:00Z") }); // weekly, same browsers
  commit("2026-11-10T00:00:00Z", { "browser-unstable": browser("d".repeat(40), "151.0", "2026-11-09T23:00:00Z", "151.0", { "aarch64-linux": "404" }) });
  const list = stays().get("browser-unstable")!;
  assert.deepEqual(list.map((s) => s.counted), ["added", true], "neither the weekly move nor a change in availability is a delivery");
  // The merged stay keeps the release time of the move that brought 151.
  assert.deepEqual([list[1].gap, list[1].pin.version], [3600, "d".repeat(40)]);
  // And status.json describes it by that first move: later weekly moves and
  // availability notes don't change it (or the page's id).
  const [h] = rows()[0].history;
  assert.equal(h.version, "b".repeat(40));
  assert.ok(!h.shown.includes("unavailable"), h.shown);
  commit("2026-11-11T00:00:00Z", { "browser-unstable": browser("e".repeat(40), "152.0", "2026-11-10T23:00:00Z") });
  assert.equal(stays().get("browser-unstable")!.at(-1)!.counted, true);
});

test("median: per release, nightlies in, the window, and fewer than five", () => {
  const rel = (v: string, at: string) => ({ version: v, released: exact(at) });
  commit("2026-10-01T00:00:00Z", { codex: { version: "0" }, t3code: { version: "0" }, t3: { version: "0" }, "t3code-nightly": { version: "0" }, "t3-nightly": { version: "0" } });
  // Outside the window (more than 30 days before the newest stay start).
  commit("2026-10-10T00:00:00Z", { codex: rel("1", "2026-10-09T00:00:00Z") });
  // Desktop and CLI at one version: one release, at the earlier publish (5 min).
  commit("2026-11-20T00:05:00Z", { t3code: rel("1", "2026-11-20T00:00:00Z") });
  commit("2026-11-20T00:20:00Z", { t3: rel("1", "2026-11-20T00:00:00Z") });
  // A nightly pair where only the CLI has an exact time: 10 min from the
  // desktop app's earlier publish.
  commit("2026-11-21T00:10:00Z", { "t3code-nightly": { version: "1", released: seen("2026-11-21T00:09:00Z") } });
  commit("2026-11-21T00:15:00Z", { "t3-nightly": rel("1", "2026-11-21T00:00:00Z") });
  // A pair whose delivery would be negative: left out.
  commit("2026-11-22T00:00:00Z", { "t3code-nightly": { version: "2", released: seen("2026-11-21T23:00:00Z") } });
  commit("2026-11-22T01:00:00Z", { "t3-nightly": rel("2", "2026-11-22T00:30:00Z") });
  // Approximate only: left out.
  commit("2026-11-23T00:00:00Z", { codex: { version: "2", released: seen("2026-11-22T00:00:00Z") } });
  assert.equal(medianDelivery(stays()), null, "two releases: no figure");
  commit("2026-11-24T00:30:00Z", { codex: rel("3", "2026-11-24T00:00:00Z") }); // 30 min
  commit("2026-11-25T01:00:00Z", { codex: rel("4", "2026-11-25T00:00:00Z") }); // 60 min
  assert.equal(medianDelivery(stays()), null, "four releases");
  commit("2026-11-26T02:00:00Z", { codex: rel("5", "2026-11-26T00:00:00Z") }); // 120 min
  const m = medianDelivery(stays())!;
  // 5, 10, 30, 60, 120 min: the middle one.
  assert.deepEqual(m, { median: 1800, count: 5, since: "2026-10-27T02:00:00.000Z", until: "2026-11-26T02:00:00.000Z" });
  commit("2026-11-27T02:00:00Z", { codex: rel("6", "2026-11-27T00:00:00Z") }); // 120 min: even count, mean of 30 and 60
  assert.equal(medianDelivery(stays())!.median, 2700);
  // A commit that isn't a version change doesn't move the window.
  commit("2026-12-31T00:00:00Z", { codex: { ...rel("6", "2026-11-27T00:00:00Z"), tag: "v6" } });
  assert.equal(medianDelivery(stays())!.until, "2026-11-27T02:00:00.000Z");
});

test("median: a release straddling the window counts by its earlier publish", () => {
  const rel = (v: string, at: string) => ({ version: v, released: exact(at) });
  commit("2026-10-01T00:00:00Z", { t3code: { version: "0" }, t3: { version: "0" }, codex: { version: "0" } });
  commit("2026-10-02T00:00:00Z", { t3code: rel("1", "2026-10-01T23:00:00Z") }); // just outside
  for (let d = 0; d < 5; d++) commit(`2026-11-0${d + 1}T00:10:00Z`, { codex: rel(`${d + 1}`, `2026-11-0${d + 1}T00:00:00Z`) });
  commit("2026-11-01T00:10:00Z", { t3: rel("1", "2026-10-01T23:00:00Z") }); // inside, but the release's publish is the earlier one
  commit("2026-11-01T00:20:00Z", { codex: rel("6", "2026-11-01T00:00:00Z") });
  const m = medianDelivery(stays())!;
  assert.equal(m.until, "2026-11-05T00:10:00.000Z");
  assert.equal(m.since, "2026-10-06T00:10:00.000Z");
  assert.equal(m.count, 6, "five codex releases and one more; the T3 Code release is out");
  // The window's start is inclusive.
  assert.ok(Date.parse("2026-10-02T00:00:00Z") < Date.parse(m.since));
});

test("status.json: history, counted and delivery; the id ignores only the check time", () => {
  commit("2026-11-01T00:00:00Z", { a: { version: "1" } });
  commit("2026-11-02T00:00:00Z", { a: { version: "2", released: exact("2026-11-01T23:00:00Z") } });
  const out = join(tmp, "site");
  const health = (written: string) => ({ keys: { "state:a": { written, entries: { a: { version: "2" } }, sources: {} } } });
  const at = (iso: string) => new Date(iso);
  const one = build(out, "HEAD", "o/r", { health: health("2026-11-02T00:10:00Z"), runs: [], issues: [] }, at("2026-11-02T00:20:00Z"));
  const s1 = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
  assert.deepEqual(s1.packages[0].history, [{ version: "2", shown: "2", published: { at: "2026-11-02T00:00:00.000Z", commit: s1.packages[0].published.commit }, released: exact("2026-11-01T23:00:00Z"), gap: 3600 }]);
  assert.equal(s1.packages[0].counted, true);
  assert.equal(s1.delivery, null);
  // A rebuild that only moves the check time: the same id, a new digest.
  const two = build(out, "HEAD", "o/r", { health: health("2026-11-02T00:25:00Z"), runs: [], issues: [] }, at("2026-11-02T00:30:00Z"));
  const s2 = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
  assert.equal(s2.id, s1.id);
  assert.notEqual(two.digest, one.digest);
  // Only history changing (an old delivery's release time corrected): a new id.
  commit("2026-11-03T00:00:00Z", { a: { version: "2", released: exact("2026-11-01T22:00:00Z") } });
  build(out, "HEAD", "o/r", { health: health("2026-11-02T00:25:00Z"), runs: [], issues: [] }, at("2026-11-02T00:30:00Z"));
  const s3 = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
  assert.notEqual(s3.id, s2.id);
  assert.notEqual(s3.digest, s2.digest);
  assert.equal(s3.packages[0].history[0].gap, 7200);
});

test("decide: a failed live read deploys only when git-derived data changed", () => {
  const packages = [{ name: "a", history: [] }] as any;
  const site = { digest: "e", packages, delivery: null };
  assert.deepEqual(decide({ digest: "d", packages, delivery: null }, site, true), { deploy: false, fail: true });
  assert.deepEqual(decide({ digest: "d", packages: [{ name: "a", history: [{ version: "2" }] }] as any, delivery: null }, site, true), { deploy: true, fail: false }, "a new delivery");
  assert.deepEqual(decide({ digest: "d", packages, delivery: { median: 1 } }, site, true), { deploy: true, fail: false }, "only the median");
});

test("badges: grey when the version shown isn't a delivery", () => {
  commit("2026-11-01T00:00:00Z", { a: { version: "1", released: exact("2026-10-31T23:50:00Z") } });
  assert.deepEqual([rows()[0].counted, badge(rows()[0]).color], ["added", "lightgrey"]);
  commit("2026-11-02T00:00:00Z", { a: { version: "2", released: exact("2026-11-01T23:50:00Z") } });
  assert.equal(badge(rows()[0]).color, "brightgreen");
  commit("2026-11-03T00:00:00Z", { a: { version: "1", released: exact("2026-10-31T23:50:00Z") } });
  assert.deepEqual([rows()[0].counted, badge(rows()[0]).color], ["returned", "lightgrey"]);
});

test("history: two files with one name, and an odd file name, don't invent stays", () => {
  commit("2026-11-01T00:00:00Z", { a: { name: "x", version: "1" }, b: { name: "x", version: "1" } });
  rmSync(join(tmp, "versions", "b.json"));
  commit("2026-11-02T00:00:00Z");
  commit("2026-11-03T00:00:00Z", { a: { name: "x", version: "1", tag: "t" } });
  assert.deepEqual(of("x").map(([v, c]) => [v, c]), [["1", "added"]], "x never left");
  // A path holding the header marker is read as a path.
  writeFileSync(join(tmp, "versions", "odd\x01name.json"), JSON.stringify({ name: "odd", version: "1", assets: {} }));
  commit("2026-11-04T00:00:00Z");
  assert.deepEqual(of("odd").map(([v, c]) => [v, c]), [["1", "added"]]);
});

test("history: a browser pin moving to a new channel with the same browsers isn't a delivery", () => {
  const browser = (rev: string, channel: string, chromium: string) => ({ version: rev, rev, channel, chromium, browsers: { chromium: { version: chromium }, "google-chrome": { version: chromium } } });
  commit("2026-11-01T00:00:00Z", { "browser-stable": browser("a".repeat(40), "nixos-26.05", "150.0") });
  commit("2026-11-02T00:00:00Z", { "browser-stable": browser("b".repeat(40), "nixos-26.11", "150.0") });
  assert.deepEqual(stays().get("browser-stable")!.map((s) => s.counted), ["added"]);
});

test("history: the publish time matches the old per-file walk on a linear history", () => {
  // The old rule: walking the file back from HEAD, the oldest commit of the
  // unbroken run of the current version.
  const old = (path: string, version: string) => {
    let found: string | null = null;
    for (const line of g(["log", "--format=%H %cI", "HEAD", "--", path]).trim().split("\n")) {
      const [c, at] = line.split(" ");
      if (JSON.parse(g(["show", `${c}:${path}`])).version !== version) break;
      found = new Date(at).toISOString();
    }
    return found;
  };
  const seq = ["1", "1", "2", "3", "3", "2", "4", "4", "4", "1"];
  seq.forEach((v, i) => commit(`2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`, { x: { version: v, tag: `t${i}` }, y: { version: seq[(i * 3) % seq.length] } }));
  for (const r of rows()) assert.equal(r.published!.at, old(`versions/${r.name}.json`, r.version), r.name);
});

test("median: the window's start is inclusive", () => {
  const rel = (v: string, at: string) => ({ version: v, released: exact(at) });
  commit("2026-09-01T00:00:00Z", { a: { version: "0" }, b: { version: "0" } });
  commit("2026-10-01T00:10:00Z", { a: rel("1", "2026-10-01T00:00:00Z") }); // exactly 30 days before the newest
  for (let d = 1; d <= 4; d++) commit(`2026-10-1${d}T00:10:00Z`, { b: rel(`${d}`, `2026-10-1${d}T00:00:00Z`) });
  commit("2026-10-31T00:10:00Z", { b: rel("5", "2026-10-31T00:00:00Z") });
  const m = medianDelivery(stays())!;
  assert.equal(m.since, "2026-10-01T00:10:00.000Z");
  assert.equal(m.count, 6, "the release exactly at the start counts");
});

test("status.json: the id and digest change with history alone and with the median alone", () => {
  const base = { packages: [{ name: "a", history: [{ version: "2", gap: 60 }] }], live: { checked: "x", states: {} }, stable: null, delivery: null };
  const id = dataId(base);
  assert.notEqual(dataId({ ...base, packages: [{ name: "a", history: [{ version: "2", gap: 120 }] }] }), id, "history alone");
  assert.notEqual(dataId({ ...base, delivery: { median: 1 } }), id, "the median alone");
  assert.equal(dataId({ ...base, live: { checked: "y", states: {} } }), id, "the check time alone: the same id");
  assert.notEqual(dataId({ ...base, live: { checked: "x", states: { a: { state: "found" } } } }), id, "a state");
  const d = digest({ "index.html": "x" }, base);
  assert.notEqual(digest({ "index.html": "x" }, { ...base, delivery: { median: 1 } }), d);
  assert.notEqual(digest({ "index.html": "x" }, { ...base, live: { checked: "y", states: {} } }), d, "the digest covers the check time");
});

test("decide: a metadata correction deploys during a failed live read", () => {
  const row = (released: string) => ({ name: "a", released: { at: released, kind: "published" }, history: [] });
  const site = { digest: "e", packages: [row("2026-11-01T00:00:00Z")], delivery: null };
  assert.deepEqual(decide({ digest: "d", packages: [row("2026-11-01T00:30:00Z")] as any, delivery: null }, site, true), { deploy: true, fail: false });
});

test("badges: grey for a re-added and an older version too", () => {
  commit("2026-11-01T00:00:00Z", { a: { version: "2.0" }, b: { version: "1" } });
  commit("2026-11-02T00:00:00Z", { a: { version: "1.0", released: exact("2026-11-01T23:50:00Z") } });
  rmSync(join(tmp, "versions", "b.json"));
  commit("2026-11-03T00:00:00Z");
  commit("2026-11-04T00:00:00Z", { b: { version: "2", released: exact("2026-11-03T23:50:00Z") } });
  const by = Object.fromEntries(rows().map((r) => [r.name, r]));
  assert.deepEqual([by.a.counted, badge(by.a).color, by.b.counted, badge(by.b).color], ["older", "lightgrey", "re-added", "lightgrey"]);
});

test("median: a pair with no exact time is left out; the newest stay sets the window even when it isn't a delivery", () => {
  const rel = (v: string, at: string) => ({ version: v, released: exact(at) });
  commit("2026-09-01T00:00:00Z", { t3code: { version: "0" }, t3: { version: "0" }, codex: { version: "0" } });
  for (let i = 1; i <= 5; i++) commit(`2026-10-0${i}T00:10:00Z`, { codex: rel(`${i}`, `2026-10-0${i}T00:00:00Z`) });
  commit("2026-10-06T00:00:00Z", { t3code: { version: "1", released: seen("2026-10-05T23:00:00Z") } });
  commit("2026-10-06T00:05:00Z", { t3: { version: "1", released: seen("2026-10-05T23:00:00Z") } });
  assert.equal(medianDelivery(stays())!.count, 5, "the T3 Code pair has no exact time: left out");
  // A return (not a delivery) a month later moves the window: the codex
  // deliveries fall out of it.
  commit("2026-11-20T00:00:00Z", { codex: rel("1", "2026-10-01T00:00:00Z") });
  assert.equal(stays().get("codex")!.at(-1)!.counted, "returned");
  assert.equal(medianDelivery(stays()), null);
});

test("rows: release notes from a GitHub pin", () => {
  commit("2026-11-01T00:00:00Z", { gh: { version: "1.0", tag: "v1.0", assets: { "x86_64-linux": { url: "https://github.com/o/r/releases/download/v1.0/a.tgz", hash: "h" } } } });
  assert.equal(rows()[0].notes, "https://github.com/o/r/releases/tag/v1.0");
});
