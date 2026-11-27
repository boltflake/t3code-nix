// scripts/ci/feeds.ts: health's check of the update notice's version files.
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { assess, fetchAnswer, GRACE_MS, subject } from "../scripts/ci/feeds.ts";

const now = new Date("2026-11-28T12:00:00Z");
const old = new Date(now.getTime() - GRACE_MS - 1).toISOString();
const fresh = new Date(now.getTime() - 60_000).toISOString();
const none = { providers: {}, removed: {} };
const pins = {
  "updates/t3code.json": { version: "0.1.13", since: old, ...none },
  "updates/t3code-nightly.json": { version: "0.1.14-nightly.20261127.5332", since: old, ...none },
  "updates/stable/t3code.json": { version: "0.1.12", since: old, ...none },
};
const ok = (version: string, providers: Record<string, string> = {}) => ({ ok: true as const, text: JSON.stringify({ version, providers }) });

test("feeds: which package and channel each file is about", () => {
  assert.deepEqual(subject("updates/t3code.json"), { pkg: "t3code", channel: null });
  assert.deepEqual(subject("updates/stable/t3code.json"), { pkg: "t3code", channel: "stable" });
});

test("feeds: main's versions are ok; anything else is a problem, a version mismatch only after the grace period", () => {
  const all = assess({
    "updates/t3code.json": ok("0.1.13"),
    "updates/t3code-nightly.json": ok("0.1.14-nightly.20261127.5319"),
    "updates/stable/t3code.json": { ok: false, error: "HTTP 404" },
  }, pins, now);
  assert.deepEqual(all.map((o) => [o.kind, o.package, o.channel, o.version]), [
    ["update-feed-ok", "t3code", null, "0.1.13"],
    ["update-feed", "t3code-nightly", null, "0.1.14-nightly.20261127.5319"],
    ["update-feed", "t3code", "stable", null],
  ]);
  assert.match(all[1].detail, /the site has 0\.1\.14-nightly\.20261127\.5319, main has 0\.1\.14-nightly\.20261127\.5332/);
  assert.equal(all[2].detail, "updates/stable/t3code.json: HTTP 404");
  // A pin that just changed: no verdict yet on a mismatch.
  const soon = assess({ "updates/t3code.json": ok("0.1.12") }, { "updates/t3code.json": { version: "0.1.13", since: fresh, ...none } }, now);
  assert.deepEqual(soon, []);
  // Bad answers are problems at once, even for a fresh pin.
  for (const [text, why] of [
    ["nope", "not JSON"],
    ['{"version":"latest"}', "no SemVer version in the file"],
    ['{"v":"1"}', "no SemVer version in the file"],
    ['[1]', "not a JSON object"],
    ['{"version":"0.1.13","providers":["codex"]}', "providers isn't an object of strings"],
    ['{"version":"0.1.13","providers":{"codex":1}}', "providers isn't an object of strings"],
  ]) {
    const [o] = assess({ "updates/t3code.json": { ok: true, text } }, { "updates/t3code.json": { version: "0.1.13", since: fresh, ...none } }, now);
    assert.equal(o.kind, "update-feed");
    assert.equal(o.detail, `updates/t3code.json: ${why}`);
  }
  // A file whose pin is gone from main: nothing said.
  assert.deepEqual(assess({ "updates/t3code-nightly.json": ok("1.0.0") }, {}, now), []);
});

test("feeds: a file is judged whole: every provider entry against main, each with its own grace", () => {
  const file = "updates/t3code.json";
  const at = (providers: Record<string, { version: string; since: string | null }>, removed: Record<string, string | null> = {}) => ({
    [file]: { version: "0.1.13", since: old, providers, removed },
  });
  const one = (answer: ReturnType<typeof ok>, p: ReturnType<typeof at>) => assess({ [file]: answer }, p, now);
  // All equal: ok, which closes the issue.
  assert.deepEqual(one(ok("0.1.13", { codex: "1.0.0" }), at({ codex: { version: "1.0.0", since: old } })).map((o) => o.kind), ["update-feed-ok"]);
  // A provider behind past its grace: a problem naming it, though T3 Code is right.
  const [late] = one(ok("0.1.13", { codex: "1.0.0", grok: "2.0.0" }), at({ codex: { version: "1.0.1", since: old }, grok: { version: "2.0.0", since: old } }));
  assert.equal(late.kind, "update-feed");
  assert.equal(late.detail, "updates/t3code.json: codex: the site has 1.0.0, main has 1.0.1");
  // Within its grace: nothing either way (no ok while anything differs).
  assert.deepEqual(one(ok("0.1.13", { codex: "1.0.0" }), at({ codex: { version: "1.0.1", since: fresh } })), []);
  // Two late entries: one observation listing both.
  const [both] = one(ok("0.1.12", { codex: "1.0.0" }), at({ codex: { version: "1.0.1", since: old } }));
  assert.match(both.detail, /the site has 0\.1\.12, main has 0\.1\.13.*; codex: the site has 1\.0\.0, main has 1\.0\.1/);
  // Missing on the site; an older file without providers at all.
  assert.match(one(ok("0.1.13", {}), at({ codex: { version: "1.0.1", since: old } }))[0].detail, /codex: the site has none, main has 1\.0\.1/);
  const older = { ok: true as const, text: JSON.stringify({ version: "0.1.13" }) };
  assert.equal(one(older, at({ codex: { version: "1.0.1", since: old } }))[0].kind, "update-feed");
  assert.equal(one(older, at({}))[0].kind, "update-feed-ok");
  // Still on the site after its pin left main: from the removal's time.
  assert.deepEqual(one(ok("0.1.13", { muse: "1.0.0" }), at({}, { muse: fresh })), []);
  assert.match(one(ok("0.1.13", { muse: "1.0.0" }), at({}, { muse: old }))[0].detail, /muse: the site has 1\.0\.0, main has no pin/);
  // Main pins a provider version the app can't compare: a problem at once.
  const [odd] = one(ok("0.1.13", { codex: "weekly" }), at({ codex: { version: "weekly", since: fresh } }));
  assert.match(odd.detail, /main's codex weekly isn't a version the app can compare/);
});

