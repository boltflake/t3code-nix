// The release watcher (watcher/src/watcher.ts) against a fake fetch and KV.
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffUntil, CRONS, health, HEARTBEAT_MS, run, type Env, type KV } from "../watcher/src/watcher.ts";
import { BOAT, VENDOR_URLS } from "../shared/sources.ts";

const A = "* * * * *", B = "*/1 * * * *";
const t0 = new Date(Date.UTC(2026, 10, 13, 12, 1)); // minute 1: not a cursor minute
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

class FakeKV implements KV {
  data = new Map<string, string>();
  reads = 0;
  writes = 0;
  failWrites = false;
  async get(k: string) { this.reads++; return this.data.get(k) ?? null; }
  async put(k: string, v: string) {
    if (this.failWrites) throw new Error("quota");
    this.writes++;
    this.data.set(k, v);
  }
}

const files = (v: string) => [`t3-${v}-linux-x64.tar.gz`, `t3-${v}-linux-arm64.tar.gz`, `T3-Code-${v}-amd64.deb`, `T3-Code-${v}-arm64.deb`, "SHA256SUMS"].map((name) => ({ name }));
const rel = (tagName: string, pre: boolean, complete = true) =>
  ({ tagName, isPrerelease: pre, isDraft: false, createdAt: "2026-11-12T00:00:00Z", releaseAssets: { nodes: complete ? files(tagName.slice(1)) : [] } });
const node = (tag: string, complete = true) => ({ tagName: tag, isDraft: false, isPrerelease: false, a0: { totalCount: 1 }, a1: { totalCount: complete ? 1 : 0 } });
const gh = (tag: string, complete = true) => ({ latestRelease: node(tag, complete) });
// opencode is read by `tags`: the highest complete 2.x-or-later among its
// newest releases, so not 1.x (1.99.0, the newest created), one still
// uploading (2.0.1), or another line's tag.
const oc = { releases: { nodes: [node("process-daemon-v9.0.0"), node("v1.99.0"), node("v2.0.1", false), node("v2.0.0"), node("v1.9.0")] } };

/** The world: versions upstream, and how each URL answers. */
function world() {
  const w = {
    codex: "rust-v0.167.2", claude: "2.1.322", grok: "1.0.77", muse: "1.4.15", agy: "1.2.0", kiro: "3.2.1", cursor: "2026.11.01-abc", boat: "1.0.100",
    browser: "v0.43.0",
    // NixOS: each channel's revision, and how the newest release's channel redirects (null: 404).
    channels: { "nixos-unstable": "a".repeat(40), "nixos-26.05": "b".repeat(40), "nixos-26.11": "c".repeat(40) } as Record<string, string>,
    release: null as string | null,
    t3: { latest: rel("v0.1.9", false), nodes: [rel("v0.1.10-nightly.20261112.4580", true), rel("v0.1.9", false)], hasNextPage: false },
    override: new Map<string, () => Response>(),
    assetPages: {} as Record<string, { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { name: string }[] }>,
    calls: [] as { url: string; body?: string }[],
    dispatches: 0,
  };
  const f = async (url: string, init?: RequestInit) => {
    w.calls.push({ url, body: init?.body as string | undefined });
    const o = w.override.get(url);
    if (o) return o();
    if (url === "https://api.github.com/graphql") {
      const q = JSON.parse(init!.body as string).query as string;
      const t3 = { latestRelease: w.t3.latest, releases: { pageInfo: { hasNextPage: w.t3.hasNextPage, endCursor: "c" }, nodes: w.t3.nodes } };
      // A release's further assets (shared/sources.ts fillAssets).
      const tagAsked = /release\(tagName: "([^"]+)"\)/.exec(q)?.[1];
      if (tagAsked) return Response.json({ data: { repository: { release: { releaseAssets: w.assetPages[tagAsked] } } } });
      if (q.includes("after:")) return Response.json({ data: { t3: { releases: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [rel("v0.1.10-nightly.20261111.4500", true)] } } } });
      return Response.json({ data: { t3, p0: gh(w.codex), p1: gh("v0.0.16"), p2: oc, p3: gh("v0.9.0"), p4: gh(w.browser) } });
    }
    if (url.endsWith("/actions/workflows/update.yml/dispatches")) { w.dispatches++; return new Response(null, { status: 204 }); }
    const channel = /^https:\/\/channels\.nixos\.org\/([^/]+)(\/git-revision)?$/.exec(url);
    if (channel && channel[2]) return w.channels[channel[1]] ? new Response(`${w.channels[channel[1]]}\n`) : new Response("no", { status: 404 });
    if (channel && init?.method === "HEAD") {
      return w.release ? new Response(null, { status: 302, headers: { location: w.release } }) : new Response("no", { status: 404 });
    }
    const text: Record<string, () => string> = {
      [`${VENDOR_URLS.claude}/latest`]: () => `${w.claude}\n`,
      [`${VENDOR_URLS.grok}/stable`]: () => w.grok,
      [VENDOR_URLS.museChannel]: () => JSON.stringify({ version: w.muse }),
      [`${VENDOR_URLS.antigravity}/linux_amd64.json`]: () => JSON.stringify({ version: w.agy }),
      [`${VENDOR_URLS.kiro}/latest/manifest.json`]: () => JSON.stringify({ version: w.kiro }),
      [VENDOR_URLS.cursorInstall]: () => `curl https://downloads.cursor.com/lab/${w.cursor}/linux/x64/agent-cli-package.tar.gz`,
      [BOAT.endpoint("linux-x64")]: () => JSON.stringify({ channel: "prod", version: w.boat, tag: `boat-cli-v${w.boat}` }),
    };
    return text[url] ? new Response(text[url]()) : new Response("no", { status: 404 });
  };
  return { w, f: f as (url: string, init?: RequestInit) => Promise<Response> };
}
const env = (kv: FakeKV): Env => ({ STATE: kv, GITHUB_TOKEN: "t", HEALTH_TOKEN: "h", REPO: "swsammy/t3code-nix", CF_VERSION: { id: "v1" } });

