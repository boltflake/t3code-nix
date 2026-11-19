// The status page (scripts/status.ts), against a scratch git repository.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { badge, browsersOf, build, dataId, decide, digest, rows, type Row, type StableView } from "../scripts/status.ts";
import { duration, roughly, utc } from "../scripts/status-page.ts";
import { AGENT_TOOLS, BROWSER_PINS, NIXPKGS_PINS, PROVIDERS, T3, UNFREE } from "../scripts/lib/packages.ts";

const ROOT = join(import.meta.dirname, "..");

// Scratch commits never read the machine's git config (signing, hooks).
Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
let tmp: string;
const cwd = process.cwd();
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "status-test-"));
  execFileSync("git", ["init", "-q", "-b", "main", tmp]);
  mkdirSync(join(tmp, "versions"));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

/** Commit pins at a given time. */
function commit(at: string, pins: Record<string, object>) {
  for (const [n, p] of Object.entries(pins)) writeFileSync(join(tmp, "versions", `${n}.json`), JSON.stringify({ name: n, assets: {}, ...p }));
  const env = { ...process.env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["add", "-A"], { env });
  execFileSync("git", ["commit", "-q", "-m", at], { env });
}

test("status: the gap for each kind of release time, and its badge colour", () => {
  const rel = (at: string, kind: string) => ({ version: "1", released: { at, kind } });
  // Each package had an earlier version, so version 1 is a delivery.
  commit("2026-11-01T00:00:00Z", Object.fromEntries("abcdefghijk".split("").map((n) => [n, { version: "0" }])));
  commit("2026-11-13T12:00:00Z", {
    a: rel("2026-11-13T11:30:00Z", "published"), // 30 min: green
    b: rel("2026-11-13T09:00:00Z", "published"), // 3 h: yellow
    c: rel("2026-11-12T12:00:00Z", "published"), // 1 d: red
    d: rel("2026-11-13T11:59:00Z", "seen"), // approximate: blue
    e: rel("2026-11-13T10:00:00Z", "built"), // approximate: blue
    i: rel("2026-11-13T09:00:00Z", "uploaded"), // approximate: blue
    j: rel("2026-11-13T11:00:00Z", "announced"), // not a kind it knows: unknown
    k: rel("2026-11-13T12:00:00.400Z", "published"), // just after the publish: unknown
    f: { version: "1" }, // unknown: grey
    g: rel("2026-11-13T13:00:00Z", "published"), // after the publish: unknown
    h: rel("not a date", "published"),
  });
  const list = rows();
  const by = Object.fromEntries(list.map((r) => [r.name, r]));
  assert.deepEqual(list.map((r) => [r.name, r.gap, badge(r).color]), [
    ["a", 1800, "brightgreen"], ["b", 3 * 3600, "yellow"], ["c", 86400, "red"], ["d", 60, "blue"],
    ["e", 2 * 3600, "blue"], ["f", null, "lightgrey"], ["g", null, "lightgrey"], ["h", null, "lightgrey"],
    ["i", 3 * 3600, "blue"], ["j", null, "lightgrey"], ["k", null, "lightgrey"],
  ]);
  assert.equal(by.j.released, null);
  assert.equal(by.h.released, null);
  assert.equal(by.g.released, null, "a release time after the publish is unknown, not shown");
  assert.deepEqual(badge(by.a), { schemaVersion: 1, label: "a", message: "1", color: "brightgreen" });
});

test("status: the publish time is the latest unbroken run of the version", () => {
  commit("2026-11-01T00:00:00Z", { x: { version: "A" } });
  commit("2026-11-02T00:00:00Z", { x: { version: "A", assets: { s: { url: "u", hash: "h" } } } }); // same version, details
  commit("2026-11-03T00:00:00Z", { x: { version: "B" } });
  commit("2026-11-04T00:00:00Z", { x: { version: "A" } }); // rolled back
  commit("2026-11-05T00:00:00Z", { x: { version: "A", tag: "vA" } });
  const [x] = rows();
  assert.equal(x.published!.at, "2026-11-04T00:00:00.000Z");
  // Without the rollback, the first commit of the run counts.
  rmSync(join(tmp, ".git"), { recursive: true, force: true });
  execFileSync("git", ["init", "-q", "-b", "main", tmp]);
  commit("2026-11-01T00:00:00Z", { x: { version: "A" } });
  commit("2026-11-02T00:00:00Z", { x: { version: "A", tag: "t" } });
  assert.equal(rows()[0].published!.at, "2026-11-01T00:00:00.000Z");
});

