// The hourly backstop's checks (scripts/ci/health.ts).
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assess, errorLine, HANDOVER_MS, LAG_MS, STALE_MS, STUCK_MS } from "../scripts/ci/health.ts";
import type { Issue } from "../scripts/ci/gh.ts";

const now = new Date(Date.UTC(2026, 11, 1, 12, 17));
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const key = (entries: Record<string, [string, number]>, extra: Record<string, unknown> = {}) => ({
  entries: Object.fromEntries(Object.entries(entries).map(([k, [version, age]]) => [k, { version, firstSeen: ago(age) }])),
  sources: {}, dispatch: { pending: false }, deployed: "v1", written: ago(60_000), ...extra,
});
const health = (a: object, b: object = key({})) => ({ deployed: "v1", keys: { "state:a": a, "state:b": b } });
const kinds = (o: { kind: string; package: string | null }[]) => o.map((x) => `${x.kind}${x.package ? `:${x.package}` : ""}`).sort();
const issue = (key: string, version: string | null, state: "open" | "closed" = "open"): Issue =>
  ({ number: 1, title: "", state, body: `<!-- t3code-nix: ${JSON.stringify({ key, version, detail: "", clean: 0, reminded: null })} -->` });

test("health: no reply, or a stale heartbeat, is watcher-stalled and nothing else", () => {
  assert.deepEqual(kinds(assess(null, "HTTP 404", {}, [], now)), ["watcher-stalled"]);
  const stale = health(key({ codex: ["1", 0] }, { written: ago(STALE_MS + 1) }));
  const o = assess(stale, null, { codex: "0" }, [], now);
  assert.deepEqual(kinds(o), ["watcher-stalled"]);
  assert.match(o[0].detail, /state:a/);
});

test("health: a missing cron key or a heartbeat that isn't a date is no evidence", () => {
  assert.deepEqual(kinds(assess({ keys: { "state:a": key({}) } }, null, {}, [], now)), ["watcher-stalled"]);
  assert.deepEqual(kinds(assess(health(key({}, { written: "soon" })), null, {}, [], now)), ["watcher-stalled"]);
});

test("health: an auth error is watcher-auth, a rate limit isn't", () => {
  const h = health(key({}, { sources: { github: { error: { kind: "auth", message: "HTTP 401", since: ago(0) } } } }));
  assert.deepEqual(kinds(assess(h, null, {}, [], now)), ["watcher-auth"]);
  const d = health(key({}, { dispatch: { pending: true, error: { kind: "auth", message: "HTTP 403", since: ago(0) } } }));
  assert.match(assess(d, null, {}, [], now)[0].detail, /dispatch: HTTP 403/);
  const rl = health(key({}, { sources: { github: { error: { kind: "rate-limit", message: "429", since: ago(0) } } } }));
  assert.deepEqual(kinds(assess(rl, null, {}, [], now)), ["watcher-healthy"]);
});