test("watcher: first sight records every version and dispatches once", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  const { state, written } = await run(A, env(kv), t0, f);
  assert.ok(written);
  assert.deepEqual(Object.fromEntries(Object.entries(state.entries).map(([k, e]) => [k, e.version])), {
    "t3code/latest": "0.1.9", "t3code/nightly": "0.1.10-nightly.20261112.4580",
    codex: "0.167.2", fx: "0.0.16", opencode: "2.0.0", pi: "0.9.0", "claude-code": "2.1.322", grok: "1.0.77", "agent-browser": "0.43.0",
    "nixos/nixos-unstable": "a".repeat(40), "nixos/nixos-26.05": "b".repeat(40),
  });
  assert.deepEqual([w.dispatches, state.dispatch.pending, state.deployed], [1, false, "v1"]);
  assert.equal(kv.reads, 1);
  // One GraphQL query: the nightly is on the first page.
  assert.equal(w.calls.filter((c) => c.url.endsWith("/graphql")).length, 1);
});

test("watcher: nothing new writes nothing until the heartbeat", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(A, env(kv), t0, f);
  const writes = kv.writes;
  assert.equal((await run(A, env(kv), at(1), f)).written, false);
  assert.deepEqual([kv.writes, w.dispatches], [writes, 1]);
  assert.equal((await run(A, env(kv), at(HEARTBEAT_MS / 60_000), f)).written, true);
  assert.equal(w.dispatches, 1);
});

test("watcher: a new version dispatches; a failed dispatch is retried", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(A, env(kv), t0, f);
  w.claude = "2.1.323";
  const url = "https://api.github.com/repos/swsammy/t3code-nix/actions/workflows/update.yml/dispatches";
  w.override.set(url, () => new Response("down", { status: 502 }));
  const r1 = await run(A, env(kv), at(1), f);
  assert.deepEqual([r1.written, r1.state.dispatch.pending, r1.state.dispatch.error?.kind], [true, true, "http"]);
  assert.equal(r1.state.entries["claude-code"].version, "2.1.323");
  w.override.delete(url);
  const r2 = await run(A, env(kv), at(2), f);
  assert.deepEqual([r2.state.dispatch, w.dispatches], [{ pending: false }, 2]);
});

test("watcher: a rate limit backs the source off; auth errors are their own kind", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  w.override.set("https://api.github.com/graphql", () => new Response("slow down", { status: 403, headers: { "retry-after": "300", "x-ratelimit-remaining": "0" } }));
  const r1 = await run(A, env(kv), t0, f);
  assert.equal(r1.state.sources.github.error?.kind, "rate-limit");
  assert.equal(r1.state.sources.github.retryAt, at(5).toISOString());
  const before = w.calls.filter((c) => c.url.endsWith("/graphql")).length;
  await run(A, env(kv), at(2), f);
  assert.equal(w.calls.filter((c) => c.url.endsWith("/graphql")).length, before, "not polled while backed off");
  w.override.set("https://api.github.com/graphql", () => new Response("bad token", { status: 401 }));
  const r3 = await run(A, env(kv), at(6), f);
  assert.equal(r3.state.sources.github.error?.kind, "auth");
  // GitHub's primary rate limit: a 403 with no Retry-After, only
  // x-ratelimit-remaining 0 and the reset time.
  const reset = String(Math.floor(at(10).getTime() / 1000));
  w.override.set("https://api.github.com/graphql", () => new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }));
  const r3a = await run(A, env(new FakeKV()), at(6), f);
  assert.equal(r3a.state.sources.github.error?.kind, "rate-limit");
  assert.equal(r3a.state.sources.github.retryAt, at(10).toISOString());
  // A plain 403 (no rate-limit headers) is an auth error too, not a rate limit.
  w.override.set("https://api.github.com/graphql", () => new Response("forbidden", { status: 403 }));
  const r3b = await run(A, env(new FakeKV()), at(6), f);
  assert.equal(r3b.state.sources.github.error?.kind, "auth");
  assert.equal(r3b.state.sources.github.retryAt, undefined);
  w.override.delete("https://api.github.com/graphql");
  const r4 = await run(A, env(kv), at(7), f);
  assert.equal(r4.state.sources.github.error, undefined);
});