test("status: the output is deterministic, and the digest covers every file", () => {
  commit("2026-11-13T12:00:00Z", { a: { version: "1", released: { at: "2026-11-13T11:00:00Z", kind: "published" } } });
  const one = join(tmp, "out1"), two = join(tmp, "out2");
  const d1 = build(one, "HEAD", "o/r").digest;
  const d2 = build(two, "HEAD", "o/r").digest;
  assert.equal(d1, d2);
  for (const f of ["index.html", "status.json", "badges/a.json"]) assert.equal(readFileSync(join(one, f), "utf8"), readFileSync(join(two, f), "utf8"));
  assert.equal(JSON.parse(readFileSync(join(one, "status.json"), "utf8")).digest, d1);
  // Rebuilt in place after a package is gone: its badge goes too.
  rmSync(join(tmp, "versions", "a.json"));
  commit("2026-11-13T13:00:00Z", { b: { version: "1" } });
  build(one, "HEAD", "o/r");
  assert.deepEqual(readdirSync(join(one, "badges")), ["b.json"]);
  // Any change to a file, or to the data, changes it; the encoding can't
  // be read two ways (a name/content split moved).
  const status = { packages: [] as Row[] };
  const base = digest({ "a": "bc" }, status);
  assert.notEqual(digest({ "a": "bd" }, status), base);
  assert.notEqual(digest({ "ab": "c" }, status), base);
  assert.notEqual(digest({ "a": "bc" }, { packages: [{ name: "x" }] }), base);
});

test("status: durations and dates read naturally", () => {
  assert.deepEqual([duration(3570), duration(3599), duration(3600)], ["59 min", "59 min", "1 h"], "under an hour stays in minutes");
  assert.deepEqual([duration(30), duration(600), duration(3 * 3600 + 60 * 5), duration(9 * 3600), duration(3 * 86400 + 3600), duration(2 * 86400)],
    ["30 s", "10 min", "3 h 5 min", "9 h", "3 d 1 h", "2 d"]);
  assert.deepEqual([roughly(20), roughly(1800), roughly(3 * 3600 + 1700), roughly(3 * 86400)], ["1 min", "30 min", "3 h", "3 d"]);
  assert.deepEqual([roughly(3570), roughly(3600), roughly(171000), roughly(48 * 3600)], ["59 min", "1 h", "47 h", "2 d"], "no unit reaches the next");
  assert.equal(utc("2026-11-12T10:17:42Z"), "12 Nov 2026, 10:17 UTC");
  assert.equal(utc("2026-01-05T03:04:00Z"), "5 Jan 2026, 03:04 UTC");
});

