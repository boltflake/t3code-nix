// The status page's live view (scripts/status-live.ts) and the secretless
// reads behind it (scripts/ci/status-reads.ts).
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { explaining, liveView, upstream, waitFor, type OpenIssue, type Run } from "../scripts/status-live.ts";
import { candidateInputs, capped, inputsJson, MAX_MEMBER, MAX_ZIP, readIssues, readRuns } from "../scripts/ci/status-reads.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pin } from "../scripts/lib/util.ts";

const NOW = new Date("2026-11-13T12:00:00Z");
const key = (written: string | undefined, entries: Record<string, string>, failing: string[] = []) => ({
  written,
  entries: Object.fromEntries(Object.entries(entries).map(([k, version]) => [k, { version, firstSeen: "2026-11-13T11:00:00Z" }])),
  sources: Object.fromEntries(failing.map((s) => [s, { error: { kind: "http", message: "x", since: "2026-11-13T10:00:00Z" } }])),
});
const health = (a: any, b: any = key("2026-11-13T11:50:00Z", {})) => ({ keys: { "state:a": a, "state:b": b } });
const pin = (name: string, version: string, extra: Partial<Pin> = {}): Pin => ({ name, version, assets: {}, ...extra });
const issue = (number: number, k: string, version: string | null): OpenIssue => ({ number, key: k, version });
const states = (pins: Pin[], h: any, runs: Run[] = [], issues: OpenIssue[] = []) => liveView(pins, h, runs, issues, "o/r", NOW)?.states;

test("live: up to date, found, and the entry-to-pin map", () => {
  const h = health(key("2026-11-13T11:55:00Z", { codex: "1.1", "t3code/latest": "0.1.9", grok: "2" }));
  assert.deepEqual(states([pin("codex", "1.0"), pin("t3code", "0.1.9"), pin("t3", "0.1.9"), pin("grok", "2")], h), {
    codex: { state: "found", version: "1.1", wait: "waiting for the next run", since: "2026-11-13T11:00:00.000Z" },
    t3code: { state: "up-to-date" },
    t3: { state: "up-to-date" },
    grok: { state: "up-to-date" },
  });
  // A found GitHub pin links to the new version's release notes.
  const gh = pin("codex", "1.0", { tag: "rust-v1.0", assets: { s: { url: "https://github.com/openai/codex/releases/download/rust-v1.0/x", hash: "h" } } });
  assert.equal(states([gh], h)!.codex.link, "https://github.com/openai/codex/releases/tag/rust-v1.1");
});

test("live: which watcher keys count, and \"data from\"", () => {
  const entries = { codex: "1.1" };
  const pins = [pin("codex", "1.0")];
  // Stale (over 30 min), from the future (over 5 min), missing, malformed: not usable.
  for (const written of ["2026-11-13T11:29:00Z", "2026-11-13T12:06:00Z", undefined, "yesterday"]) {
    assert.deepEqual(states(pins, health(key(written, entries))), { codex: { state: "not-checked" } }, String(written));
  }
  // Neither key usable: no live view at all.
  assert.equal(liveView(pins, health(key(undefined, entries), key("x", {})), [], [], "o/r", NOW), null);
  assert.equal(liveView(pins, null, [], [], "o/r", NOW), null);
  // "Data from" is the older of the usable keys; an unusable one doesn't count.
  assert.equal(upstream(health(key("2026-11-13T11:55:00Z", entries), key("2026-11-13T11:40:00Z", {})), NOW)!.checked, "2026-11-13T11:40:00.000Z");
  assert.equal(upstream(health(key("2026-11-13T11:55:00Z", entries), key(undefined, {})), NOW)!.checked, "2026-11-13T11:55:00.000Z");
  // A failing source's entries are skipped: not checked, not found. Entries
  // without a source of their own come from the github source.
  assert.deepEqual(states(pins, health(key("2026-11-13T11:55:00Z", entries, ["codex"]))), { codex: { state: "not-checked" } });
  assert.deepEqual(states(pins, health(key("2026-11-13T11:55:00Z", entries, ["github"]))), { codex: { state: "not-checked" } });
  assert.equal(states(pins, health(key("2026-11-13T11:55:00Z", entries, ["grok"])))!.codex.state, "found", "another source failing doesn't matter");
  // An empty entry map, with an open issue: still not checked.
  assert.deepEqual(states(pins, health(key("2026-11-13T11:55:00Z", {})), [], [issue(1, "test-failed/codex/-", "1.1")]), { codex: { state: "not-checked" } });
});

