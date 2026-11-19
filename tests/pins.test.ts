// Pin construction against canned vendor and GitHub responses: no network.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildGithubPin } from "../scripts/lib/pin-github.ts";
import { buildVendorPin, gcsHead, io, prefetch, Skip } from "../scripts/lib/vendors.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report, resolveT3code, resolveVendor } from "../scripts/update.ts";
import { sourceUrl } from "../scripts/lib/browser.ts";
import { catalogUrl } from "../scripts/lib/speech.ts";
import { clearFetched, settleReleased, sha256Hex, sri, timing, type Pin } from "../scripts/lib/util.ts";

const realFetch = globalThis.fetch;
const realPrefetch = io.prefetch;
const realSleep = timing.sleep;
let routes: Record<string, string | object | [number, string, Record<string, string>?]> = {};
let fetched: string[] = [];
let prefetched: string[] = [];
// Requests that must run together: each waits for the rest of its group. One
// that waits in vain (they were made one after another) is noted in `alone`
// and goes on.
let groups: { urls: string[]; seen: Set<string>; release: () => void; done: Promise<void> }[] = [];
let alone: string[] = [];
function together(...urls: string[]) {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  groups.push({ urls, seen: new Set(), release, done });
}
async function arrive(url: string) {
  const g = groups.find((x) => x.urls.includes(url));
  if (!g) return;
  g.seen.add(url);
  if (g.seen.size === g.urls.length) g.release();
  const late = await Promise.race([g.done.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 300))]);
  if (late) alone.push(url);
}