test("status page: the README and pkgs/unfree.nix agree with its package list", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const [name, p] of Object.entries({ ...PROVIDERS, ...AGENT_TOOLS })) {
    const row = readme.split("\n").find((l) => l.startsWith(`| \`${name}\` | `));
    assert.ok(row?.startsWith(`| \`${name}\` | ${p.title}: ${p.description}`), `README row for ${name}: ${row}`);
    assert.equal(row!.includes("(unfree)"), UNFREE.has(name), `${name} unfree`);
  }
  // The browser pins aren't packages: named under the table, not rows in it.
  for (const name of Object.keys(BROWSER_PINS)) {
    assert.ok(!readme.split("\n").some((l) => l.startsWith(`| \`${name}\` | `)), `${name} has no package row`);
    assert.ok(readme.includes(`\`${name}\``), `the README names ${name}`);
  }
  const unfree = [...readFileSync(join(ROOT, "pkgs/unfree.nix"), "utf8").matchAll(/^\s*"([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(unfree.filter((n) => n !== "chrome-headless-shell").sort(), [...UNFREE].sort());
  const pins = readdirSync(join(ROOT, "versions")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  assert.deepEqual([...T3.flatMap((p) => p.channels.map(([, n]) => n)), ...Object.keys(PROVIDERS), ...Object.keys(AGENT_TOOLS), ...Object.keys(BROWSER_PINS), ...Object.keys(NIXPKGS_PINS)].sort(), pins,
    "every pin has a name on the page");
});


test("status: status.json carries the live view and the id the page shows", () => {
  commit("2026-11-13T12:00:00Z", { codex: { version: "1" } });
  const out = join(tmp, "site");
  const now = new Date("2026-11-13T12:00:00Z");
  const health = { keys: { "state:a": { written: "2026-11-13T11:55:00Z", entries: { codex: { version: "1.1" } }, sources: {} }, "state:b": { written: "2026-11-13T11:50:00Z", entries: {}, sources: {} } } };
  build(out, "HEAD", "o/r", { health, runs: [], issues: [] }, now);
  const status = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
  assert.deepEqual(status.live, { checked: "2026-11-13T11:50:00.000Z", states: { codex: { state: "found", version: "1.1", wait: "waiting for the next run" } } }, "no firstSeen given: no since");
  const { id, digest: d, ...rest } = status;
  assert.equal(id, dataId(rest), "the id is over everything but id and digest");
  assert.equal(id, createHash("sha256").update(JSON.stringify({ ...rest, live: { ...rest.live, checked: undefined } })).digest("hex"),
    "everything but id, digest and live.checked");
  assert.ok(readFileSync(join(out, "index.html"), "utf8").includes(`data-id="${id}"`));
  // No reads: live is null, and so is the page's live view.
  build(out, "HEAD", "o/r", null, now);
  assert.equal(JSON.parse(readFileSync(join(out, "status.json"), "utf8")).live, null);
});

test("status: the deploy rule", () => {
  const packages = [{ name: "a" }] as Row[];
  assert.deepEqual(decide({ digest: "d", packages }, null, true), { deploy: true, fail: false }, "no live site: deploy");
  assert.deepEqual(decide({ digest: "d", packages }, { digest: "d", packages }, false), { deploy: false, fail: false }, "nothing changed");
  assert.deepEqual(decide({ digest: "d", packages }, { digest: "e", packages }, false), { deploy: true, fail: false }, "data from moved");
  // The live reads failed: keep the live site, unless the pins changed.
  assert.deepEqual(decide({ digest: "d", packages }, { digest: "e", packages }, true), { deploy: false, fail: true });
  // A site from before browser pins carried their browsers and channel: the
  // same pins, so an outage still keeps the live view.
  const withBrowsers = packages.map((r) => ({ ...r, browsers: [{ name: "ungoogled-chromium", version: "1", unavailable: [] }], channel: "nixos-unstable" }));
  assert.deepEqual(decide({ digest: "d", packages: withBrowsers }, { digest: "e", packages }, true), { deploy: false, fail: true });
  assert.deepEqual(decide({ digest: "d", packages }, { digest: "e", packages: [{ name: "b" }] }, true), { deploy: true, fail: false });
  // Even when the site already shows the same plain view, a failed read fails.
  assert.deepEqual(decide({ digest: "d", packages }, { digest: "d", packages }, true), { deploy: false, fail: true });
  // A change to the stable snapshot alone deploys during an outage too; the
  // live-derived issue number alone doesn't.
  const stable = (differing: StableView["differing"], issue: number | null): StableView => ({ current: differing.length === 0, differing, issue });
  const behind = [{ name: "a", stable: "1", main: "2" }];
  assert.deepEqual(decide({ digest: "d", packages, stable: stable([], null) }, { digest: "e", packages, stable: stable(behind, 7) }, true), { deploy: true, fail: false }, "snapshot caught up");
  assert.deepEqual(decide({ digest: "d", packages, stable: stable(behind, null) }, { digest: "e", packages, stable: stable(behind, 7) }, true), { deploy: false, fail: true }, "only the issue differs");
});

test("status: the command line reports a failed live read with a fixed reason", () => {
  commit("2026-11-13T12:00:00Z", { codex: { version: "1" } });
  const out = join(tmp, "site"), script = join(import.meta.dirname, "..", "scripts", "status.ts");
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, out, "HEAD", ...args], { encoding: "utf8" }));
  // No reads asked for (no watcher yet): no failure.
  const plain = cli();
  assert.deepEqual([plain.live, plain.error, plain.fail], [false, "no live reads given", false]);
  const site = join(tmp, "site.json");
  writeFileSync(site, readFileSync(join(out, "status.json")));
  writeFileSync(join(tmp, "reads.json"), JSON.stringify({ runs: [], issues: [] }));
  writeFileSync(join(tmp, "secret.html"), "<html>secret-token-here</html>");
  writeFileSync(join(tmp, "noruns.json"), JSON.stringify({ issues: [] }));
  for (const [health, reads, why] of [
    [join(tmp, "missing.json"), join(tmp, "reads.json"), "the watcher's reply is missing or isn't JSON"],
    [join(tmp, "secret.html"), join(tmp, "reads.json"), "the watcher's reply is missing or isn't JSON"],
    [join(tmp, "reads.json"), join(tmp, "missing.json"), "the live job's reads are missing or aren't JSON"],
    [join(tmp, "reads.json"), join(tmp, "noruns.json"), "the live job's reads have no runs or issues"],
  ]) {
    const r = cli("--health", health, "--reads", reads, "--site", site);
    assert.deepEqual([r.live, r.error, r.deploy, r.fail], [false, why, false, true], health);
    assert.ok(!JSON.stringify(r).includes("secret"), "never quotes the reply");
  }
  // A watcher that answers but has stalled (every key stale) counts as a
  // failed read too: the live site keeps its view and ages into its note.
  writeFileSync(join(tmp, "stale.json"), JSON.stringify({ keys: { "state:a": { written: "2020-01-01T00:00:00Z", entries: {}, sources: {} } } }));
  const stalled = cli("--health", join(tmp, "stale.json"), "--reads", join(tmp, "reads.json"), "--site", site);
  assert.deepEqual([stalled.live, stalled.error, stalled.deploy, stalled.fail], [false, "the watcher has no usable key", false, true]);
});