test("live: testing comes from the newest unfinished run's candidate, before held", () => {
  const h = health(key("2026-11-13T11:55:00Z", { codex: "1.2" }));
  const pins = [pin("codex", "1.0")];
  const old: Run = { id: 5, created: "2026-11-13T11:00:00Z", inputs: [{ name: "codex", version: "1.1" }] };
  const newer: Run = { id: 7, created: "2026-11-13T11:30:00Z", inputs: [{ name: "codex", version: "1.2" }] };
  for (const runs of [[old, newer], [newer, old]]) {
    assert.deepEqual(states(pins, h, runs)!.codex, { state: "testing", version: "1.2", since: "2026-11-13T11:30:00.000Z", link: "https://github.com/o/r/actions/runs/7" });
  }
  // A retry of a held version (in a run with nothing new) shows as testing.
  assert.equal(states(pins, h, [newer], [issue(3, "test-failed/codex/-", "1.2")])!.codex.state, "testing");
  // The version shown is the one that differs from main's, whatever the order.
  assert.equal(states(pins, h, [{ id: 4, created: "2026-11-13T11:50:00Z", inputs: [{ name: "codex", version: "1.0" }, { name: "codex", version: "1.3" }] }])!.codex.version, "1.3");
  // A candidate with main's own version isn't testing anything new.
  assert.equal(states(pins, h, [{ id: 8, created: "2026-11-13T11:40:00Z", inputs: [{ name: "codex", version: "1.0" }] }])!.codex.state, "found");
  // A candidate for a pin the watcher has no usable entry for: testing.
  assert.equal(states([pin("pi", "1")], h, [{ id: 9, created: "x", inputs: [{ name: "pi", version: "2" }] }])!.pi.state, "testing");
});

test("live: held, and which issue explains it", () => {
  const h = health(key("2026-11-13T11:55:00Z", { codex: "1.1" }));
  const pins = [pin("codex", "1.0")];
  const held = (issues: OpenIssue[]) => states(pins, h, [], issues)!.codex;
  assert.deepEqual(held([issue(56, "test-failed/codex/-", "rust-v1.1")]), { state: "held", version: "1.1", reason: "tests failed", since: "2026-11-13T11:00:00.000Z", link: "https://github.com/o/r/issues/56" }, "since: when the watcher first saw 1.1, not the issue's opening");
  // Precedence: the pin at that version, then a versionless resolve failure, then env-broken.
  assert.equal(held([issue(1, "env-broken/-/-", null), issue(2, "resolve-failed/codex/-", null), issue(3, "integrity/codex/-", "1.1")]).link, "https://github.com/o/r/issues/3");
  assert.equal(held([issue(1, "env-broken/-/-", null), issue(2, "resolve-failed/codex/-", null)]).reason, "couldn't read upstream");
  assert.equal(held([issue(1, "env-broken/-/-", null)]).reason, "build environment broken");
  // Two at the same tier: by kind, then the lowest number.
  assert.equal(held([issue(9, "integrity/codex/-", "1.1"), issue(4, "no-match/codex/-", "1.1")]).link, "https://github.com/o/r/issues/4");
  assert.equal(held([issue(9, "test-failed/codex/-", "1.1"), issue(4, "test-failed/codex/-", "1.1")]).link, "https://github.com/o/r/issues/4");
  // An update-lag issue reports a delay, it doesn't explain one; nor does a
  // guard review (that version ships), a downgrade (it holds nothing), or an
  // issue about another version, another pin, or with a channel.
  for (const i of [issue(1, "update-lag/codex/-", "1.1"), issue(5, "guard-review/codex/-", "1.1"), issue(6, "downgrade/codex/-", "1.1"), issue(7, "update-notice-off/codex/-", "1.1"), issue(8, "update-feed/codex/-", "1.1"), issue(2, "test-failed/codex/-", "1.0"), issue(3, "test-failed/grok/-", "1.1"), issue(4, "resolve-failed/codex/npm", null)]) {
    assert.equal(held([i]).state, "found", i.key);
  }
  assert.equal(explaining("codex", "1.1", []), null);
});