/** Serve routes by exact URL; anything else is a 404. */
beforeEach(() => {
  routes = {};
  fetched = [];
  prefetched = [];
  groups = [];
  alone = [];
  clearFetched();
  timing.sleep = async () => {};
  globalThis.fetch = (async (url: string) => {
    fetched.push(String(url));
    await arrive(String(url));
    const r = routes[String(url)];
    if (r === undefined) return new Response("not found", { status: 404 });
    if (Array.isArray(r)) return new Response(r[1], { status: r[0], headers: r[2] });
    return new Response(typeof r === "string" ? r : JSON.stringify(r), { status: 200 });
  }) as typeof fetch;
  io.prefetch = async (url: string) => {
    prefetched.push(url);
    await arrive(`download:${url}`);
    return sri("sha256", sha256Hex(url));
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  io.prefetch = realPrefetch;
  timing.sleep = realSleep;
});

const hex = (c: string) => c.repeat(64);
const hex512 = (c: string) => c.repeat(128);

// ---- vendors ----------------------------------------------------------------

const CLAUDE = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";

test("claude: hashes come from the version's manifest", async () => {
  routes[`${CLAUDE}/latest`] = "2.1.5\n";
  routes[`${CLAUDE}/2.1.5/manifest.json`] = { version: "2.1.5", platforms: { "linux-x64": { checksum: hex("a") }, "linux-arm64": { checksum: hex("b") } } };
  const pin = await buildVendorPin("claude-code", null, null);
  assert.equal(pin.version, "2.1.5");
  assert.deepEqual(pin.assets["x86_64-linux"], { url: `${CLAUDE}/2.1.5/linux-x64/claude`, hash: sri("sha256", hex("a")), checksumSource: `${CLAUDE}/2.1.5/manifest.json` });
  assert.equal(pin.assets["aarch64-linux"].hash, sri("sha256", hex("b")));
});

test("claude: a manifest for another version is refused", async () => {
  routes[`${CLAUDE}/2.1.5/manifest.json`] = { version: "2.1.4", platforms: {} };
  await assert.rejects(buildVendorPin("claude-code", "2.1.5", null), /manifest is for 2.1.4/);
});

test("claude: a missing platform checksum is refused", async () => {
  routes[`${CLAUDE}/2.1.5/manifest.json`] = { version: "2.1.5", platforms: { "linux-x64": { checksum: hex("a") } } };
  await assert.rejects(buildVendorPin("claude-code", "2.1.5", null), /not a sha256 checksum/);
});

const GROK = "https://storage.googleapis.com/grok-build-public-artifacts/cli";
const grokPin = (version: string, md5: string): Pin => ({
  name: "grok", version,
  assets: Object.fromEntries([["x86_64-linux", "linux-x86_64"], ["aarch64-linux", "linux-aarch64"]].map(([s, p]) =>
    [s, { url: `${GROK}/grok-${version}-${p}`, hash: `sha256-old-${s}`, md5, checksumSource: "none (downloaded)" }])),
});
const grokMd5 = (version: string, md5: string) => {
  for (const p of ["linux-x86_64", "linux-aarch64"]) routes[`${GROK}/grok-${version}-${p}`] = [200, "", { "x-goog-hash": `crc32c=AAAA==,md5=${md5}` }];
};

test("grok: same version and MD5 reuses the hash without downloading", async () => {
  routes[`${GROK}/stable`] = "1.0.7\n";
  grokMd5("1.0.7", "m1==");
  const pin = await buildVendorPin("grok", null, grokPin("1.0.7", "m1=="));
  assert.equal(pin.assets["x86_64-linux"].hash, "sha256-old-x86_64-linux");
  assert.deepEqual(prefetched, []);
});

test("grok: a changed MD5 or version downloads again", async () => {
  grokMd5("1.0.7", "m2==");
  const pin = await buildVendorPin("grok", "1.0.7", grokPin("1.0.7", "m1=="));
  assert.equal(prefetched.length, 2);
  assert.equal(pin.assets["x86_64-linux"].md5, "m2==");
  grokMd5("1.0.8", "m1==");
  prefetched = [];
  await buildVendorPin("grok", "1.0.8", grokPin("1.0.7", "m1=="));
  assert.equal(prefetched.length, 2);
});

test("grok (updater): a held new version is skipped before any download or HEAD", async () => {
  routes[`${GROK}/stable`] = "1.0.8\n";
  const err = await buildVendorPin("grok", null, grokPin("1.0.7", "m1=="), { held: (v) => v === "1.0.8" }).catch((e) => e);
  assert.ok(err instanceof Skip && err.kind === "held" && err.version === "1.0.8");
  assert.deepEqual([prefetched, fetched], [[], [`${GROK}/stable`]]);
});

test("grok (updater): a changed MD5 at the same version is an integrity skip, without downloading", async () => {
  grokMd5("1.0.7", "m2==");
  const err = await buildVendorPin("grok", "1.0.7", grokPin("1.0.7", "m1=="), { held: () => false }).catch((e) => e);
  assert.ok(err instanceof Skip && err.kind === "integrity");
  assert.deepEqual(prefetched, []);
});

const grokUrls = (v: string) => [`${GROK}/grok-${v}-linux-x86_64`, `${GROK}/grok-${v}-linux-aarch64`];

test("grok: both systems' HEADs run together, then both downloads; the assets keep their order", async () => {
  grokMd5("1.0.8", "m1==");
  const urls = grokUrls("1.0.8");
  together(...urls); // the HEADs
  together(...urls.map((u) => `download:${u}`));
  const pin = await buildVendorPin("grok", "1.0.8", grokPin("1.0.7", "m1=="));
  assert.deepEqual(alone, []);
  assert.deepEqual(prefetched, urls);
  assert.deepEqual(Object.keys(pin.assets), ["x86_64-linux", "aarch64-linux"]);
});

test("grok (updater): an integrity problem on either system stops it before any download", async () => {
  // x86_64's MD5 is unknown (it would be downloaded); aarch64's changed.
  const [x86, arm] = grokUrls("1.0.7");
  routes[x86] = [200, "", {}];
  routes[arm] = [200, "", { "x-goog-hash": "md5=m2==" }];
  const err = await buildVendorPin("grok", "1.0.7", grokPin("1.0.7", "m1=="), { held: () => false }).catch((e) => e);
  assert.ok(err instanceof Skip && err.kind === "integrity");
  assert.deepEqual(prefetched, []);
});

test("grok (updater): x86_64's integrity problem wins over aarch64's failed HEAD, as one after another", async () => {
  const [x86] = grokUrls("1.0.7");
  routes[x86] = [200, "", { "x-goog-hash": "md5=m2==" }]; // changed; aarch64's HEAD is a 404
  const err = await buildVendorPin("grok", "1.0.7", grokPin("1.0.7", "m1=="), { held: () => false }).catch((e) => e);
  assert.ok(err instanceof Skip && err.kind === "integrity", String(err));
  assert.deepEqual(prefetched, []);
});

test("grok: with both HEADs failing, the error is x86_64's, as one after another", async () => {
  const err = await buildVendorPin("grok", "1.0.7", null).catch((e) => e);
  assert.match(String(err?.message), /linux-x86_64/);
});

test("update: a resolver's skip becomes that package's observation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-test-"));
  try {
    writeFileSync(join(dir, "grok.json"), JSON.stringify(grokPin("1.0.7", "m1==")));
    routes[`${GROK}/stable`] = "1.0.8\n";
    const r = new Report(dir);
    await resolveVendor(r, "grok", new Set(["grok\u00001.0.8"]), false);
    assert.deepEqual(r.observations.map((o) => [o.kind, o.package, o.version]), [["held", "grok", "1.0.8"]]);
    assert.deepEqual(r.changed, []);
    // What upstream points at is still known, for the npm comparison.
    assert.equal(r.resolved.get("grok"), "1.0.8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gcsHead: HEAD is retried like any read", async () => {
  let n = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    assert.equal(init.method, "HEAD");
    return ++n === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 200, headers: { "x-goog-hash": "crc32c=x==,md5=abc==", "last-modified": "Tue, 10 Nov 2026 08:00:00 GMT" } });
  }) as typeof fetch;
  assert.deepEqual(await gcsHead("https://x/grok"), { md5: "abc==", lastModified: "Tue, 10 Nov 2026 08:00:00 GMT" });
  assert.equal(n, 2);
});