test("watcher: errors and recoveries wait for the heartbeat", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(A, env(kv), t0, f);
  w.override.set("https://api.github.com/graphql", () => new Response("bad token", { status: 401 }));
  const saved = () => JSON.parse(kv.data.get("state:a")!).sources.github.error;
  assert.equal((await run(A, env(kv), at(1), f)).written, false);
  assert.equal(saved(), undefined);
  await run(A, env(kv), at(HEARTBEAT_MS / 60_000), f);
  assert.equal(saved()?.kind, "auth");
  w.override.delete("https://api.github.com/graphql");
  assert.equal((await run(A, env(kv), at(HEARTBEAT_MS / 60_000 + 1), f)).written, false);
  await run(A, env(kv), at(2 * HEARTBEAT_MS / 60_000), f);
  assert.equal(saved(), undefined);
});

test("watcher: a dispatch kept rate limited writes once, then only heartbeats", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  const url = "https://api.github.com/repos/swsammy/t3code-nix/actions/workflows/update.yml/dispatches";
  w.override.set(url, () => new Response("slow", { status: 429, headers: { "retry-after": "60" } }));
  await run(A, env(kv), t0, f); // first sight: one write
  const first = kv.writes;
  for (let m = 1; m < 14; m++) await run(A, env(kv), at(m), f);
  assert.equal(kv.writes, first, "a renewed backoff waits for the heartbeat");
  await run(A, env(kv), at(15), f);
  assert.equal(kv.writes, first + 1);
});

test("watcher: Retry-After as an HTTP date; a GraphQL FORBIDDEN is an auth error", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  w.override.set(`${VENDOR_URLS.grok}/stable`, () => new Response("slow", { status: 429, headers: { "retry-after": at(7).toUTCString() } }));
  w.override.set("https://api.github.com/graphql", () => Response.json({ errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }));
  const r = await run(A, env(kv), t0, f);
  assert.equal(r.state.sources.grok.retryAt, at(7).toISOString());
  assert.equal(r.state.sources.github.error?.kind, "auth");
});

test("watcher: an HTTP 200 GraphQL reply with errors is a failure", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  w.override.set("https://api.github.com/graphql", () => Response.json({ errors: [{ message: "Something went wrong" }] }));
  const r = await run(A, env(kv), t0, f);
  assert.equal(r.state.sources.github.error?.kind, "parse");
  assert.equal(r.state.entries.codex, undefined);
});

test("watcher: an absurd or far-off Retry-After is cut to an hour, and never stops the cron", async () => {
  for (const after of ["99999999999999", "315360000"]) { // past any valid date; ten years
    const kv = new FakeKV();
    const { w, f } = world();
    w.override.set(VENDOR_URLS.museChannel, () => new Response("slow", { status: 429, headers: { "retry-after": after } }));
    const r = await run(B, env(kv), t0, f);
    assert.equal(r.state.sources.muse.retryAt, at(60).toISOString(), after);
    assert.ok(r.state.entries["kiro-cli"], "the cron's other sources still ran");
    w.override.delete(VENDOR_URLS.museChannel);
    const back = await run(B, env(kv), at(61), f);
    assert.equal(back.state.sources.muse.error, undefined, "asked again after the hour");
  }
  // A retry time in the past, or one saved before the cap, doesn't hold.
  assert.equal(backoffUntil(t0.getTime() - 1, t0.getTime()), null);
  assert.equal(backoffUntil(NaN, t0.getTime()), null);
  const kv = new FakeKV();
  const { f } = world();
  await run(B, env(kv), t0, f);
  const saved = JSON.parse(kv.data.get("state:b")!);
  saved.sources.muse = { retryAt: "2036-01-01T00:00:00.000Z" };
  kv.data.set("state:b", JSON.stringify(saved));
  const healed = await run(B, env(kv), at(1), f);
  assert.equal(healed.state.sources.muse.retryAt, undefined, "a stored far-off backoff is ignored");
});

