// boat's resolver (scripts/update.ts, resolveBoat): boat's own update
// endpoint for the version, GitHub for the files, with every network call
// faked.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as u from "../scripts/update.ts";
import { BOAT } from "../shared/sources.ts";
import { clearFetched, releaseNotes, timing } from "../scripts/lib/util.ts";

const REPO = BOAT.repo;
const NOW = new Date("2026-11-14T12:00:00Z");
const hex = (c: string) => c.repeat(64);
let dir: string;

interface World {
  /** What each platform's endpoint answers. */
  reply: Record<string, any>;
  /** Releases by tag; null is a 404. */
  releases: Record<string, any | null>;
  sums: Record<string, string>;
}
let w: World;

const reply = (version: string, platform: string, over: Record<string, unknown> = {}) => ({
  requestedChannel: "prod", channel: "prod", platform, version, tag: `boat-cli-v${version}`,
  downloadUrl: `https://github.com/${REPO}/releases/download/boat-cli-v${version}/boat-${platform}`, ...over,
});
const asset = (tag: string, name: string, digest: string | null, id: number) =>
  ({ id, name, digest, browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${name}` });
function release(version: string, published: string, opts: { digests?: Record<string, string | null>; sums?: boolean } = {}) {
  const tag = `boat-cli-v${version}`;
  const d = { "boat-linux-x64": hex("a"), "boat-linux-arm64": hex("b"), ...opts.digests };
  const assets = Object.entries(d).map(([n, h], i) => asset(tag, n, h ? `sha256:${h}` : null, i + 1));
  if (opts.sums !== false) {
    assets.push(asset(tag, "SHA256SUMS", null, 9));
    w.sums[tag] ??= `${hex("a")}  boat-linux-x64\n${hex("b")}  boat-linux-arm64\n`;
  }
  return { tag_name: tag, draft: false, prerelease: false, published_at: published, assets };
}
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const realFetch = globalThis.fetch;
const realSleep = timing.sleep;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boat-test-"));
  clearFetched();
  timing.sleep = async () => {};
  w = { reply: { "linux-x64": reply("1.0.100", "linux-x64"), "linux-arm64": reply("1.0.100", "linux-arm64") }, releases: {}, sums: {} };
  w.releases["boat-cli-v1.0.100"] = release("1.0.100", minutesAgo(600));
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    const json = (v: unknown) => new Response(JSON.stringify(v));
    for (const [platform, platformReply] of Object.entries(w.reply)) if (url === BOAT.endpoint(platform)) return json(platformReply);
    let m = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(url);
    if (m) return w.releases[m[1]] ? json(w.releases[m[1]]) : new Response("{}", { status: 404 });
    m = /\/git\/ref\/tags\/(.+)$/.exec(url);
    if (m) return json({ object: { type: "commit", sha: "c".repeat(40) } });
    m = /\/releases\/download\/([^/]+)\/SHA256SUMS$/.exec(url);
    if (m) return new Response(w.sums[m[1]]);
    if (url.endsWith("/LICENSE")) return new Response("MIT License\n");
    return new Response("no", { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  timing.sleep = realSleep;
  rmSync(dir, { recursive: true, force: true });
});

async function resolve(held: string[][] = []) {
  const r = new u.Report(dir, NOW);
  await u.resolveBoat(r, new Set(held.map(([p, v]) => `${p}\0${v}`)), false, NOW);
  return r;
}
const said = (r: u.Report) => r.observations.map((o) => [o.kind, o.version]);

test("boat: a prod release is pinned at its plain version, with its tag", async () => {
  const r = await resolve();
  assert.deepEqual(r.changed, [{ name: "boat", from: null, to: "1.0.100", why: "new version" }]);
  const pin = r.pins.get("boat")!;
  assert.deepEqual([pin.version, pin.tag], ["1.0.100", "boat-cli-v1.0.100"]);
  assert.equal(pin.assets["x86_64-linux"].url, `https://github.com/${REPO}/releases/download/boat-cli-v1.0.100/boat-linux-x64`);
  assert.equal(pin.licenses!.LICENSE.url, `https://raw.githubusercontent.com/${REPO}/${"c".repeat(40)}/LICENSE`);
  assert.equal(releaseNotes(pin), `https://github.com/${REPO}/releases/tag/boat-cli-v1.0.100`, "the release notes link");
});

test("boat: what the endpoint says is checked before anything else", async () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["a region build", { version: "1.0.98-busan1", tag: "boat-cli-v1.0.98-busan1", downloadUrl: `https://github.com/${REPO}/releases/download/boat-cli-v1.0.98-busan1/boat-linux-x64` }, /not a plain X\.Y\.Z/],
    ["a tag that isn't the version's", { tag: "boat-cli-v1.0.99" }, /names tag/],
    ["a staging tag", { tag: "boat-cli-v1.0.100-staging1" }, /names tag/],
    ["another host", { downloadUrl: "https://example.com/boat-linux-x64" }, /download URL/],
  ];
  for (const [what, over, re] of cases) {
    w.reply["linux-x64"] = { ...reply("1.0.100", "linux-x64"), ...over };
    clearFetched();
    await assert.rejects(resolve(), re, what);
  }
});