test("cursor: version from the install script, hash from each sidecar", async () => {
  routes["https://cursor.com/install"] = 'curl -fsSL "https://downloads.cursor.com/lab/2026.11.01-abc/linux/x64/agent-cli-package.tar.gz"';
  for (const [arch, c] of [["x64", "c"], ["arm64", "d"]]) {
    routes[`https://downloads.cursor.com/lab/2026.11.01-abc/linux/${arch}/agent-cli-package.tar.gz.sha256`] = `${hex(c)}  agent-cli-package.tar.gz\n`;
  }
  const pin = await buildVendorPin("cursor-agent", null, null);
  assert.equal(pin.version, "2026.11.01-abc");
  assert.equal(pin.assets["aarch64-linux"].hash, sri("sha256", hex("d")));
});

test("cursor: both sidecars are fetched together; a problem with x86_64's is the one reported", async () => {
  const side = (arch: string) => `https://downloads.cursor.com/lab/1/linux/${arch}/agent-cli-package.tar.gz.sha256`;
  routes[side("x64")] = `${hex("c")}  agent-cli-package.tar.gz\n`;
  routes[side("arm64")] = `${hex("d")}  agent-cli-package.tar.gz\n`;
  together(side("x64"), side("arm64"));
  const pin = await buildVendorPin("cursor-agent", "1", null);
  assert.deepEqual(alone, []);
  assert.deepEqual(Object.keys(pin.assets), ["x86_64-linux", "aarch64-linux"]);
  // x86_64's sidecar names another file and aarch64's is missing: the first.
  clearFetched();
  routes[side("x64")] = `${hex("c")}  other.tar.gz\n`;
  delete routes[side("arm64")];
  await assert.rejects(buildVendorPin("cursor-agent", "1", null), /no entries for agent-cli-package/);
});