test("health: a version seen over an hour ago and not on main is update-lag", () => {
  const h = health(key({
    codex: ["0.168.0", LAG_MS + 1],        // late
    grok: ["1.0.78", LAG_MS - 60_000],     // still within the hour
    "claude-code": ["2.1.322", LAG_MS * 3], // on main
    "t3code/latest": ["0.1.10", LAG_MS * 2], // both latest-channel pins
  }));
  const pins = { codex: "0.167.2", grok: "1.0.77", "claude-code": "2.1.322", t3code: "0.1.9", t3: "0.1.9" };
  assert.deepEqual(kinds(assess(h, null, pins, [], now)),
    ["lag-ok:claude-code", "update-lag:codex", "update-lag:t3", "update-lag:t3code", "watcher-healthy"]);
  // On its way: a run is going, and none that read upstream since the
  // release was seen has finished (it may wait behind a long one). Being on
  // main still counts.
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const run = (read: string, state: "running" | "done" | "cancelled" | "queued", finished: string | null = null) =>
    ({ read, running: state === "running", waiting: state === "queued", done: state === "done", ran: state === "done", finished });
  const lagging = (runs: ReturnType<typeof run>[]) => kinds(assess(h, null, pins, [], now, runs)).filter((k) => k.startsWith("update-lag"));
  assert.deepEqual(lagging([run(at(LAG_MS * 5), "running")]), [], "an older run going, a newer one waiting behind it");
  assert.deepEqual(lagging([run(at(LAG_MS / 2), "running"), run(at(LAG_MS * 5), "done")]), [], "the backstop's run, going now");
  // A run started since the release was seen finished without it: late,
  // even with the backstop's next run going (it would excuse every hour).
  assert.deepEqual(lagging([run(at(1000), "running"), run(at(LAG_MS / 2), "done")]),
    ["update-lag:codex", "update-lag:t3", "update-lag:t3code"]);
  // A replaced waiting run did nothing; nothing going (a stuck queue) lags.
  assert.deepEqual(lagging([run(at(1000), "running"), run(at(LAG_MS / 2), "cancelled")]), []);
  assert.deepEqual(lagging([run(at(LAG_MS / 2), "queued")]).length, 3);
  // Between two runs: the next waits for a runner just after one finished
  // (an older reading). Long after, a waiting run alone is a stuck queue.
  assert.deepEqual(lagging([run(at(1000), "queued"), run(at(LAG_MS * 2), "done", at(HANDOVER_MS - 60_000))]), []);
  assert.deepEqual(lagging([run(at(1000), "queued"), run(at(LAG_MS * 2), "done", at(HANDOVER_MS + 60_000))]).length, 3);
  // A waiting run just replaced by a newer dispatch isn't a handover: the
  // watcher's dispatches would otherwise hide a stuck queue.
  assert.deepEqual(lagging([run(at(1000), "queued"), run(at(LAG_MS * 2), "cancelled", at(60_000))]).length, 3);
});

test("health: an open issue about that exact version, or env-broken, explains the wait", () => {
  const h = health(key({ codex: ["0.168.0", LAG_MS * 2], fx: ["0.0.17", LAG_MS * 2] }));
  const pins = { codex: "0.167.2", fx: "0.0.16" };
  // An issue for another version doesn't hide this one.
  const issues = [issue("test-failed/codex/-", "0.168.0"), issue("test-failed/fx/-", "0.0.15"), issue("integrity/fx/-", "0.0.17", "closed")];
  assert.deepEqual(kinds(assess(h, null, pins, issues, now)), ["update-lag:fx", "watcher-healthy"]);
  assert.deepEqual(kinds(assess(h, null, pins, [issue("env-broken/-/-", null)], now)), ["watcher-healthy"]);
  // The update-lag issue itself explains nothing: it keeps being observed.
  assert.deepEqual(kinds(assess(h, null, { fx: "0.0.16" }, [issue("update-lag/fx/-", "0.0.17")], now)), ["update-lag:fx", "watcher-healthy"]);
  // Nor does a guard review: that version ships anyway.
  assert.deepEqual(kinds(assess(h, null, { fx: "0.0.16" }, [issue("guard-review/fx/-", "0.0.17")], now)), ["update-lag:fx", "watcher-healthy"]);
  // Nor does a downgrade: it holds nothing, so the pin lags as usual.
  assert.deepEqual(kinds(assess(h, null, { fx: "0.0.16" }, [issue("downgrade/fx/-", "0.0.17")], now)), ["update-lag:fx", "watcher-healthy"]);
});

test("health: entries that aren't packages (the unknown-release marker) are skipped", () => {
  const h = health(key({ "t3code/unknown": ["v9-canary", LAG_MS * 2] }));
  assert.deepEqual(kinds(assess(h, null, { t3code: "0.1.9" }, [], now)), ["watcher-healthy"]);
});

test("health: a lag issue closes once its version is on main or upstream moved past it", () => {
  const h = health(key({ codex: ["0.169.0", 60_000] })); // B, seen a minute ago
  const lagA = [issue("update-lag/codex/-", "0.168.0")];
  // A reached main; B is within its grace period.
  assert.deepEqual(kinds(assess(h, null, { codex: "0.168.0" }, lagA, now)), ["lag-ok:codex", "watcher-healthy"]);
  // A never reached main, but upstream now points at B.
  assert.deepEqual(kinds(assess(h, null, { codex: "0.167.2" }, lagA, now)), ["lag-ok:codex", "watcher-healthy"]);
  // Still about the current version and still late: stays open.
  const late = health(key({ codex: ["0.168.0", LAG_MS * 2] }));
  assert.deepEqual(kinds(assess(late, null, { codex: "0.167.2" }, lagA, now)), ["update-lag:codex", "watcher-healthy"]);
});

