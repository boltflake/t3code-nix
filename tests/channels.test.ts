// Channel rules (shared/channels.ts). Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify, compareTags, isComplete, select } from "../shared/channels.ts";
const tags = (list: { tagName: string }[]) => list.map((r) => r.tagName);

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/t3code-releases-2026-11-12.json", import.meta.url), "utf8"),
).data.repository;

const files = (v: string) => [
  `t3-${v}-linux-x64.tar.gz`, `t3-${v}-linux-arm64.tar.gz`,
  `T3-Code-${v}-amd64.deb`, `T3-Code-${v}-arm64.deb`, "SHA256SUMS",
].map((name) => ({ name }));
const rel = (tagName: string, isPrerelease: boolean, createdAt: string, complete = true) => ({
  tagName, isPrerelease, isDraft: false, createdAt,
  releaseAssets: { nodes: complete ? files(tagName.slice(1)) : [] },
});

test("real mixed stream: latest-channel, nightly, preview and android releases side by side", () => {
  const kinds = new Set(fixture.releases.nodes.map(classify));
  assert.ok(kinds.has("latest") && kinds.has("nightly") && kinds.has("skip"));
  const picked = select(fixture);
  assert.equal(picked.latest, "v0.1.9");
  assert.match(picked.nightly ?? "", /^v0\.1\.10-nightly\.\d{8}\.\d+$/);
  assert.deepEqual(picked.unknown, []);
});

test("a rollback on the latest channel upstream is followed", () => {
  const picked = select({
    latestRelease: rel("v1.0.0", false, "2026-12-03T00:00:00Z"),
    releases: { nodes: [rel("v1.1.0", false, "2026-12-02T00:00:00Z")] },
  });
  assert.equal(picked.latest, "v1.0.0");
});

test("an unknown release newer than the latest channel's is reported even if a newer nightly exists", () => {
  const picked = select({
    latestRelease: rel("v0.1.9", false, "2026-11-11T00:00:00Z"),
    releases: { nodes: [
      rel("v0.1.10-nightly.20261113.2", true, "2026-11-13T00:00:00Z"),
      rel("v0.1.10-release", false, "2026-11-12T00:00:00Z"),
    ] },
  });
  assert.equal(picked.nightly, "v0.1.10-nightly.20261113.2");
  assert.deepEqual(tags(picked.unknown), ["v0.1.10-release"]);
});

test("classification", () => {
  assert.equal(classify({ tagName: "v0.1.9", isPrerelease: false }), "latest");
  assert.equal(classify({ tagName: "v0.1.10-nightly.20261112.4580", isPrerelease: true }), "nightly");
  assert.equal(classify({ tagName: "v0.1.10-preview.20261112.4571", isPrerelease: true }), "skip");
  assert.equal(classify({ tagName: "android-beta-784", isPrerelease: true }), "skip");
  assert.equal(classify({ tagName: "v0.2.0", isPrerelease: false, isDraft: true }), "skip");
  // A renamed channel must not be silently skipped.
  assert.equal(classify({ tagName: "v0.1.11-canary.20261201.1", isPrerelease: true }), "unknown");
  // A vX.Y.Z tag marked prerelease is suspicious, not the latest channel.
  assert.equal(classify({ tagName: "v0.2.0", isPrerelease: true }), "unknown");
});

test("a nightly sorts below its own vX.Y.Z; nightly channel never lags the latest channel", () => {
  assert.ok(compareTags("v0.1.9-nightly.20261111.4515", "v0.1.9") < 0);
  assert.ok(compareTags("v0.1.10-nightly.20261112.4564", "v0.1.9") > 0);
  const picked = select({
    latestRelease: rel("v0.2.0", false, "2026-12-02T00:00:00Z"),
    releases: { nodes: [rel("v0.2.0-nightly.20261201.9", true, "2026-12-01T00:00:00Z")] },
  });
  assert.equal(picked.nightly, "v0.2.0");
});