test("cursor: a sidecar for another file is refused", async () => {
  for (const arch of ["x64", "arm64"]) {
    routes[`https://downloads.cursor.com/lab/1/linux/${arch}/agent-cli-package.tar.gz.sha256`] = `${hex("c")}  other.tar.gz\n`;
  }
  await assert.rejects(buildVendorPin("cursor-agent", "1", null), /no entries/);
});

const AG = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const agUrl = (v: string, folder: string, file: string) => `https://storage.googleapis.com/antigravity-public/antigravity-cli/${v}-123/${folder}/${file}`;

test("antigravity: both manifests must name the same version and a matching URL", async () => {
  routes[`${AG}/linux_amd64.json`] = { version: "1.2.0", url: agUrl("1.2.0", "linux-x64", "cli_linux_x64.tar.gz"), sha512: hex512("e") };
  routes[`${AG}/linux_arm64.json`] = { version: "1.2.0", url: agUrl("1.2.0", "linux-arm", "cli_linux_arm64.tar.gz"), sha512: hex512("f") };
  const pin = await buildVendorPin("antigravity", null, null);
  assert.equal(pin.assets["aarch64-linux"].hash, sri("sha512", hex512("f")));

  clearFetched();
  routes[`${AG}/linux_arm64.json`] = { version: "1.2.1", url: agUrl("1.2.1", "linux-arm", "cli_linux_arm64.tar.gz"), sha512: hex512("f") };
  await assert.rejects(buildVendorPin("antigravity", null, null), /disagree/);

  clearFetched();
  routes[`${AG}/linux_arm64.json`] = { version: "1.2.0", url: agUrl("1.2.0", "linux-x64", "cli_linux_x64.tar.gz"), sha512: hex512("f") };
  await assert.rejects(buildVendorPin("antigravity", null, null), /unexpected antigravity URL/);
  await assert.rejects(buildVendorPin("antigravity", "1.2.0", null), /only publishes its current version/);
});

test("antigravity: both manifests are fetched together; the assets keep their order", async () => {
  routes[`${AG}/linux_amd64.json`] = { version: "1.2.0", url: agUrl("1.2.0", "linux-x64", "cli_linux_x64.tar.gz"), sha512: hex512("e") };
  routes[`${AG}/linux_arm64.json`] = { version: "1.2.0", url: agUrl("1.2.0", "linux-arm", "cli_linux_arm64.tar.gz"), sha512: hex512("f") };
  together(`${AG}/linux_amd64.json`, `${AG}/linux_arm64.json`);
  const pin = await buildVendorPin("antigravity", null, null);
  assert.deepEqual(alone, []);
  assert.deepEqual(Object.keys(pin.assets), ["x86_64-linux", "aarch64-linux"]);
});

const KIRO = "https://desktop-release.q.us-east-1.amazonaws.com";

test("kiro: one manifest entry per architecture", async () => {
  routes[`${KIRO}/latest/manifest.json`] = { version: "1.20.0", packages: [
    { os: "linux", download: "1.20.0/kirocli-x86_64-linux.tar.gz", sha256: hex("1") },
    { os: "linux", download: "1.20.0/kirocli-aarch64-linux.tar.gz", sha256: hex("2") },
    { os: "macos", download: "1.20.0/kirocli-aarch64-linux.tar.gz", sha256: hex("3") },
  ] };
  const pin = await buildVendorPin("kiro-cli", null, null);
  assert.equal(pin.assets["aarch64-linux"].hash, sri("sha256", hex("2")));

  routes[`${KIRO}/1.20.0/manifest.json`] = { version: "1.19.0", packages: [] };
  await assert.rejects(buildVendorPin("kiro-cli", "1.20.0", null), /names version 1.19.0/);
});

const MUSE = "https://lookaside.facebook.com/lookaside/muse/download/";
const museUrl = (file: string) => `${MUSE}?${new URLSearchParams({ channel: "muse", version: "1.4", file })}`;