test("status: a browser pin shows its Chromium version and channel, not the revision", async () => {
  const { shownVersion } = await import("../scripts/lib/util.ts");
  assert.equal(shownVersion({ name: "browser-unstable", version: "a".repeat(40), assets: {}, chromium: "158.0.1", channel: "nixos-unstable" } as any),
    "158.0.1 (nixos-unstable)");
  // With the optional browsers: each named, and where one isn't available.
  const withBrowsers = (chromium: object, chrome: object) => shownVersion({ name: "browser-stable", version: "a".repeat(40), assets: {},
    chromium: "157.0.50", channel: "nixos-26.05", browsers: { chromium, "google-chrome": chrome } } as any);
  assert.equal(withBrowsers({ version: "157.0.50" }, { version: "157.0.50" }), "ungoogled-chromium 157.0.50, Chromium 157.0.50, Chrome 157.0.50 (nixos-26.05)");
  assert.equal(withBrowsers({ version: "157.0.78" }, { version: "157.0.78", unavailable: { "aarch64-linux": "404" } }),
    "ungoogled-chromium 157.0.50, Chromium 157.0.78, Chrome 157.0.78 (unavailable on aarch64-linux) (nixos-26.05)");
  assert.equal(withBrowsers({ version: "157.0.50" }, { version: null, unavailable: { "aarch64-linux": "x", "x86_64-linux": "x" } }),
    "ungoogled-chromium 157.0.50, Chromium 157.0.50, Chrome unknown (unavailable on aarch64-linux, x86_64-linux) (nixos-26.05)");
  assert.equal(shownVersion({ name: "codex", version: "1.0", assets: {} }), "1.0");
  assert.equal(shownVersion({ name: "nixpkgs-stable", version: "f".repeat(40), assets: {}, channel: "nixos-26.05", rev: "f".repeat(40) } as any),
    `nixos-26.05 ${"f".repeat(12)}`, "nixpkgs-stable: channel and short revision");
});