// A zip in memory: entries stored (0) or deflated (8), optionally a symlink,
// with knobs for every way an archive can lie about itself.
type Entry = { name: string; data: string; method?: number; symlink?: boolean; flags?: number; size?: number; localName?: string; localZero?: boolean; packedSize?: number };
function zip(entries: Entry[], o: { count?: number; commentLen?: number; disk?: number; trailing?: string; cdSizeDelta?: number } = {}): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data), method = e.method ?? 8;
    const packed = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name), localName = Buffer.from(e.localName ?? e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(e.flags ?? 0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(e.localZero ? 0 : packed.length, 18); local.writeUInt32LE(e.localZero ? 0 : e.size ?? raw.length, 22); local.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(e.symlink ? 0x0314 : 0x0014, 4); central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(e.packedSize ?? packed.length, 20); central.writeUInt32LE(e.size ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(e.symlink ? (0o120777 << 16) >>> 0 : 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, localName, packed);
    centrals.push(central, name);
    offset += 30 + localName.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(o.disk ?? 0, 4);
  end.writeUInt16LE(o.count ?? entries.length, 8); end.writeUInt16LE(o.count ?? entries.length, 10);
  end.writeUInt32LE(cd.length + (o.cdSizeDelta ?? 0), 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(o.commentLen ?? 0, 20);
  return Buffer.concat([...locals, cd, end, Buffer.from(o.trailing ?? "")]);
}
const INPUTS = JSON.stringify({ base: "b", inputs: [{ name: "codex", files: [], from: "1.0", to: "1.1" }, { name: "nixpkgs", files: [], from: "a", to: "b" }] });

test("reads: only inputs.json, in memory, from a well-formed zip", () => {
  const pins = new Set(["codex", "grok"]);
  for (const method of [0, 8]) {
    const json = inputsJson(zip([{ name: "files/versions/codex.json", data: "{}" }, { name: "inputs.json", data: INPUTS, method }]));
    assert.deepEqual(candidateInputs(json!, pins), [{ name: "codex", version: "1.1" }], `method ${method}; nixpkgs isn't a pin`);
  }
  // Anything that could escape, or isn't plainly a member, voids the zip.
  for (const bad of [
    [{ name: "../x", data: "a" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "/etc/x", data: "a" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "a\\..\\x", data: "a" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "a\u0000b", data: "a" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "files/../../x", data: "a" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "inputs.json", data: "../../scripts/status.ts", symlink: true }],
    [{ name: "link", data: "/", symlink: true }, { name: "inputs.json", data: INPUTS }],
    [{ name: "inputs.json", data: INPUTS, flags: 1 }],
    [{ name: "inputs.json", data: "x".repeat(MAX_MEMBER + 1) }],
    [{ name: "inputs.json", data: INPUTS, size: 3 }],
    [{ name: "other.json", data: INPUTS }],
    // A header that lies small: the real data is more, or inflates past the cap.
    [{ name: "inputs.json", data: INPUTS + " ".repeat(100), size: INPUTS.length }],
    [{ name: "inputs.json", data: " ".repeat(MAX_MEMBER * 4), size: 100 }],
    // ZIP64 markers, two inputs.json, a local header disguising its name.
    [{ name: "inputs.json", data: INPUTS, size: 0xffffffff }],
    [{ name: "inputs.json", data: INPUTS }, { name: "inputs.json", data: INPUTS }],
    [{ name: "inputs.json", data: INPUTS, localName: "../evil.txt" }],
    [{ name: "x", data: "a", localName: "../x" }, { name: "inputs.json", data: INPUTS }],
    [{ name: "inputs.json", data: INPUTS, packedSize: 1 << 16 }],
  ] as Entry[][]) {
    assert.equal(inputsJson(zip(bad)), null, JSON.stringify(bad.map((e) => [e.name, e.localName, e.size])));
  }
  // The archive itself lying: entry counts, a comment that isn't there,
  // another disk, bytes after the end, cut short.
  const one = [{ name: "inputs.json", data: INPUTS }];
  // The unsafe entry comes last, where a count too low would hide it.
  const two = [{ name: "inputs.json", data: INPUTS }, { name: "files/../../x", data: "a" }];
  for (const [what, z] of [
    ["count too low hides an entry", zip(two, { count: 1 })],
    ["count too high", zip(one, { count: 2 })],
    ["comment length", zip(one, { commentLen: 5 })],
    ["multidisk", zip(one, { disk: 1 })],
    ["trailing bytes", zip(one, { trailing: "xx" })],
    ["directory size too large", zip(one, { cdSizeDelta: 4 })],
    ["directory size too small", zip(one, { cdSizeDelta: -4 })],
    ["truncated", zip(one).subarray(0, zip(one).length - 5)],
    ["truncated local header", Buffer.concat([zip(one).subarray(0, 10), zip(one).subarray(-22)])],
  ] as const) {
    assert.equal(inputsJson(z), null, what);
  }
  assert.equal(inputsJson(Buffer.from("not a zip at all, just bytes")), null);
  // Data descriptors (sizes only in the central entry), as upload-artifact
  // may write: fine.
  assert.deepEqual(candidateInputs(inputsJson(zip([{ name: "inputs.json", data: INPUTS, flags: 8, localZero: true }]))!, pins), [{ name: "codex", version: "1.1" }]);
  // A pin named twice can't say which version is tested: dropped.
  assert.deepEqual(candidateInputs(Buffer.from(JSON.stringify({ inputs: [{ name: "codex", to: "1.0" }, { name: "codex", to: "1.1" }, { name: "grok", to: "2" }] })), pins), [{ name: "grok", version: "2" }]);
  // Unknown pins and implausible versions are dropped; non-candidates are null.
  const odd = JSON.stringify({ inputs: [{ name: "evil", to: "1" }, { name: "codex", to: "1.1 <script>" }, { name: "grok", to: "2" }] });
  assert.deepEqual(candidateInputs(Buffer.from(odd), pins), [{ name: "grok", version: "2" }]);
  assert.equal(candidateInputs(Buffer.from("{"), pins), null);
  assert.equal(candidateInputs(Buffer.from("{}"), pins), null);
});

test("reads: a zip over the cap is refused, read or streamed", async () => {
  // Well formed but too big (a large stored member beside inputs.json).
  const big = zip([{ name: "big.bin", data: "x".repeat(MAX_ZIP), method: 0 }, { name: "inputs.json", data: INPUTS }]);
  assert.ok(big.length > MAX_ZIP);
  assert.ok(inputsJson(big) === null, "an oversized zip is refused");
  // A body with no content-length stops being read at the cap.
  let pulled = 0;
  const chunk = new Uint8Array(64 << 10);
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulled += chunk.length; if (pulled > 8 * MAX_ZIP) c.close(); else c.enqueue(chunk); } });
  const read = await capped(new Response(body), MAX_ZIP);
  assert.ok(read === null, `got ${read?.length} bytes, not null`);
  assert.ok(pulled <= MAX_ZIP + 2 * chunk.length, `read ${pulled} bytes`);
  assert.equal((await capped(new Response("x".repeat(10)), 10))?.toString(), "x".repeat(10));
});