test("muse: artifact URLs must be the expected lookaside ones", async () => {
  routes["https://api.meta.ai/muse-code/channels/muse-stable"] = { version: "1.4" };
  routes[museUrl("manifest.json")] = { version: "1.4", checksum_algorithm: "sha256", artifacts: {
    x86_linux: { url: museUrl("muse-x86-linux"), checksum: hex("4") },
    aarch64_linux: { url: museUrl("muse-aarch64-linux"), checksum: hex("5") },
  } };
  const pin = await buildVendorPin("muse", null, null);
  assert.equal(pin.assets["x86_64-linux"].url, museUrl("muse-x86-linux"));

  clearFetched();
  routes[museUrl("manifest.json")] = { version: "1.4", checksum_algorithm: "sha256", artifacts: {
    x86_linux: { url: "https://evil.example/muse", checksum: hex("4") },
  } };
  await assert.rejects(buildVendorPin("muse", null, null), /unexpected muse URL/);
});

test("vendor: an unknown name or a strange version is refused", async () => {
  await assert.rejects(buildVendorPin("nope", null, null), /unknown vendor/);
  await assert.rejects(buildVendorPin("claude-code", "../x", null), /unexpected version string/);
});

// ---- GitHub -------------------------------------------------------------------

const API = "https://api.github.com/repos/o/r";
const COMMIT = "c".repeat(40);
const DL = "https://github.com/o/r/releases/download/v1.2.3";

function release(extra: Record<string, unknown> = {}, sums?: string) {
  const assets: any[] = [
    { id: 1, name: "tool-1.2.3-x64.tar.gz", digest: `sha256:${hex("a")}`, browser_download_url: `${DL}/tool-1.2.3-x64.tar.gz` },
    { id: 2, name: "tool-1.2.3-arm64.tar.gz", digest: `sha256:${hex("b")}`, browser_download_url: `${DL}/tool-1.2.3-arm64.tar.gz` },
  ];
  if (sums !== undefined) {
    assets.push({ id: 3, name: "SHA256SUMS", digest: null, browser_download_url: `${DL}/SHA256SUMS` });
    routes[`${DL}/SHA256SUMS`] = sums;
  }
  routes[`${API}/releases/tags/v1.2.3`] = { tag_name: "v1.2.3", draft: false, prerelease: false, assets, ...extra };
}
const wanted = { "x86_64-linux": "tool-{version}-x64.tar.gz", "aarch64-linux": "tool-{version}-arm64.tar.gz" };
const lightweightTag = () => { routes[`${API}/git/ref/tags/v1.2.3`] = { object: { type: "commit", sha: COMMIT } }; };

test("github: digests, a nested annotated tag and the license at that commit", async () => {
  release({}, `${hex("a")}  tool-1.2.3-x64.tar.gz\n${hex("b")}  tool-1.2.3-arm64.tar.gz\n`);
  routes[`${API}/git/ref/tags/v1.2.3`] = { object: { type: "tag", sha: "t1" } };
  routes[`${API}/git/tags/t1`] = { object: { type: "tag", sha: "t2" } };
  routes[`${API}/git/tags/t2`] = { object: { type: "commit", sha: COMMIT } };
  routes[`https://raw.githubusercontent.com/o/r/${COMMIT}/LICENSE`] = "MIT";
  const pin = await buildGithubPin("tool", "o/r", "v1.2.3", wanted);
  assert.equal(pin.version, "1.2.3");
  assert.deepEqual(pin.assets["x86_64-linux"], { url: `${DL}/tool-1.2.3-x64.tar.gz`, hash: sri("sha256", hex("a")), assetId: 1, digest: `sha256:${hex("a")}` });
  assert.deepEqual(pin.licenses, { LICENSE: { url: `https://raw.githubusercontent.com/o/r/${COMMIT}/LICENSE`, hash: sri("sha256", sha256Hex("MIT")) } });
});