test("watcher: a GitHub repository that isn't found leaves the others' data good", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  w.t3.latest = rel("v0.2.0", false);
  w.t3.nodes = [rel("v0.2.0", false)];
  const real = f;
  const partial = async (url: string, init?: RequestInit) => {
    const res = await real(url, init);
    if (url !== "https://api.github.com/graphql") return res;
    const doc = await res.json();
    doc.data.p1 = null; // fx's repository is gone
    doc.errors = [{ type: "NOT_FOUND", path: ["p1"], message: "Could not resolve to a Repository" }];
    return Response.json(doc);
  };
  const r = await run(A, env(kv), t0, partial);
  assert.equal(r.state.sources.github.error, undefined);
  assert.equal(r.state.entries["t3code/latest"]?.version, "0.2.0", "a new T3 Code is still seen");
  assert.equal(r.state.entries.codex?.version, "0.167.2");
  assert.equal(r.state.entries.fx, undefined);
  assert.equal(w.dispatches, 1);
  // T3 Code's own repository missing: the providers still count.
  const noT3 = async (url: string, init?: RequestInit) => {
    const res = await real(url, init);
    if (url !== "https://api.github.com/graphql") return res;
    const doc = await res.json();
    doc.data.t3 = null;
    doc.errors = [{ type: "NOT_FOUND", path: ["t3"] }];
    return Response.json(doc);
  };
  const r2 = await run(A, env(new FakeKV()), t0, noT3);
  assert.equal(r2.state.sources.github.error, undefined);
  assert.equal(r2.state.entries.codex?.version, "0.167.2");
  assert.equal(r2.state.entries["t3code/latest"], undefined);
  // Any other error still fails the source.
  const other = async (url: string, init?: RequestInit) => url === "https://api.github.com/graphql"
    ? Response.json({ data: { t3: null }, errors: [{ type: "NOT_FOUND" }, { type: "FORBIDDEN" }] }) : real(url, init);
  assert.equal((await run(A, env(new FakeKV()), t0, other)).state.sources.github.error?.kind, "auth");
});

test("watcher: an incomplete release waits; paging stops at the first complete nightly", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  w.t3.nodes = [rel("v0.1.10-nightly.20261112.4600", true, false), rel("v0.1.9", false)];
  w.t3.hasNextPage = true;
  const r = await run(A, env(kv), t0, f);
  // The incomplete one isn't seen; page 2 has the newest complete nightly.
  assert.equal(r.state.entries["t3code/nightly"].version, "0.1.10-nightly.20261111.4500");
  assert.equal(w.calls.filter((c) => c.url.endsWith("/graphql")).length, 2);
  w.codex = "rust-v0.168.0";
  w.override.set("https://api.github.com/graphql", () => Response.json({ data: { t3: { latestRelease: w.t3.latest, releases: { pageInfo: { hasNextPage: false }, nodes: [] } },
    p0: gh("rust-v0.168.0", false), p1: gh("v0.0.16"), p2: oc, p3: gh("v0.9.0") } }));
  const r2 = await run(A, env(kv), at(1), f);
  assert.equal(r2.state.entries.codex.version, "0.167.2", "missing an asset: not seen yet");
});

test("watcher: no `tags` match in the window keeps opencode's entry, and the source stays healthy", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(A, env(kv), t0, f);
  w.override.set("https://api.github.com/graphql", () => Response.json({ data: { t3: { latestRelease: w.t3.latest, releases: { pageInfo: { hasNextPage: false }, nodes: w.t3.nodes } },
    p0: gh(w.codex), p1: gh("v0.0.16"), p2: { releases: { nodes: [node("v1.19.7"), node("process-daemon-v1.0.0")] } }, p3: gh("v0.9.0") } }));
  const r = await run(A, env(kv), at(1), f);
  assert.equal(r.state.entries.opencode.version, "2.0.0");
  assert.equal(r.state.sources.github.error, undefined);
});

test("watcher: cron B polls its vendors, cursor only every 5th minute", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  const r1 = await run(B, env(kv), t0, f);
  assert.deepEqual(Object.keys(r1.state.entries).sort(), ["antigravity", "boat", "kiro-cli", "muse"]);
  assert.equal(r1.state.entries.boat.version, "1.0.100", "the endpoint's plain version, not the tag");
  assert.ok(!w.calls.some((c) => c.url === VENDOR_URLS.cursorInstall));
  const r2 = await run(B, env(kv), at(4), f); // minute 5
  assert.equal(r2.state.entries["cursor-agent"].version, "2026.11.01-abc");
  assert.ok(!w.calls.some((c) => c.url.endsWith("/graphql")), "cron B never asks GitHub for releases");
  assert.deepEqual(CRONS[B].sources.map((s) => s.name), ["muse", "antigravity", "kiro-cli", "boat", "cursor-agent"]);
  assert.ok(CRONS[B].sources.length <= 6, "a Worker has at most 6 connections open at once");
});

test("watcher: a source that names no version fails on its own", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  w.muse = "";
  const r = await run(B, env(kv), t0, f);
  assert.equal(r.state.sources.muse.error?.kind, "parse");
  assert.equal(r.state.entries["kiro-cli"].version, "3.2.1");
});

test("watcher: a failed KV write doesn't stop polling or dispatching", async () => {
  const kv = new FakeKV();
  kv.failWrites = true;
  const { w, f } = world();
  const r = await run(A, env(kv), t0, f);
  assert.deepEqual([r.written, w.dispatches], [false, 1]);
});