test("reads: unfinished runs on main, dry runs left out, one bad artifact ignored alone", async () => {
  const good = zip([{ name: "inputs.json", data: INPUTS }]);
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("/runs?branch=main&status=in_progress")) {
      return json({ workflow_runs: [{ id: 1, created_at: "2026-11-13T11:00:00Z", display_title: "update" }, { id: 2, created_at: "x", display_title: "update (dry run)" }] });
    }
    if (url.includes("/runs?branch=main&status=queued")) {
      // The run's own status wins over the query's; one finished by now is left out.
      return json({ workflow_runs: [{ id: 3, created_at: "2026-11-13T11:30:00Z", display_title: "update", status: "pending" },
        { id: 6, created_at: "2026-11-13T11:31:00Z", display_title: "update", status: "completed" },
        // Run 7 was waiting at an earlier query (UNFINISHED's order) and has finished since.
        { id: 7, created_at: "2026-11-13T10:00:00Z", display_title: "update", status: "completed" }] });
    }
    if (url.includes("/runs?branch=main&status=waiting")) {
      return json({ workflow_runs: [{ id: 4, created_at: "2026-11-13T11:35:00Z", display_title: "update" }, { id: 5, created_at: "2026-11-13T11:36:00Z", display_title: "update" },
        { id: 7, created_at: "2026-11-13T10:00:00Z", display_title: "update" }] });
    }
    if (url.includes("/runs?")) return json({ workflow_runs: [] });
    if (url.endsWith("/runs/1/artifacts?name=candidate&per_page=100")) {
      return json({ artifacts: [{ id: 10, created_at: "2026-11-13T11:01:00Z", expired: false }, { id: 11, created_at: "2026-11-13T11:05:00Z", expired: false }] });
    }
    if (url.endsWith("/runs/3/artifacts?name=candidate&per_page=100")) return json({ artifacts: [{ id: 30, created_at: "2026-11-13T11:31:00Z", expired: false }] });
    if (url.endsWith("/runs/4/artifacts?name=candidate&per_page=100")) {
      // The newest has expired: the older one is read.
      return json({ artifacts: [{ id: 40, created_at: "2026-11-13T11:40:00Z", expired: false }, { id: 41, created_at: "2026-11-13T11:45:00Z", expired: true }] });
    }
    if (url.endsWith("/artifacts/41/zip")) throw new Error("an expired artifact was fetched");
    if (url.endsWith("/artifacts/40/zip")) return new Response(new Uint8Array(good), { status: 200 });
    if (url.endsWith("/runs/5/artifacts?name=candidate&per_page=100")) return json({ artifacts: [{ id: 50, created_at: "2026-11-13T11:50:00Z", expired: false }] });
    if (url.endsWith("/artifacts/50/zip")) return new Response(new Uint8Array(good), { status: 200, headers: { "content-length": String(MAX_ZIP + 1) } });
    if (url.endsWith("/artifacts/11/zip")) {
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://storage.example/11" } });
    }
    if (url === "https://storage.example/11") {
      assert.equal((init?.headers as any)?.Authorization, undefined, "the token isn't sent to storage");
      return new Response(new Uint8Array(good), { status: 200 });
    }
    if (url.endsWith("/artifacts/30/zip")) return new Response(new Uint8Array(zip([{ name: "../x", data: "a" }, { name: "inputs.json", data: INPUTS }])), { status: 200 });
    return new Response("no", { status: 404 });
  };
  const warnings: string[] = [];
  // Nothing is written anywhere: run it in an empty folder and look.
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "status-reads-"));
  process.chdir(dir);
  let runs;
  try {
    runs = await readRuns(new Set(["codex"]), "o/r", "tok", f as any, (m) => warnings.push(m));
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(runs.sort((a, b) => a.id - b.id), [
    { id: 1, created: "2026-11-13T11:00:00Z", status: "in_progress", inputs: [{ name: "codex", version: "1.1" }] },
    { id: 3, created: "2026-11-13T11:30:00Z", status: "pending", inputs: [] },
    { id: 4, created: "2026-11-13T11:35:00Z", status: "waiting", inputs: [{ name: "codex", version: "1.1" }] },
    { id: 5, created: "2026-11-13T11:36:00Z", status: "waiting", inputs: [] },
  ]);
  assert.equal(warnings.length, 2, "run 3's unsafe zip and run 5's oversized download");
  assert.ok(!calls.some((u) => u.includes("/runs/2/")), "the dry run's artifacts aren't read");
  assert.ok(!calls.some((u) => u.includes("/runs/6/") || u.includes("/runs/7/")), "a run finished by now is left out, even one an earlier query had unfinished");
  for (const s of ["requested", "waiting", "pending", "queued", "in_progress"]) assert.ok(calls.some((u) => u.includes(`status=${s}`)), s);
  // Listing the runs failing ends the reads.
  await assert.rejects(readRuns(new Set(["codex"]), "o/r", "tok", (async () => new Response("", { status: 500 })) as any));
});

