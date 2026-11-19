// The HTTP helper: one fetch per URL per run, and retries for reads.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clearFetched, getJson, getText, request, retryAfterMs, RETRIES, timing } from "../scripts/lib/util.ts";

const realFetch = globalThis.fetch;
const realSleep = timing.sleep;
let calls: { url: string; method: string }[] = [];
let waits: number[] = [];

/** Answer each call with the next reply: a status (with optional headers),
 * or an Error to throw. */
function replies(...answers: (number | [number, Record<string, string>] | Error)[]) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const a = answers.length > 1 ? answers.shift()! : answers[0];
    if (a instanceof Error) throw a;
    const [status, headers] = Array.isArray(a) ? a : [a, {}];
    return new Response(status === 200 ? JSON.stringify({ n: calls.length }) : "no", { status, headers });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  waits = [];
  clearFetched();
  timing.sleep = async (ms: number) => { waits.push(ms); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  timing.sleep = realSleep;
});

test("a URL is fetched once per run", async () => {
  replies(200);
  const [a, b] = await Promise.all([getJson("https://x/a"), getJson("https://x/a")]);
  assert.deepEqual([a, b, await getText("https://x/a")], [{ n: 1 }, { n: 1 }, '{"n":1}']);
  assert.equal(calls.length, 1);
  await getJson("https://x/b");
  assert.equal(calls.length, 2);
});

test("a failed fetch isn't remembered", async () => {
  replies(404, 200);
  await assert.rejects(getJson("https://x/a"), /HTTP 404/);
  assert.deepEqual(await getJson("https://x/a"), { n: 2 });
});

test("5xx and network errors are retried with back-off", async () => {
  replies(502, new TypeError("fetch failed"), 200);
  assert.deepEqual(await getJson("https://x/a"), { n: 3 });
  assert.deepEqual(waits, [timing.backoffMs, timing.backoffMs * 2]);
});

test("Retry-After is honoured (capped)", async () => {
  replies([429, { "retry-after": "5" }], [429, { "retry-after": "999" }], 200);
  await getJson("https://x/a");
  assert.deepEqual(waits, [5000, 30_000]);
});

test("gives up after the last attempt", async () => {
  replies(503);
  await assert.rejects(getJson("https://x/a"), /HTTP 503/);
  assert.equal(calls.length, RETRIES);
});

test("other errors fail at once", async () => {
  replies(404);
  await assert.rejects(getJson("https://x/a"), /HTTP 404/);
  assert.equal(calls.length, 1);
});

test("a POST is retried only when it's a read", async () => {
  replies(502, 200);
  await assert.rejects(request("https://x/a", { body: {} }), /HTTP 502/);
  assert.equal(calls.length, 1);
  replies(502, 200);
  calls = [];
  assert.deepEqual(JSON.parse((await request("https://x/a", { body: {}, read: true })).toString()), { n: 2 });
  assert.equal(calls.length, 2);
});

test("Retry-After as seconds or as an HTTP date", () => {
  const now = Date.UTC(2026, 10, 13, 12);
  assert.equal(retryAfterMs("5", now), 5000);
  assert.equal(retryAfterMs(new Date(now + 20_000).toUTCString(), now), 20_000);
  assert.equal(retryAfterMs(new Date(now - 5000).toUTCString(), now), 0);
  assert.equal(retryAfterMs("999", now), 30_000);
  assert.equal(retryAfterMs("soon", now), null);
  assert.equal(retryAfterMs(null, now), null);
});

test("a connection dropped while the body arrives is retried", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    if (n === 1) {
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"par')); c.error(new TypeError("terminated")); } });
      return new Response(body, { status: 200 });
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await getJson("https://x/a"), { ok: true });
  assert.equal(n, 2);
});

test("timeoutMs is one deadline across all attempts", async () => {
  let n = 0;
  // Every attempt stalls until it is aborted.
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    n++;
    return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new TypeError("aborted"))));
  }) as typeof fetch;
  const start = Date.now();
  await assert.rejects(request("https://x/big", { timeoutMs: 100 }), /aborted/);
  assert.equal(n, 1);
  assert.ok(Date.now() - start < 1000);
});

test("the GitHub token goes to api.github.com only, never to a vendor", async () => {
  const seen: Record<string, string | undefined> = {};
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen[url] = (init.headers as Record<string, string>).Authorization;
    return Response.json({ ok: true });
  }) as typeof fetch;
  const before = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "secret-token";
  try {
    for (const url of ["https://api.github.com/repos/o/r", "https://storage.googleapis.com/x", "https://github.com/o/r/releases", "https://api.github.com.evil.example/x"]) await getJson(url);
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = before;
  }
  assert.deepEqual(seen, {
    "https://api.github.com/repos/o/r": "Bearer secret-token",
    "https://storage.googleapis.com/x": undefined,
    "https://github.com/o/r/releases": undefined,
    "https://api.github.com.evil.example/x": undefined,
  });
});