test("health: 404 without the token, and no KV read", async () => {
  const kv = new FakeKV();
  for (const auth of [undefined, "Bearer wrong", "Bearer hh", "Bearer x", "bearer h", "h"]) {
    const res = await health(new Request("https://w/health", { headers: auth ? { authorization: auth } : {} }), env(kv));
    assert.equal(res.status, 404);
  }
  assert.equal((await health(new Request("https://w/other", { headers: { authorization: "Bearer h" } }), env(kv))).status, 404);
  assert.equal(kv.reads, 0);
  const { f } = world();
  await run(A, env(kv), t0, f);
  const res = await health(new Request("https://w/health", { headers: { authorization: "Bearer h" } }), env(kv));
  const body: any = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.deployed, "v1");
  assert.equal(body.keys["state:a"].entries.codex.version, "0.167.2");
  assert.equal(body.keys["state:b"].written, null);
});

test("watcher: errors changing kind cost only heartbeats", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(A, env(kv), t0, f);
  const first = kv.writes;
  let n = 0;
  // HTTP 500 and a dropped connection, by turns, for an hour.
  w.override.set(`${VENDOR_URLS.grok}/stable`, () => {
    if (n++ % 2) throw new TypeError("fetch failed");
    return new Response("down", { status: 500 });
  });
  for (let m = 1; m <= 60; m++) await run(A, env(kv), at(m), f);
  // A heartbeat every 15 minutes, nothing else.
  assert.equal(kv.writes - first, 60 / (HEARTBEAT_MS / 60_000));
});

test("watcher: sources failing and recovering by turns cost only heartbeats", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(A, env(kv), t0, f);
  const first = kv.writes;
  let m = 0;
  // grok fails on even minutes, claude on odd ones, for a day.
  w.override.set(`${VENDOR_URLS.grok}/stable`, () => (m % 2 ? new Response(w.grok) : new Response("down", { status: 500 })));
  w.override.set(`${VENDOR_URLS.claude}/latest`, () => (m % 2 ? new Response("down", { status: 500 }) : new Response(w.claude)));
  for (m = 1; m <= 24 * 60; m++) await run(A, env(kv), at(m), f);
  assert.equal(kv.writes - first, 24 * 60 / (HEARTBEAT_MS / 60_000));
});

test("watcher: a failure keeps its first `since` while its kind changes", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  w.override.set(`${VENDOR_URLS.grok}/stable`, () => new Response("down", { status: 500 }));
  const r1 = await run(A, env(kv), t0, f);
  w.override.set(`${VENDOR_URLS.grok}/stable`, () => { throw new TypeError("fetch failed"); });
  const r2 = await run(A, env(kv), at(1), f);
  assert.deepEqual([r2.state.sources.grok.error?.kind, r2.state.sources.grok.error?.since], ["network", r1.state.sources.grok.error?.since]);
});

test("watcher: a release no channel rule knows dispatches at once", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(A, env(kv), t0, f);
  // Newer than GitHub's latest release (older unknown releases don't count).
  w.t3.nodes = [{ ...rel("v0.2.0-canary.1", true), createdAt: "2026-11-13T00:00:00Z" }, ...w.t3.nodes];
  const r = await run(A, env(kv), at(1), f);
  assert.deepEqual([r.state.entries["t3code/unknown"].version, w.dispatches], ["v0.2.0-canary.1", 2]);
});

test("watcher: t3code's paging stops at three pages", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  w.t3.nodes = [rel("v0.1.9", false)];
  w.t3.hasNextPage = true;
  w.override.set("https://api.github.com/graphql", () => Response.json({ data: {
    t3: { latestRelease: w.t3.latest, releases: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [rel("v0.1.10-preview.1", true)] } },
    p0: gh(w.codex), p1: gh("v0.0.16"), p2: oc, p3: gh("v0.9.0") } }));
  await run(A, env(kv), t0, f);
  assert.equal(w.calls.filter((c) => c.url.endsWith("/graphql")).length, 3);
});

test("watcher: a long backoff after an expired one is saved at once", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(A, env(kv), t0, f);
  const url = `${VENDOR_URLS.grok}/stable`;
  w.override.set(url, () => new Response("slow", { status: 429, headers: { "retry-after": "900" } }));
  assert.equal((await run(A, env(kv), at(1), f)).written, true); // a heartbeat long: saved
  const saved = () => JSON.parse(kv.data.get("state:a")!).sources.grok.retryAt;
  assert.equal(saved(), at(16).toISOString());
  w.claude = "2.1.323";
  await run(A, env(kv), at(10), f); // a release: written, so no heartbeat is due at 17
  // Still limited when the backoff ends; the new, longer one is saved at once.
  w.override.set(url, () => new Response("slow", { status: 429, headers: { "retry-after": "3600" } }));
  assert.equal((await run(A, env(kv), at(17), f)).written, true);
  assert.equal(saved(), at(77).toISOString());
});