test("reads: only open issues, with their metadata", async () => {
  const body = (meta: object) => `text\n<!-- t3code-nix: ${JSON.stringify(meta)} -->`;
  const gh = {
    openIssues: async () => [
      { number: 1, title: "t", body: body({ key: "test-failed/codex/-", version: "1.1" }), state: "open" as const },
      { number: 2, title: "t", body: body({ key: "test-failed/grok/-", version: "2" }), state: "closed" as any },
      { number: 3, title: "t", body: "no metadata", state: "open" as const },
    ],
  };
  assert.deepEqual(await readIssues(gh as any), [{ number: 1, key: "test-failed/codex/-", version: "1.1" }]);
});

test("live: a browser pin has no watcher entry: current unless an issue holds it, testing while a run tests it", () => {
  const h = health(key("2026-11-13T11:55:00Z", { "nixos/nixos-unstable": "b".repeat(40) }));
  const bp = pin("browser-unstable", "a".repeat(40), { channel: "nixos-unstable", chromium: "158.0.1" } as any);
  assert.deepEqual(states([bp], h), { "browser-unstable": { state: "up-to-date" } }, "the channel's own entry doesn't make it 'found'");
  const held = states([bp], h, [], [issue(7, "bump-waiting/browser-unstable/-", "a".repeat(40))])!["browser-unstable"];
  assert.deepEqual([held.state, held.link], ["held", "https://github.com/o/r/issues/7"]);
  const failing = states([bp], h, [], [issue(8, "resolve-failed/browser-unstable/-", null)])!["browser-unstable"];
  assert.deepEqual([failing.state, failing.link], ["held", "https://github.com/o/r/issues/8"], "a revision that can't be resolved isn't green");
  const waiting = states([bp], h, [], [issue(10, "browser-waiting/browser-unstable/-", "a".repeat(40))])!["browser-unstable"];
  assert.deepEqual([waiting.state, waiting.reason, waiting.link], ["held", "waiting for Chromium or Chrome", "https://github.com/o/r/issues/10"],
    "a move waiting for the optional browsers isn't green either");
  const run: Run = { id: 9, created: "2026-11-13T11:58:00Z", inputs: [{ name: "browser-unstable", version: "b".repeat(40) }] } as any;
  assert.equal(states([bp], h, [run])!["browser-unstable"].state, "testing");
  // An ordinary pin without an entry is still "not checked".
  assert.deepEqual(states([pin("boat", "1.0.100")], h), { boat: { state: "not-checked" } });
});