test("feeds: fetched as the app reads it: a redirect, an error status or a big body is a problem", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/ok") res.writeHead(200).end('{"version":"0.1.13"}');
    else if (req.url === "/moved") res.writeHead(301, { location: "https://example.com/x" }).end();
    else if (req.url === "/big") res.writeHead(200).end("x".repeat(5000));
    else res.writeHead(404).end("no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.deepEqual(await fetchAnswer(`${base}/ok`), { ok: true, text: '{"version":"0.1.13"}' });
    assert.deepEqual(await fetchAnswer(`${base}/moved`), { ok: false, error: "redirects (HTTP 301) to https://example.com/x" });
    assert.deepEqual(await fetchAnswer(`${base}/gone`), { ok: false, error: "HTTP 404" });
    assert.deepEqual(await fetchAnswer(`${base}/big`), { ok: false, error: "more than 4096 bytes" });
  } finally {
    server.close();
  }
  assert.match((await fetchAnswer("http://127.0.0.1:1/x") as { error: string }).error, /^no answer: /);
});

test("feeds: a body that keeps coming past the limit is cut off, not read to the end", async () => {
  let sent = 0;
  const server = createServer((_req, res) => {
    res.writeHead(200);
    const tick = setInterval(() => {
      sent += 1024;
      if (!res.write("x".repeat(1024))) return;
    }, 5);
    res.on("close", () => clearInterval(tick));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    const started = Date.now();
    assert.deepEqual(await fetchAnswer(`http://127.0.0.1:${port}/`, 10_000), { ok: false, error: "more than 4096 bytes" });
    assert.ok(Date.now() - started < 5000, "it stopped at the limit, not the timeout");
    assert.ok(sent < 64 * 1024, `read ${sent} bytes`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("feeds: a pin's time is when its version last changed on REF, not another edit", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pinsOnMain } = await import("../scripts/ci/feeds.ts");
  const dir = mkdtempSync(join(tmpdir(), "feeds-"));
  const cwd = process.cwd();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, env, encoding: "utf8" });
  const commit = (at: string, pin: object) => {
    writeFileSync(join(dir, "versions", "t3code.json"), JSON.stringify(pin, null, 2) + "\n");
    git("add", "-A");
    execFileSync("git", ["commit", "-q", "-m", at], { cwd: dir, env: { ...env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at } });
  };
  try {
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, "versions"));
    commit("2026-11-20T10:00:00Z", { name: "t3code", version: "0.1.12", hash: "a" });
    commit("2026-11-26T19:40:45Z", { name: "t3code", version: "0.1.13", hash: "b" });
    commit("2026-11-28T09:00:00Z", { name: "t3code", version: "0.1.13", hash: "c" });
    // The bundled browser's version moving isn't the pin's version moving.
    commit("2026-11-28T10:00:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "159.0" } });
    commit("2026-11-28T11:00:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    process.chdir(dir);
    const t3 = (ref: string) => {
      const { version, since } = pinsOnMain(ref)["updates/t3code.json"];
      return { version, since };
    };
    assert.deepEqual(t3("HEAD"), { version: "0.1.13", since: "2026-11-26T19:40:45Z" });
    assert.deepEqual(t3("HEAD~4"), { version: "0.1.12", since: "2026-11-20T10:00:00Z" });
    // A provider pin, and one that left main: when it left.
    writeFileSync(join(dir, "versions", "codex.json"), JSON.stringify({ name: "codex", version: "1.0.0" }, null, 2) + "\n");
    writeFileSync(join(dir, "versions", "muse.json"), JSON.stringify({ name: "muse", version: "1.0.0" }, null, 2) + "\n");
    commit("2026-11-28T11:30:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    rmSync(join(dir, "versions", "muse.json"));
    commit("2026-11-28T11:45:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    // One that isn't a bundled provider's name (any more) too.
    writeFileSync(join(dir, "versions", "oldtool.json"), JSON.stringify({ name: "oldtool", version: "1.0.0" }, null, 2) + "\n");
    commit("2026-11-28T11:50:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    rmSync(join(dir, "versions", "oldtool.json"));
    commit("2026-11-28T11:55:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    const p = pinsOnMain("HEAD")["updates/t3code.json"];
    assert.deepEqual(p.providers, { codex: { version: "1.0.0", since: "2026-11-28T11:30:00Z" } });
    assert.equal(p.removed.muse, "2026-11-28T11:45:00Z");
    assert.equal(p.removed.oldtool, "2026-11-28T11:55:00Z");
    assert.equal(p.removed.grok, undefined, "never there: no time (counts as long gone)");
    // A pin moved to another name: the old name's deletion.
    git("mv", "versions/codex.json", "versions/codex2.json");
    commit("2026-11-28T12:00:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    assert.equal(pinsOnMain("HEAD")["updates/t3code.json"].removed.codex, "2026-11-28T12:00:00Z");
    // A pin still there but never a bundled provider's: no time.
    assert.equal(pinsOnMain("HEAD")["updates/t3code.json"].removed.codex2, null);
    // The names come from REF: grok's pin stays, its name leaves the list
    // (another name added later doesn't move that time).
    writeFileSync(join(dir, "versions", "grok.json"), JSON.stringify({ name: "grok", version: "1.0.0" }, null, 2) + "\n");
    mkdirSync(join(dir, "pkgs", "t3code"), { recursive: true });
    const names = (n: object) => writeFileSync(join(dir, "pkgs", "t3code", "provider-names.json"), JSON.stringify(n));
    names({ codex: "codex2", grok: "grok" });
    commit("2026-11-28T12:10:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    assert.deepEqual(Object.keys(pinsOnMain("HEAD")["updates/t3code.json"].providers).sort(), ["codex2", "grok"]);
    names({ codex: "codex2" });
    commit("2026-11-28T12:20:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    names({ codex: "codex2", pi: "pi" });
    commit("2026-11-28T12:30:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    const q = pinsOnMain("HEAD")["updates/t3code.json"];
    assert.deepEqual(Object.keys(q.providers), ["codex2"]);
    assert.equal(q.removed.grok, "2026-11-28T12:20:00Z");
    // A name added for a pin that's been there a while: its grace runs from
    // the name's addition (the names file's first commit counts as one).
    assert.equal(q.providers.codex2.since, "2026-11-28T12:10:00Z");
    names({ codex: "codex2", pi: "pi", old: "muse2" });
    writeFileSync(join(dir, "versions", "muse2.json"), JSON.stringify({ name: "muse2", version: "1.0.0" }, null, 2) + "\n");
    commit("2026-11-28T12:40:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    // fx: a pin first, its name an hour later.
    writeFileSync(join(dir, "versions", "fx.json"), JSON.stringify({ name: "fx", version: "0.0.18" }, null, 2) + "\n");
    commit("2026-11-28T12:45:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    names({ codex: "codex2", pi: "pi", old: "muse2", fx: "fx" });
    commit("2026-11-28T13:45:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    const r = pinsOnMain("HEAD")["updates/t3code.json"];
    assert.equal(r.providers.muse2.since, "2026-11-28T12:40:00Z", "pin and name together");
    assert.equal(r.providers.fx.since, "2026-11-28T13:45:00Z", "an older pin's name added later");
    // A later bump of a listed provider moves its time past the name's.
    writeFileSync(join(dir, "versions", "fx.json"), JSON.stringify({ name: "fx", version: "0.0.19" }, null, 2) + "\n");
    commit("2026-11-28T14:30:00Z", { name: "t3code", version: "0.1.13", hash: "c", browser: { version: "160.0" } });
    assert.equal(pinsOnMain("HEAD")["updates/t3code.json"].providers.fx.since, "2026-11-28T14:30:00Z");
    assert.equal(pinsOnMain("HEAD")["updates/t3code-nightly.json"], undefined);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("feeds: a ref git can't read fails the probe; a pin that isn't there is skipped", async () => {
  const { pinsOnMain } = await import("../scripts/ci/feeds.ts");
  assert.throws(() => pinsOnMain("no-such-ref-at-all"), /no commit no-such-ref-at-all/);
});