test("boat: platforms disagreeing is a rollout for an hour, then no-match, named by the higher version", async () => {
  w.reply["linux-x64"] = reply("1.0.101", "linux-x64");
  w.releases["boat-cli-v1.0.101"] = release("1.0.101", minutesAgo(10));
  let r = await resolve();
  assert.deepEqual([said(r), r.changed], [[["incomplete", "1.0.101"]], []]);
  w.releases["boat-cli-v1.0.101"] = release("1.0.101", minutesAgo(90));
  clearFetched();
  r = await resolve();
  assert.deepEqual(said(r), [["no-match", "1.0.101"]]);
  // arm64 ahead: still the higher version.
  w.reply["linux-x64"] = reply("1.0.100", "linux-x64");
  w.reply["linux-arm64"] = reply("1.0.101", "linux-arm64");
  w.releases["boat-cli-v1.0.101"] = release("1.0.101", minutesAgo(10));
  clearFetched();
  r = await resolve();
  assert.deepEqual(said(r), [["incomplete", "1.0.101"]]);
});

test("boat: a missing release counts from the other one; with none at all it fails at once", async () => {
  w.reply["linux-x64"] = reply("1.0.101", "linux-x64");
  w.releases["boat-cli-v1.0.101"] = null; // a 404
  w.releases["boat-cli-v1.0.100"] = release("1.0.100", minutesAgo(30));
  let r = await resolve();
  assert.deepEqual(said(r), [["incomplete", "1.0.101"]], "an hour from the release that exists");
  w.releases["boat-cli-v1.0.100"] = release("1.0.100", minutesAgo(120));
  clearFetched();
  r = await resolve();
  assert.deepEqual(said(r), [["no-match", "1.0.101"]]);
  // Both platforms on a version without a release.
  w.reply["linux-arm64"] = reply("1.0.101", "linux-arm64");
  clearFetched();
  r = await resolve();
  assert.equal(said(r)[0][0], "resolve-failed");
  assert.match(r.observations[0].detail, /no published release/);
  // A draft is no release either.
  w.releases["boat-cli-v1.0.101"] = { ...release("1.0.101", minutesAgo(5)), draft: true };
  clearFetched();
  r = await resolve();
  assert.equal(said(r)[0][0], "resolve-failed");
});

test("boat: a release missing a digest or SHA256SUMS waits an hour, then fails", async () => {
  for (const opts of [{ digests: { "boat-linux-arm64": null } }, { sums: false }]) {
    w.releases["boat-cli-v1.0.100"] = release("1.0.100", minutesAgo(20), opts);
    clearFetched();
    let r = await resolve();
    assert.deepEqual(said(r), [["incomplete", "1.0.100"]], JSON.stringify(opts));
    w.releases["boat-cli-v1.0.100"] = release("1.0.100", minutesAgo(70), opts);
    clearFetched();
    r = await resolve();
    assert.deepEqual(said(r), [["resolve-failed", "1.0.100"]], JSON.stringify(opts));
    assert.match(r.observations[0].detail, /missing (boat-linux-arm64|SHA256SUMS)/);
  }
});

test("boat: SHA256SUMS disagreeing with GitHub's digest fails", async () => {
  w.sums["boat-cli-v1.0.100"] = `${hex("f")}  boat-linux-x64\n${hex("b")}  boat-linux-arm64\n`;
  const r = await resolve();
  assert.deepEqual(said(r), [["resolve-failed", "1.0.100"]]);
  assert.match(r.observations[0].detail, /SHA256SUMS says/);
});

test("boat: a held version stays out; a pointer moving back is followed as a downgrade", async () => {
  let r = await resolve([["boat", "1.0.100"]]);
  assert.deepEqual([said(r), r.changed], [[["held", "1.0.100"]], []]);
  writeFileSync(join(dir, "boat.json"), JSON.stringify({ name: "boat", version: "1.0.101", tag: "boat-cli-v1.0.101", assets: {} }));
  clearFetched();
  r = await resolve();
  assert.ok(said(r).some(([k, v]) => k === "downgrade" && v === "1.0.100"));
  assert.equal(r.changed[0]?.to, "1.0.100");
});

test("boat: a draft release is no release", async () => {
  w.releases["boat-cli-v1.0.100"] = { ...release("1.0.100", minutesAgo(600)), draft: true };
  const r = await resolve();
  assert.deepEqual(r.changed, []);
  assert.deepEqual(r.observations.map((o) => o.kind), ["resolve-failed"]);
  assert.match(r.observations[0].detail, /no published release for boat-cli-v1\.0\.100/);
});