test("live: a partly failing source keeps the entries it read", () => {
  const k = key("2026-11-13T11:55:00Z", { codex: "1.1", "t3code/latest": "0.2.0" });
  k.sources = { github: { error: { kind: "rate-limit", message: "x", since: "2026-11-13T10:00:00Z", unread: "t3code/" } } } as any;
  assert.deepEqual(states([pin("codex", "1.0"), pin("t3code", "0.1.9")], health(k)), {
    codex: { state: "found", version: "1.1", wait: "waiting for the next run", since: "2026-11-13T11:00:00.000Z" },
    t3code: { state: "not-checked" },
  });
  // A wholly failing source still hides all its entries.
  assert.deepEqual(states([pin("codex", "1.0")], health(key("2026-11-13T11:55:00Z", { codex: "1.1" }, ["github"]))), { codex: { state: "not-checked" } });
});

test("live: a tags package read below its pin is the crowded window, not a release", () => {
  const h = health(key("2026-11-13T11:55:00Z", { opencode: "2.8.0", codex: "0.9" }));
  // opencode (tags): the updater keeps the pin; codex (latest): a real downgrade shows.
  assert.deepEqual(states([pin("opencode", "2.9.0"), pin("codex", "1.0")], h), {
    opencode: { state: "up-to-date" },
    codex: { state: "found", version: "0.9", wait: "waiting for the next run", since: "2026-11-13T11:00:00.000Z" },
  });
  // A run that tests the lower version still shows as testing.
  const run: Run = { id: 5, created: "2026-11-13T11:58:00Z", inputs: [{ name: "opencode", version: "2.8.0" }] };
  assert.equal(states([pin("opencode", "2.9.0")], h, [run])!.opencode.state, "testing");
});