test("watcher: cron B's heartbeats land on cursor's minutes, so its state is saved both ways", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(B, env(kv), at(2), f); // first write at :03, not a cursor minute
  const saved = () => JSON.parse(kv.data.get("state:b")!).sources["cursor-agent"]?.error?.kind;
  w.override.set(VENDOR_URLS.cursorInstall, () => new Response("down", { status: 500 }));
  for (let m = 3; m <= 40; m++) await run(B, env(kv), at(m), f);
  assert.equal(saved(), "http", "the failure reached KV");
  w.kiro = "3.2.2";
  await run(B, env(kv), at(41), f); // a release moves the last write to :42
  w.override.delete(VENDOR_URLS.cursorInstall);
  for (let m = 42; m <= 80; m++) await run(B, env(kv), at(m), f);
  assert.equal(saved(), undefined, "the recovery reached KV");
  // Every heartbeat was on a cursor minute.
  assert.equal(new Date(JSON.parse(kv.data.get("state:b")!).written).getUTCMinutes() % 5, 0);
});

test("watcher: releases off cursor's minutes can't put off its heartbeat", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(B, env(kv), at(2), f);
  const saved = () => JSON.parse(kv.data.get("state:b")!).sources["cursor-agent"]?.error?.kind;
  w.override.set(VENDOR_URLS.cursorInstall, () => new Response("down", { status: 500 }));
  let k = 0;
  for (let m = 3; m <= 120; m++) {
    if (m % 10 === 0) w.kiro = `3.9.${++k}`; // a kiro release at :01, :11, :21 … (minute m+1)
    await run(B, env(kv), at(m), f);
  }
  assert.equal(saved(), "http", "the failure reached KV");
  w.override.delete(VENDOR_URLS.cursorInstall);
  for (let m = 121; m <= 240; m++) {
    if (m % 10 === 0) w.kiro = `3.9.${++k}`;
    await run(B, env(kv), at(m), f);
  }
  assert.equal(saved(), undefined, "the recovery reached KV");
});

test("watcher: NixOS channels follow the newest release once it's out of beta", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  const entries = async (t: Date) => Object.keys((await run(A, env(kv), t, f)).state.entries).filter((k) => k.startsWith("nixos/")).sort();
  assert.deepEqual(await entries(t0), ["nixos/nixos-26.05", "nixos/nixos-unstable"], "26.11 isn't out (404)");
  w.release = "https://releases.nixos.org/nixos/26.11-beta/nixos-26.11beta100.cccccccccccc";
  assert.deepEqual(await entries(at(1)), ["nixos/nixos-26.05", "nixos/nixos-unstable"], "in beta: not followed");
  w.release = "https://releases.nixos.org/nixos/26.11/nixos-26.11.100.cccccccccccc";
  const kv2 = new FakeKV();
  const { state } = await run(A, env(kv2), at(2), f);
  assert.equal(state.entries["nixos/nixos-26.11"]?.version, "c".repeat(40));
  // At most 6 requests in flight in cron A: the three channel requests come two, then one.
  assert.ok(w.calls.filter((c) => c.url.startsWith("https://channels.nixos.org/")).length >= 3);
});

test("watcher: a release whose required files are past the first 100 assets is still complete", async () => {
  const { w, f } = world();
  const extra = Array.from({ length: 100 }, (_, i) => ({ name: `extra-${i}.zip` }));
  w.t3.latest = { ...rel("v0.2.0", false), releaseAssets: { nodes: extra, pageInfo: { hasNextPage: true, endCursor: "p2" } } } as any;
  w.t3.nodes = [w.t3.latest as any, rel("v0.1.10-nightly.20261112.4580", true)];
  w.assetPages["v0.2.0"] = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: files("0.2.0") };
  const { state } = await run(A, env(new FakeKV()), t0, f);
  assert.equal(state.entries["t3code/latest"]?.version, "0.2.0");
});

test("watcher: skipped previews' assets aren't paged; a budget or page failure costs only t3code's result", async () => {
  const { w, f } = world();
  const huge = (tag: string) => ({ ...rel(tag, true, false), releaseAssets: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "x" } } });
  // Six previews with more assets: skipped by the channel rules, never paged.
  w.t3.nodes = [...Array.from({ length: 6 }, (_, i) => huge(`v0.2.0-preview.20261112.${i}`)), rel("v0.1.10-nightly.20261112.4580", true), rel("v0.1.9", false)];
  const pages = () => w.calls.filter((c) => c.body?.includes("release(tagName:")).length;
  let r = await run(A, env(new FakeKV()), t0, f);
  assert.equal(pages(), 0);
  assert.equal(r.state.entries["t3code/latest"]?.version, "0.1.9");
  // A pickable release whose further page fails: no t3code version this run, the others still count.
  w.t3.latest = { ...rel("v0.2.0", false), releaseAssets: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "p2" } } } as any;
  w.t3.nodes = [w.t3.latest as any];
  r = await run(A, env(new FakeKV()), t0, f); // w.assetPages has no v0.2.0: the page comes back empty
  assert.equal(r.state.entries["t3code/latest"], undefined);
  assert.equal(r.state.entries.codex?.version, "0.167.2");
});

