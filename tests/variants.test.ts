// agent-browser's report-only variants (scripts/ci/variants.ts), with Nix
// and the smoke faked.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as v from "../scripts/ci/variants.ts";

const real = { ...v.io };
const T = "a".repeat(40), U = "b".repeat(40);
let builds: { status: number; out: string | null; log: string };
let buildQueue: typeof builds[];
let wrapperPath: string;
let smokes: string[][];
beforeEach(() => {
  builds = { status: 0, out: "/nix/store/ab", log: "" };
  buildQueue = [];
  wrapperPath = "/nix/store/gc/bin/google-chrome-stable";
  smokes = [[]];
  Object.assign(v.io, {
    build: () => buildQueue.shift() ?? builds,
    read: () => `export AGENT_BROWSER_EXECUTABLE_PATH=\${AGENT_BROWSER_EXECUTABLE_PATH-'${wrapperPath}'}\n`,
    smoke: async () => ({ problems: smokes.shift() ?? [], timedOut: false }),
    has: () => true,
  });
});
afterEach(() => Object.assign(v.io, real));

const pin = (extra: object = {}) => ({ browsers: { "google-chrome": { version: "157.1", outPaths: { "x86_64-linux": "/nix/store/gc" }, ...extra } } });

test("variants: a pass needs the build, the pin's own browser in the wrapper, and the smoke", async () => {
  assert.deepEqual(await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux"), { outcome: "pass", detail: "" });
  wrapperPath = "/nix/store/other/bin/google-chrome-stable";
  assert.match((await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux")).detail, /runs \/nix\/store\/other.*not the pin's/);
});

test("variants: the smoke is tried twice; Widevine is asked of Chrome on x86_64 only", async () => {
  smokes = [["open: no"], []];
  assert.equal((await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux")).outcome, "pass");
  smokes = [["widevine: Widevine isn't available"], ["widevine: Widevine isn't available"]];
  assert.deepEqual(await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux"), { outcome: "fail", detail: "widevine: Widevine isn't available" });
  const asked: any[] = [];
  v.io.smoke = async (_p, e) => (asked.push(e), { problems: [], timedOut: false });
  await v.variant("/src", "a", pin(), "google-chrome", "aarch64-linux");
  await v.variant("/src", "a", { browsers: { chromium: { version: "1" } } }, "chromium", "x86_64-linux");
  assert.deepEqual(asked, [{ brand: "chrome", version: "157.1", widevine: false }, { brand: "chromium", version: "1", widevine: false }]);
});

test("variants: unavailable is a failure; a 404 couldn't download; other download errors and timeouts are no result", async () => {
  assert.deepEqual(await v.variant("/src", "a", pin({ unavailable: { "x86_64-linux": "404" } }), "google-chrome", "x86_64-linux"),
    { outcome: "fail", detail: "not available: 404" });
  builds = { status: 100, out: null, log: "error: cannot download google-chrome-stable.deb from any mirror\nHTTP error 404" };
  assert.match((await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux")).detail, /^couldn't download/);
  builds = { status: 100, out: null, log: "error: unable to download 'https://dl.google.com/x.deb': Could not resolve host" };
  assert.equal((await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux")).outcome, "none");
  builds = { status: 1, out: null, log: "(ETIMEDOUT: spawnSync nix ETIMEDOUT)" };
  assert.equal((await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux")).outcome, "none");
  builds = { status: 100, out: null, log: "error: builder for agent-browser failed" };
  assert.match((await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux")).detail, /^build failed/);
});

test("variants: a broken attribute is a failure; a timed-out smoke is no result; a failure is tried again whole", async () => {
  builds = { status: 1, out: null, log: "error: attribute 'google-chrome' missing\n       at «string»:1:1" };
  assert.match((await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux")).detail, /^evaluation failed/);
  builds = { status: 0, out: "/nix/store/ab", log: "" };
  v.io.smoke = async () => ({ problems: ["open: timed out"], timedOut: true });
  assert.equal((await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux")).outcome, "none");
  v.io.smoke = async () => ({ problems: [], timedOut: false });
  buildQueue = [{ status: 100, out: null, log: "error: builder failed" }, { status: 0, out: "/nix/store/ab", log: "" }];
  assert.equal((await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux")).outcome, "pass", "the second attempt decides");
  buildQueue = [{ status: 100, out: null, log: "error: builder failed" }, { status: 1, out: null, log: "(ETIMEDOUT: spawnSync nix ETIMEDOUT)" }];
  assert.equal((await v.variant("/src", "a", pin(), "google-chrome", "x86_64-linux")).outcome, "none", "no result there is no result");
});

test("variants: only the published tree's well-formed results become observations", () => {
  const ok = { scope: "browser-stable", browser: "chromium", system: "aarch64-linux", tree: T, outcome: "pass", detail: "" };
  const bad = { scope: "browser-stable", browser: "google-chrome", system: "x86_64-linux", tree: T, rev: U, outcome: "fail", detail: "smoke failed" };
  const list = v.observationsOf([ok, bad, { ...ok, tree: U }, { ...ok, outcome: "none" }, { ...ok, scope: "codex" }, { ...ok, browser: "firefox" },
    { ...ok, system: "riscv" }], T);
  assert.deepEqual(list.map((o) => [o.kind, o.package, o.channel, o.version, o.detail]),
    [["browser-ok", "browser-stable", "chromium", null, "aarch64-linux"], ["browser-failed", "browser-stable", "google-chrome", U, "x86_64-linux: smoke failed"]],
    "a failure names the pin's revision");
  assert.deepEqual(v.observationsOf([ok], ""), [], "nothing published: no evidence");
});

test("variants: what a publish asks for: the pins it changed, both for agent-browser or nixpkgs, open issues' scopes, and the stable set's", () => {
  assert.deepEqual(v.argsFor(["codex"], [], false), [], "nothing about the browsers");
  assert.deepEqual(v.argsFor(["browser-stable", "codex"], [], false), ["--pins=browser-stable"]);
  assert.deepEqual(v.argsFor(["agent-browser"], [], false), ["--pins=browser-stable,browser-unstable"]);
  assert.deepEqual(v.argsFor(["nixpkgs"], [], false), ["--pins=browser-stable,browser-unstable"]);
  assert.deepEqual(v.argsFor(["codex"], ["browser-unstable"], false), ["--pins=browser-unstable"], "an open issue is retested");
  assert.deepEqual(v.argsFor(["codex"], ["stable-browser-stable"], false), ["--stable"]);
  assert.deepEqual(v.argsFor(["nixpkgs-stable"], [], false), ["--stable"], "the stable set builds on nixpkgs-stable directly");
  assert.deepEqual(v.argsFor(["codex"], [], true), ["--stable"], "the publish moved the snapshot's browser pins");
});

test("variants: the stable set's runs come from its snapshot's browser-stable pin", () => {
  const names = (r: ReturnType<typeof v.plan>) => r.map(([scope, attr]) => `${scope} ${attr}`);
  assert.deepEqual(names(v.plan("x86_64-linux", "/s", ["browser-unstable"], true)), [
    'browser-unstable legacyPackages.x86_64-linux.agentBrowserVariants."browser-unstable-chromium"',
    'browser-unstable legacyPackages.x86_64-linux.agentBrowserVariants."browser-unstable-google-chrome"',
    "stable-browser-stable legacyPackages.x86_64-linux.stableAgentBrowserVariants.chromium",
    "stable-browser-stable legacyPackages.x86_64-linux.stableAgentBrowserVariants.google-chrome"]);
});

test("variants: branch CI blames the branch unless the parent's same variant fails too", () => {
  assert.equal(v.madeByBranch(null), true, "the parent has none");
  assert.equal(v.madeByBranch({ outcome: "pass" }), true);
  assert.equal(v.madeByBranch({ outcome: "none" }), true, "the parent gives no result");
  assert.equal(v.madeByBranch({ outcome: "fail" }), false);
});