test("live: what a found version waits for, from the unfinished runs", () => {
  const r = (id: number, status: string | undefined, inputs: Run["inputs"] = []): Run => ({ id, created: "2026-11-13T11:00:00Z", ...(status ? { status } : {}), inputs });
  const other = [{ name: "grok", version: "2" }];
  assert.equal(waitFor([]), "waiting for the next run");
  for (const s of ["requested", "pending"]) assert.equal(waitFor([r(1, s)]), "run starting", s);
  // A pending run with a candidate has resolved: a job of its own waits, not the run.
  assert.equal(waitFor([r(1, "pending", other)]), "not in this run");
  assert.equal(waitFor([r(1, "pending", other), r(2, "pending")]), "queued for next run");
  // Queued: one of its jobs waits for a runner, after others ran.
  assert.equal(waitFor([r(1, "queued", other)]), "not in this run", "queued counts as running");
  assert.equal(waitFor([r(1, "queued")]), "run in progress");
  assert.equal(waitFor([r(1, "queued", other), r(2, "pending")]), "queued for next run");
  assert.equal(waitFor([r(1, "in_progress")]), "run in progress", "running, no candidate read (yet)");
  assert.equal(waitFor([r(1, "in_progress"), r(2, "in_progress", other)]), "not in this run");
  assert.equal(waitFor([r(1, "in_progress", other)]), "not in this run");
  assert.equal(waitFor([r(1, "waiting", other)]), "not in this run", "waiting for an approval counts as running");
  assert.equal(waitFor([r(1, undefined, other)]), "not in this run", "an older read without a status counts as running");
  assert.equal(waitFor([r(1, "in_progress", other), r(2, "pending")]), "queued for next run");
  assert.equal(waitFor([r(1, "in_progress"), r(2, "requested")]), "queued for next run");
  // The found state carries it; a run testing the pin makes it testing instead.
  const h = health(key("2026-11-13T11:55:00Z", { codex: "1.1" }));
  assert.equal(states([pin("codex", "1.0")], h, [r(1, "in_progress", other), r(2, "pending")])!.codex.wait, "queued for next run");
  assert.equal(states([pin("codex", "1.0")], h, [r(1, "in_progress", [{ name: "codex", version: "1.1" }])])!.codex.state, "testing");
});