test("github: license hashes are reused only while the tag's commit is unchanged", async () => {
  release();
  lightweightTag();
  const url = `https://raw.githubusercontent.com/o/r/${COMMIT}/LICENSE`;
  const previous: Pin = { name: "tool", version: "1.2.2", assets: {}, licenses: { LICENSE: { url, hash: "sha256-kept" } } };
  const pin = await buildGithubPin("tool", "o/r", "v1.2.3", wanted, { previous });
  assert.equal(pin.licenses!.LICENSE.hash, "sha256-kept");
  assert.ok(!fetched.includes(url));

  clearFetched();
  routes[`${API}/git/ref/tags/v1.2.3`] = { object: { type: "commit", sha: "d".repeat(40) } };
  routes[`https://raw.githubusercontent.com/o/r/${"d".repeat(40)}/LICENSE`] = "MIT2";
  const moved = await buildGithubPin("tool", "o/r", "v1.2.3", wanted, { previous });
  assert.equal(moved.licenses!.LICENSE.hash, sri("sha256", sha256Hex("MIT2")));
});

test("github: a checksum file that disagrees with GitHub's digest is refused", async () => {
  release({}, `${hex("f")}  tool-1.2.3-x64.tar.gz\n${hex("b")}  tool-1.2.3-arm64.tar.gz\n`);
  lightweightTag();
  await assert.rejects(buildGithubPin("tool", "o/r", "v1.2.3", wanted), /SHA256SUMS says/);
});

test("github: SHA256SUMS without the asset fails unless partial sums are allowed", async () => {
  release({}, `${hex("a")}  tool-1.2.3-x64.tar.gz\n`);
  lightweightTag();
  routes[`https://raw.githubusercontent.com/o/r/${COMMIT}/LICENSE`] = "MIT";
  await assert.rejects(buildGithubPin("tool", "o/r", "v1.2.3", wanted), /no entries for tool-1.2.3-arm64/);
  const pin = await buildGithubPin("tool", "o/r", "v1.2.3", wanted, { partialSums: true });
  assert.equal(pin.assets["aarch64-linux"].hash, sri("sha256", hex("b")));
});

test("github: drafts, unexpected prereleases and odd URLs are refused", async () => {
  release({ draft: true });
  await assert.rejects(buildGithubPin("tool", "o/r", "v1.2.3", wanted), /is a draft/);
  clearFetched();
  release({ prerelease: true });
  await assert.rejects(buildGithubPin("tool", "o/r", "v1.2.3", wanted), /is a prerelease/);
  clearFetched();
  release();
  (routes[`${API}/releases/tags/v1.2.3`] as any).assets[0].browser_download_url = "https://evil.example/x";
  await assert.rejects(buildGithubPin("tool", "o/r", "v1.2.3", wanted), /unexpected download URL/);
  await assert.rejects(buildGithubPin("tool", "o/r", "v1;rm", wanted), /bad tag/);
});

test("github: a tag that never reaches a commit is refused", async () => {
  release();
  routes[`${API}/git/ref/tags/v1.2.3`] = { object: { type: "tag", sha: "loop" } };
  routes[`${API}/git/tags/loop`] = { object: { type: "tag", sha: "loop" } };
  await assert.rejects(buildGithubPin("tool", "o/r", "v1.2.3", wanted), /nested too deeply/);
  clearFetched();
  routes[`${API}/git/ref/tags/v1.2.3`] = { object: { type: "tree", sha: COMMIT } };
  await assert.rejects(buildGithubPin("tool", "o/r", "v1.2.3", wanted), /can't resolve the tag's commit/);
});

