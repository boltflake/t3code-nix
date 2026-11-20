// tooling.ts: the weekly check of the project's own CI tooling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionlintLabels, NODE_RELEASES, nodeMajors, nodejs, offeredUbuntu, RUNNER_IMAGES, runnerImage, tooling, usedUbuntu } from "../scripts/ci/tooling.ts";
import * as issues from "../scripts/ci/issues.ts";
import { obs } from "../scripts/update.ts";
import { Fake } from "./fake-gh.ts";

const README = [
  "# GitHub Actions Runner Images",
  "| Image | Architecture | YAML Label | Included Software |",
  "| --------------------| -----| ----| ----|",
  "| Ubuntu 28.04 [![preview](x)] | x64 | `ubuntu-28.04` | [ubuntu-28.04] |",
  "| Ubuntu 26.04 | x64 | `ubuntu-26.04` | [ubuntu-26.04], see `ubuntu-30.04` |",
  "| Ubuntu 26.04 Arm64 | arm64 | `ubuntu-26.04-arm` | [ubuntu-26.04-arm64] |",
  "| Ubuntu 24.04 | x64 | `ubuntu-latest` or `ubuntu-24.04` | [ubuntu-24.04] |",
  "",
  "| Other table | `ubuntu-30.04` |",
  "Text mentioning `ubuntu-32.04`.",
].join("\n");

function repo(workflows: Record<string, string>, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tooling-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(dir, ".github", "actions", "setup"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  for (const [f, body] of Object.entries(workflows)) writeFileSync(join(dir, ".github", "workflows", f), body);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: ">=26" } }));
  writeFileSync(join(dir, ".github", "actions", "setup", "action.yml"), "attrs=(nixpkgs#nodejs_26)\n        node-version: 26\n");
  writeFileSync(join(dir, "lib", "checks.nix"), "  nodejs_26,\n");
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
}
const wf = (x64: string, arm: string) => `jobs:\n  a:\n    runs-on: ${x64}\n  b:\n    runs-on: ${arm}\n`;
const kinds = (r: { observations: { kind: string; package: string | null }[] }) => r.observations.map((o) => `${o.kind} ${o.package}`);

test("runner images: the README's label column only (no preview), against every label in use, per architecture", () => {
  assert.deepEqual(offeredUbuntu(README), { x64: 26.04, arm: 26.04 });
  assert.deepEqual(offeredUbuntu("no table here"), { x64: null, arm: null });
  // A workflow behind while another is current (and a comment naming the
  // new one) still counts as behind.
  const mixed = repo({ "a.yml": wf("ubuntu-26.04", "ubuntu-26.04-arm"), "b.yml": `# moving to ubuntu-26.04 soon\n${wf("ubuntu-24.04", "ubuntu-26.04-arm")}` });
  const current = repo({ "a.yml": wf("ubuntu-26.04", "ubuntu-26.04-arm") });
  const x64only = repo({ "a.yml": "jobs:\n  a:\n    runs-on: ubuntu-24.04\n" });
  try {
    assert.deepEqual(usedUbuntu(join(mixed, ".github", "workflows")), { x64: [26.04, 24.04], arm: [26.04, 26.04] });
    const r = runnerImage(join(mixed, ".github", "workflows"), README);
    assert.deepEqual(kinds(r), ["tooling-outdated runner-image"]);
    assert.equal(r.observations[0].version, "ubuntu-26.04", "the affected target only, not arm's");
    assert.match(r.observations[0].detail, /ubuntu-26\.04 \(the workflows use ubuntu-24\.04\)/);
    assert.deepEqual(kinds(runnerImage(join(current, ".github", "workflows"), README)), ["tooling-ok runner-image"]);
    // x64 only in use: arm missing from the table doesn't matter.
    const noArm = README.split("\n").filter((l) => !l.includes("-arm")).join("\n");
    assert.deepEqual(kinds(runnerImage(join(x64only, ".github", "workflows"), noArm)), ["tooling-outdated runner-image"]);
    // An architecture in use that the table doesn't show: unknown, nothing written.
    const r2 = runnerImage(join(current, ".github", "workflows"), noArm);
    assert.deepEqual(r2.observations, []);
    assert.match(r2.unknown[0].why, /no arm Ubuntu image/);
  } finally {
    for (const d of [mixed, current, x64only]) rmSync(d, { recursive: true, force: true });
  }
});