test("status: an exact gap of one hour is no longer green", () => {
  const row = (gap: number): Row => ({ name: "a", version: "1", released: { at: "2026-11-13T11:00:00Z", kind: "published" }, published: null, gap, notes: null, counted: true, history: [] });
  assert.deepEqual([3599, 3600, 6 * 3600 - 1, 6 * 3600].map((g) => badge(row(g)).color), ["brightgreen", "yellow", "yellow", "red"]);
});

test("status: the deploy rule compares what differs in the stable snapshot, not only whether it's current", () => {
  const packages = [{ name: "a" }] as Row[];
  const stable = (differing: StableView["differing"]): StableView => ({ current: false, differing, issue: null });
  assert.deepEqual(decide({ digest: "d", packages, stable: stable([{ name: "a", stable: "1", main: "3" }]) },
    { digest: "e", packages, stable: stable([{ name: "a", stable: "1", main: "2" }]) }, true), { deploy: true, fail: false });
});


test("status: live.json carries the page's id and check time, and is in the digest", () => {
  commit("2026-11-13T12:00:00Z", { codex: { version: "1" } });
  const out = join(tmp, "site");
  const health = (written: string) => ({ keys: { "state:a": { written, entries: { codex: { version: "1" } }, sources: {} } } });
  const read = (f: string) => readFileSync(join(out, f), "utf8");
  const one = build(out, "HEAD", "o/r", { health: health("2026-11-13T11:55:00Z"), runs: [], issues: [] }, new Date("2026-11-13T12:00:00Z"));
  const live1 = JSON.parse(read("live.json")), status1 = JSON.parse(read("status.json"));
  assert.deepEqual(live1, { id: status1.id, checked: "2026-11-13T11:55:00.000Z" });
  assert.ok(read("index.html").includes(`data-id="${live1.id}"`), "the id the page carries");
  assert.ok(read("live.json").length < 200, "a few bytes");
  // Only the check time moves: live.json changes, the id doesn't, the digest does.
  const two = build(out, "HEAD", "o/r", { health: health("2026-11-13T12:10:00Z"), runs: [], issues: [] }, new Date("2026-11-13T12:15:00Z"));
  const live2 = JSON.parse(read("live.json"));
  assert.deepEqual(live2, { id: live1.id, checked: "2026-11-13T12:10:00.000Z" });
  assert.notEqual(two.digest, one.digest);
  // Without the live view: checked is null.
  build(out, "HEAD", "o/r", null);
  assert.deepEqual(JSON.parse(read("live.json")), { id: JSON.parse(read("status.json")).id, checked: null });
  // The digest covers live.json like any other file.
  assert.notEqual(digest({ "live.json": "a" }, {}), digest({ "live.json": "b" }, {}));
});

test("status: a browser pin's browsers, the default first, with what isn't recorded or available", () => {
  assert.deepEqual(browsersOf({ chromium: "157.0.50" }), [
    { name: "ungoogled-chromium", version: "157.0.50", unavailable: [] },
    { name: "chromium", version: null, unavailable: [] },
    { name: "google-chrome", version: null, unavailable: [] },
  ], "a pin from before the browsers were recorded");
  assert.deepEqual(browsersOf({ chromium: "157.0.50", browsers: { chromium: { version: "157.0.78" }, "google-chrome": { version: null, unavailable: { "x86_64-linux": "x", "aarch64-linux": "y" } } } }), [
    { name: "ungoogled-chromium", version: "157.0.50", unavailable: [] },
    { name: "chromium", version: "157.0.78", unavailable: [] },
    { name: "google-chrome", version: null, unavailable: ["aarch64-linux", "x86_64-linux"] },
  ]);
  // A row carries them, with its channel; another pin's row has neither.
  commit("2026-11-13T12:00:00Z", { "browser-stable": { version: "a".repeat(40), channel: "nixos-26.05", chromium: "157.0.50", browsers: { chromium: { version: "157.0.78" } } }, codex: { version: "1.0" } });
  const got = rows("HEAD");
  const b = got.find((r) => r.name === "browser-stable")!;
  assert.equal(b.channel, "nixos-26.05");
  assert.deepEqual(b.browsers?.map((x) => x.version), ["157.0.50", "157.0.78", null]);
  const c = got.find((r) => r.name === "codex")!;
  assert.ok(!("browsers" in c) && !("channel" in c));
});