test("watcher: only the deciding releases' assets are paged, and a run that can't read them says so softly", async () => {
  const { w, f } = world();
  const more = (r: any, end = "p2") => ({ ...r, releaseAssets: { nodes: [], pageInfo: { hasNextPage: true, endCursor: end } } });
  // The latest channel's release and the newest nightly are complete on the first page: older nightlies with more pages don't matter.
  w.t3.latest = rel("v0.2.0", false) as any;
  w.t3.nodes = [rel("v0.2.1-nightly.20261113.9", true), ...[1, 2, 3, 4, 5].map((i) => more(rel(`v0.2.0-nightly.20261110.${i}`, true))), w.t3.latest as any];
  const pages = () => w.calls.filter((c) => c.body?.includes("release(tagName:")).length;
  let r = await run(A, env(new FakeKV()), t0, f);
  assert.equal(pages(), 0);
  assert.deepEqual([r.state.entries["t3code/latest"]?.version, r.state.entries["t3code/nightly"]?.version], ["0.2.0", "0.2.1-nightly.20261113.9"]);
  // The deciding ones need more pages than the budget: no t3code version this run (not an
  // older complete nightly instead), a soft error, and the other sources still count.
  w.t3.latest = more(rel("v0.3.0", false), "s2") as any;
  w.t3.nodes = [...[9, 8, 7, 6].map((i) => more(rel(`v0.3.1-nightly.2026111${i}.1`, true), `n${i}`)), rel("v0.2.1-nightly.20261113.9", true), w.t3.latest as any];
  for (const t of ["v0.3.0", "v0.3.1-nightly.20261119.1", "v0.3.1-nightly.20261118.1", "v0.3.1-nightly.20261117.1", "v0.3.1-nightly.20261116.1"]) {
    w.assetPages[t] = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  }
  const kv = new FakeKV();
  r = await run(A, env(kv), t0, f);
  assert.equal(r.state.entries["t3code/nightly"], undefined, "not v0.2.1, which a partial read would pick");
  assert.equal(r.state.entries["t3code/latest"], undefined);
  assert.equal(r.state.entries.codex?.version, "0.167.2");
  assert.match(r.state.sources.github?.error?.message ?? "", /^t3code not read this run: .*budget \(4\)/);
});

test("watcher: a t3code page that's rate limited keeps the back-off and the kind, and the other packages' entries", async () => {
  const { w, f } = world();
  // A release page (more releases) rate limited: codex still counts.
  w.t3.nodes = [rel("v0.1.9", false)];
  w.t3.hasNextPage = true;
  const original = f;
  const limited = (async (url: string, init?: RequestInit) => {
    const q = url === "https://api.github.com/graphql" ? JSON.parse(init!.body as string).query as string : "";
    if (q.includes("after:") || q.includes("release(tagName:")) {
      return new Response("slow down", { status: 429, headers: { "retry-after": "3600" } });
    }
    return original(url, init);
  }) as typeof f;
  let r = await run(A, env(new FakeKV()), t0, limited);
  assert.equal(r.state.entries.codex?.version, "0.167.2");
  assert.equal(r.state.entries["t3code/latest"], undefined);
  assert.equal(r.state.sources.github?.error?.kind, "rate-limit");
  assert.equal(r.state.sources.github?.error?.unread, "t3code/");
  assert.ok(r.state.sources.github?.retryAt, "the back-off is kept");
  assert.ok(r.written, "a back-off over a heartbeat is saved at once");
  // An asset page rate limited: the same.
  w.t3.hasNextPage = false;
  w.t3.latest = { ...rel("v0.2.0", false), releaseAssets: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "p2" } } } as any;
  w.t3.nodes = [w.t3.latest as any];
  r = await run(A, env(new FakeKV()), t0, limited);
  assert.deepEqual([r.state.entries.codex?.version, r.state.sources.github?.error?.kind, !!r.state.sources.github?.retryAt], ["0.167.2", "rate-limit", true]);
});

test("watcher: a 403 with Retry-After alone is GitHub's secondary rate limit, not auth", async () => {
  const { w, f } = world();
  w.override.set("https://api.github.com/graphql", () => new Response("secondary", { status: 403, headers: { "retry-after": "120" } }));
  const r = await run(A, env(new FakeKV()), t0, f);
  assert.deepEqual([r.state.sources.github.error?.kind, r.state.sources.github.retryAt], ["rate-limit", at(2).toISOString()]);
});

test("watcher: a GraphQL UNAUTHORIZED is an auth error", async () => {
  const { w, f } = world();
  w.override.set("https://api.github.com/graphql", () => Response.json({ errors: [{ type: "UNAUTHORIZED", message: "Bad credentials" }] }));
  const r = await run(A, env(new FakeKV()), t0, f);
  assert.equal(r.state.sources.github.error?.kind, "auth");
});

test("watcher: a prerelease is never taken, even as a `tags` package's highest", async () => {
  const { f } = world();
  const base = f;
  const g = (async (url: string, init?: RequestInit) => {
    const res = await base(url, init);
    if (url !== "https://api.github.com/graphql" || JSON.parse(init!.body as string).query.includes("after:")) return res;
    const doc: any = await res.json();
    if (doc.data?.p2) doc.data.p2 = { releases: { nodes: [{ ...node("v2.1.0"), isPrerelease: true }, node("v2.0.0")] } };
    return Response.json(doc);
  }) as typeof f;
  const r = await run(A, env(new FakeKV()), t0, g);
  assert.equal(r.state.entries.opencode?.version, "2.0.0");
});

