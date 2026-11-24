// The updater (scripts/update.ts), with every network call faked.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as u from "../scripts/update.ts";
import * as issues from "../scripts/ci/issues.ts";
import { Fake } from "./fake-gh.ts";
import { requiredAssets, select } from "../shared/channels.ts";
import { GITHUB, highestTag } from "../shared/sources.ts";
import { io, VENDORS } from "../scripts/lib/vendors.ts";
import { clearFetched, timing, type Pin } from "../scripts/lib/util.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "update-test-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pin = (name: string, version: string, hash = "sha256-AAA", source = "https://vendor/manifest"): Pin => ({
  name, version,
  assets: {
    "x86_64-linux": { url: `https://x/${version}`, hash, checksumSource: source },
    "aarch64-linux": { url: `https://a/${version}`, hash, checksumSource: source },
  },
});
const write = (p: Pin) => writeFileSync(join(dir, `${p.name}.json`), JSON.stringify(p));
const kinds = (r: u.Report) => r.observations.map((o) => o.kind);

function candidate(next: Pin, held: string[][] = [], retry = false) {
  const r = new u.Report(dir);
  r.candidate(next, new Set(held.map(([p, v]) => `${p}\0${v}`)), retry);
  return r;
}

test("a new version is a candidate", () => {
  write(pin("muse", "1.0"));
  assert.deepEqual(candidate(pin("muse", "1.1")).changed, [{ name: "muse", from: "1.0", to: "1.1", why: "new version" }]);
});

test("unchanged is a pass", () => {
  write(pin("muse", "1.0"));
  const r = candidate(pin("muse", "1.0"));
  assert.deepEqual([r.changed, kinds(r)], [[], ["pass"]]);
});

test("same version, new bytes, with a checksum: re-pinned", () => {
  write(pin("muse", "1.0", "sha256-OLD"));
  const r = candidate(pin("muse", "1.0", "sha256-NEW"));
  assert.ok(kinds(r).includes("integrity"));
  assert.deepEqual(r.changed.map((c) => c.name), ["muse"]);
});

test("same version, new bytes, without a checksum: old pin kept", () => {
  write(pin("grok", "1.0", "sha256-OLD", "none (downloaded)"));
  const r = candidate(pin("grok", "1.0", "sha256-NEW", "none (downloaded)"));
  assert.deepEqual([r.changed, kinds(r)], [[], ["integrity"]]);
});

test("a t3code pin's browser archives count as its bytes", () => {
  const browser = (hash: string) => ({ version: "157", source: "s", assets: { "x86_64-linux": { url: "u", hash } } });
  const old = pin("t3code", "0.1.9", "sha256-APP", "SHA256SUMS");
  write(old);
  // Adding the record to a pin that had none: details only.
  const enriched = { ...structuredClone(old), browser: browser("sha256-B1") };
  assert.deepEqual(candidate(enriched).changed.map((c) => c.why), ["details only"]);
  write(enriched);
  // A different archive at the same version is new bytes, so a hold applies.
  const moved = { ...structuredClone(old), browser: browser("sha256-B2") };
  const r = candidate(moved, [["t3code", "0.1.9"]]);
  assert.deepEqual([r.changed, kinds(r).includes("held")], [[], true]);
  assert.deepEqual(candidate(moved).changed.map((c) => c.why), ["same version, new bytes"]);
});

test("details-only changes are kept", () => {
  const old = pin("grok", "1.0", "sha256-SAME", "none (downloaded)");
  write(old);
  const next = structuredClone(old);
  for (const a of Object.values(next.assets)) a.md5 = "abc==";
  assert.deepEqual(candidate(next).changed.map((c) => [c.name, c.why]), [["grok", "details only"]]);
});

test("a downgrade is followed and noted; a promotion isn't a downgrade", () => {
  write(pin("claude-code", "2.1.322"));
  const r = candidate(pin("claude-code", "2.1.321"));
  assert.ok(kinds(r).includes("downgrade"));
  write(pin("muse", "1.0.0-rc.1"));
  assert.ok(!kinds(candidate(pin("muse", "1.0.0"))).includes("downgrade"));
});