test("a preview with a lower version than the latest channel's is ignored", () => {
  const picked = select({
    latestRelease: rel("v0.1.9", false, "2026-11-11T11:00:00Z"),
    releases: { nodes: [rel("v0.1.9-preview.20261111.4536", true, "2026-11-11T18:00:00Z")] },
  });
  assert.equal(picked.latest, "v0.1.9");
  assert.equal(picked.nightly, "v0.1.9");
  assert.deepEqual(picked.unknown, []);
});

test("an incomplete release is not picked, and is reported", () => {
  const picked = select({
    latestRelease: rel("v0.1.9", false, "2026-11-11T00:00:00Z"),
    releases: { nodes: [rel("v0.1.10-nightly.20261112.1", true, "2026-11-12T00:00:00Z", false)] },
  });
  assert.equal(picked.nightly, "v0.1.9");
  assert.deepEqual(tags(picked.incomplete), ["v0.1.10-nightly.20261112.1"]);
});

test("a newer release that fits no rule is reported as unknown", () => {
  const picked = select({
    latestRelease: rel("v0.1.9", false, "2026-11-11T00:00:00Z"),
    releases: { nodes: [rel("v0.1.10-canary.20261112.1", true, "2026-11-12T00:00:00Z")] },
  });
  assert.deepEqual(tags(picked.unknown), ["v0.1.10-canary.20261112.1"]);
});

test("an unknown latestRelease is always reported", () => {
  const picked = select({
    latestRelease: rel("v1.0.0-release", false, "2026-12-01T00:00:00Z"),
    releases: { nodes: [rel("v1.0.0-nightly.20261130.1", true, "2026-11-30T00:00:00Z")] },
  });
  assert.equal(picked.latest, null);
  assert.deepEqual(tags(picked.unknown), ["v1.0.0-release"]);
});

test("an incomplete nightly older than the latest channel's release is ignored", () => {
  const picked = select({
    latestRelease: rel("v1.0.0", false, "2026-12-01T00:00:00Z"),
    releases: { nodes: [rel("v1.0.0-nightly.20261112.1", true, "2026-11-12T00:00:00Z", false)] },
  });
  assert.equal(picked.nightly, "v1.0.0");
  assert.deepEqual(picked.incomplete, []);
});

test("channels: upstream's update-feed release is skipped, and a release needs every file", () => {
  // A prerelease holding only the desktop app's update feed (seen 2026-11-12).
  const feed = { tagName: "update-feed", isPrerelease: true, isDraft: false, createdAt: "2026-11-12T23:09:51Z", releaseAssets: { nodes: [{ name: "nightly.json" }] } };
  assert.equal(classify(feed), "skip");
  const latestChannelRelease = rel("v0.1.9", false, "2026-11-11T09:11:31Z");
  assert.deepEqual(select({ latestRelease: latestChannelRelease, releases: { nodes: [feed, latestChannelRelease] } }).unknown, []);
  // Missing any one of the files leaves a release incomplete.
  for (const missing of files("0.2.0").map((f) => f.name)) {
    const r = { ...rel("v0.2.0", false, "2026-11-13T00:00:00Z"), releaseAssets: { nodes: files("0.2.0").filter((f) => f.name !== missing) } };
    assert.equal(isComplete(r), false, missing);
  }
  assert.equal(isComplete(rel("v0.2.0", false, "2026-11-13T00:00:00Z")), true);
});

test("channels: an unknown release older than the latest channel's raises nothing", () => {
  const latestChannelRelease = rel("v0.1.9", false, "2026-11-11T00:00:00Z");
  const old = { ...rel("v0.1.8-hotfix", false, "2026-11-01T00:00:00Z"), releaseAssets: { nodes: [] } };
  assert.equal(classify(old), "unknown");
  assert.deepEqual(select({ latestRelease: latestChannelRelease, releases: { nodes: [latestChannelRelease, old] } }).unknown, []);
});