test("health: a failing source's entries may be old, so they raise no lag", () => {
  const err = (kind: string) => ({ error: { kind, message: "x", since: ago(60_000) } });
  const h = health(key({ codex: ["0.167.2", LAG_MS * 2], grok: ["1.0.77", LAG_MS * 2] }, { sources: { github: err("auth"), grok: err("http") } }));
  assert.deepEqual(kinds(assess(h, null, { codex: "0.168.0", grok: "1.0.78" }, [], now)), ["watcher-auth"]);
});

test("health: only GitHub's or the dispatch's auth errors are watcher-auth", () => {
  const h = health(key({}), key({}, { sources: { "cursor-agent": { error: { kind: "auth", message: "HTTP 403", since: ago(0) } } } }));
  assert.deepEqual(kinds(assess(h, null, {}, [], now)), ["watcher-healthy"]);
});

test("health: a source failing for over 6 hours is watcher-stalled", () => {
  const h = health(key({}, { sources: { github: { error: { kind: "parse", message: "NOT_FOUND", since: ago(STUCK_MS + 60_000) } } } }));
  const o = assess(h, null, {}, [], now);
  assert.deepEqual(kinds(o), ["watcher-stalled"]);
  assert.match(o[0].detail, /github/);
});

test("health: only a pin issue explains a lag; a resolve failure counts by tag or without a version", () => {
  const h = health(key({ codex: ["0.168.0", LAG_MS * 2], "t3code/latest": ["0.1.10", LAG_MS * 2] }));
  const pins = { codex: "0.167.2", t3code: "0.1.9", t3: "0.1.9" };
  const npm = [issue("latest-mismatch/codex/npm", "0.168.0")];
  assert.ok(kinds(assess(h, null, pins, npm, now)).includes("update-lag:codex"), "an npm issue explains nothing");
  const resolve = [issue("resolve-failed/codex/-", null), issue("resolve-failed/t3code/-", "v0.1.10"), issue("resolve-failed/t3/-", "v0.1.10")];
  assert.deepEqual(kinds(assess(h, null, pins, resolve, now)), ["watcher-healthy"]);
});

test("health: a fetch error reads the same every hour", () => {
  assert.equal(errorLine("curl: (28) Operation timed out after 20001 milliseconds with 0 bytes received\n"),
    "curl: (28) Operation timed out after the time limit with 0 bytes received");
  assert.equal(errorLine(""), "no reply");
});