test("a downgrade carries both versions, and says when NixOS stable's set keeps the pulled one", () => {
  write(pin("claude-code", "2.1.322"));
  let o = candidate(pin("claude-code", "2.1.321")).observations.find((x) => x.kind === "downgrade")!;
  assert.deepEqual([o.package, o.version, o.from, o.to], ["claude-code", "2.1.321", "2.1.322", "2.1.321"]);
  assert.doesNotMatch(o.detail, /NixOS stable/);
  mkdirSync(join(dir, "stable"), { recursive: true });
  writeFileSync(join(dir, "stable", "claude-code.json"), JSON.stringify(pin("claude-code", "2.1.322")));
  o = candidate(pin("claude-code", "2.1.321")).observations.find((x) => x.kind === "downgrade")!;
  assert.match(o.detail, /NixOS stable's set \(versions\/stable\/\) keeps 2\.1\.322/);
});

test("which moves are downgrades: across numeric parts whatever the suffix, never within one base", () => {
  write(pin("cursor-agent", "2026.11.12-b912975"));
  assert.ok(kinds(candidate(pin("cursor-agent", "2026.11.11-c000000"))).includes("downgrade"), "cursor across dates");
  write(pin("t3code-nightly", "0.1.10-nightly.20261113.1"));
  assert.ok(!kinds(candidate(pin("t3code-nightly", "0.1.10-nightly.20261112.4564"))).includes("downgrade"), "same-base nightlies");
});

test("a held lower version reports held; the retry reports the downgrade, which the merge keeps", () => {
  write(pin("kiro-cli", "3.2.2"));
  write(pin("muse", "1.1"));
  const held = new Set(["kiro-cli\x003.2.1"]);
  // A mixed run: muse new, kiro-cli moved back to a held version.
  const first = new u.Report(dir);
  first.candidate(pin("muse", "1.2"), held, false);
  first.candidate(pin("kiro-cli", "3.2.1"), held, false);
  assert.deepEqual(first.observations.map((o) => [o.kind, o.package]), [["held", "kiro-cli"]]);
  assert.deepEqual(first.changed.map((c) => c.name), ["muse"]);
  const retry = new u.Report(dir);
  retry.candidate(pin("kiro-cli", "3.2.1"), held, true);
  first.merge(retry);
  const kiro = first.observations.filter((o) => o.package === "kiro-cli");
  assert.deepEqual(kiro.map((o) => o.kind), ["held", "downgrade"]);
  assert.deepEqual([kiro[1].from, kiro[1].to], ["3.2.2", "3.2.1"]);
});

test("version ordering", () => {
  assert.equal(u.compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(u.compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(u.compareVersions("2.1.321", "2.1.322"), -1);
  assert.equal(u.compareVersions("0.167.10", "0.167.9"), 1);
  assert.equal(u.compareVersions("2026.11.11-b912975", "2026.11.11-c000000"), null);
  assert.equal(u.compareVersions("1.4.15-R8339.1", "1.4.16-R8400.1"), -1);
  // A suffix that isn't a prerelease marker can't be ordered against the release.
  assert.equal(u.compareVersions("1.0.0", "1.0.0-R8339"), null);
  assert.equal(u.compareVersions("1.0.0-R8339", "1.0.0"), null);
  // A missing part counts as 0.
  assert.equal(u.compareVersions("1.0", "1.0.0"), 0);
  assert.equal(u.compareVersions("1.0.0", "1.0"), 0);
});

test("a held version is skipped unless retrying", () => {
  write(pin("kiro-cli", "3.2.1"));
  const held = [["kiro-cli", "3.2.2"]];
  const r = candidate(pin("kiro-cli", "3.2.2"), held);
  assert.deepEqual([r.changed, kinds(r)], [[], ["held"]]);
  const retried = candidate(pin("kiro-cli", "3.2.2"), held, true);
  assert.deepEqual([retried.changed.map((c) => c.to), kinds(retried)], [["3.2.2"], ["held"]], "still `held`: its source resolves");
});

test("held versions are retried only when nothing else is new", () => {
  write(pin("kiro-cli", "3.2.1"));
  const held = new Set(["kiro-cli\x003.2.2"]);
  const r = new u.Report(dir);
  r.candidate(pin("kiro-cli", "3.2.2"), held, false);
  assert.deepEqual([...u.retryNames(r, false)], ["kiro-cli"]);
  assert.deepEqual([...u.retryNames(r, true)], [], "a new nixpkgs revision is something new");
  // Anything the candidate would test counts: a new version, new bytes for
  // the same version, a details-only change (even to a held version), a
  // downgrade.
  write(pin("muse", "1.1", "sha256-OLD"));
  const changes: [string, Pin][] = [
    ["new version", pin("muse", "1.2", "sha256-OLD")],
    ["same version, new bytes", pin("muse", "1.1", "sha256-NEW")],
    ["details only", { ...pin("muse", "1.1", "sha256-OLD"), tag: "moved" }],
    ["new version", pin("muse", "1.0", "sha256-OLD")],
  ];
  for (const [why, next] of changes) {
    const both = new u.Report(dir);
    both.candidate(pin("kiro-cli", "3.2.2"), held, false);
    both.candidate(next, new Set(why === "details only" ? ["muse\x001.1"] : []), false);
    assert.deepEqual([both.changed.map((c) => c.why), [...u.retryNames(both, false)]], [[why], []], why);
  }
});

test("a new nixpkgs revision counts unless it's held, or unreadable", () => {
  const lock = (rev: string) => JSON.stringify({ nodes: { nixpkgs: { locked: { rev } } } });
  const held = new Set(["nixpkgs\x00bad"]);
  assert.equal(u.nixpkgsBump(lock("a"), lock("b"), held), true);
  assert.equal(u.nixpkgsBump(lock("a"), lock("bad"), held), false);
  assert.equal(u.nixpkgsBump(lock("a"), lock("a"), held), false);
  assert.equal(u.nixpkgsBump(null, lock("b"), held), true, "no lock on main yet");
  assert.equal(u.nixpkgsBump(lock("a"), null, held), false);
  assert.equal(u.nixpkgsBump(lock("a"), "{not json", held), false);
});

test("the second pass replaces the first's report for each package it said something about", () => {
  write(pin("kiro-cli", "3.2.1"));
  write(pin("grok", "1.0"));
  const held = new Set(["kiro-cli\x003.2.2", "grok\x002.0"]);
  const first = () => {
    const r = new u.Report(dir);
    r.candidate(pin("kiro-cli", "3.2.2"), held, false);
    r.candidate(pin("grok", "2.0"), held, false);
    r.observe(u.obs("releases-ok", u.RELEASES));
    r.observe(u.obs("on-main", "nixpkgs", "r1"));
    return r;
  };
  const kinds = (r: u.Report) => r.observations.map((o) => [o.kind, o.package]).sort();
  // grok's source failed in the second pass before saying anything: it keeps
  // the first pass's `held`.
  const r = first(), second = new u.Report(dir);
  second.candidate(pin("kiro-cli", "3.2.2"), held, true);
  r.merge(second);
  assert.deepEqual(r.changed.map((c) => [c.name, c.to]), [["kiro-cli", "3.2.2"]]);
  assert.deepEqual(kinds(r), [["held", "grok"], ["held", "kiro-cli"], ["on-main", "nixpkgs"], ["releases-ok", u.RELEASES]]);
  assert.deepEqual([...r.pins.keys()], ["kiro-cli"]);
  // Upstream moved between the passes: npm is compared with the newer one.
  const moved = new u.Report(dir);
  moved.candidate(pin("kiro-cli", "3.2.3"), held, true);
  r.merge(moved);
  assert.equal(r.resolved.get("kiro-cli"), "3.2.3");
  // A second pass that fails to resolve a held package reports that instead.
  const failed = new u.Report(dir);
  failed.observe(u.obs("resolve-failed", "grok", "2.0", "gone"));
  r.merge(failed);
  // (kiro-cli's report is now 3.2.3's, which isn't held.)
  assert.deepEqual(kinds(r), [["on-main", "nixpkgs"], ["releases-ok", u.RELEASES], ["resolve-failed", "grok"]]);
  // The t3code release stream read again: its newer reading wins, so a
  // failure or an unknown release isn't hidden behind the first `releases-ok`.
  for (const problem of [u.obs("resolve-failed", u.RELEASES, null, "GraphQL down"), u.obs("no-match", u.RELEASES, "v9", "odd")]) {
    const r2 = first(), stream = new u.Report(dir);
    stream.observe(problem);
    r2.merge(stream);
    assert.deepEqual(r2.observations.filter((o) => o.package === u.RELEASES).map((o) => o.kind), [problem.kind]);
  }
  // Observations about no package are never touched.
  const r3 = first(), loose = new u.Report(dir);
  r3.observe(u.obs("integrity", null, null, "first"));
  loose.observe(u.obs("integrity", null, null, "second"));
  r3.merge(loose);
  assert.deepEqual(r3.observations.filter((o) => o.package === null).map((o) => o.detail), ["first"]);
});

test("npm is compared with what upstream points at, not the pin", async () => {
  const r = new u.Report(dir);
  r.resolved.set("codex", "0.167.2");
  r.resolved.set("claude-code", "2.1.322");
  const npm: Record<string, string> = { "@openai/codex": "0.167.3", "@anthropic-ai/claude-code": "2.1.322" };
  await u.checkNpm(r, new Set(["codex", "claude-code"]), async (url: string) => ({ version: npm[url.split("registry.npmjs.org/")[1].replace(/\/latest$/, "")] }));
  const got = new Set(r.observations.map((o) => `${o.package}:${o.kind}`));
  assert.ok(got.has("codex:latest-mismatch") && got.has("claude-code:latest-match"));
});

test("npm: only npm being newer is a mismatch; npm lagging behind upstream is not", async () => {
  const check = async (ours: string, npm: string) => {
    const r = new u.Report();
    r.resolved.set("codex", ours);
    await u.checkNpm(r, new Set(["codex"]), async () => ({ version: npm }));
    return r.observations.filter((o) => o.kind.startsWith("latest-")).map((o) => o.kind);
  };
  assert.deepEqual(await check("0.172.0", "0.171.0"), ["latest-match"]);
  assert.deepEqual(await check("0.172.0", "0.172.0"), ["latest-match"]);
  assert.deepEqual(await check("0.171.0", "0.172.0"), ["latest-mismatch"]);
  assert.deepEqual(await check("0.172.0-alpha.1", "0.172.0"), ["latest-mismatch"]);
});

test("npm: started before the resolves finish, compared only for packages that resolved", async () => {
  const asked: string[] = [];
  let answer!: () => void;
  const gate = new Promise<void>((r) => (answer = r));
  const fetchJson = async (url: string) => {
    asked.push(url);
    await gate;
    if (url.includes("pi-coding-agent")) throw new Error("npm down");
    return { version: url.includes("@openai/codex") ? "0.167.3" : "2.1.322" };
  };
  const wanted = new Set(["codex", "claude-code", "pi"]);
  const started = u.startNpm(wanted, fetchJson);
  // Asked at once, before anything resolved.
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(asked.length, 3);
  const r = new u.Report();
  r.resolved.set("codex", "0.167.2");
  r.resolved.set("claude-code", "2.1.322");
  // pi didn't resolve: its failed npm fetch is ignored, as if never made.
  answer();
  await u.checkNpm(r, wanted, fetchJson, started);
  const kinds = r.observations.map((o) => `${o.package}:${o.kind}`).sort();
  assert.deepEqual(kinds, ["claude-code:latest-match", "claude-code:npm-ok", "codex:latest-mismatch", "codex:npm-ok"]);
  assert.equal(asked.length, 3, "no second fetch");

  assert.deepEqual(r.observations.filter((o) => o.package === "codex").map((o) => [o.kind, o.version, o.detail]).sort(), [
    ["latest-mismatch", "0.167.2", "npm's `latest` for @openai/codex is 0.167.3, newer than 0.167.2, which upstream points at; t3code's update notice offers a version this package doesn't have"],
    ["npm-ok", null, ""],
  ]);

  // A failed fetch for a package that resolved is its resolve-failed.
  r.resolved.set("pi", "1.0.0");
  const withPi = new u.Report();
  withPi.resolved = new Map(r.resolved);
  await u.checkNpm(withPi, new Set(["pi"]), fetchJson);
  assert.deepEqual(withPi.observations.map((o) => [o.kind, o.channel, o.detail]), [["resolve-failed", "npm", "npm @earendil-works/pi-coding-agent: npm down"]]);
});

test("update: held versions are resolved again, downloads included, only when nothing else is new", async () => {
  // kiro-cli and grok against a faked network; versions above the pinned ones.
  const KIRO = "https://desktop-release.q.us-east-1.amazonaws.com", GROK = "https://storage.googleapis.com/grok-build-public-artifacts/cli";
  const real = { fetch: globalThis.fetch, log: console.log, sleep: timing.sleep, prefetch: io.prefetch, locks: u.locks.read };
  const run = async (holds: string[], lock = { head: null as string | null, work: null as string | null }) => {
    const heldFile = join(dir, "held.json");
    writeFileSync(heldFile, JSON.stringify(holds.map((p) => ({ package: p, version: "99.0.0" }))));
    const prefetched: string[] = [];
    let out = "";
    globalThis.fetch = (async (url: string) => {
      url = String(url);
      if (url === `${KIRO}/latest/manifest.json`) {
        return Response.json({ version: "99.0.0", packages: ["x86_64", "aarch64"].map((a) => ({ os: "linux", download: `99.0.0/kirocli-${a}-linux.tar.gz`, sha256: "ab".repeat(32) })) });
      }
      // grok answers last, so the report's order isn't the network's.
      if (url === `${GROK}/stable`) { await new Promise((r) => setTimeout(r, 20)); return new Response("99.0.0\n"); }
      if (url.startsWith(`${GROK}/grok-`)) return new Response(null, { status: 200, headers: { "x-goog-hash": "md5=zz==" } });
      if (url.startsWith("https://registry.npmjs.org/")) return Response.json({ version: "0" });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    io.prefetch = async (url: string) => { prefetched.push(url); return "sha256-FAKE"; };
    u.locks.read = () => lock; // not this checkout's flake.lock
    console.log = (s: string) => { out += s; };
    timing.sleep = async () => {};
    clearFetched();
    try {
      assert.equal(await u.main(["--only", "kiro-cli,grok", "--held", heldFile]), 0);
    } finally {
      Object.assign(globalThis, { fetch: real.fetch });
      console.log = real.log;
      timing.sleep = real.sleep;
      io.prefetch = real.prefetch;
      u.locks.read = real.locks;
      clearFetched();
    }
    const report = JSON.parse(out);
    const order = (names: (string | null)[]) => names.map((n) => (n === null ? -1 : u.ALL.indexOf(n)));
    const sorted = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);
    assert.ok(sorted(order(report.changed.map((c: any) => c.name))), "changed in ALL's order");
    assert.ok(sorted(order(report.observations.map((o: any) => o.package))), "observations in ALL's order");
    return { changed: report.changed.map((c: any) => c.name).sort(), held: report.observations.filter((o: any) => o.kind === "held").map((o: any) => o.package).sort(), grok: prefetched.filter((x) => x.startsWith(GROK)) };
  };
  // Both held, nothing else new: both resolved again and proposed; grok's
  // files downloaded once, in the second pass.
  const both = await run(["kiro-cli", "grok"]);
  assert.deepEqual([both.changed, both.held], [["grok", "kiro-cli"], ["grok", "kiro-cli"]]);
  assert.ok(both.grok.length > 0);
  assert.equal(new Set(both.grok).size, both.grok.length, "each file once");
  // kiro-cli is new: no second pass, grok stays held and isn't downloaded.
  const one = await run(["grok"]);
  assert.deepEqual([one.changed, one.held, one.grok], [["kiro-cli"], ["grok"], []]);
  // A new nixpkgs revision is something new too.
  const lock = (rev: string) => JSON.stringify({ nodes: { nixpkgs: { locked: { rev } } } });
  const bumped = await run(["kiro-cli", "grok"], { head: lock("a"), work: lock("b") });
  assert.deepEqual([bumped.changed, bumped.held, bumped.grok], [[], ["grok", "kiro-cli"], []]);
});

test("update: npm is asked while the sources are still resolving", async () => {
  // GitHub answers only once npm has been asked; if npm waited for the
  // resolves, GitHub's answer would come late and be noted.
  const real = { fetch: globalThis.fetch, log: console.log, sleep: timing.sleep };
  let npmAsked!: () => void;
  const asked = new Promise<void>((r) => (npmAsked = r));
  let late = false;
  globalThis.fetch = (async (url: string) => {
    if (String(url).startsWith("https://registry.npmjs.org/")) {
      npmAsked();
      return Response.json({ version: "1.0.0" });
    }
    late = await Promise.race([asked.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 500))]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  console.log = () => {};
  timing.sleep = async () => {};
  clearFetched();
  try {
    assert.equal(await u.main(["--only", "codex"]), 0);
  } finally {
    globalThis.fetch = real.fetch;
    console.log = real.log;
    timing.sleep = real.sleep;
    clearFetched();
  }
  assert.equal(late, false);
});

const files = (v: string) => [`t3-${v}-linux-x64.tar.gz`, `t3-${v}-linux-arm64.tar.gz`, `T3-Code-${v}-amd64.deb`, `T3-Code-${v}-arm64.deb`, "SHA256SUMS"].map((name) => ({ name }));
const rel = (tagName: string, isPrerelease: boolean, createdAt: string, complete = true) =>
  ({ tagName, isPrerelease, isDraft: false, createdAt, releaseAssets: { nodes: complete ? files(tagName.slice(1)) : [] } });
const doc = (nodes: any[], hasNextPage = false) =>
  ({ data: { repository: { latestRelease: rel("v0.1.9", false, "2026-11-11T00:00:00Z"), releases: { pageInfo: { hasNextPage, endCursor: "c" }, nodes } } } });

test("pages until a nightly turns up", async () => {
  process.env.GH_TOKEN = "test";
  const previews = Array.from({ length: 40 }, (_, i) => rel(`v0.1.10-preview.20261112.${i}`, true, "2026-11-12T00:00:00Z"));
  const pages = [doc(previews, true), doc([rel("v0.1.10-nightly.20261112.9", true, "2026-11-12T00:00:00Z")])];
  const afters: unknown[] = [];
  const repo = await u.fetchT3code(async (_url: string, body?: any) => {
    afters.push(/after: "([^"]*)"/.exec(body.query)?.[1] ?? null);
    return pages[afters.length - 1];
  });
  assert.deepEqual(afters, [null, "c"]);
  assert.ok(repo.releases!.nodes.some((n) => n.tagName === "v0.1.10-nightly.20261112.9"));
});

test("a nightly older than the latest channel's release ends the paging, and is the nightly channel's pick", async () => {
  process.env.GH_TOKEN = "test";
  let calls = 0;
  const page = doc([rel("v0.1.9-nightly.20261110.3", true, "2026-11-10T00:00:00Z")], true);
  const repo = await u.fetchT3code(async () => { calls++; return page; });
  assert.equal(calls, 1);
  assert.equal(select(repo).nightly, "v0.1.9-nightly.20261110.3");
});

test("GraphQL needs a token", async () => {
  delete process.env.GH_TOKEN;
  await assert.rejects(u.fetchT3code(async () => ({})), /GH_TOKEN/);
});

test("an incomplete release escalates after an hour; an unknown one raises no-match", async () => {
  process.env.GH_TOKEN = "test";
  const d = doc([rel("v0.1.10-nightly.20261112.1", true, "2026-11-12T00:00:00Z", false),
    rel("v0.1.10-canary.20261112.1", true, "2026-11-12T00:00:00Z")]);
  for (const [minutes, kind] of [[30, "incomplete"], [90, "no-match"]] as const) {
    const r = new u.Report(dir);
    // Only the unknown/incomplete reporting matters here; no pins are built
    // (`wanted` is empty).
    await u.resolveT3code(r, new Set(), false, new Set(), new Date(Date.UTC(2026, 10, 12, 0, minutes)), async () => d);
    const about = r.observations.filter((o) => o.version === "v0.1.10-nightly.20261112.1").map((o) => o.kind);
    assert.ok(about.includes(kind), `${minutes} min: ${about}`);
    assert.ok(r.observations.some((o) => o.kind === "no-match" && o.version === "v0.1.10-canary.20261112.1"));
  }
});

test("a channel whose only release is incomplete says so once, not also no-match", async () => {
  process.env.GH_TOKEN = "test";
  const r1 = rel("v0.2.0", false, "2026-11-12T00:00:00Z", false);
  const d = { data: { repository: { latestRelease: r1, releases: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [r1] } } } };
  const r = new u.Report(dir);
  await u.resolveT3code(r, new Set(), false, new Set(["t3code", "t3-nightly"]), new Date(Date.UTC(2026, 10, 12, 0, 30)), async () => d);
  assert.deepEqual(r.observations.map((o) => [o.kind, o.package, o.version, o.channel]).sort(), [
    ["incomplete", u.RELEASES, "v0.2.0", "latest"], ["no-match", "t3-nightly", null, null], ["releases-ok", u.RELEASES, null, null],
  ]);
  // After an hour it's a no-match issue, keyed by the latest channel.
  const later = new u.Report(dir);
  await u.resolveT3code(later, new Set(), false, new Set(), new Date(Date.UTC(2026, 10, 12, 1, 30)), async () => d);
  const late = later.observations.find((o) => o.kind === "no-match" && o.version === "v0.2.0")!;
  assert.equal(issues.keyOf(late), "no-match/t3code-releases/latest");
});

test("every vendor has a resolver", () => {
  assert.deepEqual(Object.keys(VENDORS).sort(), [...u.VENDOR].sort());
});

test("run and tryRun work with inherited output", async () => {
  const { run, tryRun } = await import("../scripts/lib/util.ts");
  assert.equal(run("true", [], { stdio: ["ignore", "inherit", "inherit"] }), "");
  assert.equal(tryRun("true", [], { stdio: ["ignore", "inherit", "inherit"] }).status, 0);
  assert.equal(tryRun("false", [], { stdio: ["ignore", "inherit", "inherit"] }).status, 1);
  assert.equal(run("echo", ["hi"]), "hi");
});

test("tryRun treats a spawn failure as failure", async () => {
  const { tryRun } = await import("../scripts/lib/util.ts");
  assert.notEqual(tryRun("/nonexistent/command", []).status, 0);
});

test("a `tags` package takes its highest complete stable 2.x-or-later release, not the newest", () => {
  const wanted = { "x86_64-linux": "a.tar.gz", "aarch64-linux": "b.tar.gz" };
  const r = (tag_name: string, extra: object = {}, names = ["a.tar.gz", "b.tar.gz"]) => ({ tag_name, draft: false, prerelease: false, assets: names.map((name) => ({ name })), ...extra });
  const list = [
    r("process-daemon-v9.0.0"),
    r("v2.10.1", {}, ["a.tar.gz"]), // still uploading
    r("v3.0.0", { prerelease: true }),
    r("v2.11.0", { draft: true }),
    r("v1.19.6"), // the other line, released last
    r("v2.10.0"),
    r("v2.9.9"),
  ];
  assert.equal(u.pickRelease(list, wanted, GITHUB.opencode.tags!)?.tag_name, "v2.10.0");
  // A later major is followed, as t3code drives it (10 > 9, as numbers).
  assert.equal(u.pickRelease([r("v9.1.0"), r("v10.0.0"), r("v2.10.0")], wanted, GITHUB.opencode.tags!)?.tag_name, "v10.0.0");
  // 1.x releases filling the window never pull it back to 1.x.
  assert.equal(u.pickRelease([r("process-daemon-v1.0.0"), r("v1.19.7"), r("v1.19.6")], wanted, GITHUB.opencode.tags!), null);
});

test("highestTag compares each part as a number, and keeps the first of equals", () => {
  const re = /^v(\d+)\.(\d+)\.(\d+)$/;
  assert.equal(highestTag(["v2.9.0", "v2.10.0", "v10.0.0-rc1", "v1.99.99"], re), "v2.10.0");
  assert.equal(highestTag(["x", "y"], re), null);
  assert.equal(highestTag(["v01.0.0", "v1.0.0"], re), "v01.0.0");
});

// ---- released (the status page's upstream time) -----------------------------

const NOW = new Date("2026-11-13T12:00:00Z");
const at = (r: u.Report, name: string) => r.pins.get(name)?.released;
const settle = (next: Pin) => {
  const r = new u.Report(dir, NOW);
  r.candidate(next, new Set(), false);
  return r;
};

test("released: a new version takes the source's time, or `seen` now when it gives none", () => {
  write(pin("codex", "1.0"));
  assert.deepEqual(at(settle({ ...pin("codex", "1.1"), released: { at: "2026-11-13T11:00:00Z", kind: "published" } }), "codex"),
    { at: "2026-11-13T11:00:00.000Z", kind: "published" });
  assert.deepEqual(at(settle(pin("codex", "1.1")), "codex"), { at: NOW.toISOString(), kind: "seen" });
  // A time after the run, or not a time, is unknown.
  assert.equal(at(settle({ ...pin("codex", "1.1"), released: { at: "2026-11-14T00:00:00Z", kind: "published" } }), "codex"), undefined);
  assert.equal(at(settle({ ...pin("codex", "1.1"), released: { at: "soon", kind: "built" } }), "codex"), undefined);
  // A version that moved back is `seen` now, whatever its source says.
  assert.deepEqual(at(settle({ ...pin("codex", "0.9"), released: { at: "2026-10-01T00:00:00Z", kind: "published" } }), "codex"),
    { at: NOW.toISOString(), kind: "seen" });
});

test("released: an unchanged version keeps it, so a resolve with a fresh time is a pass", () => {
  const kept = { at: "2026-11-01T00:00:00.000Z", kind: "seen" as const };
  write({ ...pin("muse", "1.0"), released: kept });
  const r = settle({ ...pin("muse", "1.0"), released: { at: "2026-11-13T11:59:00Z", kind: "published" } });
  assert.deepEqual([kinds(r), r.changed, r.pins.size], [["pass"], [], 0]);
  // A pin from before (no released) stays without one, and still passes.
  write(pin("muse", "1.0"));
  const s = settle({ ...pin("muse", "1.0"), released: { at: "2026-11-13T11:59:00Z", kind: "published" } });
  assert.deepEqual([kinds(s), s.pins.size], [["pass"], 0]);
});

test("released: same-version writes (new bytes, details) keep it", () => {
  const kept = { at: "2026-11-01T00:00:00.000Z", kind: "published" as const };
  write({ ...pin("muse", "1.0"), released: kept });
  const bytes = settle({ ...pin("muse", "1.0", "sha256-BBB"), released: { at: "2026-11-13T00:00:00Z", kind: "published" } });
  assert.deepEqual([bytes.changed[0]?.why, at(bytes, "muse")], ["same version, new bytes", kept]);
  const details = settle({ ...pin("muse", "1.0"), assets: { ...pin("muse", "1.0").assets, "x86_64-linux": { ...pin("muse", "1.0").assets["x86_64-linux"], assetId: 7 } } });
  assert.deepEqual([details.changed[0]?.why, at(details, "muse")], ["details only", kept]);
});

test("same version: one system's new bytes are new bytes", () => {
  write(pin("grok", "1.0", "sha256-OLD", "none (downloaded)"));
  const next = pin("grok", "1.0", "sha256-OLD", "none (downloaded)");
  next.assets["aarch64-linux"].hash = "sha256-NEW";
  const r = candidate(next);
  assert.deepEqual([r.changed, kinds(r)], [[], ["integrity"]], "not a pass: aarch64's file changed");
});

// ---- the nixpkgs bump --------------------------------------------------------

const DAY = u.DAY_MS;
const T0 = Date.parse("2026-11-14T12:00:00Z");
const hist = (lockAgeDays: number | null, latestChannelSince: string | null = null): u.LockHistory =>
  ({ lockChangedAt: lockAgeDays === null ? null : T0 - lockAgeDays * DAY, latestChannelSince });

test("a bump is due with each new T3 Code on the latest channel and at least weekly", () => {
  write(pin("t3code", "0.1.9"));
  const fresh = new u.Report(dir);
  assert.equal(u.bumpDue(hist(2), fresh, new Date(T0)), null, "a 2-day-old lock and no new T3 Code");
  assert.match(u.bumpDue(hist(8), fresh, new Date(T0))!, /week/);
  assert.match(u.bumpDue(hist(null), fresh, new Date(T0))!, /week/, "never bumped");
  assert.match(u.bumpDue(hist(2, "0.1.9"), fresh, new Date(T0))!, /^T3 Code 0\.1\.9 on the latest channel reached main after the last nixpkgs bump$/, "a latest-channel T3 Code published since, without its bump");
  const own = candidate(pin("t3code", "0.2.0"));
  assert.match(u.bumpDue(hist(2), own, new Date(T0))!, /new T3 Code 0\.2\.0 on the latest channel/);
  const down = candidate(pin("t3code", "0.1.8"));
  assert.match(u.bumpDue(hist(2), down, new Date(T0))!, /0\.1\.8/, "a downgrade is a different release");
  const bytes = candidate(pin("t3code", "0.1.9", "sha256-NEW", "https://github.com/x/SHA256SUMS"));
  assert.deepEqual([bytes.changed[0]?.why, u.bumpDue(hist(2), bytes, new Date(T0))], ["same version, new bytes", null], "a same-version re-pin isn't a new T3 Code");
  const nightly = candidate(pin("t3code-nightly", "0.2.0-nightly.1"));
  assert.equal(u.bumpDue(hist(2), nightly, new Date(T0)), null, "nightly doesn't count");
  const held = candidate(pin("t3code", "0.2.0"), [["t3code", "0.2.0"]]);
  assert.equal(u.bumpDue(hist(2), held, new Date(T0)), null, "a held T3 Code brings no bump");
});

/** A git repo with main's history, for history.read(). */
function repo(steps: { lock?: string; t3code?: string; other?: boolean; at: number }[]): string {
  const r = mkdtempSync(join(tmpdir(), "update-hist-"));
  const g = (...args: string[]) => execFileSync("git", ["-C", r, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "", GIT_COMMITTER_DATE: "" } });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  mkdirSync(join(r, "versions"));
  for (const s of steps) {
    if (s.lock) writeFileSync(join(r, "flake.lock"), JSON.stringify({ nodes: { nixpkgs: { locked: { rev: s.lock } } } }));
    if (s.t3code) writeFileSync(join(r, "versions", "t3code.json"), JSON.stringify(s.t3code.startsWith("{") ? JSON.parse(s.t3code) : { name: "t3code", version: s.t3code }));
    if (s.other) writeFileSync(join(r, "README"), String(s.at));
    g("add", "-A");
    const when = new Date(s.at).toISOString();
    execFileSync("git", ["-C", r, "commit", "-q", "-m", "x"], { env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  }
  return r;
}

test("history: when flake.lock last changed, and a latest-channel T3 Code published since", () => {
  const cases: [string, Parameters<typeof repo>[0], u.LockHistory][] = [
    ["lock only", [{ lock: "a", t3code: "0.1.8", at: T0 - 9 * DAY }], { lockChangedAt: T0 - 9 * DAY, latestChannelSince: null }],
    ["a T3 Code after the lock", [{ lock: "a", t3code: "0.1.8", at: T0 - 3 * DAY }, { t3code: "0.1.9", at: T0 - 2 * DAY }],
      { lockChangedAt: T0 - 3 * DAY, latestChannelSince: "0.1.9" }],
    ["bumped with the T3 Code in one commit", [{ lock: "a", t3code: "0.1.8", at: T0 - 3 * DAY }, { lock: "b", t3code: "0.1.9", at: T0 - 2 * DAY }],
      { lockChangedAt: T0 - 2 * DAY, latestChannelSince: null }],
    ["a same-version re-pin after the lock", [{ lock: "a", t3code: "0.1.9", at: T0 - 3 * DAY },
      { t3code: JSON.stringify({ name: "t3code", version: "0.1.9", assets: { moved: true } }), at: T0 - DAY }], { lockChangedAt: T0 - 3 * DAY, latestChannelSince: null }],
    ["a downgrade after the lock", [{ lock: "a", t3code: "0.1.9", at: T0 - 3 * DAY }, { t3code: "0.1.8", at: T0 - DAY }],
      { lockChangedAt: T0 - 3 * DAY, latestChannelSince: "0.1.8" }],
    ["other commits after the lock", [{ lock: "a", t3code: "0.1.9", at: T0 - 3 * DAY }, { other: true, at: T0 - DAY }],
      { lockChangedAt: T0 - 3 * DAY, latestChannelSince: null }],
    ["no lock yet", [{ t3code: "0.1.9", at: T0 - DAY }], { lockChangedAt: null, latestChannelSince: "0.1.9" }],
  ];
  for (const [what, steps, want] of cases) {
    const r = repo(steps);
    try {
      assert.deepEqual(u.history.read(r), want, what);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  }
});

/** maybeBump with a faked bumper. */
async function bumped(result: Partial<u.BumpResult> | null, h: u.LockHistory, report = new u.Report(dir), held = new Set<string>(),
  elapsedMs = 0) {
  const real = { run: u.bumper.run, read: u.locks.read };
  let ran = false, budget = 0;
  u.bumper.run = async (_d, ms) => { ran = true; budget = ms ?? 0; return { from: "old", to: "new", offered: false, missing: [], unknown: [], ...result }; };
  u.locks.read = () => ({ head: JSON.stringify({ nodes: { nixpkgs: { locked: { rev: "old" } } } }), work: null });
  try {
    await u.maybeBump(report, held, new Date(T0), h, T0, () => T0 + elapsedMs);
  } finally {
    u.bumper.run = real.run;
    u.locks.read = real.read;
  }
  return { report, ran, budget };
}

test("maybeBump: the bump gets what's left of the run's time, and waits when that's too little", async () => {
  const quick = await bumped({ offered: true }, hist(8));
  assert.equal(quick.budget, 15 * 60_000);
  const slowUpstream = await bumped({ offered: true }, hist(8), undefined, undefined, 10 * 60_000);
  assert.equal(slowUpstream.budget, 10 * 60_000, "20 minutes from the start, less the 10 upstream took");
  const late = await bumped({ offered: true }, hist(15), undefined, undefined, 18 * 60_000);
  assert.equal(late.ran, false);
  assert.deepEqual(kinds(late.report), ["waiting", "bump-waiting"]);
  assert.match(late.report.observations[0].detail, /not enough time left/);
  assert.equal(late.report.observations[1].version, "old");
});

test("maybeBump: offered, waiting, an issue after 14 days, nothing when unstable hasn't moved", async () => {
  const notDue = await bumped({ offered: true }, hist(2));
  assert.equal(notDue.ran, false, "not due: no bump is tried");

  const offered = await bumped({ offered: true }, hist(8));
  assert.deepEqual(offered.report.changed, [{ name: "nixpkgs", from: "old", to: "new", why: "a week since the last nixpkgs bump" }]);
  assert.deepEqual([...u.retryNames(offered.report, false)], [], "a bump is something new: no retries beside it");

  const heldRev = await bumped({ offered: true }, hist(8), undefined, new Set(["nixpkgs\x00new"]));
  assert.deepEqual(heldRev.report.changed, [], "a held revision is left to candidate.ts, and doesn't stop retries");

  const still = await bumped({}, hist(8));
  assert.deepEqual([still.report.changed, still.report.observations], [[], []], "nixos-unstable hasn't moved");

  const waits = await bumped({ missing: ["x86_64-linux: gtk+3-3.24.53"] }, hist(8));
  assert.deepEqual(kinds(waits.report), ["waiting"]);
  assert.equal(waits.report.observations[0].version, "new");
  assert.match(waits.report.observations[0].detail, /not on cache\.nixos\.org yet: x86_64-linux: gtk\+3-3\.24\.53/);

  const long = await bumped({ missing: ["x86_64-linux: gtk+3-3.24.53"], unknown: ["https://cache.nixos.org/x.narinfo: HTTP 503"] }, hist(15));
  assert.deepEqual(kinds(long.report), ["waiting", "bump-waiting"]);
  const issue = long.report.observations[1];
  assert.deepEqual([issue.package, issue.version], ["nixpkgs", "old"], "the issue names the revision main is stuck at");
  assert.doesNotMatch(issue.detail, /new|503/, "nor the revision tried or a lookup's error, which change from run to run");
  assert.match(issue.detail, /gtk\+3-3\.24\.53[\s\S]*couldn't check the cache/);
  // why() keeps several lines of an error; none of them reaches the issue.
  const multi = await bumped({ unknown: ["the packages don't evaluate at new: error: attribute missing\n  at /nix/store/x/default.nix:3:1\n  (run 42)"] }, hist(15));
  const multiIssue = multi.report.observations.find((o) => o.kind === "bump-waiting")!;
  assert.doesNotMatch(multiIssue.detail, /attribute missing|default\.nix|run 42/, "a multi-line error is shortened too");
  assert.match(multiIssue.detail, /couldn't check the cache$/);

  const many = await bumped({ missing: Array.from({ length: 40 }, (_, i) => `x86_64-linux: p${i}`) }, hist(3, "0.1.9"));
  assert.match(many.report.observations[0].detail, /and 10 more$/);
});

test("bumper: flake.lock is put back unless the bump is offered", async () => {
  const lock = (rev: string) => JSON.stringify({ nodes: { nixpkgs: { locked: { rev } } } });
  const path = join(dir, "flake.lock");
  const real = { tops: u.bumper.tops, update: u.bumper.update, compare: u.bumper.compare };
  type Step = { tops?: (d: string) => Record<string, string[]>; update?: (d: string) => void; compare?: typeof u.bumper.compare };
  const runWith = async (steps: Step) => {
    writeFileSync(path, lock("old"));
    let evals = 0;
    u.bumper.tops = steps.tops ?? (() => ({ x: [`eval${evals++}`] }));
    u.bumper.update = steps.update ?? (() => writeFileSync(path, lock("new")));
    u.bumper.compare = steps.compare ?? (async () => ({ missing: [], unknown: [] }));
    try {
      const r = await u.bumper.run(dir);
      return { r, rev: JSON.parse(readFileSync(path, "utf8")).nodes.nixpkgs.locked.rev };
    } finally {
      Object.assign(u.bumper, real);
    }
  };
  const ok = await runWith({});
  assert.deepEqual([ok.r.offered, ok.r.from, ok.r.to, ok.rev], [true, "old", "new", "new"]);
  const missing = await runWith({ compare: async () => ({ missing: ["x86_64-linux: gtk+3"], unknown: [] }) });
  assert.deepEqual([missing.r.offered, missing.r.to, missing.r.missing, missing.rev], [false, "new", ["x86_64-linux: gtk+3"], "old"]);
  const unknown = await runWith({ compare: async () => ({ missing: [], unknown: ["HTTP 503"] }) });
  assert.deepEqual([unknown.r.offered, unknown.rev], [false, "old"]);
  const crash = await runWith({ compare: async () => { throw new Error("nix derivation show failed"); } });
  assert.deepEqual([crash.r.offered, crash.rev], [false, "old"]);
  assert.match(crash.r.unknown[0], /cache check failed: nix derivation show failed/);
  const updateFails = await runWith({ update: () => { writeFileSync(path, "{half"); throw new Error("network"); } });
  assert.deepEqual([updateFails.r.offered, updateFails.rev], [false, "old"]);
  const same = await runWith({ update: () => writeFileSync(path, lock("old")) });
  assert.deepEqual([same.r.offered, same.r.missing, same.r.unknown, same.rev], [false, [], [], "old"], "nixos-unstable hasn't moved");
  let calls = 0;
  const brokenAtNew = await runWith({ tops: () => { if (calls++) throw new Error("attribute missing"); return { x: ["a"] }; } });
  assert.deepEqual([brokenAtNew.r.offered, brokenAtNew.rev], [false, "old"], "not offered: the cache wasn't checked");
  assert.match(brokenAtNew.r.unknown[0], /don't evaluate at new: attribute missing/);
  const brokenAtMain = await runWith({ tops: () => { throw new Error("main broken"); } });
  assert.deepEqual([brokenAtMain.r.offered, brokenAtMain.rev], [false, "old"]);
  const spent = await runWith({ compare: async (_b, _n, budget) => { budget.left(-1); return { missing: [], unknown: [] }; } });
  assert.deepEqual([spent.r.offered, spent.rev], [false, "old"], "running out of time declines");
  assert.match(spent.r.unknown[0], /ran out of time/);
});

test("agent-browser: its musl assets, by exact name; a missing asset, a missing digest or a prerelease fails", async () => {
  const tag = "v0.43.0";
  const asset = (name: string, digest: string | null = `sha256:${"a".repeat(64)}`) =>
    ({ id: 1, name, digest, browser_download_url: `https://github.com/vercel-labs/agent-browser/releases/download/${tag}/${name}` });
  const musl = ["agent-browser-linux-musl-x64", "agent-browser-linux-musl-arm64"];
  const glibc = ["agent-browser-linux-x64", "agent-browser-linux-arm64"];
  let release: any;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith("/releases/latest")) return new Response(JSON.stringify(release));
    if (String(url).includes("/git/ref/tags/")) return new Response(JSON.stringify({ object: { type: "commit", sha: "c".repeat(40) } }));
    if (String(url).endsWith("/LICENSE")) return new Response("Apache License");
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  try {
    const go = async () => {
      clearFetched();
      const r = new u.Report(dir);
      await u.resolveGithub(r, "agent-browser", new Set(), false);
      return r;
    };
    release = { tag_name: tag, draft: false, prerelease: false, assets: [...musl, ...glibc].map((n) => asset(n)) };
    const p = (await go()).pins.get("agent-browser")!;
    assert.deepEqual([p.version, p.assets["x86_64-linux"].url.split("/").pop(), p.assets["aarch64-linux"].url.split("/").pop()],
      ["0.43.0", "agent-browser-linux-musl-x64", "agent-browser-linux-musl-arm64"], "the static musl builds, not the glibc ones");
    release = { ...release, assets: [asset(musl[0]), ...glibc.map((n) => asset(n))] };
    await assert.rejects(go(), /no asset agent-browser-linux-musl-arm64/);
    release = { ...release, assets: [asset(musl[0]), asset(musl[1], null)] };
    await assert.rejects(go(), /has no sha256 digest/);
    release = { tag_name: tag, draft: false, prerelease: true, assets: musl.map((n) => asset(n)) };
    await assert.rejects(go(), /is a prerelease/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- the nixpkgs-stable pin ---------------------------------------------------

test("nixpkgs-stable: on-main always; moves when due and cached; waits otherwise; a new release is due at once", async () => {
  const { io: ch } = await import("../scripts/lib/browserpins.ts");
  const real = { rev: ch.rev, released: ch.released, prefetch: ch.prefetch, check: u.stableBumper.check };
  const pinFile = (rev: string, channel = "nixos-26.05") =>
    writeFileSync(join(dir, "versions", "nixpkgs-stable.json"), JSON.stringify({ name: "nixpkgs-stable", version: rev, assets: {}, channel, rev, narHash: "sha256-x" }));
  mkdirSync(join(dir, "versions"));
  let revs: Record<string, string> = { "nixos-26.05": "b".repeat(40) };
  let released = new Set<string>();
  let verdict = { missing: [] as string[], unknown: [] as string[] };
  Object.assign(ch, { rev: async (c: string) => revs[c], released: async (c: string) => released.has(c), prefetch: async () => "sha256-new" });
  u.stableBumper.check = async () => verdict;
  const go = async (h: u.LockHistory, report = new u.Report(join(dir, "versions"), new Date(T0))) => {
    await u.maybeBumpStable(report, new Set(), new Date(T0), h, T0, () => T0, dir);
    return report;
  };
  try {
    pinFile("a".repeat(40));
    let r = await go(hist(2));
    assert.deepEqual(kinds(r), ["on-main", "waiting"], "moved but not due");
    assert.equal(r.observations[0].version, "a".repeat(40));
    r = await go(hist(8));
    assert.deepEqual([r.changed[0]?.name, r.changed[0]?.to, r.changed[0]?.why], ["nixpkgs-stable", "b".repeat(40), "a week since the last nixpkgs-stable move"]);
    const p: any = r.pins.get("nixpkgs-stable");
    assert.deepEqual([p.channel, p.rev, p.narHash, p.assets], ["nixos-26.05", "b".repeat(40), "sha256-new", {}]);
    // The T3 Code reason goes through the same rewording as the weekly one.
    r = await go(hist(2, "0.1.9"));
    assert.equal(r.changed[0]?.why, "T3 Code 0.1.9 on the latest channel reached main after the last nixpkgs-stable move");
    verdict = { missing: ["x86_64-linux: gtk+3"], unknown: [] };
    r = await go(hist(8));
    assert.deepEqual([r.changed, kinds(r)], [[], ["on-main", "waiting"]], "due but not cached");
    r = await go(hist(15));
    assert.deepEqual(kinds(r), ["on-main", "waiting", "bump-waiting"]);
    assert.equal(r.observations[2].version, "a".repeat(40), "named by main's revision");
    verdict = { missing: [], unknown: [] };
    released.add("nixos-26.11");
    revs["nixos-26.11"] = "c".repeat(40);
    r = await go(hist(1));
    assert.deepEqual([(r.pins.get("nixpkgs-stable") as any)?.channel, r.changed[0]?.why], ["nixos-26.11", "NixOS 26.11 is out"], "a new release is due at once");
    // A held revision: left out on an ordinary run, proposed on a retry run
    // (which needs no new reason).
    released.delete("nixos-26.11");
    const heldR = new Set([`nixpkgs-stable\0${"b".repeat(40)}`]);
    let h1 = new u.Report(join(dir, "versions"), new Date(T0));
    await u.maybeBumpStable(h1, heldR, new Date(T0), hist(8), T0, () => T0, dir);
    assert.deepEqual([h1.changed, kinds(h1)], [[], ["on-main", "held"]]);
    assert.deepEqual([...u.retryNames(h1, false)], ["nixpkgs-stable"], "a quiet run retries it");
    h1 = new u.Report(join(dir, "versions"), new Date(T0));
    await u.maybeBumpStable(h1, heldR, new Date(T0), hist(2), T0, () => T0, dir, true);
    assert.deepEqual([h1.changed[0]?.to, h1.changed[0]?.why], ["b".repeat(40), "retrying a held revision"], "the retry, though not due");
    released.add("nixos-26.11");
    pinFile("c".repeat(40), "nixos-26.11");
    r = await go(hist(30));
    assert.deepEqual([r.changed, kinds(r)], [[], ["on-main"]], "at the channel's revision: nothing to say, never pass");
    assert.ok(!kinds(r).includes("pass"));
  } finally {
    Object.assign(ch, { rev: real.rev, released: real.released, prefetch: real.prefetch });
    u.stableBumper.check = real.check;
  }
});

test("a release whose required files are past the first 100 assets is still complete (assets paged)", async () => {
  process.env.GH_TOKEN = "test";
  const extra = Array.from({ length: 100 }, (_, i) => ({ name: `extra-${i}.zip` }));
  const big = { ...rel("v0.2.0", false, "2026-11-13T00:00:00Z"), releaseAssets: { nodes: extra, pageInfo: { hasNextPage: true, endCursor: "a1" } } };
  const asked: string[] = [];
  const repo = await u.fetchT3code(async (_url: string, body?: any) => {
    asked.push(body.query);
    if (/release\(tagName: "v0\.2\.0"\)/.test(body.query)) {
      return { data: { repository: { release: { releaseAssets: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: files("0.2.0") } } } } };
    }
    return { data: { repository: { latestRelease: big, releases: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [big, rel("v0.2.1-nightly.20261113.1", true, "2026-11-13T01:00:00Z")] } } } };
  });
  assert.equal(select(repo).latest, "v0.2.0");
  assert.match(asked[1], /after: "a1"/);
  // A further page that doesn't come back is an error, not a silently incomplete release.
  await assert.rejects(u.fetchT3code(async (_url: string, body?: any) => (/release\(tagName/.test(body.query) ? { data: { repository: null } }
    : { data: { repository: { latestRelease: { ...rel("v0.2.0", false, "2026-11-13T00:00:00Z"), releaseAssets: { nodes: Array.from({ length: 100 }, (_, i) => ({ name: `extra-${i}.zip` })), pageInfo: { hasNextPage: true, endCursor: "a1" } } },
      releases: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } })),
    /didn't come back/);
});

test("a `tags` package keeps its pin only when the pinned release was crowded out of a full window", async () => {
  const { wanted } = GITHUB.opencode;
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ name: "opencode", version: "2.9.0", tag: "v2.9.0", assets: {} }));
  const asset = (name: string) => ({ name, browser_download_url: `https://x/${name}` });
  const release = (v: string) => ({ tag_name: `v${v}`, draft: false, prerelease: false, assets: Object.values(wanted).map((a) => asset(a as string)) });
  const daemon = (i: number) => ({ tag_name: `process-daemon-v${i}`, draft: false, prerelease: false, assets: [] });
  const real = globalThis.fetch;
  const asked: string[] = [];
  const use = (list: any[]) => {
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return String(url).includes("/releases?per_page=100") ? Response.json(list) : new Response("no", { status: 404 });
    }) as typeof fetch;
    clearFetched();
  };
  try {
    // Crowded: a full window of daemon releases plus an older backport; v2.9.0 isn't in it.
    use([release("2.1.0"), ...Array.from({ length: 99 }, (_, i) => daemon(i))]);
    let report = new u.Report(dir);
    await u.resolveGithub(report, "opencode", new Set(), false);
    assert.deepEqual(report.changed, []);
    assert.deepEqual(report.observations.map((o) => [o.kind, o.version]), [["waiting", "2.9.0"]]);
    // Withdrawn: the window isn't full and v2.9.0 is gone, so upstream moved back: it goes on to pin 2.1.0.
    use([release("2.1.0"), daemon(1)]);
    asked.length = 0;
    report = new u.Report(dir);
    await u.resolveGithub(report, "opencode", new Set(), false).catch(() => {});
    assert.ok(!report.observations.some((o) => o.kind === "waiting"));
    assert.ok(asked.some((x) => !x.includes("/releases?per_page=100")), "it goes on to read the release's files");
  } finally {
    globalThis.fetch = real;
    clearFetched();
  }
});

test("fillAssets: each tag once, exactly the budget, and it stops after the deciding release", async () => {
  const { fillAssets } = await import("../shared/sources.ts");
  const mk = (tag: string) => ({ tagName: tag, releaseAssets: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "c" } } });
  const asked: string[] = [];
  const run = async (q: string) => {
    asked.push(/tagName: "([^"]+)"/.exec(q)![1]);
    return { repository: { release: { releaseAssets: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: "x" }] } } } };
  };
  // The same tag twice (latestRelease is also in the list): paged once.
  await fillAssets([mk("a"), mk("a"), mk("b")], run, { budget: 2 });
  assert.deepEqual(asked, ["a", "b"], "a duplicate tag once; a budget of 2 allows exactly 2");
  await assert.rejects(fillAssets([mk("c"), mk("d"), mk("e")], run, { budget: 2 }), /budget \(2\)/);
  asked.length = 0;
  await fillAssets([mk("f"), mk("g")], run, { until: (r) => r.tagName === "f" });
  assert.deepEqual(asked, ["f"]);
});

test("fetchT3code pages assets only for the deciding releases (a skipped preview never)", async () => {
  process.env.GH_TOKEN = "test";
  const asked: string[] = [];
  const preview = { ...rel("v0.2.0-preview.20261112.1", true, "2026-11-12T00:00:00Z"), releaseAssets: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "x" } } };
  await u.fetchT3code(async (_url: string, body?: any) => {
    asked.push(body.query);
    return doc([preview, rel("v0.1.10-nightly.20261112.9", true, "2026-11-12T00:00:00Z")]);
  });
  assert.ok(!asked.some((q) => q.includes("release(tagName:")));
});