test("github: the release and the tag, each system's sidecar, and the license files run together", async () => {
  release();
  const rel: any = routes[`${API}/releases/tags/v1.2.3`];
  for (const [i, a] of ["tool-1.2.3-x64.tar.gz", "tool-1.2.3-arm64.tar.gz"].entries()) {
    rel.assets.push({ id: 10 + i, name: `${a}.sha256`, digest: null, browser_download_url: `${DL}/${a}.sha256` });
    routes[`${DL}/${a}.sha256`] = `${hex(i ? "b" : "a")}\n`;
  }
  lightweightTag();
  const lic = (p: string) => `https://raw.githubusercontent.com/o/r/${COMMIT}/${p}`;
  routes[lic("LICENSE")] = "MIT";
  routes[lic("NOTICE")] = "notice";
  together(`${API}/releases/tags/v1.2.3`, `${API}/git/ref/tags/v1.2.3`);
  together(`${DL}/tool-1.2.3-x64.tar.gz.sha256`, `${DL}/tool-1.2.3-arm64.tar.gz.sha256`);
  together(lic("LICENSE"), lic("NOTICE"));
  const pin = await buildGithubPin("tool", "o/r", "v1.2.3", wanted, { licenses: ["LICENSE", "NOTICE"] });
  assert.deepEqual(alone, []);
  assert.deepEqual(Object.keys(pin.assets), ["x86_64-linux", "aarch64-linux"]);
  assert.deepEqual(Object.keys(pin.licenses!), ["LICENSE", "NOTICE"]);
});

test("released: GitHub pins carry the release's published_at", async () => {
  release({ published_at: "2026-11-13T10:00:00Z" });
  lightweightTag();
  routes[`https://raw.githubusercontent.com/o/r/${COMMIT}/LICENSE`] = "MIT";
  const pin = await buildGithubPin("tool", "o/r", "v1.2.3", wanted);
  assert.deepEqual(pin.released, { at: "2026-11-13T10:00:00Z", kind: "published" });
});

test("released: claude's buildDate, grok's Last-Modified, none for the rest", async () => {
  routes[`${CLAUDE}/2.0/manifest.json`] = { version: "2.0", buildDate: "2026-11-13T09:00:00Z", platforms: { "linux-x64": { checksum: hex("a") }, "linux-arm64": { checksum: hex("b") } } };
  assert.deepEqual((await buildVendorPin("claude-code", "2.0", null)).released, { at: "2026-11-13T09:00:00Z", kind: "built" });
  for (const p of ["linux-x86_64", "linux-aarch64"]) {
    routes[`${GROK}/grok-1.0.9-${p}`] = [200, "", { "x-goog-hash": "md5=m1==", "last-modified": "Fri, 13 Nov 2026 08:00:00 GMT" }];
  }
  assert.deepEqual((await buildVendorPin("grok", "1.0.9", null)).released, { at: "2026-11-13T08:00:00.000Z", kind: "uploaded" });
  routes["https://cursor.com/install"] = 'curl -fsSL "https://downloads.cursor.com/lab/2026.11.01-abc/linux/x64/agent-cli-package.tar.gz"';
  for (const [arch, c] of [["x64", "c"], ["arm64", "d"]]) {
    routes[`https://downloads.cursor.com/lab/2026.11.01-abc/linux/${arch}/agent-cli-package.tar.gz.sha256`] = `${hex(c)}  agent-cli-package.tar.gz\n`;
  }
  assert.equal((await buildVendorPin("cursor-agent", null, null)).released, undefined);
});

test("released: a grok Last-Modified that doesn't parse is unknown, not seen", async () => {
  for (const p of ["linux-x86_64", "linux-aarch64"]) {
    routes[`${GROK}/grok-1.0.9-${p}`] = [200, "", { "x-goog-hash": "md5=m1==", "last-modified": "yesterday-ish" }];
  }
  const pin = await buildVendorPin("grok", "1.0.9", null);
  assert.equal(settleReleased(pin, null, new Date("2026-11-13T12:00:00Z"), false).released, undefined);
  // No header at all: the run's time, as "seen".
  for (const p of ["linux-x86_64", "linux-aarch64"]) {
    routes[`${GROK}/grok-1.0.9-${p}`] = [200, "", { "x-goog-hash": "md5=m1==" }];
  }
  const none = await buildVendorPin("grok", "1.0.9", null);
  assert.deepEqual(settleReleased(none, null, new Date("2026-11-13T12:00:00Z"), false).released, { at: "2026-11-13T12:00:00.000Z", kind: "seen" });
});