test("health: only a resolve failure explains a lag without naming a version", () => {
  const h = health(key({ fx: ["0.0.17", LAG_MS * 2] }));
  assert.deepEqual(kinds(assess(h, null, { fx: "0.0.16" }, [issue("resolve-failed/fx/-", null)], now)), ["watcher-healthy"]);
  for (const k of ["integrity", "no-match", "latest-mismatch", "test-failed"]) {
    assert.deepEqual(kinds(assess(h, null, { fx: "0.0.16" }, [issue(`${k}/fx/-`, null)], now)), ["update-lag:fx", "watcher-healthy"], k);
  }
});
test("health: a `tags` package's watcher reading below the pin (a crowded window) is never update-lag; above it still is", () => {
  const h = health(key({ opencode: ["2.1.0", LAG_MS * 3] }));
  assert.deepEqual(kinds(assess(h, null, { opencode: "2.9.0" }, [], now)), ["watcher-healthy"]);
  const up = health(key({ opencode: ["3.0.0", LAG_MS * 3] }));
  assert.deepEqual(kinds(assess(up, null, { opencode: "2.9.0" }, [], now)), ["update-lag:opencode", "watcher-healthy"]);
});
test("health: a partial GitHub failure (t3code unread) still checks the packages it did read", () => {
  const partial = { github: { error: { kind: "rate-limit", message: "t3code not read this run: 429", since: ago(0), unread: "t3code/" } } };
  const h = health(key({ codex: ["0.168.0", LAG_MS * 2], "t3code/latest": ["0.2.0", LAG_MS * 2] }, { sources: partial }));
  assert.deepEqual(kinds(assess(h, null, { codex: "0.167.2", t3code: "0.1.9", t3: "0.1.9" }, [], now)), ["update-lag:codex", "watcher-healthy"],
    "codex's lag counts; t3code's stale entry doesn't");
  // A whole-source failure still distrusts every entry.
  const whole = health(key({ codex: ["0.168.0", LAG_MS * 2] }, { sources: { github: { error: { kind: "parse", message: "x", since: ago(0) } } } }));
  assert.deepEqual(kinds(assess(whole, null, { codex: "0.167.2" }, [], now)), ["watcher-healthy"]);
});
test("health: a failure younger than 6 hours isn't stuck", () => {
  const h = health(key({}, { sources: { github: { error: { kind: "parse", message: "x", since: ago(STUCK_MS - 60 * 60_000) } } } }));
  assert.deepEqual(kinds(assess(h, null, {}, [], now)), ["watcher-healthy"]);
});
test("health: a lag issue stays open while the watcher has no fresh reading of that package", () => {
  const lag = [issue("update-lag/codex/-", "0.168.0")];
  // No entry at all, and an entry from a failing source: neither says upstream moved.
  assert.deepEqual(kinds(assess(health(key({})), null, { codex: "0.167.2" }, lag, now)), ["watcher-healthy"]);
  const failing = health(key({ codex: ["0.169.0", 60_000] }, { sources: { github: { error: { kind: "parse", message: "x", since: ago(0) } } } }));
  assert.deepEqual(kinds(assess(failing, null, { codex: "0.167.2" }, lag, now)), ["watcher-healthy"]);
  // A lag issue about a package with no pin (removed) says nothing.
  const gone = health(key({ gone: ["2.0.0", 60_000] }));
  assert.deepEqual(kinds(assess(gone, null, {}, [issue("update-lag/gone/-", "1.0.0")], now)), ["watcher-healthy"]);
});
test("health: a non-`tags` package's pin stuck above the watcher's reading (a pulled version) lags as usual", () => {
  const h = health(key({ codex: ["0.167.2", LAG_MS * 2] }));
  assert.deepEqual(kinds(assess(h, null, { codex: "0.168.0" }, [], now)), ["update-lag:codex", "watcher-healthy"]);
});
test("health: the nightly entry stands for both nightly pins", () => {
  const h = health(key({ "t3code/nightly": ["0.2.0-nightly.20261201.5", LAG_MS * 2] }));
  const pins = { "t3code-nightly": "0.2.0-nightly.20261130.4", "t3-nightly": "0.2.0-nightly.20261130.4" };
  assert.deepEqual(kinds(assess(h, null, pins, [], now)), ["update-lag:t3-nightly", "update-lag:t3code-nightly", "watcher-healthy"]);
});

test("health: a timed send's auth error is watcher-auth, a long failure watcher-stalled, each naming the workflow", () => {
  const timed = (name: string, kind: string, since: number) => key({}, { timed: { [name]: { error: { kind, message: `HTTP ${kind === "auth" ? 401 : 502}`, since: ago(since) } } } });
  const auth = assess(health(timed("health.yml", "auth", 0)), null, {}, [], now);
  assert.deepEqual(kinds(auth), ["watcher-auth"], "and not healthy");
  assert.match(auth[0].detail, /health\.yml: HTTP 401/);
  const stuck = assess(health(timed("pages.yml", "http", STUCK_MS + 1)), null, {}, [], now);
  assert.deepEqual(kinds(stuck), ["watcher-stalled"]);
  assert.match(stuck[0].detail, /pages\.yml/);
  assert.deepEqual(kinds(assess(health(timed("pages.yml", "rate-limit", 0)), null, {}, [], now)), ["watcher-healthy"]);
  // A reply without the timed field still reads as before.
  assert.deepEqual(kinds(assess(health(key({})), null, {}, [], now)), ["watcher-healthy"]);
});