test("a `tags` package at its pin's version (same version, new bytes) is still resolved, never kept early", async () => {
  const { wanted } = GITHUB.opencode;
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ name: "opencode", version: "2.9.0", tag: "v2.9.0", assets: {} }));
  const release = (v: string) => ({ tag_name: `v${v}`, draft: false, prerelease: false, assets: Object.values(wanted).map((a) => ({ name: a, browser_download_url: `https://x/${a}` })) });
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => (asked.push(String(url)),
    String(url).includes("/releases?per_page=100") ? Response.json([release("2.9.0"), ...Array.from({ length: 99 }, (_, i) => ({ tag_name: `d${i}`, assets: [] }))])
      : new Response("no", { status: 404 }))) as typeof fetch;
  clearFetched();
  try {
    const report = new u.Report(dir);
    await u.resolveGithub(report, "opencode", new Set(), false).catch(() => {});
    assert.ok(!report.observations.some((o) => o.kind === "waiting"));
    assert.ok(asked.length > 1);
  } finally {
    globalThis.fetch = real;
    clearFetched();
  }
});

test("fillRules: a complete release isn't paged further; a nightly below the latest channel's release still is (it's the nightly channel's own)", async () => {
  const { fillAssets } = await import("../shared/sources.ts");
  const { fillRules, decisive } = await import("../shared/channels.ts");
  const more = (r: any) => ({ ...r, releaseAssets: { nodes: [...r.releaseAssets.nodes], pageInfo: { hasNextPage: true, endCursor: "x" } } });
  const latestChannelRelease = more(rel("v0.3.0", false, "2026-11-13T00:00:00Z")); // complete on page 1, with more pages
  const asked: string[] = [];
  const repo = { latestRelease: latestChannelRelease, releases: { nodes: [latestChannelRelease] } };
  await fillAssets(decisive(repo as any), async (q) => { asked.push(q); throw new Error("an unneeded page"); }, fillRules);
  assert.deepEqual(asked, []);
  const oldNightly = more(rel("v0.2.0-nightly.20261112.1", true, "2026-11-12T00:00:00Z", false)); // below the latest channel's
  const repo2 = { latestRelease: latestChannelRelease, releases: { nodes: [oldNightly, latestChannelRelease] } };
  await assert.rejects(fillAssets(decisive(repo2 as any), async () => { throw new Error("needed page"); }, fillRules), /needed page/);
});