test("nodejs: a newer LTS line than the oldest Node the project is on (a Current release isn't one)", () => {
  const dir = repo({ "a.yml": wf("ubuntu-26.04", "ubuntu-26.04-arm") });
  const index = (rows: [string, string | false][]) => JSON.stringify(rows.map(([version, lts]) => ({ version, lts })));
  try {
    assert.deepEqual(nodeMajors(dir), { majors: [26, 26, 26, 26], missing: [] });
    assert.deepEqual(kinds(nodejs(dir, index([["v27.1.0", false], ["v26.13.1", "Lyra"]]))), ["tooling-ok nodejs"]);
    const r = nodejs(dir, index([["v28.0.1", "Mira"], ["v26.13.1", "Lyra"]]));
    assert.deepEqual([r.observations[0].kind, r.observations[0].version], ["tooling-outdated", "28"]);
    // engines moved but the setup action still installs 26: still behind.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: ">=28" } }));
    assert.deepEqual(kinds(nodejs(dir, index([["v28.0.1", "Mira"]]))), ["tooling-outdated nodejs"]);
    // An index that isn't one: unknown.
    assert.deepEqual(nodejs(dir, "not json").observations, []);
    // Quoted, or nodejs-slim: still read. A place that names no version:
    // unknown, never a pass on what's left.
    writeFileSync(join(dir, ".github", "actions", "setup", "action.yml"), 'attrs=(nixpkgs#nodejs-slim_26)\n        node-version: "26"\n');
    assert.deepEqual(nodeMajors(dir).majors.sort(), [26, 26, 26, 28]);
    // A "node" script, or a commented-out pin, isn't a version.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { node: "node 30" } }));
    writeFileSync(join(dir, "lib", "checks.nix"), "  # nodejs_30,\n  nodejs,\n");
    assert.deepEqual(nodeMajors(dir).missing, ["package.json's engines", "lib/checks.nix's Node"]);
    const r2 = nodejs(dir, index([["v28.0.1", "Mira"]]));
    assert.deepEqual(r2.observations, []);
    assert.match(r2.unknown[0].why, /lib\/checks\.nix's Node/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("actionlint labels: the file can go once the pinned actionlint passes the workflows without it (the workflow's probe)", () => {
  const none = repo({});
  const dir = repo({}, { ".github/actionlint.yaml": "self-hosted-runner:\n  labels:\n    - ubuntu-26.04\n" });
  try {
    assert.deepEqual(kinds(actionlintLabels(none, null)), ["tooling-ok actionlint-labels"], "no file: nothing to remove");
    assert.deepEqual(kinds(actionlintLabels(dir, "known")), ["tooling-outdated actionlint-labels"]);
    assert.match(actionlintLabels(dir, "known").observations[0].detail, /delete it.*closes this issue/s);
    assert.deepEqual(kinds(actionlintLabels(dir, "unknown")), ["tooling-ok actionlint-labels"]);
    for (const probe of [null, "error"]) {
      const r = actionlintLabels(dir, probe);
      assert.deepEqual(r.observations, [], `probe ${probe}: nothing written`);
      assert.equal(r.unknown.length, 1);
    }
  } finally {
    for (const d of [none, dir]) rmSync(d, { recursive: true, force: true });
  }
});

test("this repository: every place that pins Node reads, and its runs-on labels are found", () => {
  const root = join(import.meta.dirname, "..");
  const { majors, missing } = nodeMajors(root);
  assert.deepEqual(missing, []);
  assert.ok(majors.length >= 4 && majors.every((m) => m === majors[0]), majors.join(" "));
  const used = usedUbuntu(join(root, ".github", "workflows"));
  assert.ok(used.x64.length > 0 && used.arm.length > 0);
});

test("tooling: one observation per item, or why it's unknown (a source that's down)", async () => {
  const dir = repo({ "a.yml": wf("ubuntu-24.04", "ubuntu-24.04-arm") });
  try {
    const all = await tooling(dir, null, async (url) => (url === RUNNER_IMAGES ? README : JSON.stringify([{ version: "v26.13.1", lts: "Lyra" }])));
    assert.deepEqual(kinds(all).sort(), ["tooling-ok actionlint-labels", "tooling-ok nodejs", "tooling-outdated runner-image"]);
    assert.deepEqual(all.unknown, []);
    const down = await tooling(dir, null, async (url) => { if (url === NODE_RELEASES) throw new Error("HTTP 503"); return README; });
    assert.deepEqual(kinds(down).sort(), ["tooling-ok actionlint-labels", "tooling-outdated runner-image"]);
    assert.deepEqual(down.unknown, [{ item: "nodejs", why: `${NODE_RELEASES}: HTTP 503` }]);
    // That week, issues.ts gets the script's observations: the open nodejs
    // issue stays as it is.
    const gh = new Fake();
    const t0 = Date.UTC(2026, 10, 20, 6);
    await issues.apply([obs("tooling-outdated", "nodejs", "28", "Node 28")], gh, new Date(t0));
    await issues.apply(down.observations, gh, new Date(t0 + 7 * 86400_000));
    assert.deepEqual(gh.issueList.filter((i) => i.title.includes("nodejs")).map((i) => i.state), ["open"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issues: tooling-outdated opens one per item, and tooling-ok closes that item's", async () => {
  const gh = new Fake();
  const t0 = Date.UTC(2026, 10, 20, 6), week = 7 * 86400_000;
  await issues.apply([obs("tooling-outdated", "runner-image", "ubuntu-26.04", "GitHub offers ubuntu-26.04"), obs("tooling-outdated", "nodejs", "28", "Node 28")], gh, new Date(t0));
  assert.deepEqual(gh.issueList.map((i) => [i.title, i.state]), [["tooling-outdated: runner-image", "open"], ["tooling-outdated: nodejs", "open"]]);
  await issues.apply([obs("tooling-ok", "runner-image")], gh, new Date(t0 + week));
  assert.deepEqual(gh.issueList.map((i) => i.state), ["closed", "open"]);
});