test("health: only GET, and never without a configured token", async () => {
  const kv = new FakeKV();
  const post = await health(new Request("https://w/health", { method: "POST", headers: { authorization: "Bearer h" } }), env(kv));
  assert.equal(post.status, 404);
  const unset = { ...env(kv), HEALTH_TOKEN: undefined as unknown as string };
  assert.equal((await health(new Request("https://w/health", { headers: { authorization: "Bearer undefined" } }), unset)).status, 404);
  const blank = { ...env(kv), HEALTH_TOKEN: "" };
  assert.equal((await health(new Request("https://w/health", { headers: { authorization: "Bearer " } }), blank)).status, 404);
  assert.equal(kv.reads, 0);
});

test("watcher: the dispatch asks for main, keeps its back-off and its first `since`, and saves a long back-off at once", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  const url = "https://api.github.com/repos/swsammy/t3code-nix/actions/workflows/update.yml/dispatches";
  await run(A, env(kv), t0, f);
  assert.deepEqual(w.calls.filter((c) => c.url === url).map((c) => JSON.parse(c.body!)), [{ ref: "main" }]);
  // A new version, the dispatch failing twice: the failure keeps its first `since`.
  w.claude = "2.1.323";
  w.override.set(url, () => new Response("down", { status: 502 }));
  const r1 = await run(A, env(kv), at(1), f);
  const r2 = await run(A, env(kv), at(2), f);
  assert.equal(r2.state.dispatch.error?.since, at(1).toISOString());
  assert.equal(r1.state.dispatch.error?.since, at(1).toISOString());
  // Nothing else to write: a back-off over a heartbeat is saved at once.
  let asked = 0;
  w.override.set(url, () => { asked++; return new Response("slow", { status: 429, headers: { "retry-after": "900" } }); });
  const r3 = await run(A, env(kv), at(3), f);
  assert.deepEqual([r3.written, r3.state.dispatch.retryAt, asked], [true, at(18).toISOString(), 1]);
  // Not asked again while backed off.
  const r4 = await run(A, env(kv), at(4), f);
  assert.deepEqual([asked, r4.state.dispatch.pending], [1, true]);
});

test("watcher: a whole failure after a partial one of the same kind is no longer partial", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  w.t3.nodes = [rel("v0.1.9", false)];
  w.t3.hasNextPage = true;
  let whole = false;
  const g = (async (url: string, init?: RequestInit) => {
    const q = url === "https://api.github.com/graphql" ? JSON.parse(init!.body as string).query as string : "";
    if (q && (whole || q.includes("after:"))) return new Response("slow down", { status: 429 });
    return f(url, init);
  }) as typeof f;
  const r1 = await run(A, env(kv), t0, g);
  assert.deepEqual([r1.state.sources.github.error?.kind, r1.state.sources.github.error?.unread], ["rate-limit", "t3code/"]);
  whole = true;
  const r2 = await run(A, env(kv), at(1), g);
  assert.deepEqual([r2.state.sources.github.error?.kind, r2.state.sources.github.error?.unread], ["rate-limit", undefined]);
});

test("watcher: a stored state of the wrong shape starts over", async () => {
  const kv = new FakeKV();
  kv.data.set("state:a", "{}");
  const { f } = world();
  const r = await run(A, env(kv), t0, f);
  assert.equal(r.state.entries.codex?.version, "0.167.2");
});

test("watcher: a NixOS channel's revision must be a commit, and a failing release check never picks the older channel", async () => {
  const { w, f } = world();
  w.channels["nixos-unstable"] = "<html>maintenance</html>";
  const bad = await run(A, env(new FakeKV()), t0, f);
  assert.equal(bad.state.sources.nixos.error?.kind, "parse");
  assert.deepEqual(Object.keys(bad.state.entries).filter((k) => k.startsWith("nixos/")), []);
  const w2 = world();
  w2.w.override.set("https://channels.nixos.org/nixos-26.11", () => new Response("oops", { status: 503 }));
  const down = await run(A, env(new FakeKV()), t0, w2.f);
  assert.equal(down.state.sources.nixos.error?.kind, "http");
  assert.deepEqual(Object.keys(down.state.entries).filter((k) => k.startsWith("nixos/")), []);
});

test("watcher: a source's short back-off waits for the heartbeat", async () => {
  const kv = new FakeKV();
  const { w, f } = world();
  await run(A, env(kv), t0, f);
  w.override.set(`${VENDOR_URLS.grok}/stable`, () => new Response("slow", { status: 429, headers: { "retry-after": "60" } }));
  const r = await run(A, env(kv), at(1), f);
  assert.deepEqual([r.written, r.state.sources.grok.retryAt], [false, at(2).toISOString()]);
});