test("a release repeated on the next list page (one created between pages) is judged by its filled copy", async () => {
  process.env.GH_TOKEN = "test";
  const extra = Array.from({ length: 100 }, (_, i) => ({ name: `extra-${i}.zip` }));
  const big = (tagName: string) => ({ tagName, isPrerelease: true, isDraft: false, createdAt: "2026-11-13T00:00:00Z",
    releaseAssets: { nodes: [...extra], pageInfo: { hasNextPage: true, endCursor: "a1" } } });
  const older = { tagName: "v0.1.10-nightly.20261112.1", isPrerelease: true, isDraft: false, createdAt: "2026-11-12T00:00:00Z",
    releaseAssets: { nodes: requiredAssets("v0.1.10-nightly.20261112.1").map((name) => ({ name })), pageInfo: { hasNextPage: false, endCursor: null } } };
  const N = "v0.1.10-nightly.20261113.2";
  const repo = await u.fetchT3code(async (_url: string, body?: any) => {
    const q: string = body.query;
    if (q.includes("release(tagName:")) return { data: { repository: { release: { releaseAssets:
      { pageInfo: { hasNextPage: false, endCursor: null }, nodes: requiredAssets(N).map((name) => ({ name })) } } } } };
    // Page 1 ends with N; a release is created; page 2 starts with N again.
    return q.includes("after:")
      ? { data: { repository: { latestRelease: null, releases: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [big(N), older] } } } }
      : { data: { repository: { latestRelease: null, releases: { pageInfo: { hasNextPage: true, endCursor: "p1" }, nodes: [big(N)] } } } };
  });
  const picked = select(repo);
  assert.equal(picked.nightly, N);
  assert.deepEqual(picked.incomplete, []);
});