test("github: a problem with the release is reported before one with the tag", async () => {
  release({ draft: true }); // and no tag ref at all
  await assert.rejects(buildGithubPin("tool", "o/r", "v1.2.3", wanted), /is a draft/);
});

test("github: bad license paths are refused before any request", async () => {
  for (const licenses of [["../x"], ["a/LICENSE", "b/LICENSE"], ["a b"]]) {
    await assert.rejects(buildGithubPin("tool", "o/r", "v1.2.3", wanted, { licenses }), /license/);
  }
  assert.deepEqual(fetched, []);
});

test("prefetch: the SRI hash of the downloaded bytes, retried like any read", async () => {
  let n = 0;
  globalThis.fetch = (async () => (++n === 1 ? new Response("busy", { status: 503 }) : new Response("grok bytes"))) as typeof fetch;
  assert.equal(await prefetch("https://x/grok"), sri("sha256", sha256Hex("grok bytes")));
  assert.equal(n, 2);
});

test("update: a t3code release whose SHA256SUMS lists only the CLI archives still pins the desktop app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-test-"));
  const env = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test";
  try {
    const repo = "pingdotgg/t3code", tag = "v0.2.0", v = "0.2.0";
    const dl = `https://github.com/${repo}/releases/download/${tag}`;
    const names = [`t3-${v}-linux-x64.tar.gz`, `t3-${v}-linux-arm64.tar.gz`, `T3-Code-${v}-amd64.deb`, `T3-Code-${v}-arm64.deb`];
    const assets: any[] = names.map((name, i) => ({ id: i + 1, name, digest: `sha256:${hex("abcd"[i])}`, browser_download_url: `${dl}/${name}` }));
    assets.push({ id: 9, name: "SHA256SUMS", digest: null, browser_download_url: `${dl}/SHA256SUMS` });
    routes[`${dl}/SHA256SUMS`] = `${hex("a")}  ${names[0]}\n${hex("b")}  ${names[1]}\n`;
    routes[`https://api.github.com/repos/${repo}/releases/tags/${tag}`] = { tag_name: tag, draft: false, prerelease: false, assets };
    routes[`https://api.github.com/repos/${repo}/git/ref/tags/${tag}`] = { object: { type: "commit", sha: COMMIT } };
    routes[`https://raw.githubusercontent.com/${repo}/${COMMIT}/LICENSE`] = "MIT";
    // The browser and speech records for this commit are kept (no requests);
    // the Electron version's file is missing (unknown, a note).
    writeFileSync(join(dir, "t3code.json"), JSON.stringify({ name: "t3code", version: "0.1.9", assets: {},
      browser: { source: sourceUrl(repo, COMMIT) }, speech: { checked: catalogUrl(repo, COMMIT), fromCatalog: true } }));
    const node = { tagName: tag, isPrerelease: false, isDraft: false, createdAt: "2026-11-12T00:00:00Z", releaseAssets: { nodes: [...names, "SHA256SUMS"].map((name) => ({ name })) } };
    const doc = { data: { repository: { latestRelease: node, releases: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } } };
    const r = new Report(dir);
    await resolveT3code(r, new Set(), false, new Set(["t3code"]), new Date("2026-11-13T00:00:00Z"), async () => doc);
    assert.deepEqual(r.observations.filter((o) => o.kind === "resolve-failed"), []);
    assert.deepEqual(r.changed.map((c) => [c.name, c.to]), [["t3code", "0.2.0"]]);
    assert.equal(r.pins.get("t3code")!.assets["aarch64-linux"].hash, sri("sha256", hex("d")));
  } finally {
    if (env === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = env;
    rmSync(dir, { recursive: true, force: true });
  }
});