test("end to end: a vendor pointer moving back opens the issue in that run; a later pass at the pulled version closes it", async () => {
  write(pin("claude-code", "2.1.322"));
  const gh = new Fake();
  const at = new Date(Date.UTC(2026, 10, 15, 12));
  await issues.apply(candidate(pin("claude-code", "2.1.321")).observations, gh, at);
  assert.deepEqual(gh.issueList.map((i) => [i.title, i.state]), [["downgrade: claude-code (2.1.322 pulled)", "open"]]);
  // main publishes 2.1.321; then upstream points at 2.1.322 again and main has it.
  write(pin("claude-code", "2.1.321"));
  await issues.apply(candidate(pin("claude-code", "2.1.321")).observations, gh, new Date(at.getTime() + 3600_000));
  assert.equal(gh.issueList[0].state, "open", "on the lower version: not back");
  write(pin("claude-code", "2.1.322"));
  await issues.apply(candidate(pin("claude-code", "2.1.322")).observations, gh, new Date(at.getTime() + 7200_000));
  assert.equal(gh.issueList[0].state, "closed");
});

// agent-browser's optional browsers: the pin's wait and the variants' issues.
const bo = (kind: string, pkg: string, channel: string | null, detail = "", version: string | null = null) => ({ kind, package: pkg, channel, version, detail });
const openOf = (gh: Fake, prefix: string) => gh.issueList.filter((i) => i.state === "open" && (issues.metaOf(i)?.key ?? "").startsWith(prefix));

test("issues: a browser wait's start is written once, kept while it's open about the same main revision, and read back", async () => {
  const gh = new Fake();
  const t0 = new Date("2026-11-15T00:00:00Z");
  const hour = 3600_000;
  const main = "a".repeat(40);
  await issues.apply([bo("browser-waiting", "browser-unstable", null, "google-chrome on x86_64-linux: 404", main)], gh, t0, "", null, t0.toISOString());
  const since = issues.metaOf(openOf(gh, "browser-waiting/")[0])!.since;
  assert.equal(since, t0.toISOString());
  // Chrome comes back, chromium goes missing (another channel revision), a day later: main is the same.
  const t1 = new Date(t0.getTime() + 24 * hour);
  await issues.apply([bo("browser-waiting", "browser-unstable", null, "chromium on aarch64-linux: not cached", main)], gh, t1, "", null, t1.toISOString());
  assert.equal(issues.metaOf(openOf(gh, "browser-waiting/")[0])!.since, since, "alternating browsers don't restart the clock");
  // A retry passing on the published pin closes its browser-failed issue, never the wait.
  await issues.apply([bo("browser-failed", "browser-unstable", "google-chrome", "x86_64-linux: smoke failed")], gh, t1, "", null, t1.toISOString());
  const t2 = new Date(t1.getTime() + hour);
  await issues.apply([bo("browser-ok", "browser-unstable", "google-chrome", "x86_64-linux"), bo("browser-ok", "browser-unstable", "google-chrome", "aarch64-linux"),
    bo("on-main", "browser-unstable", null, "", main), bo("browser-waiting", "browser-unstable", null, "chromium on aarch64-linux: not cached", main)],
    gh, t2, "", null, t2.toISOString());
  assert.equal(openOf(gh, "browser-failed/").length, 0);
  assert.equal(issues.metaOf(openOf(gh, "browser-waiting/")[0])!.since, since, "main's own revision on main doesn't end it");
  assert.deepEqual(issues.waitingStarts(await gh.issues()), [{ package: "browser-unstable", since, from: main }]);
  // main moves on: on-main at another revision ends the wait.
  const t3 = new Date(t2.getTime() + hour);
  await issues.apply([bo("on-main", "browser-unstable", null, "", "m".repeat(40))], gh, t3, "", null, t3.toISOString());
  assert.deepEqual(issues.waitingStarts(await gh.issues()), []);
  // A wait about the new main revision starts its own clock; so does one
  // reported about yet another revision while it's open.
  const t4 = new Date(t3.getTime() + hour);
  await issues.apply([bo("browser-waiting", "browser-unstable", null, "x", "m".repeat(40))], gh, t4, "", null, t4.toISOString());
  assert.deepEqual(issues.waitingStarts(await gh.issues()), [{ package: "browser-unstable", since: t4.toISOString(), from: "m".repeat(40) }]);
  const t5 = new Date(t4.getTime() + hour);
  await issues.apply([bo("browser-waiting", "browser-unstable", null, "x", "n".repeat(40))], gh, t5, "", null, t5.toISOString());
  assert.deepEqual(issues.waitingStarts(await gh.issues()), [{ package: "browser-unstable", since: t5.toISOString(), from: "n".repeat(40) }]);
  // browsers-ready ends it too.
  const t6 = new Date(t5.getTime() + hour);
  await issues.apply([bo("browsers-ready", "browser-unstable", null)], gh, t6, "", null, t6.toISOString());
  assert.deepEqual(issues.waitingStarts(await gh.issues()), []);
});

test("issues: browser-failed closes only when both systems pass in the same run; a missing result is no evidence", async () => {
  const gh = new Fake();
  const at = new Date("2026-11-15T00:00:00Z");
  await issues.apply([bo("browser-failed", "browser-stable", "chromium", "aarch64-linux: not available")], gh, at);
  await issues.apply([bo("browser-ok", "browser-stable", "chromium", "x86_64-linux")], gh, new Date(at.getTime() + 1000));
  assert.equal(openOf(gh, "browser-failed/").length, 1, "one system's pass");
  await issues.apply([bo("browser-ok", "browser-stable", "chromium", "x86_64-linux"), bo("browser-failed", "browser-stable", "chromium", "aarch64-linux: smoke failed")],
    gh, new Date(at.getTime() + 2000));
  assert.equal(openOf(gh, "browser-failed/").length, 1, "one passes, the other fails");
  // Another scope's pass (the stable set's) closes nothing here.
  await issues.apply([bo("browser-ok", "stable-browser-stable", "chromium", "x86_64-linux"), bo("browser-ok", "stable-browser-stable", "chromium", "aarch64-linux")],
    gh, new Date(at.getTime() + 3000));
  assert.equal(openOf(gh, "browser-failed/").length, 1, "the stable set's scope is its own");
  await issues.apply([bo("browser-ok", "browser-stable", "chromium", "x86_64-linux"), bo("browser-ok", "browser-stable", "chromium", "aarch64-linux")],
    gh, new Date(at.getTime() + 4000));
  assert.equal(openOf(gh, "browser-failed/").length, 0);
});

test("issues: a browser wait with a malformed start is skipped", () => {
  const body = (meta: object) => `<!-- t3code-nix: ${JSON.stringify(meta)} -->`;
  assert.equal(issues.metaOf({ number: 1, title: "", state: "open", body: body({ key: "browser-waiting/browser-unstable/-", version: null, since: "soon" }) } as any), null);
});
