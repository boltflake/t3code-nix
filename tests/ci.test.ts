// Workflow fault tests: the update workflow's job scripts (scripts/ci/)
// against real git repositories in temporary folders, a local bare repo as
// "origin", and an in-memory GitHub (Fake). No network.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as candidate from "../scripts/ci/candidate.ts";
import { current } from "../scripts/ci/gate.ts";
import { UPDATE_JOBS } from "../scripts/ci/gh.ts";
import { BRANCH_ONLY, checkNames, failedOnNotes, notesOf } from "../scripts/ci/test.ts";
import { DryRun } from "../scripts/ci/gh.ts";
import { Fake } from "./fake-gh.ts";
import type { Release } from "../scripts/ci/gh.ts";
import * as issues from "../scripts/ci/issues.ts";
import * as narrow from "../scripts/ci/narrow.ts";
import { publish, latestChannelTag } from "../scripts/ci/publish.ts";
import { moved } from "../scripts/lib/snapshot.ts";
import { firstPublications, purgeTestCaches, reconcile, stableNote } from "../scripts/ci/reconcile.ts";
import { obs } from "../scripts/update.ts";
import { writeHeld } from "../scripts/ci/held.ts";
import { SYSTEMS } from "../scripts/lib/util.ts";

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
Object.assign(process.env, GIT_ENV);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const pinText = (name: string, version: string, extra: object = {}) => JSON.stringify({ name, version, assets: {}, ...extra }, null, 2) + "\n";

let tmp: string;
const cwd = process.cwd();
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "ci-test-")); });
afterEach(() => { process.chdir(cwd); rmSync(tmp, { recursive: true, force: true }); });

/** A working clone of a bare "origin", starting with pins on main. */
class Repo {
  origin = join(tmp, "origin.git");
  work = join(tmp, "work");
  constructor(pins: Record<string, string>) {
    git(tmp, "init", "-q", "--bare", "-b", "main", this.origin);
    git(tmp, "init", "-q", "-b", "main", this.work);
    mkdirSync(join(this.work, "versions"));
    for (const [n, v] of Object.entries(pins)) writeFileSync(join(this.work, "versions", `${n}.json`), pinText(n, v));
    git(this.work, "add", "-A");
    git(this.work, "commit", "-q", "-m", "init");
    git(this.work, "remote", "add", "origin", this.origin);
    git(this.work, "push", "-q", "origin", "main");
    process.chdir(this.work);
  }
  head = () => git(this.work, "rev-parse", "HEAD");
  originMain = () => git(this.work, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0];
  bump = (n: string, v: string) => writeFileSync(join(this.work, "versions", `${n}.json`), pinText(n, v));
  lock = (rev: string) => writeFileSync(join(this.work, "flake.lock"), JSON.stringify({ nodes: { nixpkgs: { locked: { rev } } } }));
  /** Someone else moves main while our run is testing. */
  otherCommitOnOrigin() {
    const other = join(tmp, "other");
    git(tmp, "clone", "-q", this.origin, other);
    writeFileSync(join(other, "README"), "x");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "someone else");
    git(other, "push", "-q", "origin", "main");
  }
  /** A candidate kept outside the checkout, as the workflow does. */
  candidate(bumps: Record<string, string>) {
    for (const [n, v] of Object.entries(bumps)) this.bump(n, v);
    const dir = join(tmp, "candidate");
    candidate.make(dir);
    git(this.work, "checkout", "-q", "--", ".");
    git(this.work, "clean", "-qfd");
    return dir;
  }
}

const env = (extra: Record<string, string> = {}) => ({ RUN_ID: "42", RUN_URL: "https://run", ATTEMPT: "0", DRY_RUN: "false", ...extra });

// ---- narrow ---------------------------------------------------------------

const inputs: candidate.Input[] = [{ name: "grok", files: [], from: "1", to: "2" }, { name: "codex", files: [], from: "2", to: "3" }];
function result(dir: string, set: string, system: string, passed: boolean, tree = "t1") {
  writeFileSync(join(dir, `${set}-${system}.json`), JSON.stringify({ set, system, passed, failed: passed ? [] : ["t3-smoke"] }));
  writeFileSync(join(dir, `manifest-${set}-${system}.json`), JSON.stringify({ codex: { path: "/nix/store/x" } }));
  writeFileSync(join(dir, `tree-${set}-${system}.txt`), tree + "\n");
}
const both = (dir: string, set: string, passed: boolean) => SYSTEMS.forEach((s) => result(dir, set, s, passed));

test("narrow: manifests and tree files aren't results", () => {
  both(tmp, "candidate", true);
  assert.equal(narrow.plan(inputs, narrow.load(tmp)), null);
});

test("narrow: a missing architecture never passes, and isn't held as a test failure", () => {
  result(tmp, "candidate", "x86_64-linux", true);
  assert.deepEqual(narrow.plan(inputs, narrow.load(tmp)), ["main", "grok", "codex"]);
  both(tmp, "main", true);
  result(tmp, "grok", "x86_64-linux", true); // aarch64 never reported
  both(tmp, "codex", true);
  const { final, observations } = narrow.decide(inputs, narrow.load(tmp));
  assert.deepEqual(final, ["codex"], "not published");
  assert.ok(!observations.some((o) => o.kind === "test-failed"), "a dead runner says nothing about grok");
  assert.match(observations.find((o) => o.kind === "update-failed")!.detail, /grok \(no result for aarch64-linux\)/);
});

test("narrow: a failure on aarch64 alone fails the set, whatever order the files are read in", () => {
  result(tmp, "candidate", "aarch64-linux", false);
  result(tmp, "candidate", "x86_64-linux", true);
  assert.equal(narrow.passed(narrow.load(tmp), "candidate"), false);
  assert.notEqual(narrow.plan(inputs, narrow.load(tmp)), null);
});

test("narrow: one system failed and the other never reported is still a failure (held)", () => {
  const one = [{ name: "codex", files: [], from: "1", to: "2" }];
  result(tmp, "candidate", "x86_64-linux", false); // failed; aarch64 never reported
  both(tmp, "main", true);
  assert.equal(narrow.decide(one, narrow.load(tmp)).observations[0].kind, "test-failed");
});

test("narrow: decide and verdict on the command line", () => {
  const repo = new Repo({ grok: "1" });
  const dir = repo.candidate({ grok: "2" });
  const results = join(tmp, "results");
  mkdirSync(results);
  const script = join(import.meta.dirname, "..", "scripts", "ci", "narrow.ts");
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: "utf8" }));
  both(results, "main", true);
  both(results, "candidate", true);
  assert.deepEqual(cli("decide", dir, results).final, ["grok"]);
  both(results, "final", true);
  for (const s of SYSTEMS) writeFileSync(join(results, `tree-final-${s}.txt`), "t");
  assert.deepEqual([cli("verdict", dir, results, "final", "grok").ok, cli("verdict", dir, results, "final", "grok").tree], [true, "t"]);
});

test("guard notes: read from the guard checks' outputs, other checks' files skipped", () => {
  const a = join(tmp, "a"), b = join(tmp, "b"), file = join(tmp, "plain");
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, "checked"), "t3\nt3-nightly\n");
  writeFileSync(join(a, "notes"), "t3\tnew commands: x y\nno tab here\n");
  writeFileSync(join(b, "checked"), "codex\n");
  writeFileSync(join(b, "notes"), "");
  writeFileSync(file, "");
  assert.deepEqual(notesOf([a, b, file, join(tmp, "missing")]), {
    checked: ["codex", "t3", "t3-nightly"],
    notes: [{ package: "t3", detail: "new commands: x y" }],
  });
  // Strict (branch CI on a change to lib/guard.nix): a check with a note
  // fails; otherwise none does.
  const out = (n: string) => ({ guards: a, codex: b, other: file })[n]!;
  assert.deepEqual(failedOnNotes(true, ["guards", "codex", "other"], out), ["guards"]);
  assert.deepEqual(failedOnNotes(false, ["guards", "codex", "other"], out), []);
  const ci = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /git diff --quiet HEAD~1 HEAD -- lib\/guard\.nix \|\| strict=\(--strict-guards\)\n.*test\.ts branch .* "\$\{strict\[@\]\}"/);
});

test("narrow: a published set's guard notes become guard-review, never a hold", () => {
  for (const system of SYSTEMS) {
    writeFileSync(join(tmp, `final-${system}.json`), JSON.stringify({ set: "final", system, passed: true, failed: [],
      checked: ["codex", "t3"], notes: [{ package: "codex", detail: `new option (${system === "x86_64-linux" ? "a" : "b"})` }] }));
    writeFileSync(join(tmp, `tree-final-${system}.txt`), "t\n");
  }
  const v = narrow.verdict(inputs, tmp, "final", ["grok", "codex"]);
  assert.equal(v.ok, true);
  assert.ok(!v.observations.some((o) => o.kind.startsWith("guard-")), "only once published");
  const guard = v.guard;
  const t3Pin = JSON.parse(readFileSync(join(import.meta.dirname, "..", "versions", "t3.json"), "utf8")).version;
  assert.deepEqual(guard.map((o) => [o.kind, o.package, o.version, o.detail]), [
    ["guard-review", "codex", "3", "new option (a)\nnew option (b)"],
    ["guard-reviewed", "t3", t3Pin, ""],
  ], "a package that isn't among the changes carries main's pin");
  assert.ok(!issues.HOLD_KINDS.has("guard-review"));
  // A result without the fields (an older test.ts) notes nothing.
  both(tmp, "final", true);
  assert.deepEqual(narrow.verdict(inputs, tmp, "final", ["grok"]).guard, []);
  // The workflow passes them on only after a publish (or a dry run's).
  const wf = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "update.yml"), "utf8");
  const step = wf.slice(wf.indexOf("- name: Guard notes, once published"));
  assert.ok(wf.indexOf("- name: Guard notes, once published") > wf.indexOf("node scripts/ci/publish.ts"), "after publish");
  assert.match(step, /^- name: Guard notes, once published\n\s+if: steps\.publish\.outcome == 'success' && \(steps\.publish\.outputs\.published != '' \|\| inputs\.dry_run\)\n\s+run: \|\n\s+jq '\{observations: \.guard\}' "\$RUNNER_TEMP\/obs\/observations-verdict\.json" > "\$RUNNER_TEMP\/obs\/observations-guard\.json"/);
});

test("narrow: guard notes only for our packages, and the same note keeps its version", () => {
  const s: narrow.SetResult = { passed: true, failed: new Set(), systems: new Set(SYSTEMS), checked: new Set(), notes: new Map(), perSystem: new Map() };
  for (const system of SYSTEMS) {
    writeFileSync(join(tmp, `final-${system}.json`), JSON.stringify({ set: "final", system, passed: true, failed: [],
      checked: ["codex", "a/b", "@someone"], notes: [{ package: "a/b", detail: "x" }, { package: "codex", detail: 7 }, { package: "codex", detail: "y" }] }));
  }
  const loaded = narrow.load(tmp).get("final")!;
  assert.deepEqual([[...loaded.checked], [...loaded.notes.keys()]], [["codex"], ["codex"]]);
  assert.deepEqual([...loaded.notes.get("codex")!], ["y"]);
  // codex unchanged in one run, bumped in the next: the issue's version is
  // the published tree's either way.
  s.checked.add("codex"); s.notes.set("codex", new Set(["y"]));
  const pin = () => "3";
  assert.deepEqual(narrow.guardReview(s, [], pin).map((o) => o.version), ["3"]);
  assert.deepEqual(narrow.guardReview(s, [{ name: "codex", files: [], from: "2", to: "3" }], pin).map((o) => o.version), ["3"]);
});

test("issues: guard-review opens per package and closes on guard-reviewed", async () => {
  const gh = new Fake();
  await issues.apply([obs("guard-review", "codex", "3", "new option"), obs("guard-review", "t3", null, "new command")], gh, now);
  assert.deepEqual(gh.issueList.map((i) => [i.title, i.state]), [["guard-review: codex", "open"], ["guard-review: t3", "open"]]);
  assert.deepEqual(issues.heldVersions(gh.issueList), [], "holds nothing");
  await issues.apply([obs("guard-review", "codex", "3", "new option")], gh, hours(0.5)); // the same again: no comment
  assert.equal(gh.issueList[0].comments!.length, 0);
  await issues.apply([obs("guard-reviewed", "codex", "4", "")], gh, hours(1));
  assert.deepEqual(gh.issueList.map((i) => i.state), ["closed", "open"]);
});

/** A downgrade as the updater reports it: upstream moved `pkg` back. */
const down = (pkg: string, from: string, to: string, detail = `upstream moved ${pkg} back from ${from} to ${to}.`) =>
  ({ ...obs("downgrade", pkg, to, detail), from, to });

test("issues: a downgrade opens one, titled with the pulled version, holding nothing", async () => {
  const gh = new Fake();
  await issues.apply([down("codex", "0.9.0", "0.8.0")], gh, now);
  assert.deepEqual(gh.issueList.map((i) => [i.title, i.state]), [["downgrade: codex (0.9.0 pulled)", "open"]]);
  const meta = issues.metaOf(gh.issueList[0])!;
  assert.deepEqual([meta.key, meta.version, meta.from, meta.to], ["downgrade/codex/-", "0.9.0", "0.9.0", "0.8.0"]);
  assert.match(gh.issueList[0].body, /moved it back from ` 0\.9\.0 ` to ` 0\.8\.0 `/);
  assert.match(gh.issueList[0].body, /closes once codex is back at ` 0\.9\.0 ` or higher/);
  assert.deepEqual(issues.heldVersions(gh.issueList), [], "holds nothing");
  // The same move again: nothing but the daily reminder.
  await issues.apply([down("codex", "0.9.0", "0.8.0")], gh, hours(2));
  assert.equal(gh.issueList[0].comments!.length, 0);
  await issues.apply([down("codex", "0.9.0", "0.8.0")], gh, hours(25));
  assert.deepEqual(gh.issueList[0].comments, ["Still happening."]);
});

test("issues: a further downgrade keeps the higher pulled version; a higher one retitles", async () => {
  const gh = new Fake();
  await issues.apply([down("t3code", "0.2.0", "0.1.9")], gh, now);
  // 0.1.9 pulled too: still tracks 0.2.0, one comment, same title.
  await issues.apply([down("t3code", "0.1.9", "0.1.8")], gh, hours(1));
  let meta = issues.metaOf(gh.issueList[0])!;
  assert.deepEqual([meta.version, meta.from, meta.to], ["0.2.0", "0.1.9", "0.1.8"]);
  assert.equal(gh.issueList[0].comments!.length, 1);
  assert.equal(gh.issueList[0].title, "downgrade: t3code (0.2.0 pulled)");
  assert.match(gh.issueList[0].body, /from ` 0\.1\.9 ` to ` 0\.1\.8 `/, "the body follows the move");
  await issues.apply([down("t3code", "0.1.9", "0.1.8")], gh, hours(2)); // reported again: nothing
  assert.equal(gh.issueList[0].comments!.length, 1);
  // Main got to 0.2.1 and that was pulled before the issue closed: it tracks
  // 0.2.1 now, and the title follows.
  await issues.apply([down("t3code", "0.2.1", "0.1.8")], gh, hours(3));
  meta = issues.metaOf(gh.issueList[0])!;
  assert.equal(meta.version, "0.2.1");
  assert.equal(gh.issueList[0].title, "downgrade: t3code (0.2.1 pulled)");
  // A pulled version that can't be ordered against the tracked one keeps it.
  const odd = new Fake();
  await issues.apply([down("muse", "1.4.15-R2", "1.4.15-R1")], odd, now);
  await issues.apply([down("muse", "1.4.15-R3", "1.4.14-R9")], odd, hours(1));
  assert.equal(issues.metaOf(odd.issueList[0])!.version, "1.4.15-R2");
});

test("issues: the same pulled version moving to a new destination is a change", async () => {
  // 2.0.0 pulled, upstream back to 1.9.0; 1.9.0 fails its tests, so main stays
  // on 2.0.0; then 1.9.0 is pulled too: the move is now 2.0.0 to 1.8.0.
  const gh = new Fake();
  await issues.apply([down("codex", "2.0.0", "1.9.0")], gh, now);
  await issues.apply([down("codex", "2.0.0", "1.8.0")], gh, hours(1));
  const meta = issues.metaOf(gh.issueList[0])!;
  assert.deepEqual([meta.version, meta.from, meta.to], ["2.0.0", "2.0.0", "1.8.0"]);
  assert.match(gh.issueList[0].body, /from ` 2\.0\.0 ` to ` 1\.8\.0 `/);
  assert.equal(gh.issueList[0].comments!.length, 1);
});

test("issues: a downgrade closes on a pass at or above the pulled version, not below, nor on held", async () => {
  const gh = new Fake();
  await issues.apply([down("codex", "0.9.0", "0.8.0")], gh, now);
  await issues.apply([obs("pass", "codex", "0.8.0")], gh, hours(1)); // main on the lower one: not back
  await issues.apply([obs("held", "codex", "0.9.0")], gh, hours(2)); // upstream back, main not yet
  assert.equal(gh.issueList[0].state, "open");
  await issues.apply([obs("pass", "codex", "0.9.0")], gh, hours(3));
  assert.equal(gh.issueList[0].state, "closed");
  assert.match(gh.issueList[0].comments!.at(-1)!, /^Closing: back at 0\.9\.0\./);
  // Above it closes too.
  const up = new Fake();
  await issues.apply([down("fx", "2.0.0", "1.9.0")], up, now);
  await issues.apply([obs("pass", "fx", "2.1.0")], up, hours(1));
  assert.equal(up.issueList[0].state, "closed");
  // A nightly of the pulled one's base: can't be ordered against 0.2.0-nightly.5,
  // but above the destination, so it's back.
  const night = new Fake();
  await issues.apply([down("t3code-nightly", "0.2.0-nightly.5", "0.1.10-nightly.9")], night, now);
  await issues.apply([obs("pass", "t3code-nightly", "0.1.10-nightly.9")], night, hours(1));
  assert.equal(night.issueList[0].state, "open");
  await issues.apply([obs("pass", "t3code-nightly", "0.2.0-nightly.6")], night, hours(2));
  assert.equal(night.issueList[0].state, "closed");
  // A pulled latest-channel release on the nightly pin: a same-version nightly is below it.
  const promoted = new Fake();
  await issues.apply([down("t3code-nightly", "0.2.0", "0.1.10-nightly.9")], promoted, now);
  await issues.apply([obs("pass", "t3code-nightly", "0.2.0-nightly.6")], promoted, hours(1));
  assert.equal(promoted.issueList[0].state, "open", "waits for 0.2.0 or a higher base");
  await issues.apply([obs("pass", "t3code-nightly", "0.2.1-nightly.1")], promoted, hours(2));
  assert.equal(promoted.issueList[0].state, "closed");
});

test("issues: one pull on the latest channel opens an issue per T3 Code pin, each titled with the pull", async () => {
  const gh = new Fake();
  await issues.apply(["t3code", "t3", "t3code-nightly", "t3-nightly"].map((p) => down(p, "0.2.0", "0.1.9")), gh, now);
  assert.deepEqual(gh.issueList.map((i) => i.title), ["t3code", "t3", "t3code-nightly", "t3-nightly"].map((p) => `downgrade: ${p} (0.2.0 pulled)`));
  // The latest channel back; the nightly pins at a same-version nightly stay open.
  await issues.apply([obs("pass", "t3code", "0.2.0"), obs("pass", "t3", "0.2.0"), obs("pass", "t3code-nightly", "0.2.0-nightly.1"),
    obs("pass", "t3-nightly", "0.2.0-nightly.1")], gh, hours(1));
  assert.deepEqual(await states(gh), ["closed", "closed", "open", "open"]);
});

test("issues: a downgrade reopens on a new move, starting over; a hand-closed one with the move standing reopens", async () => {
  const gh = new Fake();
  await issues.apply([down("grok", "2.0.0", "1.9.0")], gh, now);
  await issues.apply([obs("pass", "grok", "2.1.0")], gh, hours(1));
  assert.equal(gh.issueList[0].state, "closed");
  // Pulled again later, from a lower version: it starts over with that move.
  await issues.apply([down("grok", "1.9.5", "1.9.0")], gh, hours(2));
  assert.equal(gh.issueList[0].state, "open");
  assert.match(gh.issueList[0].comments!.at(-1)!, /^It's back/);
  assert.equal(issues.metaOf(gh.issueList[0])!.version, "1.9.5");
  assert.equal(gh.issueList[0].title, "downgrade: grok (1.9.5 pulled)");
  // Closed by hand while the move still stands: the next report reopens it.
  gh.issueList[0].state = "closed";
  await issues.apply([down("grok", "1.9.5", "1.9.0")], gh, hours(3));
  assert.equal(gh.issueList[0].state, "open");
});

test("issues: a downgrade from an earlier reading changes nothing; its package gone closes it", async () => {
  const t = (m: number) => new Date(now.getTime() + m * 60_000).toISOString();
  const gh = new Fake();
  await issues.apply([down("pi", "3.0.0", "2.0.0")], gh, now, "", null, t(10));
  await issues.apply([down("pi", "4.0.0", "2.0.0")], gh, hours(1), "", null, t(5));
  assert.equal(issues.metaOf(gh.issueList[0])!.version, "3.0.0");
  await issues.apply([obs("pass", "pi", "3.0.0")], gh, hours(2), "", null, t(8));
  assert.equal(gh.issueList[0].state, "open", "an earlier reading's pass doesn't close it");
  await issues.apply([], gh, hours(3), "", new Set(["codex"]), t(20));
  assert.equal(gh.issueList[0].state, "closed");
});

test("issues: a downgrade's move fields are checked like the rest of the metadata", async () => {
  const body = (extra: object) => `<!-- t3code-nix: ${JSON.stringify({ key: "downgrade/fx/-", version: "2", ...extra })} -->`;
  assert.equal(issues.metaOf({ number: 1, title: "t", body: body({ from: 5 }), state: "open" }), null);
  assert.equal(issues.metaOf({ number: 1, title: "t", body: body({ to: ["x"] }), state: "open" }), null);
  const none = issues.metaOf({ number: 1, title: "t", body: body({}), state: "open" })!;
  assert.deepEqual([none.from, none.to], [undefined, undefined], "an issue without them has no last move");
  // Other kinds' metadata doesn't grow the fields.
  const gh = new Fake();
  await issues.apply([obs("test-failed", "grok", "2", "d")], gh, now);
  assert.doesNotMatch(gh.issueList[0].body, /"from"|"to"/);
});

test("narrow: a final round whose aarch64 job died isn't a combination failure", () => {
  const two = [{ name: "grok", files: [], from: "1", to: "2" }, { name: "codex", files: [], from: "1", to: "2" }];
  result(tmp, "final", "x86_64-linux", true);
  writeFileSync(join(tmp, "tree-final-x86_64-linux.txt"), "t");
  const v = narrow.verdict(two, tmp, "final", ["grok"]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.observations.map((o) => o.kind), ["update-failed"]);
  assert.match(v.observations[0].detail, /no result for aarch64-linux/);
  // A real failure in the final round is still a combination failure.
  both(tmp, "final", false);
  assert.deepEqual(narrow.verdict(two, tmp, "final", ["grok", "codex"]).observations.map((o) => o.kind), ["combination-failed", "combination-failed"]);
});

test("held: the resolve job's file lists the open holds", async () => {
  const gh = new Fake();
  await issues.apply([obs("test-failed", "grok", "2", "d")], gh, now);
  const out = join(tmp, "held.json");
  const retest = join(tmp, "retest.json");
  assert.deepEqual(await writeHeld(out, gh, retest), { held: [{ package: "grok", version: "2" }], waits: [] });
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), [{ package: "grok", version: "2" }]);
  assert.deepEqual(JSON.parse(readFileSync(retest, "utf8")), []);
});

test("narrow: a lone update whose aarch64 job died is retried, not held", () => {
  const one = [{ name: "codex", files: [], from: "1", to: "2" }];
  result(tmp, "candidate", "x86_64-linux", true);
  assert.deepEqual(narrow.plan(one, narrow.load(tmp)), ["main"]);
  both(tmp, "main", true);
  const { final, observations } = narrow.decide(one, narrow.load(tmp));
  assert.deepEqual(final, []);
  assert.deepEqual(observations.map((o) => o.kind).sort(), ["env-ok", "update-failed"]);
  assert.deepEqual(issues.heldVersions([]), []);
  // A real failure is still held.
  both(tmp, "candidate", false);
  assert.equal(narrow.decide(one, narrow.load(tmp)).observations[0].kind, "test-failed");
  // And env-broken needs main to have really failed, not just gone missing.
  rmSync(join(tmp, "main-x86_64-linux.json"));
  rmSync(join(tmp, "main-aarch64-linux.json"));
  result(tmp, "main", "x86_64-linux", true);
  assert.ok(!narrow.decide(one, narrow.load(tmp)).observations.some((o) => o.kind === "env-broken"));
});

test("narrow: one input failing while the rest publish", () => {
  both(tmp, "main", true); both(tmp, "grok", false); both(tmp, "codex", true);
  const { final, observations } = narrow.decide(inputs, narrow.load(tmp));
  assert.deepEqual(final, ["codex"]);
  assert.ok(observations.some((o) => o.kind === "test-failed" && o.package === "grok" && o.version === "2"));
  assert.ok(observations.some((o) => o.kind === "env-ok"));
});

test("narrow: main broken but the fix still gets through", () => {
  both(tmp, "main", false); both(tmp, "grok", false); both(tmp, "codex", true);
  const { final, observations } = narrow.decide(inputs, narrow.load(tmp));
  assert.deepEqual(final, ["codex"]);
  assert.ok(!observations.some((o) => o.kind === "env-broken"));
});

test("narrow: env-broken never while a change has no result", () => {
  both(tmp, "main", false); both(tmp, "grok", false);
  result(tmp, "codex", "x86_64-linux", true); // aarch64 never reported: no result yet
  const { observations } = narrow.decide(inputs, narrow.load(tmp));
  assert.ok(!observations.some((o) => o.kind === "env-broken"));
  assert.ok(observations.some((o) => o.kind === "update-failed"));
});

test("narrow: a set that passed with a tree file missing or different publishes nothing and holds nothing", () => {
  for (const set of ["candidate", "final"]) {
    both(tmp, set, true);
    rmSync(join(tmp, `tree-${set}-aarch64-linux.txt`));
    let v = narrow.verdict(inputs, tmp, set, ["grok", "codex"]);
    assert.equal(v.ok, false, `${set}: one tree file`);
    assert.deepEqual(v.observations.map((o) => o.kind), ["update-failed"], set);
    writeFileSync(join(tmp, `tree-${set}-aarch64-linux.txt`), "other\n");
    v = narrow.verdict(inputs, tmp, set, ["grok", "codex"]);
    assert.deepEqual([v.ok, v.observations.map((o) => o.kind)], [false, ["update-failed"]], `${set}: different trees`);
    assert.match(v.observations[0].detail, /tree files differ or one is missing/);
  }
  // A final set whose tests failed is still a combination failure.
  both(tmp, "final", false);
  assert.deepEqual(narrow.verdict(inputs, tmp, "final", ["grok", "codex"]).observations.map((o) => o.kind), ["combination-failed", "combination-failed"]);
});

test("update.ts reports the nixpkgs revision main locks (on-main)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "update.ts"), "utf8");
  assert.match(src, /const onMain = nixpkgsRev\(lock\.head\);\n\s+if \(onMain\) report\.observe\(obs\("on-main", "nixpkgs", onMain\)\);/);
});

test("workflow: resolve has Nix for update.ts's bump, which runs after the first pass (no bump step of its own)", () => {
  const wf = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "update.yml"), "utf8");
  const resolve = wf.slice(wf.indexOf("\n  resolve:\n") + 1).split(/\n  [a-z-]+:\n/)[0];
  const nix = resolve.indexOf("uses: cachix/install-nix-action@"), step = resolve.indexOf("- name: Resolve upstream versions");
  assert.ok(nix >= 0 && nix < step, "Nix is installed before the resolve step");
  assert.doesNotMatch(resolve, /^\s*(- )?(run: )?nix flake update/m, "the bump is update.ts's, after its first pass");
  assert.match(resolve.slice(step), /NIX_CONFIG: access-tokens = github\.com=\$\{\{ github\.token \}\}/);
  assert.match(resolve.slice(step), /node scripts\/update\.ts --write/);
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "update.ts"), "utf8");
  const first = src.indexOf("await resolveAll(report, wanted, held, false, waits);"), bump = src.indexOf("await maybeBump(report, held, new Date(), undefined, startedAt);"),
    retry = src.indexOf("const retry = retryNames(report, nixpkgsBump(lock.head, lock.work, held));");
  assert.ok(first >= 0 && first < bump && bump < retry, "bump decided after the first pass, before the retry check");
  assert.match(src, /if \(args\.write && !args\.only\) \{/);
  assert.ok(src.indexOf("const startedAt = Date.now();") < first, "the bump's deadline counts from update.ts's start");
  assert.match(resolve, /\n    timeout-minutes: 57\n/);
});

test("workflow: resolve records the Electron each tree runs, after make and before the upload, never failing the run", () => {
  const wf = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "update.yml"), "utf8");
  const resolve = wf.slice(wf.indexOf("\n  resolve:\n") + 1).split(/\n  [a-z-]+:\n/)[0];
  const make = resolve.indexOf("candidate.ts make"), step = resolve.indexOf("- name: The Electron each tree runs"), upload = resolve.indexOf("id: candidate-artifact");
  assert.ok(make >= 0 && make < step && step < upload, "after the candidate is made, before it's uploaded");
  const body = resolve.slice(step, upload);
  assert.match(body, /if: steps\.candidate\.outputs\.desktop != ''\n/);
  assert.match(body, /continue-on-error: true\n/);
  assert.match(body, /timeout-minutes: 12\n/);
  assert.match(body, /NIX_CONFIG: access-tokens = github\.com=\$\{\{ github\.token \}\}/);
  assert.match(body, /run: node scripts\/ci\/electron-runtime\.ts table "\$RUNNER_TEMP\/candidate" >> "\$GITHUB_STEP_SUMMARY"\n/);
  // The script's own budget fits the step's limit.
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "ci", "electron-runtime.ts"), "utf8");
  assert.match(src, /budgetMs = 10 \* 60e3/);
});

test("dependabot: one entry and one group cover the workflows and every composite action", () => {
  const root = join(import.meta.dirname, "..");
  const cfg = readFileSync(join(root, ".github", "dependabot.yml"), "utf8").replace(/^\s*#.*$/gm, "");
  // Entries are the `updates:` list items, whatever key comes first.
  assert.equal(cfg.match(/^  - /gm)?.length, 1, "one update entry");
  assert.equal(cfg.match(/package-ecosystem:/g)?.length, 1, "one ecosystem");
  assert.match(cfg, /- package-ecosystem: github-actions\n/);
  const block = cfg.match(/\n    directories:\n((?:      - .*\n)+)/);
  assert.ok(block, "a directories list");
  const listed = block[1].trim().split("\n").map((l) => l.replace(/^\s*- /, "").trim()).sort();
  // Every directory holding action.yml or action.yaml, as the unit check finds them.
  const actions: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name === "action.yml" || e.name === "action.yaml") actions.push("/" + dir);
    }
  };
  walk(join(".github", "actions"));
  assert.ok(actions.length > 0, "composite actions found");
  assert.deepEqual(listed, ["/", ...actions].sort());
  assert.match(cfg, /\n    cooldown:\n      default-days: 7\n/);
  // The whole groups block, to its end: one group matching everything, with no
  // exclusions (an excluded action would get PRs of its own).
  const groups = cfg.match(/\n    groups:\n((?: {6,}.*\n|\s*\n)*)/);
  assert.equal(groups?.[1].replace(/^\s*\n/gm, ""), '      actions:\n        patterns: ["*"]\n', "one group, matching *");
});

test("workflow: a hanging test fails its step, below the job's limit (a cancelled job isn't narrowed)", () => {
  const wf = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "update.yml"), "utf8");
  // A hung build fails at the daemon's timeout. Up to two waves of hung
  // builds (max-jobs = auto: four, the runners' CPU count) in each of
  // test.ts's two passes stay inside every test step's limit, with 20 minutes
  // left for evaluation and the rest.
  const setup = readFileSync(join(import.meta.dirname, "..", ".github", "actions", "setup", "action.yml"), "utf8");
  const timeout = Number(/extra_nix_config: \|\n\s+timeout = (\d+)\n/.exec(setup)?.[1]);
  assert.ok(timeout > 0, "a nix timeout");
  for (const [job, step] of [["test", "Test the candidate"], ["narrow", "Test ${{ matrix.set }} alone"], ["final", "Test the final candidate"]]) {
    const body = wf.slice(wf.indexOf(`\n  ${job}:\n`) + 1).split(/\n  [a-z-]+:\n/)[0];
    const jobLimit = Number(/\n    timeout-minutes: (\d+)/.exec(body)?.[1]);
    const stepLimit = Number(new RegExp(`- name: ${step.replace(/[$.{}]/g, "\\$&")}\n(?:\\s+#.*\n)*\\s+timeout-minutes: (\\d+)`).exec(body)?.[1]);
    // Every step limit in the job (the test step and the NixOS-stable step),
    // with 20 minutes left for setup, the store cache and the uploads.
    const steps = [...body.matchAll(/\n {8}timeout-minutes: (\d+)/g)].map((m) => Number(m[1]));
    const sum = steps.reduce((a, b) => a + b, 0);
    assert.ok(steps.length >= 2, `${job}: the test and NixOS-stable steps have limits`);
    assert.ok(stepLimit > 0 && jobLimit - sum >= 20, `${job}: steps ${steps.join("+")}, job ${jobLimit}`);
    assert.ok(4 * timeout <= (stepLimit - 20) * 60, `${job}: nix timeout ${timeout} s against a ${stepLimit}-minute step`);
  }
  assert.match(wf, /narrow-plan:\n.*\n    if: always\(\) && needs\.resolve\.outputs\.inputs != '' && needs\.test\.result != 'cancelled'/);
});

test("issues: several update-failed in one run: one issue, details joined in a fixed order", async () => {
  const a = obs("update-failed", null, null, "a job failed or was cancelled");
  const b = obs("update-failed", null, null, "no complete test result for grok (no result for aarch64-linux); not held, the next run retries");
  const one = new Fake(), two = new Fake();
  await issues.apply([a, b], one, now);
  await issues.apply([b, a], two, now);
  assert.equal(one.issueList.length, 1);
  assert.equal(one.issueList[0].body, two.issueList[0].body);
  assert.match(one.issueList[0].body, /no complete test result for grok/);
  assert.match(one.issueList[0].body, /a job failed or was cancelled/);
  await issues.apply([b, a], one, hours(1)); // the same again: no "Changed" comment
  assert.equal(one.issueList[0].comments!.length, 0);
  // Many long distinct details for one key: capped, whatever the order.
  const long = [0, 1, 2, 3, 4].map((i) => obs("update-failed", null, "x86_64-linux", `${i}`.repeat(issues.DETAIL_MAX)));
  const four = new Fake(), five = new Fake();
  await issues.apply(long, four, now);
  await issues.apply([...long].reverse(), five, now);
  assert.equal(issues.metaOf(four.issueList[0])!.detail.length, 3 * issues.DETAIL_MAX);
  assert.equal(four.issueList[0].body, five.issueList[0].body);
  // A lone detail, lines and all, is kept as it is.
  const html = 'GET https://x/y: Unexpected token \'<\', "\n<html>\n<head>\n<html>"... is not valid JSON';
  const three = new Fake();
  await issues.apply([obs("resolve-failed", "grok", null, html)], three, now);
  assert.ok(three.issueList[0].body.includes(html));
});

test("narrow: everything broken is env-broken", () => {
  for (const s of ["main", "grok", "codex"]) both(tmp, s, false);
  const { final, observations } = narrow.decide(inputs, narrow.load(tmp));
  assert.deepEqual([final, observations.map((o) => o.kind)], [[], ["env-broken"]]);
});

test("narrow: a single input isn't tested alone again", () => {
  both(tmp, "candidate", false);
  assert.deepEqual(narrow.plan([inputs[0]], narrow.load(tmp)), ["main"]);
  both(tmp, "main", true);
  const { final, observations } = narrow.decide([inputs[0]], narrow.load(tmp));
  assert.deepEqual(final, []);
  assert.ok(observations.some((o) => o.kind === "test-failed" && o.package === "grok"));
});

test("verdict: a passing set gives test-passed per input", () => {
  both(tmp, "candidate", true);
  const v = narrow.verdict(inputs, tmp, "candidate", ["grok", "codex"]);
  assert.deepEqual([v.ok, v.tree], [true, "t1"]);
  assert.deepEqual(v.observations.filter((o) => o.package).map((o) => [o.kind, o.package]).sort(), [["test-passed", "codex"], ["test-passed", "grok"]]);
});

test("verdict: a failed final holds each input", () => {
  both(tmp, "final", false);
  const v = narrow.verdict(inputs, tmp, "final", ["grok", "codex"]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.observations.map((o) => [o.kind, o.package, o.version]).sort(), [["combination-failed", "codex", "3"], ["combination-failed", "grok", "2"]]);
});

test("verdict: systems that tested different trees are refused", () => {
  result(tmp, "candidate", "x86_64-linux", true, "t1");
  result(tmp, "candidate", "aarch64-linux", true, "t2");
  assert.equal(narrow.verdict(inputs, tmp, "candidate", ["grok", "codex"]).ok, false);
});

// ---- publish --------------------------------------------------------------

test("publish: exactly the tested tree, with status and tag", async () => {
  const repo = new Repo({ t3code: "0.1.9", grok: "1" });
  const dir = repo.candidate({ t3code: "0.2.0", grok: "2" });
  const tree = candidate.tree(dir, "t3code,grok");
  // The candidate's base, not the checkout's HEAD: a later commit doesn't move it.
  const head = repo.head();
  writeFileSync(join(repo.work, "README"), "later");
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "later");
  assert.equal(candidate.tree(dir, "t3code,grok"), tree);
  git(repo.work, "reset", "-q", "--hard", head);
  const gh = new Fake();
  const o = await publish(dir, ["t3code", "grok"], tree, gh, env());
  const main = repo.originMain();
  assert.equal(git(repo.work, "rev-parse", `${main}^{tree}`), tree);
  assert.deepEqual(gh.statuses, [[main, "tested", "success"]]);
  assert.deepEqual(gh.statusUrls, ["https://run"], "the status links the run");
  assert.ok(git(repo.work, "ls-remote", "origin", "refs/tags/t3code-v0.2.0"));
  assert.equal(git(repo.work, "ls-remote", "origin", "refs/heads/bot/candidate/42"), "");
  assert.deepEqual(o.map((x) => x.kind), ["published", "stable-behind"]); // the fixture has no snapshot
  // The status page rebuilds from the new main.
  assert.deepEqual(gh.dispatches, [["pages.yml", "main", {}]]);
});

test("publish: a failed pages.yml dispatch is only a warning", async () => {
  const repo = new Repo({ t3code: "0.1.9" });
  const dir = repo.candidate({ t3code: "0.2.0" });
  const gh = new Fake();
  gh.dispatch = async () => { throw new Error("HTTP 404 workflow not found"); };
  const o = await publish(dir, ["t3code"], candidate.tree(dir, "t3code"), gh, env());
  assert.deepEqual(o.map((x) => x.kind), ["published", "stable-behind"]); // the fixture has no snapshot
});

test("publish: the run's candidate ref is removed even when posting the status fails", async () => {
  const repo = new Repo({ grok: "1" });
  const dir = repo.candidate({ grok: "2" });
  const gh = new Fake();
  gh.createStatus = async () => { throw new Error("HTTP 502"); };
  await assert.rejects(publish(dir, ["grok"], candidate.tree(dir, "grok"), gh, env()), /HTTP 502/);
  assert.equal(git(repo.work, "ls-remote", "origin", "refs/heads/bot/candidate/42"), "");
});

test("publish: untracked files in the checkout don't change the tree", async () => {
  const repo = new Repo({ grok: "1" });
  const dir = repo.candidate({ grok: "2" });
  const tested = candidate.tree(dir, "grok");
  writeFileSync(join(repo.work, "publish.json"), "{}"); // like a shell redirection
  mkdirSync(join(repo.work, "candidate"));
  writeFileSync(join(repo.work, "candidate", "inputs.json"), "{}");
  const o = await publish(dir, ["grok"], tested, new Fake(), env());
  assert.deepEqual(o.map((x) => x.kind), ["published", "stable-behind"]); // the fixture has no snapshot
  assert.equal(git(repo.work, "rev-parse", `${repo.originMain()}^{tree}`), tested);
});

test("publish: only the final inputs are published", async () => {
  const repo = new Repo({ grok: "1", codex: "1" });
  const dir = repo.candidate({ grok: "2", codex: "2" });
  await publish(dir, ["codex"], candidate.tree(dir, "codex"), new Fake(), env());
  const main = repo.originMain();
  assert.equal(JSON.parse(git(repo.work, "show", `${main}:versions/grok.json`)).version, "1");
  assert.equal(JSON.parse(git(repo.work, "show", `${main}:versions/codex.json`)).version, "2");
});

test("publish: an existing t3code-v tag is never moved", async () => {
  const repo = new Repo({ t3code: "0.2.0" });
  git(repo.work, "tag", "t3code-v0.1.9");
  git(repo.work, "push", "-q", "origin", "t3code-v0.1.9");
  const before = git(repo.work, "ls-remote", "origin", "refs/tags/t3code-v0.1.9");
  const dir = repo.candidate({ t3code: "0.1.9" }); // a vendor downgrade
  await publish(dir, ["t3code"], candidate.tree(dir, "t3code"), new Fake(), env());
  assert.equal(git(repo.work, "ls-remote", "origin", "refs/tags/t3code-v0.1.9"), before);
});

test("publish: a same-version t3code change never makes the t3code-v tag", async () => {
  // Details only (the version stays): that version's tag belongs on the
  // commit that first published it, which reconcile tags.
  const repo = new Repo({ t3code: "0.1.9" });
  writeFileSync(join(repo.work, "versions", "t3code.json"), pinText("t3code", "0.1.9", { tag: "v0.1.9" }));
  const dir = join(tmp, "candidate");
  candidate.make(dir);
  git(repo.work, "checkout", "-q", "--", ".");
  assert.deepEqual(candidate.load(dir).inputs.map((i) => [i.name, i.from, i.to]), [["t3code", "0.1.9", "0.1.9"]]);
  const o = await publish(dir, ["t3code"], candidate.tree(dir, "t3code"), new Fake(), env());
  assert.equal(o[0].kind, "published");
  assert.equal(git(repo.work, "ls-remote", "origin", "refs/tags/t3code-v0.1.9"), "");
  assert.equal(latestChannelTag([{ name: "t3code", files: [], from: "0.1.9", to: "0.1.9" }], ["t3code"]), null);
  assert.equal(latestChannelTag([{ name: "t3code", files: [], from: "0.1.9", to: "0.2.0" }], ["t3code"]), "t3code-v0.2.0");
  assert.equal(latestChannelTag([{ name: "t3code", files: [], from: null, to: "0.2.0" }], ["t3code"]), "t3code-v0.2.0");
});

test("publish: a real run on a branch is refused (a dry run isn't)", async () => {
  const repo = new Repo({ grok: "1" });
  const main0 = repo.originMain();
  const dir = repo.candidate({ grok: "2" });
  await assert.rejects(publish(dir, ["grok"], candidate.tree(dir, "grok"), new Fake(), env({ GITHUB_REF: "refs/heads/wip" })), /only from main/);
  assert.equal(repo.originMain(), main0);
  const dry = new Fake();
  await publish(dir, ["grok"], candidate.tree(dir, "grok"), dry, env({ GITHUB_REF: "refs/heads/wip", DRY_RUN: "true" }));
  await publish(dir, ["grok"], candidate.tree(dir, "grok"), new Fake(), env({ GITHUB_REF: "refs/heads/main" }));
  assert.notEqual(repo.originMain(), main0);
});

test("publish: a re-run after a killed attempt replaces its own leftover candidate ref", async () => {
  const repo = new Repo({ grok: "1" });
  const dir = repo.candidate({ grok: "2" });
  const tree = candidate.tree(dir, "grok");
  // The killed attempt pushed its candidate ref (another commit time) and died.
  const leftover = git(repo.work, "commit-tree", tree, "-p", repo.head(), "-m", "leftover");
  git(repo.work, "push", "-q", "origin", `${leftover}:refs/heads/bot/candidate/42`);
  const o = await publish(dir, ["grok"], tree, new Fake(), env());
  assert.equal(o[0].kind, "published");
  assert.equal(git(repo.work, "rev-parse", `${repo.originMain()}^{tree}`), tree);
  assert.equal(git(repo.work, "ls-remote", "origin", "refs/heads/bot/candidate/42"), "");
});

test("publish: main and the t3code-v tag go in one atomic push", async () => {
  const repo = new Repo({ t3code: "0.1.9" });
  // The remote turns down main (a ruleset, say) but would take the tag.
  const hook = join(repo.origin, "hooks", "update");
  writeFileSync(hook, '#!/bin/sh\n[ "$1" = refs/heads/main ] && { echo "main is protected"; exit 1; }\nexit 0\n');
  chmodSync(hook, 0o755);
  const dir = repo.candidate({ t3code: "0.2.0" });
  await assert.rejects(publish(dir, ["t3code"], candidate.tree(dir, "t3code"), new Fake(), env()), /main didn't move/);
  assert.equal(git(repo.work, "ls-remote", "origin", "refs/tags/t3code-v0.2.0"), "", "no tag without main");
});

test("reconcile: a version's first publication is its first commit, even after a rollback", () => {
  const repo = new Repo({ t3code: "0.1.9" });
  const first = repo.head();
  repo.bump("t3code", "0.2.0"); git(repo.work, "commit", "-qam", "0.2.0");
  const second = repo.head();
  repo.bump("t3code", "0.1.9"); git(repo.work, "commit", "-qam", "back to 0.1.9");
  assert.deepEqual([...firstPublications()], [["0.1.9", first], ["0.2.0", second]]);
});

test("publish: an untested tree is refused", async () => {
  const repo = new Repo({ grok: "1" });
  const before = repo.originMain();
  const dir = repo.candidate({ grok: "2" });
  await assert.rejects(publish(dir, ["grok"], "0".repeat(40), new Fake(), env()), /not the tested tree/);
  assert.equal(repo.originMain(), before);
});

test("publish: main moved, so re-dispatch and never rebase", async () => {
  const repo = new Repo({ grok: "1" });
  const dir = repo.candidate({ grok: "2" });
  const tree = candidate.tree(dir, "grok");
  repo.otherCommitOnOrigin();
  const before = repo.originMain();
  const gh = new Fake();
  const o = await publish(dir, ["grok"], tree, gh, env());
  assert.equal(repo.originMain(), before);
  assert.deepEqual(gh.dispatches, [["update.yml", "main", { attempt: "1" }]]);
  assert.deepEqual(o.map((x) => x.kind), ["redispatched"]);
});

test("publish: gives up after three attempts", async () => {
  const repo = new Repo({ grok: "1" });
  const dir = repo.candidate({ grok: "2" });
  const tree = candidate.tree(dir, "grok");
  repo.otherCommitOnOrigin();
  const gh = new Fake();
  const o = await publish(dir, ["grok"], tree, gh, env({ ATTEMPT: "2" }));
  assert.deepEqual([gh.dispatches, o.map((x) => x.kind)], [[], ["update-failed"]]);
});

test("publish: rejected although main didn't move is a failure", async () => {
  const repo = new Repo({ grok: "1" });
  const hook = join(repo.origin, "hooks", "pre-receive");
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && exit 1; done\nexit 0\n');
  chmodSync(hook, 0o755);
  const dir = repo.candidate({ grok: "2" });
  await assert.rejects(publish(dir, ["grok"], candidate.tree(dir, "grok"), new Fake(), env()), /didn't move/);
});

test("publish: a dry run writes nothing", async () => {
  const repo = new Repo({ t3code: "0.1.9" });
  const before = repo.originMain();
  const dir = repo.candidate({ t3code: "0.2.0" });
  const gh = new DryRun();
  await publish(dir, ["t3code"], candidate.tree(dir, "t3code"), gh, env({ DRY_RUN: "true" }));
  assert.equal(repo.originMain(), before);
  assert.equal(git(repo.work, "ls-remote", "origin", "refs/tags/*"), "");
  assert.deepEqual(gh.actions.map((a) => a.action), ["create_ref", "create_status", "create_ref", "create_ref", "delete_ref", "dispatch"]);
  assert.equal(gh.actions.find((a) => a.action === "create_status")?.target_url, "https://run", "the recorded status links the run");
});

// ---- reconcile, gate ------------------------------------------------------

test("reconcile: missing tag restored at its first publication; a mismatch left alone", async () => {
  const repo = new Repo({ t3code: "0.1.8" });
  const first018 = repo.head();
  repo.bump("t3code", "0.1.9");
  git(repo.work, "commit", "-q", "-am", "0.1.9");
  writeFileSync(join(repo.work, "README"), "x");
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "unrelated");
  const gh = new Fake();
  gh.refMap = { "refs/tags/t3code-v0.1.9": repo.head(), "refs/heads/bot/candidate/41": "x", "refs/heads/bot/candidate/42": "y" };
  gh.completed.add("41");
  const o = await reconcile(gh, join(repo.work, ".github", "workflows"));
  assert.equal(gh.refMap["refs/tags/t3code-v0.1.8"], first018);
  assert.equal(gh.refMap["refs/tags/t3code-v0.1.9"], repo.head()); // not moved
  const mismatch = o.find((x) => x.kind === "tag-mismatch" && x.version === "0.1.9");
  assert.equal(mismatch?.channel, "latest");
  assert.equal(mismatch && issues.keyOf(mismatch), "tag-mismatch/t3code/latest", "the issue's key names the latest channel");
  assert.deepEqual(o.filter((x) => x.kind === "tag-created").map((x) => [x.version, x.channel]), [["0.1.8", "latest"]]);
  // A finished run's leftover ref goes; a running one's may be publishing.
  assert.ok(!("refs/heads/bot/candidate/41" in gh.refMap) && "refs/heads/bot/candidate/42" in gh.refMap);
});

test("reconcile: a workflow disabled by hand stays disabled", async () => {
  const repo = new Repo({ t3code: "0.1.9" });
  const wf = join(repo.work, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "health.yml"), "name: health\n");
  const gh = new Fake();
  gh.workflows["health.yml"] = "disabled_manually";
  const o = await reconcile(gh, wf);
  assert.equal(gh.workflows["health.yml"], "disabled_manually");
  assert.ok(!o.some((x) => x.kind === "backstop-enabled"));
});

test("reconcile: a disabled backstop is enabled", async () => {
  const repo = new Repo({ t3code: "0.1.9" });
  const wf = join(repo.work, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "health.yml"), "name: health\n");
  const gh = new Fake();
  gh.workflows["health.yml"] = "disabled_inactivity";
  const o = await reconcile(gh, wf);
  assert.equal(gh.workflows["health.yml"], "active");
  assert.ok(o.some((x) => x.kind === "backstop-enabled"));
});

/** A Fake whose reads wait for the others in their group, and whose writes
 * take a moment and must never overlap. */
class Timed extends Fake {
  groups: { names: Set<string>; seen: Set<string>; release: () => void; done: Promise<void> }[];
  alone: string[] = [];
  writes: string[] = [];
  inFlight = 0;
  overlapped = false;
  constructor(...groups: string[][]) {
    super();
    this.groups = groups.map((names) => {
      let release!: () => void;
      const done = new Promise<void>((r) => (release = r));
      return { names: new Set(names), seen: new Set<string>(), release, done };
    });
  }
  private async read<T>(name: string, value: () => Promise<T>): Promise<T> {
    const g = this.groups.find((x) => x.names.has(name));
    if (g) {
      g.seen.add(name);
      if (g.seen.size === g.names.size) g.release();
      const late = await Promise.race([g.done.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 300))]);
      if (late) this.alone.push(name);
    }
    return value();
  }
  private async write<T>(name: string, act: () => Promise<T>): Promise<T> {
    if (++this.inFlight > 1) this.overlapped = true;
    await new Promise((r) => setTimeout(r, 5));
    const result = await act();
    this.writes.push(name);
    this.inFlight--;
    return result;
  }
  override refs(prefix: string) { return this.read(`refs ${prefix}`, () => super.refs(prefix)); }
  override workflowState(w: string) { return this.read(`state ${w}`, () => super.workflowState(w)); }
  override runCompleted(id: string) { return this.read(`run ${id}`, () => super.runCompleted(id)); }
  override createRef(ref: string, sha: string) { return this.write(`create ${ref}`, () => super.createRef(ref, sha)); }
  override deleteRef(ref: string) { return this.write(`delete ${ref}`, () => super.deleteRef(ref)); }
  override enableWorkflow(w: string) { return this.write(`enable ${w}`, () => super.enableWorkflow(w)); }
  override releases() { return this.read("releases", () => super.releases()); }
  override latestRelease() { return this.read("latest", () => super.latestRelease()); }
  override createRelease(r: { tag: string; target: string; name: string; body: string }) {
    return this.write(`release ${r.tag}`, () => super.createRelease(r));
  }
  override markLatest(r: Release) { return this.write(`latest ${r.tag}`, () => super.markLatest(r)); }
}

test("reconcile: the reads run together, the writes one at a time and in order", async () => {
  const repo = new Repo({ t3code: "0.1.8" });
  repo.bump("t3code", "0.1.9");
  git(repo.work, "commit", "-q", "-am", "0.1.9");
  const wf = join(repo.work, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "health.yml"), "name: health\n");
  // The five reads first; each leftover run's check once the refs are known.
  const gh = new Timed(["refs tags/t3code-v", "refs heads/bot/candidate/", "state health.yml", "releases", "latest"], ["run 41", "run 43"]);
  gh.refMap = { "refs/heads/bot/candidate/41": "x", "refs/heads/bot/candidate/42x": "y", "refs/heads/bot/candidate/43": "z" };
  gh.completed.add("41");
  gh.completed.add("43");
  gh.workflows["health.yml"] = "disabled_inactivity";
  await reconcile(gh, wf);
  assert.deepEqual(gh.alone, []);
  assert.equal(gh.overlapped, false);
  assert.deepEqual(gh.writes, [
    "create refs/tags/t3code-v0.1.8", "create refs/tags/t3code-v0.1.9",
    "delete refs/heads/bot/candidate/41", "delete refs/heads/bot/candidate/43", "enable health.yml",
    "release t3code-v0.1.8", "release t3code-v0.1.9", "latest t3code-v0.1.9",
  ]);
});

test("reconcile: a failed read stops it where it always did, after the same writes", async () => {
  const repo = new Repo({ t3code: "0.1.9" });
  const gh = new Fake();
  gh.refMap = { "refs/heads/bot/candidate/41": "x" };
  gh.completed.add("41");
  const real = gh.refs.bind(gh);
  gh.refs = async (prefix: string) => {
    if (prefix.startsWith("heads/")) throw new Error("rate limited");
    return real(prefix);
  };
  await assert.rejects(reconcile(gh, join(repo.work, ".github", "workflows")), /rate limited/);
  // The tag was created before the candidate refs were needed.
  assert.ok("refs/tags/t3code-v0.1.9" in gh.refMap);
  assert.ok("refs/heads/bot/candidate/41" in gh.refMap);
});

test("reconcile: a failed run check stops it after the deletes before it", async () => {
  const repo = new Repo({ t3code: "0.1.9" });
  const gh = new Fake();
  gh.refMap = { "refs/tags/t3code-v0.1.9": repo.head(), "refs/heads/bot/candidate/41": "x", "refs/heads/bot/candidate/43": "y" };
  gh.completed.add("41");
  gh.completed.add("43");
  const real = gh.runCompleted.bind(gh);
  gh.runCompleted = async (id: string) => {
    if (id === "43") throw new Error("HTTP 502");
    return real(id);
  };
  await assert.rejects(reconcile(gh, join(repo.work, ".github", "workflows")), /HTTP 502/);
  assert.ok(!("refs/heads/bot/candidate/41" in gh.refMap), "41's check came first and succeeded");
  assert.ok("refs/heads/bot/candidate/43" in gh.refMap);
});

// ---- releases (reconcile) ---------------------------------------------------

/** A main with latest-channel versions published in order, each commit also holding
 * a codex pin (bumped on the third) and a nightly. */
function releaseRepo(versions: string[]) {
  const repo = new Repo({ t3code: versions[0], codex: "1.0", "t3code-nightly": "n1", boat: "1.0.100" });
  const commits = [repo.head()];
  for (const [i, v] of versions.slice(1).entries()) {
    repo.bump("t3code", v);
    if (i === 1) repo.bump("codex", "1.1");
    repo.bump("t3code-nightly", `n${i + 2}`);
    git(repo.work, "commit", "-q", "-am", v);
    commits.push(repo.head());
  }
  return { repo, commits };
}

test("releases: each verified tag gets one, in history order, with its packages and what changed", async () => {
  const { repo, commits } = releaseRepo(["0.1.7", "0.1.8", "0.1.9"]);
  const gh = new Fake();
  // 0.1.8's tag points elsewhere (a mismatch): no release for it.
  gh.refMap = { "refs/tags/t3code-v0.1.8": "f".repeat(40) };
  await reconcile(gh, join(repo.work, ".github", "workflows"));
  assert.deepEqual(gh.releaseList.map((r) => [r.tag, r.target, r.name]), [
    ["t3code-v0.1.7", commits[0], "T3 Code 0.1.7"],
    ["t3code-v0.1.9", commits[2], "T3 Code 0.1.9"],
  ]);
  const first = gh.releaseList[0].body, last = gh.releaseList[1].body;
  assert.match(first, /\| t3code \| 0\.1\.7 \|/);
  assert.match(first, /## Release notes\n\n- T3 Code 0\.1\.7: \[release notes\]\(https:\/\/github\.com\/pingdotgg\/t3code\/releases\/tag\/v0\.1\.7\)\n$/);
  assert.match(last, /github:swsammy\/t3code-nix\/t3code-v0\.1\.9/);
  // The previous release is the highest verified one below: 0.1.7, not the
  // mismatched 0.1.8. codex changed since; the nightly isn't listed.
  assert.match(last, /## Changed since t3code-v0\.1\.7/);
  assert.match(last, /- codex 1\.0 → 1\.1\n/);
  assert.match(last, /\| t3code-nightly \| n3 \|/, "every package is listed");
  assert.doesNotMatch(last.slice(last.indexOf("## Changed")), /nightly/, "but nightlies aren't changes");
  // Agent tools come after T3 Code and the providers, under their own label.
  assert.match(last, /\| codex \| 1\.1 \|[\s\S]*\| \*Agent tools\* \| \|\n\| boat \| 1\.0\.100 \|/);
  assert.equal(gh.latest, "t3code-v0.1.9");
});

test("releases: a provider's upstream notes are linked, and a package new since the previous is marked", async () => {
  const repo = new Repo({ t3code: "0.1.8" });
  repo.bump("t3code", "0.1.9");
  writeFileSync(join(repo.work, "versions", "pi.json"), JSON.stringify({
    name: "pi", version: "2.0", tag: "v2.0",
    assets: { "x86_64-linux": { url: "https://github.com/o/pi/releases/download/v2.0/pi.tgz", hash: "h" } },
  }) + "\n");
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "0.1.9");
  repo.bump("t3code", "0.2.0");
  writeFileSync(join(repo.work, "versions", "pi.json"), JSON.stringify({
    name: "pi", version: "2.1", tag: "v2.1",
    assets: { "x86_64-linux": { url: "https://github.com/o/pi/releases/download/v2.1/pi.tgz", hash: "h" } },
  }) + "\n");
  git(repo.work, "commit", "-q", "-am", "0.2.0");
  const gh = new Fake();
  await reconcile(gh, join(repo.work, ".github", "workflows"));
  const body = (t: string) => gh.releaseList.find((r) => r.tag === t)!.body;
  assert.match(body("t3code-v0.1.9"), /\n- pi 2\.0 \(new\): \[release notes\]\(https:\/\/github\.com\/o\/pi\/releases\/tag\/v2\.0\)\n/);
  assert.match(body("t3code-v0.2.0"), /\n- pi 2\.0 → 2\.1: \[release notes\]\(https:\/\/github\.com\/o\/pi\/releases\/tag\/v2\.1\)\n/);
});

test("releases: an annotated tag (as publish makes them) counts; one off main gets none", async () => {
  const { repo, commits } = releaseRepo(["0.1.8", "0.1.9"]);
  git(repo.work, "tag", "-a", "t3code-v0.1.8", "-m", "T3 Code 0.1.8", commits[0]);
  const gh = new Fake();
  gh.refMap = {
    "refs/tags/t3code-v0.1.8": git(repo.work, "rev-parse", "refs/tags/t3code-v0.1.8"), // the tag object
    "refs/tags/t3code-v9.9.9": "e".repeat(40), // no such version on main
  };
  await reconcile(gh, join(repo.work, ".github", "workflows"));
  assert.deepEqual(gh.releaseList.map((r) => [r.tag, r.target]), [["t3code-v0.1.8", commits[0]], ["t3code-v0.1.9", commits[1]]]);
});

test("releases: a rollback to a version never published before isn't anyone's previous", async () => {
  // History 0.1.8, 0.2.0, then back to 0.1.9: 0.2.0's previous is 0.1.8,
  // made now or later, and 0.1.9's is 0.1.8 too.
  const { repo } = releaseRepo(["0.1.8", "0.2.0", "0.1.9"]);
  const gh = new Fake();
  await reconcile(gh, join(repo.work, ".github", "workflows"));
  const body = (t: string) => gh.releaseList.find((r) => r.tag === t)!.body;
  assert.match(body("t3code-v0.2.0"), /## Changed since t3code-v0\.1\.8/);
  assert.match(body("t3code-v0.1.9"), /## Changed since t3code-v0\.1\.8/);
  assert.equal(gh.latest, "t3code-v0.1.9", "latest is what main pins, not the highest");
});

test("releases: existing ones are left alone", async () => {
  const { repo } = releaseRepo(["0.1.8", "0.1.9"]);
  const wf = join(repo.work, ".github", "workflows");
  const gh = new Fake();
  await reconcile(gh, wf);
  const before = JSON.stringify(gh.releaseList);
  await reconcile(gh, wf);
  assert.equal(JSON.stringify(gh.releaseList), before, "nothing re-created or edited");
});

test("releases: one made in between is fine", async () => {
  const { repo } = releaseRepo(["0.2.0"]);
  const gh = new Fake();
  gh.sneakIn = "t3code-v0.2.0";
  await reconcile(gh, join(repo.work, ".github", "workflows"));
  assert.deepEqual(gh.releaseList.map((r) => [r.tag, r.body]), [["t3code-v0.2.0", "someone else's"]]);
});

test("releases: any other error is raised, after the rest of reconcile's work", async () => {
  const { repo } = releaseRepo(["0.3.0"]);
  const gh = new Fake();
  gh.createRelease = async () => { throw new Error("POST releases: HTTP 500"); };
  const o: ReturnType<typeof obs>[] = [];
  await assert.rejects(reconcile(gh, join(repo.work, ".github", "workflows"), "HEAD", o), /HTTP 500/);
  assert.ok("refs/tags/t3code-v0.3.0" in gh.refMap, "the tag was still made");
  assert.deepEqual(o.map((x) => [x.kind, x.channel]), [["tag-created", "latest"], ["tag-ok", null]], "and its observations kept");
});

test("releases: latest follows main's pin, from none (a 404), back and forward, and leaves a hand-made one", async () => {
  const { repo } = releaseRepo(["0.1.8", "0.1.9"]);
  const wf = join(repo.work, ".github", "workflows");
  const gh = new Fake();
  await reconcile(gh, wf);
  assert.equal(gh.latest, "t3code-v0.1.9");
  // Someone marked 0.1.8; reconcile moves it to main's pin again.
  gh.latest = "t3code-v0.1.8";
  await reconcile(gh, wf);
  assert.equal(gh.latest, "t3code-v0.1.9");
  // Upstream pulled 0.2.0 and main went back to 0.1.9: latest moves back.
  repo.bump("t3code", "0.2.0");
  git(repo.work, "commit", "-q", "-am", "0.2.0");
  await reconcile(gh, wf);
  assert.equal(gh.latest, "t3code-v0.2.0");
  repo.bump("t3code", "0.1.9");
  git(repo.work, "commit", "-q", "-am", "back to 0.1.9");
  await reconcile(gh, wf);
  assert.equal(gh.latest, "t3code-v0.1.9", "back with main");
  assert.ok(gh.releaseList.some((r) => r.tag === "t3code-v0.2.0"), "the pulled version's release stays");
  // Already the target: nothing written.
  let marks = 0;
  const mark = gh.markLatest.bind(gh);
  gh.markLatest = async (r) => { marks++; return mark(r); };
  await reconcile(gh, wf);
  assert.equal(marks, 0);
  // A hand-made latest (not a t3code-v* tag) is left, with a warning.
  gh.releaseList.push({ id: 51, tag: "manual", target: "x", name: "n", body: "b" });
  gh.latest = "manual";
  const logged: string[] = [];
  await reconcile(gh, wf, "HEAD", [], (m) => logged.push(m));
  assert.equal(gh.latest, "manual");
  assert.match(logged.join("\n"), /Latest marker \(on manual\) was set by hand/);
});

test("releases: main's pin is read from the history ref, not the working tree", async () => {
  const { repo } = releaseRepo(["0.1.8", "0.1.9"]);
  const wf = join(repo.work, ".github", "workflows");
  const gh = new Fake();
  // The job checks out resolve's older head; main (the ref) is at 0.1.9.
  git(repo.work, "branch", "-q", "main-ref");
  git(repo.work, "checkout", "-q", "HEAD~1");
  await reconcile(gh, wf, "main-ref");
  assert.equal(gh.latest, "t3code-v0.1.9");
});

test("releases: no release for the pin falls back to the highest below; unreadable pins and prereleases", async () => {
  const { repo } = releaseRepo(["0.1.7", "0.1.8", "0.1.9"]);
  const wf = join(repo.work, ".github", "workflows");
  // 0.1.9's tag is mismatched: no release of its own, so 0.1.8 is latest.
  const gh = new Fake();
  gh.refMap = { "refs/tags/t3code-v0.1.9": "f".repeat(40) };
  gh.releaseList.push({ id: 60, tag: "t3code-v0.1.9", target: "x", name: "n", body: "on the mismatched tag" });
  await reconcile(gh, wf);
  assert.equal(gh.latest, "t3code-v0.1.8", "a release on a mismatched tag is never chosen");
  // A latest on the mismatched tag's release is moved, too.
  gh.latest = "t3code-v0.1.9";
  await reconcile(gh, wf);
  assert.equal(gh.latest, "t3code-v0.1.8");

  // A prerelease at the pin's tag can't be latest: a warning, and the fallback.
  const pre = new Fake();
  pre.releaseList.push({ id: 61, tag: "t3code-v0.1.9", target: "x", name: "n", body: "b", prerelease: true });
  pre.releaseList.push({ id: 62, tag: "t3code-v0.1.8", target: "x", name: "n", body: "b", prerelease: true });
  const logged: string[] = [];
  await reconcile(pre, wf, "HEAD", [], (m) => logged.push(m));
  assert.equal(pre.latest, "t3code-v0.1.7", "and a prerelease among the candidates is skipped");
  assert.match(logged.join("\n"), /t3code-v0\.1\.9 is a prerelease/);
});

test("releases: no release for the pin and none below leaves latest, with a warning", async () => {
  const { repo } = releaseRepo(["0.1.9"]);
  const gh = new Fake();
  gh.refMap = { "refs/tags/t3code-v0.1.9": "f".repeat(40) };
  const said: string[] = [];
  await reconcile(gh, join(repo.work, ".github", "workflows"), "HEAD", [], (m) => said.push(m));
  assert.equal(gh.latest, null);
  assert.match(said.join("\n"), /no release for 0\.1\.9 or below it/);
});

test("releases: a pin file that can't be read leaves latest, with a warning (missing)", async () => {
  const { repo } = releaseRepo(["0.1.8", "0.1.9"]);
  const wf = join(repo.work, ".github", "workflows");
  const gh = new Fake();
  await reconcile(gh, wf);
  gh.latest = "t3code-v0.1.8";
  git(repo.work, "rm", "-q", "versions/t3code.json");
  git(repo.work, "commit", "-q", "-am", "broken pin");
  const logged: string[] = [];
  await reconcile(gh, wf, "HEAD", [], (m) => logged.push(m));
  assert.equal(gh.latest, "t3code-v0.1.8");
  assert.match(logged.join("\n"), /versions\/t3code\.json can't be read/);
});

test("releases: a pin file that can't be read leaves latest, with a warning (not JSON)", async () => {
  const { repo } = releaseRepo(["0.1.8", "0.1.9"]);
  const wf = join(repo.work, ".github", "workflows");
  const gh = new Fake();
  await reconcile(gh, wf);
  gh.latest = "t3code-v0.1.8";
  writeFileSync(join(repo.work, "versions", "t3code.json"), "not json");
  git(repo.work, "commit", "-q", "-am", "broken pin");
  const logged: string[] = [];
  await reconcile(gh, wf, "HEAD", [], (m) => logged.push(m));
  assert.equal(gh.latest, "t3code-v0.1.8");
  assert.match(logged.join("\n"), /versions\/t3code\.json can't be read/);
});

test("releases: a pin file that can't be read leaves latest, with a warning (no version)", async () => {
  const { repo } = releaseRepo(["0.1.8", "0.1.9"]);
  const wf = join(repo.work, ".github", "workflows");
  const gh = new Fake();
  await reconcile(gh, wf);
  gh.latest = "t3code-v0.1.8";
  writeFileSync(join(repo.work, "versions", "t3code.json"), JSON.stringify({ name: "t3code" }));
  git(repo.work, "commit", "-q", "-am", "broken pin");
  const logged: string[] = [];
  await reconcile(gh, wf, "HEAD", [], (m) => logged.push(m));
  assert.equal(gh.latest, "t3code-v0.1.8");
  assert.match(logged.join("\n"), /versions\/t3code\.json can't be read/);
});

test("releases: a creation failing before the target stops there, sets latest below it, then raises", async () => {
  // 0.1.9 (main's pin) isn't made, so 0.1.7 is latest.
  const { repo } = releaseRepo(["0.1.7", "0.1.8", "0.1.9"]);
  const gh = new Fake();
  const create = gh.createRelease.bind(gh);
  gh.createRelease = async (r) => { if (r.tag === "t3code-v0.1.8") throw new Error("POST releases: HTTP 500"); return create(r); };
  await assert.rejects(reconcile(gh, join(repo.work, ".github", "workflows")), /HTTP 500/);
  assert.deepEqual(gh.releaseList.map((r) => r.tag), ["t3code-v0.1.7"], "creation stopped at the failure");
  assert.equal(gh.latest, "t3code-v0.1.7");
});

test("releases: a creation failing after the target still marks it, then raises", async () => {
  // History 0.1.8, 0.1.9, back to 0.1.8: 0.1.8 (main's pin) is made this run,
  // then creating 0.1.9's fails.
  const { repo } = releaseRepo(["0.1.8", "0.1.9", "0.1.8"]);
  const gh = new Fake();
  const create = gh.createRelease.bind(gh);
  gh.createRelease = async (r) => { if (r.tag === "t3code-v0.1.9") throw new Error("POST releases: HTTP 500"); return create(r); };
  await assert.rejects(reconcile(gh, join(repo.work, ".github", "workflows")), /HTTP 500/);
  assert.deepEqual(gh.releaseList.map((r) => r.tag), ["t3code-v0.1.8"]);
  assert.equal(gh.latest, "t3code-v0.1.8", "made this run, so it's latest");
});

test("releases: a creation and its re-read both failing raise the creation's error and log the re-read's", async () => {
  const { repo } = releaseRepo(["0.1.8"]);
  const gh = new Fake();
  gh.createRelease = async () => { throw new Error("POST releases: HTTP 500"); };
  gh.releaseByTag = async () => { throw new Error("GET releases/tags: HTTP 403"); };
  const logged: string[] = [];
  await assert.rejects(reconcile(gh, join(repo.work, ".github", "workflows"), "HEAD", [], (m) => logged.push(m)), /HTTP 500/);
  assert.match(logged.join("\n"), /couldn't re-read t3code-v0\.1\.8's release: GET releases\/tags: HTTP 403/);
});

test("releases: a creation and the mark both failing raise the creation's error and log the mark's", async () => {
  const { repo } = releaseRepo(["0.1.7", "0.1.8"]);
  const gh = new Fake();
  gh.releaseList.push({ id: 71, tag: "t3code-v0.1.8", target: "x", name: "n", body: "b" });
  gh.releaseList.push({ id: 72, tag: "t3code-v0.1.5", target: "x", name: "n", body: "an older set" });
  gh.latest = "t3code-v0.1.5"; // so 0.1.8 has to be marked
  gh.createRelease = async () => { throw new Error("POST releases: HTTP 500"); };
  gh.markLatest = async () => { throw new Error("PATCH releases: HTTP 502"); };
  const logged: string[] = [];
  await assert.rejects(reconcile(gh, join(repo.work, ".github", "workflows"), "HEAD", [], (m) => logged.push(m)), /HTTP 500/);
  assert.match(logged.join("\n"), /couldn't move GitHub's Latest marker: PATCH releases: HTTP 502/);
});

test("releases: a failing mark alone fails reconcile (so the run reports it)", async () => {
  const { repo } = releaseRepo(["0.1.7", "0.1.8"]);
  const gh = new Fake();
  gh.releaseList.push({ id: 73, tag: "t3code-v0.1.5", target: "x", name: "n", body: "an older set" });
  gh.latest = "t3code-v0.1.5"; // so 0.1.8 has to be marked
  gh.markLatest = async () => { throw new Error("PATCH releases: HTTP 502"); };
  await assert.rejects(reconcile(gh, join(repo.work, ".github", "workflows"), "HEAD", [], () => {}), /HTTP 502/);
  assert.ok(gh.releaseList.some((r) => r.tag === "t3code-v0.1.8"), "the creations still happened");
});

test("releases: a prerelease found by the re-read after a duplicate create isn't chosen", async () => {
  const { repo } = releaseRepo(["0.1.8", "0.1.9"]);
  const gh = new Fake();
  const create = gh.createRelease.bind(gh);
  gh.createRelease = async (r) => {
    if (r.tag === "t3code-v0.1.9") {
      gh.releaseList.push({ id: 80, ...r, body: "someone's prerelease", prerelease: true });
      throw new Error("POST releases: HTTP 422 already_exists");
    }
    return create(r);
  };
  await reconcile(gh, join(repo.work, ".github", "workflows"));
  assert.equal(gh.latest, "t3code-v0.1.8");
});

test("releases: versions compareVersions can't order", async () => {
  // One it can't read at all doesn't block latest moving to 0.1.9. With a
  // pair it can't order, the previous release is the one before in history.
  const { repo } = releaseRepo(["custom", "0.1.8", "0.1.9"]);
  const gh = new Fake();
  gh.releaseList.push({ id: 40, tag: "t3code-v0.1.8", target: "x", name: "n", body: "b" });
  gh.latest = "t3code-v0.1.8";
  await reconcile(gh, join(repo.work, ".github", "workflows"));
  assert.equal(gh.latest, "t3code-v0.1.9");
  assert.match(gh.releaseList.find((r) => r.tag === "t3code-vcustom")!.body, /## Release notes/);
  assert.match(gh.releaseList.find((r) => r.tag === "t3code-v0.1.9")!.body, /## Changed since t3code-v0\.1\.8/);
});

test("releases: a pin compareVersions can't read still gets its own release", async () => {
  // Main pins "custom", an exact match: no ordering needed.
  const { repo } = releaseRepo(["0.1.9", "custom"]);
  const gh = new Fake();
  await reconcile(gh, join(repo.work, ".github", "workflows"));
  assert.equal(gh.latest, "t3code-vcustom");
});

test("releases: a candidate that can't be ordered against the pin is skipped, not blocking", async () => {
  // No release for 0.2.0-bar; 0.2.0-foo can't be ordered against it; 0.1.9 is below.
  const { repo } = releaseRepo(["0.1.9", "0.2.0-foo", "0.2.0-bar"]);
  const gh = new Fake();
  gh.refMap = { "refs/tags/t3code-v0.2.0-bar": "f".repeat(40) };
  await reconcile(gh, join(repo.work, ".github", "workflows"));
  assert.equal(gh.latest, "t3code-v0.1.9");
});

test("releases: an unreadable candidate below the pin is skipped, not blocking a readable one", async () => {
  // No release for 0.2.0 (its tag is mismatched); "custom" can't be read; 0.1.9 can.
  const { repo } = releaseRepo(["custom", "0.1.9", "0.2.0"]);
  const gh = new Fake();
  gh.refMap = { "refs/tags/t3code-v0.2.0": "f".repeat(40) };
  await reconcile(gh, join(repo.work, ".github", "workflows"));
  assert.equal(gh.latest, "t3code-v0.1.9");
});

test("releases: an unreadable pin without its own release has nothing orderable below it: latest left, with a warning", async () => {
  const { repo } = releaseRepo(["0.1.9", "custom"]);
  const gh = new Fake();
  gh.refMap = { "refs/tags/t3code-vcustom": "f".repeat(40) };
  const logged: string[] = [];
  await reconcile(gh, join(repo.work, ".github", "workflows"), "HEAD", [], (m) => logged.push(m));
  assert.equal(gh.marked, null, "nothing marked");
  assert.match(logged.join("\n"), /no release for custom or below it/);
});

test("releases: two below the pin that can't be ordered against each other leave latest, with a warning", async () => {
  const { repo } = releaseRepo(["0.1.9-a", "0.1.9-b", "0.2.0"]);
  const gh = new Fake();
  gh.refMap = { "refs/tags/t3code-v0.2.0": "f".repeat(40) };
  const logged: string[] = [];
  await reconcile(gh, join(repo.work, ".github", "workflows"), "HEAD", [], (m) => logged.push(m));
  assert.equal(gh.marked, null, "nothing marked");
  assert.match(logged.join("\n"), /can't tell which of 0\.1\.9-a, 0\.1\.9-b below it is highest/);
});

test("releases: with none marked, GitHub's latest is the newest release; a hand-made one there is left", async () => {
  const { repo } = releaseRepo(["0.1.8", "0.1.9"]);
  const wf = join(repo.work, ".github", "workflows");
  const gh = new Fake();
  // The pin's release is already the newest, unmarked: GitHub calls it latest, so nothing is written.
  gh.releaseList.push({ id: 90, tag: "t3code-v0.1.8", target: "x", name: "n", body: "b" }, { id: 91, tag: "t3code-v0.1.9", target: "x", name: "n", body: "b" });
  await reconcile(gh, wf);
  assert.equal(gh.marked, null);
  assert.equal(gh.latest, "t3code-v0.1.9");
  // A release made by hand later, unmarked, is GitHub's latest now: left, with a warning.
  gh.releaseList.push({ id: 92, tag: "notes-2026", target: "x", name: "n", body: "b" });
  const logged: string[] = [];
  await reconcile(gh, wf, "HEAD", [], (m) => logged.push(m));
  assert.equal(gh.latest, "notes-2026");
  assert.match(logged.join("\n"), /Latest marker \(on notes-2026\) was set by hand/);
});

test("releases: the CLI writes its observations and fails when a release write fails", () => {
  const { repo } = releaseRepo(["0.1.9"]);
  /** Run reconcile.ts as the workflow does, with GitHub's API faked by a
   * fetch loaded first (`fail` makes creating a release answer 500). */
  const cli = (env: Record<string, string>, fail: boolean) => {
    const stub = join(tmp, `fetch-${fail}.mjs`);
    writeFileSync(stub, `
      globalThis.fetch = async (url, init) => {
        const u = new URL(String(url));
        if (${fail} && init?.method === "POST" && u.pathname.endsWith("/releases")) return new Response("boom", { status: 500 });
        if (u.pathname.endsWith("/releases/latest") || u.pathname.includes("/releases/tags/")) return new Response("not found", { status: 404 });
        if (u.pathname.endsWith("/releases")) return init?.method === "POST" ? Response.json({ id: 1, tag_name: "t3code-v0.1.9" }) : Response.json([]);
        if (u.pathname.includes("/matching-refs/tags")) return Response.json(${JSON.stringify([{ ref: "refs/tags/t3code-v0.1.9", object: { sha: repo.head() } }])});
        if (u.pathname.includes("/matching-refs/")) return Response.json([]);
        if (u.pathname.includes("/actions/workflows/")) return Response.json({ state: "active" });
        if (u.pathname.endsWith("/actions/caches")) { (await import("node:fs")).appendFileSync(${JSON.stringify(join(tmp, "purged"))}, "listed\\n"); return Response.json({ actions_caches: [] }); }
        return Response.json({});
      };`);
    try {
      return { status: 0, stdout: execFileSync(process.execPath, ["--import", stub, join(cwd, "scripts", "ci", "reconcile.ts")],
        { cwd: repo.work, env: { ...process.env, GH_TOKEN: "t", GITHUB_REF: "", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e: any) {
      return { status: e.status, stdout: e.stdout };
    }
  };
  const dry = cli({ DRY_RUN: "true" }, false);
  assert.equal(dry.status, 0);
  assert.deepEqual(JSON.parse(dry.stdout).observations.map((o: any) => o.kind), ["tag-ok"]);
  assert.deepEqual(JSON.parse(dry.stdout).dryRun.map((a: any) => a.action), ["create_release", "mark_latest"]);
  const failed = cli({ DRY_RUN: "false", GITHUB_REF: "refs/heads/main" }, true);
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stdout).observations.map((o: any) => o.kind), ["tag-ok"], "observations still written");
  assert.match(readFileSync(join(tmp, "purged"), "utf8"), /listed/, "and the cache purge still ran");
});

test("reconcile: a disabled pages.yml is enabled too", async () => {
  const repo = new Repo({ t3code: "0.1.9" });
  const wf = join(repo.work, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "pages.yml"), "name: pages\n");
  const gh = new Fake();
  gh.workflows["pages.yml"] = "disabled_inactivity";
  const o = await reconcile(gh, wf);
  assert.equal(gh.workflows["pages.yml"], "active");
  assert.ok(o.some((x) => x.kind === "pages-enabled"));
});

test("purgeTestCaches: per system, all but the most recently used cache under this ref go", async () => {
  const gh = new Fake();
  const c = (id: number, key: string, lastAccessed: string, ref = "refs/heads/main") => ({ id, key, ref, lastAccessed });
  gh.cacheList = [
    c(1, "nix-test-x86_64-linux-aaa", "2026-11-10T00:00:00Z"),
    c(2, "nix-test-x86_64-linux-bbb", "2026-11-12T00:00:00Z"),
    c(3, "nix-test-x86_64-linux-ccc", "2026-11-11T00:00:00Z"),
    c(4, "nix-test-aarch64-linux-aaa", "2026-11-09T00:00:00Z"),
    c(5, "nix-test-x86_64-linux-ddd", "2026-11-01T00:00:00Z", "refs/heads/other"),
    c(6, "something-else", "2026-11-01T00:00:00Z"),
  ];
  await purgeTestCaches(gh, "refs/heads/main");
  assert.deepEqual(gh.cacheList.map((x) => x.id), [2, 4, 5, 6]);

  // A dry run records the deletes instead.
  const dry = new DryRun(gh);
  gh.cacheList.push(c(7, "nix-test-aarch64-linux-new", "2026-11-13T00:00:00Z"));
  await purgeTestCaches(dry, "refs/heads/main");
  assert.deepEqual(dry.actions, [{ action: "delete_cache", id: 4, key: "nix-test-aarch64-linux-aaa" }]);
  assert.equal(gh.cacheList.length, 5);

  // Housekeeping: a failure is logged, not raised.
  const logged: string[] = [];
  gh.caches = async () => { throw new Error("HTTP 403"); };
  await purgeTestCaches(gh, "refs/heads/main", (m) => logged.push(m));
  assert.match(logged[0], /^::warning::couldn't purge old test caches: HTTP 403/);
});

test("gate: only .github/ and scripts/ changes make a definition stale", () => {
  const repo = new Repo({ grok: "1" });
  const defined = repo.head();
  writeFileSync(join(repo.work, "README"), "docs");
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "docs");
  assert.equal(current(defined, repo.head()), true);
  mkdirSync(join(repo.work, "scripts"));
  writeFileSync(join(repo.work, "scripts", "x.ts"), "changed");
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "scripts");
  assert.equal(current(defined, repo.head()), false);
  // What the workflow reads: current=false after re-dispatching (recorded
  // in a dry run), current=true otherwise.
  const script = join(import.meta.dirname, "..", "scripts", "ci", "gate.ts");
  const out = (sha: string) => execFileSync(process.execPath, [script, sha, repo.head()],
    { cwd: repo.work, encoding: "utf8", env: { ...process.env, DRY_RUN: "true", RUNNER_TEMP: tmp, GITHUB_REF_NAME: "main" } }).trim();
  assert.equal(out(defined), "current=false");
  assert.match(readFileSync(join(tmp, "dry-run-gate.json"), "utf8"), /"update\.yml"/);
  assert.equal(out(repo.head()), "current=true");
  // The re-dispatch is on the run's own ref, as the same kind of run.
  const branch = execFileSync(process.execPath, [script, defined, repo.head()],
    { cwd: repo.work, encoding: "utf8", env: { ...process.env, DRY_RUN: "true", RUNNER_TEMP: tmp, GITHUB_REF_NAME: "review-branch", ATTEMPT: "2" } }).trim();
  assert.equal(branch, "current=false");
  const recorded = JSON.stringify(JSON.parse(readFileSync(join(tmp, "dry-run-gate.json"), "utf8")));
  assert.match(recorded, /"review-branch"/);
  assert.match(recorded, /"dry_run":"true"/);
  assert.match(recorded, /"attempt":"2"/);
  // A workflow-only change is stale too.
  const wf = repo.head();
  mkdirSync(join(repo.work, ".github"), { recursive: true });
  writeFileSync(join(repo.work, ".github", "x.yml"), "changed");
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "workflow");
  assert.equal(current(wf, repo.head()), false);
});

test("narrow: the command line the workflow reads", () => {
  const repo = new Repo({ grok: "1" });
  const dir = repo.candidate({ grok: "2" });
  const results = join(tmp, "results");
  mkdirSync(results);
  const script = join(import.meta.dirname, "..", "scripts", "ci", "narrow.ts");
  const plan = () => execFileSync(process.execPath, [script, "plan", dir, results], { encoding: "utf8" }).trim();
  both(results, "candidate", true);
  assert.equal(plan(), "failed=false");
  both(results, "candidate", false);
  assert.equal(plan(), 'failed=true\nsets=["main"]\nstable-sets=["main"]');
});

// ---- issues ---------------------------------------------------------------

const now = new Date(Date.UTC(2026, 10, 13, 12));
const hours = (h: number) => new Date(now.getTime() + h * 3600_000);
const states = async (gh: Fake) => gh.issueList.map((i) => i.state); // in creation order

test("issues: upstream text can't break the metadata, ping anyone or run long", async () => {
  const gh = new Fake();
  const nasty = "GraphQL: {\"a\":1} --> <b>hi</b> ```x``` @someone " + "y".repeat(5000);
  const o = obs("resolve-failed", "grok", null, nasty);
  for (let i = 0; i < 3; i++) await issues.apply([o], gh, hours(i * 30), "https://run");
  // One issue, found again each run (a reminder and a reopen), never a new one.
  assert.equal(gh.issueList.length, 1);
  const issue = gh.issueList[0];
  const meta = issues.metaOf(issue)!;
  assert.equal(meta.detail, nasty.slice(0, issues.DETAIL_MAX));
  const hidden = /<!-- t3code-nix: (.*?) -->/s.exec(issue.body)![1];
  assert.ok(!hidden.includes("-->") && !hidden.includes("<"), "the metadata can't end early");
  // Shown in a code block longer than any backtick run inside it.
  assert.match(issue.body, /\n````\nGraphQL: .*@someone y+\n````\n/);
  await issues.apply([obs("pass", "grok", "4")], gh, hours(100));
  await issues.apply([o], gh, hours(101), "https://run"); // back: the comment quotes it too
  const back = gh.issueList[0].comments!.at(-1)!;
  assert.match(back, /^It's back\.\n\n````\n[\s\S]*\n````\n\nhttps:\/\/run$/);
});

test("issues: a detail with $& survives a metadata update", async () => {
  const gh = new Fake();
  const stalled = obs("watcher-stalled", null, null, "/health: upstream said $& and $` and $'");
  await issues.apply([stalled], gh, now);
  await issues.apply([obs("watcher-healthy", null, null, "")], gh, hours(1)); // rewrites the metadata (clean count)
  const meta = issues.metaOf(gh.issueList[0]);
  assert.equal(meta?.detail, stalled.detail);
  await issues.apply([stalled], gh, hours(2));
  assert.equal(gh.issueList.length, 1);
});

test("issues: an empty observations file (a crashed script's) is skipped, the rest read", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-"));
  try {
    writeFileSync(join(dir, "a.json"), "");
    writeFileSync(join(dir, "b.json"), JSON.stringify({ observations: [obs("pass", "grok", "1")] }));
    writeFileSync(join(dir, "c.json"), JSON.stringify([obs("pass", "fx", "2")]));
    const warned: string[] = [];
    const got = issues.readObservations(["a.json", "b.json", "c.json"].map((f) => join(dir, f)), (m) => warned.push(m));
    assert.deepEqual(got.map((o) => o.package), ["grok", "fx"]);
    assert.match(warned[0], /a\.json is empty; skipped/);
    writeFileSync(join(dir, "d.json"), "{not json");
    assert.throws(() => issues.readObservations([join(dir, "d.json")]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issues: lifecycle", async () => {
  const gh = new Fake();
  const fail = obs("test-failed", "grok", "2", "d");
  await issues.apply([fail], gh, now);
  assert.deepEqual(await states(gh), ["open"]);
  await issues.apply([fail], gh, hours(2)); // same within a day: nothing
  assert.equal(gh.issueList[0].comments!.length, 0);
  await issues.apply([fail], gh, hours(25)); // a day later: one reminder
  assert.equal(gh.issueList[0].comments!.length, 1);
  await issues.apply([obs("test-failed", "grok", "3", "d")], gh, hours(26)); // changed: comment, not a new issue
  assert.deepEqual([gh.issueList.length, gh.issueList[0].comments!.length], [1, 2]);
  await issues.apply([obs("resolve-failed", "grok")], gh, hours(27)); // an error isn't recovery
  assert.equal(gh.issueList[0].state, "open");
  await issues.apply([obs("pass", "grok", "4")], gh, hours(28)); // pass for a newer version: superseded
  assert.equal(gh.issueList[0].state, "closed");
  assert.match(gh.issueList[0].comments!.at(-1)!, /superseded/);
  await issues.apply([obs("test-failed", "grok", "5", "d")], gh, hours(29)); // recurrence reopens
  assert.deepEqual(gh.issueList.filter((i) => i.title.startsWith("test-failed")).map((i) => i.state), ["open"]);
});

test("issues: an earlier reading of upstream never moves, closes or reopens a problem", async () => {
  // A re-run of an old run's failed jobs keeps its reading, so its issues job
  // can come after a newer run's; run IDs follow dispatch order, and upstream
  // can roll back: only when each run read upstream orders their news.
  const t = (m: number) => new Date(now.getTime() + m * 60_000).toISOString();
  const held = (gh: Fake) => issues.heldVersions(gh.issueList);
  // An earlier reading's failure doesn't move the hold, whatever the version.
  let gh = new Fake();
  await issues.apply([obs("test-failed", "codex", "3.0", "fails")], gh, now, "", null, t(10));
  await issues.apply([obs("test-failed", "codex", "2.0", "fails")], gh, hours(1), "", null, t(5));
  assert.deepEqual(held(gh), [{ package: "codex", version: "3.0" }]);
  // An earlier reading's pass never closes a later failure (a run that
  // waited in the queue read upstream first, though dispatched later).
  gh = new Fake();
  await issues.apply([obs("test-failed", "codex", "2.0", "fails")], gh, now, "", null, t(10));
  await issues.apply([obs("pass", "codex", "1.0")], gh, hours(1), "", null, t(5));
  assert.equal(gh.issueList[0].state, "open");
  // Upstream rolls back from 3.0 to 2.0: the later reading wins, the old
  // failure closes, and a failure of 2.0 then holds 2.0.
  gh = new Fake();
  await issues.apply([obs("test-failed", "grok", "3.0.0", "fails")], gh, now, "", null, t(10));
  await issues.apply([obs("pass", "grok", "2.0.0")], gh, hours(1), "", null, t(20));
  assert.equal(gh.issueList[0].state, "closed");
  await issues.apply([obs("test-failed", "grok", "2.0.0", "fails")], gh, hours(2), "", null, t(30));
  assert.deepEqual(held(gh), [{ package: "grok", version: "2.0.0" }]);
  // A late failure from an earlier reading doesn't reopen what a later one
  // closed, even about a newer version.
  gh = new Fake();
  await issues.apply([obs("test-failed", "fx", "1.0.0", "fails")], gh, now, "", null, t(10));
  await issues.apply([obs("pass", "fx", "2.0.0")], gh, hours(1), "", null, t(20));
  assert.equal(gh.issueList[0].state, "closed");
  assert.equal(issues.metaOf(gh.issueList[0])!.seen, t(20), "the close is recorded");
  await issues.apply([obs("test-failed", "fx", "2.0.0", "fails")], gh, hours(2), "", null, t(15));
  assert.equal(gh.issueList[0].state, "closed");
  await issues.apply([obs("test-failed", "fx", "2.0.0", "fails")], gh, hours(3), "", null, t(25));
  assert.equal(gh.issueList[0].state, "open", "a later reading does");
  // The same version: an earlier reading changes nothing; a later one is
  // recorded even with nothing else new.
  gh = new Fake();
  await issues.apply([obs("test-failed", "pi", "3", "d")], gh, now, "", null, t(10));
  await issues.apply([obs("test-passed", "pi", "3")], gh, hours(1), "", null, t(5));
  assert.equal(gh.issueList[0].state, "open");
  await issues.apply([obs("test-failed", "pi", "3", "e")], gh, hours(2), "", null, t(8));
  assert.deepEqual([issues.metaOf(gh.issueList[0])!.seen, issues.metaOf(gh.issueList[0])!.detail], [t(10), "d"]);
  await issues.apply([obs("test-failed", "pi", "3", "d")], gh, hours(3), "", null, t(40));
  assert.equal(issues.metaOf(gh.issueList[0])!.seen, t(40));
  await issues.apply([obs("test-passed", "pi", "3")], gh, hours(4), "", null, t(30));
  assert.equal(gh.issueList[0].state, "open", "30 is earlier than 40");
  await issues.apply([obs("test-passed", "pi", "3")], gh, hours(5), "", null, t(50));
  assert.equal(gh.issueList[0].state, "closed");
  // Without a reading time (an issue from before, or local use): as before.
  const old = new Fake();
  await issues.apply([obs("test-failed", "kiro-cli", "2", "d")], old, now);
  assert.equal(issues.metaOf(old.issueList[0])!.seen, null);
  await issues.apply([obs("test-passed", "kiro-cli", "2")], old, hours(1), "", null, t(1));
  assert.equal(old.issueList[0].state, "closed");
  // An unreadable reading time turns ordering off for that run, nothing worse.
  const odd = new Fake();
  await issues.apply([obs("test-failed", "kiro-cli", "2", "d")], odd, now, "", null, "not a time");
  assert.equal(issues.metaOf(odd.issueList[0])!.seen, null);
  // A reading time that isn't a date makes the metadata malformed.
  for (const seen of [5, "yesterday", ""]) {
    const body = `<!-- t3code-nix: ${JSON.stringify({ key: "test-failed/fx/-", version: "2", seen })} -->`;
    assert.equal(issues.metaOf({ number: 1, title: "t", body, state: "open" }), null, String(seen));
  }
});

test("issues: repeated failing runs comment once a day, not each run", async () => {
  const gh = new Fake();
  const failed = { kind: "update-failed", package: null, channel: null, version: null, detail: "a job failed or was cancelled" };
  for (let run = 1; run <= 5; run++) {
    const at = new Date(now.getTime() + run * 60_000);
    await issues.apply([failed], gh, at, `https://github.com/o/r/actions/runs/${run}`, null, at.toISOString());
  }
  assert.equal(gh.issueList.length, 1);
  assert.equal(gh.issueList[0].comments!.length, 0);
  assert.match(gh.issueList[0].body, /First seen in https:\/\/github\.com\/o\/r\/actions\/runs\/1$/);
  // A day later the same report gets one reminder, and records its reading.
  const later = hours(25);
  await issues.apply([failed], gh, later, "https://github.com/o/r/actions/runs/9", null, later.toISOString());
  assert.equal(gh.issueList[0].comments!.length, 1);
  assert.equal(issues.metaOf(gh.issueList[0])!.seen, later.toISOString());
});

test("issues: a package dropped in an earlier checkout doesn't close a later reading's hold", async () => {
  // A run read upstream before a provider was added (its issues job re-run
  // later); a later run then held that provider's failing version.
  const t = (m: number) => new Date(now.getTime() + m * 60_000).toISOString();
  const gh = new Fake();
  await issues.apply([obs("test-failed", "newp", "2.0", "fails")], gh, now, "", new Set(["newp"]), t(6));
  await issues.apply([], gh, hours(1), "", new Set(["codex"]), t(0));
  assert.equal(gh.issueList[0].state, "open");
  assert.deepEqual(issues.heldVersions(gh.issueList), [{ package: "newp", version: "2.0" }]);
  // A later reading without the package does close it.
  await issues.apply([], gh, hours(2), "", new Set(["codex"]), t(10));
  assert.equal(gh.issueList[0].state, "closed");
  assert.match(gh.issueList[0].comments!.at(-1)!, /no longer packaged/);
});

test("issues: a run's own failure counts whenever it arrives", async () => {
  // A run that read upstream earlier fails after a later-reading run's
  // success closed update-failed: its failure is still reported.
  const t = (m: number) => new Date(now.getTime() + m * 60_000).toISOString();
  const failed = { kind: "update-failed", package: null, channel: null, version: null, detail: "a job failed or was cancelled" };
  const ok = { kind: "run-ok", package: null, channel: null, version: null, detail: "" };
  const gh = new Fake();
  await issues.apply([failed], gh, now, "", null, t(0));
  await issues.apply([ok], gh, hours(1), "", null, t(20));
  assert.equal(gh.issueList[0].state, "closed");
  await issues.apply([failed], gh, hours(2), "", null, t(10));
  assert.equal(gh.issueList[0].state, "open");
  // The same reading time (a re-run of the issues job) counts.
  await issues.apply([ok], gh, hours(3), "", null, t(20));
  assert.equal(gh.issueList[0].state, "closed");
  // An earlier reading's own failure reopens it, but doesn't drag its
  // recorded reading back: a still-earlier success arriving late can't close it.
  await issues.apply([failed], gh, hours(4), "", null, t(12));
  assert.deepEqual([gh.issueList[0].state, issues.metaOf(gh.issueList[0])!.seen], ["open", t(20)]);
  await issues.apply([ok], gh, hours(5), "", null, t(15));
  assert.equal(gh.issueList[0].state, "open");
});

test("issues: the daily reminder comes at exactly a day", async () => {
  const gh = new Fake();
  const fail = obs("test-failed", "grok", "2", "d");
  await issues.apply([fail], gh, now);
  await issues.apply([fail], gh, new Date(now.getTime() + 24 * 3600_000 - 1));
  assert.equal(gh.issueList[0].comments!.length, 0);
  await issues.apply([fail], gh, hours(24));
  assert.equal(gh.issueList[0].comments!.length, 1);
});

test("update: a release during a run waits for it; the run isn't restarted", () => {
  const root = join(import.meta.dirname, "..");
  const wf = readFileSync(join(root, ".github", "workflows", "update.yml"), "utf8");
  // A dispatch arriving during a real run waits in the same group; nothing
  // in the workflow cancels the run going.
  assert.ok(wf.includes("format('update-dry-{0}', github.ref) || 'update' }}"), "real runs share `update`");
  const cancels = [...wf.matchAll(/cancel-in-progress: *(\S+)/g)].map((m) => m[1]);
  assert.ok(cancels.length >= 3);
  assert.deepEqual([...new Set(cancels)], ["false"]);
  // Upstream is read once, in resolve; every later job tests and publishes
  // that candidate, so a release mid-run waits for the next run.
  const reads = [...wf.matchAll(/node scripts\/update\.ts/g)];
  assert.equal(reads.length, 1);
  assert.ok(reads[0].index! < wf.indexOf("\n  test:\n"), "in resolve");
  // Nor does anything else cancel or re-run a run: no workflow step, action,
  // script or the watcher calls `gh run cancel|rerun` or the API's
  // cancel, force-cancel or rerun endpoints.
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : /\.(ts|ya?ml|sh|js)$/.test(e.name) ? [join(d, e.name)] : []);
  const files = [".github", "scripts", "shared", "watcher/src"].flatMap((d) => walk(join(root, d)));
  for (const f of ["gh.ts", "watcher.ts", "update.yml", "action.yml"]) assert.ok(files.some((x) => x.endsWith(f)), f);
  const restart = /gh\s+run\s+(cancel|rerun)|\/(force-)?cancel\b|\/rerun|rerun-failed-jobs/;
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), restart, f);
  // Branch CI alone replaces its own runs: it never runs on main, in a group
  // per branch.
  for (const f of files.filter((x) => !x.endsWith("workflows/ci.yml"))) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /cancel-in-progress: *true/, f);
  }
  assert.match(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"), /branches-ignore: \[main/);
  assert.match("gh run cancel 1", restart);
  assert.match("`/repos/o/r/actions/runs/${id}/rerun-failed-jobs`", restart);
  assert.doesNotMatch("await res.body?.cancel();", restart);
});

test("issues: SEEN_AT reaches the issues job (update.yml), else now", () => {
  const at = new Date("2026-11-13T12:00:00Z");
  assert.equal(issues.seenAt({ SEEN_AT: "2026-11-13T11:00:00.123Z" }, at), "2026-11-13T11:00:00.123Z");
  assert.equal(issues.seenAt({}, at), at.toISOString());
  assert.equal(issues.seenAt({ SEEN_AT: "" }, at), at.toISOString(), "a run that never resolved");
  const wf = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "update.yml"), "utf8");
  assert.ok(wf.includes('echo "seen-at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" >> "$GITHUB_OUTPUT"'), "resolve records it");
  assert.ok(wf.includes("seen-at: ${{ steps.resolve.outputs.seen-at }}"), "as a job output");
  assert.ok(wf.includes("SEEN_AT: ${{ needs.resolve.outputs.seen-at }}"), "and hands it to issues.ts");
  assert.ok(wf.indexOf('echo "seen-at=') < wf.indexOf("node scripts/update.ts"), "stamped before the read");
  // The package sweep only for a run that read upstream.
  const dir = join(tmp, "versions");
  mkdirSync(dir);
  writeFileSync(join(dir, "codex.json"), "{}");
  assert.deepEqual(issues.packagesFor({ SEEN_AT: "2026-11-13T11:00:00Z" }, dir, []), new Set(["codex"]));
  // The updater's list too: a package new on main before its first pin.
  assert.deepEqual(issues.packagesFor({ SEEN_AT: "2026-11-13T11:00:00Z" }, dir, ["newp"]), new Set(["codex", "newp"]));
  assert.ok(issues.packagesFor({ SEEN_AT: "2026-11-13T11:00:00Z" }, dir)!.has("grok"), "by default, update.ts's packages");
  assert.equal(issues.packagesFor({}, dir), null);
  assert.equal(issues.packagesFor({ SEEN_AT: "" }, dir), null);
  // Never in a re-run, whose checkout may predate a package.
  assert.deepEqual(issues.packagesFor({ SEEN_AT: "2026-11-13T11:00:00Z", GITHUB_RUN_ATTEMPT: "1" }, dir, []), new Set(["codex"]));
  assert.equal(issues.packagesFor({ SEEN_AT: "2026-11-13T11:00:00Z", GITHUB_RUN_ATTEMPT: "2" }, dir), null);
});

test("workflows: pages.yml finds the live site on every kind of run", () => {
  // A scheduled run's event has no repository; GITHUB_REPOSITORY is always set.
  const pages = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "pages.yml"), "utf8");
  assert.ok(!pages.includes("github.event.repository"), "nothing read from the event's repository");
  assert.ok(pages.includes('${GITHUB_REPOSITORY#*/}/status.json'));
});

test("workflows: health's run lookups find update.yml's jobs by name", () => {
  const update = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "update.yml"), "utf8");
  const jobs = update.slice(update.indexOf("\njobs:\n"));
  for (const id of Object.values(UPDATE_JOBS)) {
    const at = jobs.indexOf(`\n  ${id}:\n`);
    assert.ok(at >= 0, `update.yml has a ${id} job`);
    const next = jobs.slice(at + 1).search(/\n  [a-z][a-z0-9-]*:\n/);
    const block = jobs.slice(at, next < 0 ? undefined : at + 1 + next);
    assert.ok(!/\n    name:/.test(block), `the ${id} job has no name: (GitHub would list it by that instead)`);
  }
});

test("test.ts: formatting is for branch CI only, never a candidate", () => {
  // Every branch-only name is a real check (lib/checks.nix defines it).
  const checksNix = readFileSync(join(import.meta.dirname, "..", "lib", "checks.nix"), "utf8");
  for (const name of BRANCH_ONLY) assert.match(checksNix, new RegExp(`\\n  ${name} =\\n`), `${name} is a check`);
  const all = ["unit", "nix-format", "t3-smoke"];
  assert.deepEqual(checkNames(all, "branch"), ["nix-format", "t3-smoke", "unit"]);
  for (const set of ["candidate", "final", "set-1"]) assert.deepEqual(checkNames(all, set), ["t3-smoke", "unit"]);
});

test("workflows: one queue of real update runs, no separate retry run", () => {
  const read = (f: string) => readFileSync(join(import.meta.dirname, "..", ".github", "workflows", f), "utf8");
  const update = read("update.yml"), health = read("health.yml");
  for (const [name, text] of [["update.yml", update], ["health.yml", health]]) {
    assert.ok(!/retry.held|update-retry/i.test(text), `${name} has no retry run left`);
  }
  assert.ok(update.includes("if: always() && needs.resolve.result != 'skipped' && (inputs.dry_run || github.ref == 'refs/heads/main') && (needs.resolve.result"),
    "a real run on a branch never writes issues, nor a run before updates are on");
  // Real runs only once UPDATES is on; dry runs always. The backstop waits too.
  assert.ok(update.includes("  resolve:\n    if: inputs.dry_run || vars.UPDATES == 'true'\n"), "resolve is gated");
  assert.ok(health.includes("  dispatch:\n    if: vars.UPDATES == 'true'\n"), "the backstop is gated");
  assert.ok(health.includes("  issues:\n    if: vars.UPDATES == 'true' && "), "and its lag issues");
  assert.ok(read("deploy-watcher.yml").includes("    if: github.ref == 'refs/heads/main' && "), "the watcher deploys only from main");
  // A branch's runs (dry, or real by mistake) never join main's queue.
  assert.ok(update.includes("group: ${{ (inputs.dry_run || github.ref != 'refs/heads/main') && format('update-dry-{0}', github.ref) || 'update' }}"));
  assert.ok(health.includes('gh workflow run update.yml --repo "$GITHUB_REPOSITORY" --ref main\n'), "a plain dispatch");
  assert.ok(update.includes('candidate.ts make "$RUNNER_TEMP/candidate" "$RUNNER_TEMP/obs/observations-candidate.json"'),
    "held inputs the candidate leaves out are reported with the run's observations");
  assert.ok(update.indexOf("observations-candidate.json") < update.indexOf("id: obs-artifact"), "before they're uploaded");
  for (const step of ["- name: Resolve upstream versions", "- id: candidate"]) {
    const at = update.indexOf(step);
    assert.ok(at > 0 && update.slice(at, update.indexOf("run:", at)).includes("HELD_JSON: ${{ runner.temp }}/held.json"), `${step} reads the holds`);
  }
});

test("issues: evidence closes only the kinds it proves, and never comments on a closed issue", async () => {
  const gh = new Fake();
  await issues.apply([obs("test-failed", "grok", "2", "d"), obs("update-lag", "grok", "2", "late")], gh, now);
  await issues.apply([obs("test-passed", "grok", "2")], gh, hours(1));
  const byTitle = Object.fromEntries(gh.issueList.map((i) => [i.title, i]));
  assert.equal(byTitle["test-failed: grok"].state, "closed");
  assert.equal(byTitle["update-lag: grok"].state, "open", "test-passed doesn't prove the lag is over");
  const comments = byTitle["test-failed: grok"].comments!.length;
  await issues.apply([obs("test-passed", "grok", "2")], gh, hours(2));
  assert.equal(byTitle["test-failed: grok"].comments!.length, comments, "a closed issue isn't closed again");
});

test("issues: a version with backticks, HTML or @mentions stays inside its code span", async () => {
  const gh = new Fake();
  await issues.apply([obs("no-match", "t3code-releases", "x`@octocat<b>hi</b>`", "fits no channel rule")], gh, now);
  const line = gh.issueList[0].body.split("\n")[1];
  assert.equal(line, "**no-match** for t3code-releases, version `` x`@octocat<b>hi</b>` ``");
  assert.equal(issues.metaOf(gh.issueList[0])!.version, "x`@octocat<b>hi</b>`");
});

test("issues: a test failure closes on test-passed, or on a pass (the pin is then on main)", async () => {
  const gh = new Fake();
  await issues.apply([obs("test-failed", "grok", "2", "d")], gh, now);
  await issues.apply([obs("test-passed", "grok", "2")], gh, now);
  assert.deepEqual(await states(gh), ["closed"]);
  await issues.apply([obs("test-failed", "codex", "3", "d")], gh, now);
  await issues.apply([obs("pass", "codex", "3")], gh, now); // a lost test-passed, healed
  assert.deepEqual(await states(gh), ["closed", "closed"]);
});

test("issues: cache success on one system doesn't close the other", async () => {
  const gh = new Fake();
  await issues.apply([obs("nondeterministic", "codex", null, "d", "aarch64-linux")], gh, now);
  await issues.apply([obs("cache-ok", null, null, "", "x86_64-linux")], gh, now);
  assert.deepEqual(await states(gh), ["open"]);
  await issues.apply([obs("cache-ok", null, null, "", "aarch64-linux")], gh, now);
  assert.deepEqual(await states(gh), ["closed"]);
});

test("issues: a removed package closes; non-package issues survive", async () => {
  const gh = new Fake();
  await issues.apply([obs("test-failed", "oldtool", "1"), obs("test-failed", "nixpkgs", "abc"), obs("update-failed", "issues-job")], gh, now);
  await issues.apply([], gh, now, "", new Set(["codex"]));
  assert.deepEqual(await states(gh), ["closed", "open", "open"]);
  await issues.apply([obs("run-ok")], gh, now);
  assert.deepEqual(await states(gh), ["closed", "open", "closed"]);
});

test("issues: a watcher issue closes after three healthy checks", async () => {
  const gh = new Fake();
  await issues.apply([obs("watcher-stalled")], gh, now);
  for (const h of [1, 2]) {
    await issues.apply([obs("watcher-healthy")], gh, hours(h));
    assert.deepEqual(await states(gh), ["open"]);
  }
  await issues.apply([obs("watcher-healthy")], gh, hours(3));
  assert.deepEqual(await states(gh), ["closed"]);
});

test("issues: a problem and its evidence in one run keep it open", async () => {
  const gh = new Fake();
  await issues.apply([obs("latest-mismatch", "codex", "1")], gh, now);
  await issues.apply([obs("latest-mismatch", "codex", "1"), obs("latest-match", "codex", "1")], gh, hours(1));
  assert.deepEqual(await states(gh), ["open"]);
});

test("issues: held versions come from open hold issues only", async () => {
  const gh = new Fake();
  await issues.apply([obs("test-failed", "grok", "2", "d"), obs("combination-failed", "muse", "1.4", "d"),
    obs("integrity", "codex", "1.0", "d"), obs("no-match", "t3code-releases", "v9", "d"),
    obs("latest-mismatch", "codex", "0.1", "d"), obs("env-broken", null, null, "d")], gh, now);
  await issues.apply([obs("test-passed", "grok", "2")], gh, now); // grok's hold closes
  assert.deepEqual(issues.heldVersions(await gh.issues()), [{ package: "muse", version: "1.4" }]);
});

test("issues: releases-ok closes the release stream's problems, never a t3code pin's", async () => {
  const gh = new Fake();
  await issues.apply([obs("no-match", "t3code-releases", "v9", "d", "nightly"), obs("resolve-failed", "t3code-releases", null, "d"),
    obs("resolve-failed", "t3code", "v1", "d"), obs("integrity", "t3code-nightly", "v9", "d")], gh, now);
  await issues.apply([obs("releases-ok", "t3code-releases", null, "")], gh, hours(1), "", new Set(["t3code", "t3code-nightly"]));
  assert.deepEqual(await states(gh), ["closed", "closed", "open", "open"]);
});

test("issues: npm-ok closes npm's resolve failure only", async () => {
  const gh = new Fake();
  await issues.apply([obs("resolve-failed", "codex", null, "d", "npm"), obs("resolve-failed", "codex", null, "d")], gh, now);
  await issues.apply([obs("npm-ok", "codex", null, "", "npm")], gh, hours(1));
  assert.deepEqual(await states(gh), ["closed", "open"]);
  await issues.apply([obs("pass", "codex", "1")], gh, hours(2));
  assert.deepEqual(await states(gh), ["closed", "closed"]);
});

test("issues: the same problem twice in one run is one issue, and the last one stands", async () => {
  const gh = new Fake();
  await issues.apply([obs("test-failed", "grok", "2", "a"), obs("test-failed", "grok", "3", "b")], gh, now);
  assert.equal(gh.issueList.length, 1);
  assert.deepEqual(issues.heldVersions(await gh.issues()), [{ package: "grok", version: "3" }]);
});

test("issues: malformed metadata is skipped, never fatal", async () => {
  const gh = new Fake();
  await gh.createIssue("hand-edited", "<!-- t3code-nix: {not json} -->");
  await gh.createIssue("wrong shape", '<!-- t3code-nix: {"key":"x"} -->');
  for (const bad of ['"reminded":{"toString":null,"valueOf":null}', '"reminded":"soon"', '"clean":-1', '"clean":"x"']) {
    await gh.createIssue("bad field", `<!-- t3code-nix: {"key":"test-failed/grok/-","version":"2",${bad}} -->`);
  }
  await issues.apply([obs("test-failed", "grok", "2", "d")], gh, hours(30));
  assert.equal(gh.issueList.length, 7);
  assert.deepEqual(issues.heldVersions(await gh.issues()), [{ package: "grok", version: "2" }]);
});

test("verdict: a passing final candidate also shows the environment works", () => {
  both(tmp, "final", true);
  const v = narrow.verdict(inputs, tmp, "final", ["grok"]);
  assert.ok(v.ok);
  assert.ok(v.observations.some((o) => o.kind === "env-ok"));
});

// A candidate repo with a nixpkgs lock, and holds in HELD_JSON.
function heldRepo(pins: Record<string, string>, holds: [string, string][]) {
  const repo = new Repo(pins);
  repo.lock("old");
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "lock");
  const held = join(tmp, "held.json");
  writeFileSync(held, JSON.stringify(holds.map(([p, v]) => ({ package: p, version: v }))));
  process.env.HELD_JSON = held;
  return repo;
}
const leftOut = (file: string) => JSON.parse(readFileSync(file, "utf8")).observations.map((o: any) => [o.kind, o.package, o.version]);

test("candidate: an input that isn't in the candidate is refused", () => {
  const repo = new Repo({ grok: "1" });
  const dir = repo.candidate({ grok: "2" });
  assert.throws(() => candidate.apply(dir, "grok,nope"), /no such input\(s\) nope/);
  assert.throws(() => candidate.tree(dir, "nope"), /no such input/);
});

test("publish: only from the candidate's base", async () => {
  const repo = new Repo({ grok: "1" });
  const dir = repo.candidate({ grok: "2" });
  writeFileSync(join(repo.work, "extra"), "x");
  git(repo.work, "add", "extra");
  git(repo.work, "commit", "-q", "-m", "moved");
  await assert.rejects(publish(dir, ["grok"], candidate.tree(dir, "grok"), new Fake(), env()), /not the candidate's base/);
});

test("candidate: held inputs are left out, reverted and reported when anything else is new", () => {
  const repo = heldRepo({ grok: "1", codex: "1" }, [["nixpkgs", "bad"], ["codex", "2"]]);
  try {
    repo.lock("bad");
    repo.bump("codex", "2");
    repo.bump("grok", "2");
    const out = join(tmp, "left.json");
    assert.deepEqual(candidate.make(join(tmp, "c1"), out), ["grok"]);
    assert.equal(git(repo.work, "status", "--porcelain", "flake.lock", "versions/codex.json"), "", "both put back as on main");
    assert.deepEqual(leftOut(out), [["held", "nixpkgs", "bad"], ["held", "codex", "2"]]);
  } finally {
    delete process.env.HELD_JSON;
  }
});

test("candidate: held inputs are all tested when nothing else is new (the retry)", () => {
  const repo = heldRepo({ grok: "1" }, [["nixpkgs", "bad"], ["grok", "2"]]);
  try {
    repo.lock("bad");
    repo.bump("grok", "2");
    const out = join(tmp, "left.json");
    assert.deepEqual(candidate.make(join(tmp, "c1"), out), ["nixpkgs", "grok"]);
    assert.deepEqual(leftOut(out), []);
    // A non-held nixpkgs revision is new: the held pin is left out.
    git(repo.work, "checkout", "-q", "--", ".");
    repo.lock("good");
    repo.bump("grok", "2");
    assert.deepEqual(candidate.make(join(tmp, "c2"), out), ["nixpkgs"]);
    assert.deepEqual(leftOut(out), [["held", "grok", "2"]]);
  } finally {
    delete process.env.HELD_JSON;
  }
});

test("candidate: upstream moving between the updater's passes keeps the new version only", () => {
  // The second pass met codex 3 (not held) beside the held grok 2.
  const repo = heldRepo({ grok: "1", codex: "1" }, [["grok", "2"], ["codex", "2"]]);
  try {
    repo.bump("grok", "2");
    repo.bump("codex", "3");
    assert.deepEqual(candidate.make(join(tmp, "c1"), join(tmp, "left.json")), ["codex"]);
    assert.deepEqual(leftOut(join(tmp, "left.json")), [["held", "grok", "2"]]);
  } finally {
    delete process.env.HELD_JSON;
  }
});

test("candidate: a held version of a package new on the branch is removed, not checked out", () => {
  const repo = heldRepo({ grok: "1" }, [["newp", "1"]]);
  try {
    repo.bump("newp", "1");
    repo.bump("grok", "2");
    assert.deepEqual(candidate.make(join(tmp, "c1"), join(tmp, "left.json")), ["grok"]);
    assert.ok(!existsSync(join(repo.work, "versions", "newp.json")));
  } finally {
    delete process.env.HELD_JSON;
  }
});

test("candidate: a details-only change is never held, even to main's own held version", () => {
  // grok 1 on main is held (its new bytes failed); now upstream serves the
  // old bytes again under a new URL: details only, so it's new, not a retry.
  const repo = heldRepo({ grok: "1" }, [["grok", "1"], ["nixpkgs", "bad"]]);
  try {
    repo.lock("bad");
    writeFileSync(join(repo.work, "versions", "grok.json"), pinText("grok", "1", { tag: "moved" }));
    const out = join(tmp, "left.json");
    assert.deepEqual(candidate.make(join(tmp, "c1"), out), ["grok"]);
    assert.deepEqual(leftOut(out), [["held", "nixpkgs", "bad"]]);
    // New bytes for that held version are held: alone, they're a retry.
    git(repo.work, "checkout", "-q", "--", ".");
    writeFileSync(join(repo.work, "versions", "grok.json"), pinText("grok", "1", { assets: { "x86_64-linux": { hash: "new" } } }));
    assert.deepEqual(candidate.make(join(tmp, "c2"), out), ["grok"]);
    assert.deepEqual(leftOut(out), []);
  } finally {
    delete process.env.HELD_JSON;
  }
});

test("issues: the cache job's failure closes only on that system's cache-ok, not run-ok", async () => {
  const gh = new Fake();
  await issues.apply([obs("update-failed", "fx", null, "not free", "aarch64-linux"), obs("update-failed", null, null, "infra")], gh, now);
  await issues.apply([obs("run-ok")], gh, hours(1));
  assert.deepEqual(await states(gh), ["open", "closed"]);
  await issues.apply([obs("cache-ok", null, null, "", "x86_64-linux")], gh, hours(2));
  assert.deepEqual(await states(gh), ["open", "closed"]);
  await issues.apply([obs("cache-ok", null, null, "", "aarch64-linux")], gh, hours(3));
  assert.deepEqual(await states(gh), ["closed", "closed"]);
});

test("issues: two issues with one key: the open one counts, an older open one closes as a duplicate", async () => {
  const meta = (version: string) => `<!-- t3code-nix: {"key":"test-failed/codex/-","version":"${version}","detail":"d"} -->`;
  // A closed issue and a newer open one (a hand-edited body fixed later).
  const gh = new Fake();
  await gh.createIssue("test-failed: codex", meta("1"));
  await gh.editIssue(1, { state: "closed" });
  await gh.createIssue("test-failed: codex", meta("2"));
  await issues.apply([obs("test-passed", "codex", "2")], gh, now);
  assert.deepEqual(await states(gh), ["closed", "closed"], "the open one was closed by the evidence");
  assert.deepEqual(issues.heldVersions(await gh.issues()), []);
  // An open one and a newer closed one: still the open one.
  const gh2 = new Fake();
  await gh2.createIssue("test-failed: codex", meta("2"));
  await gh2.createIssue("test-failed: codex", meta("1"));
  await gh2.editIssue(2, { state: "closed" });
  await issues.apply([], gh2, now);
  assert.deepEqual(await states(gh2), ["open", "closed"], "the open one is kept, not closed as a duplicate");
  assert.equal(gh2.issueList[1].comments!.length, 0, "a closed duplicate is left alone");
  // Two open: the newer counts, the older closes as its duplicate.
  const gh3 = new Fake();
  await gh3.createIssue("test-failed: codex", meta("2"));
  await gh3.createIssue("test-failed: codex", meta("2"));
  await issues.apply([], gh3, now);
  assert.deepEqual(await states(gh3), ["closed", "open"]);
  assert.match(gh3.issueList[0].comments!.at(-1)!, /duplicate of #2/);
  assert.deepEqual(issues.heldVersions(await gh3.issues()), [{ package: "codex", version: "2" }]);
});

test("issues: a held version proves its source resolves", async () => {
  const gh = new Fake();
  await issues.apply([obs("resolve-failed", "grok", null, "d"), obs("resolve-failed", "codex", null, "d", "npm")], gh, now);
  await issues.apply([obs("held", "grok", "2"), obs("held", "codex", "3")], gh, hours(1));
  assert.deepEqual(await states(gh), ["closed", "open"]);
});

test("issues: watcher issues need three healthy checks in a row, whatever interrupts them", async () => {
  const gh = new Fake();
  await issues.apply([obs("watcher-stalled")], gh, now);
  await issues.apply([obs("watcher-healthy")], gh, hours(1));
  await issues.apply([obs("watcher-healthy")], gh, hours(2));
  await issues.apply([obs("watcher-auth", null, null, "HTTP 401")], gh, hours(3)); // another watcher problem
  await issues.apply([obs("watcher-healthy")], gh, hours(4));
  assert.deepEqual(await states(gh), ["open", "open"], "the stalled count started over");
  await issues.apply([obs("watcher-healthy")], gh, hours(5));
  await issues.apply([obs("watcher-healthy")], gh, hours(6));
  assert.deepEqual(await states(gh), ["closed", "closed"]);
});

test("issues: on-main closes a test failure at exactly the version main has", async () => {
  const gh = new Fake();
  await issues.apply([obs("test-failed", "nixpkgs", "r2", "d")], gh, now);
  await issues.apply([obs("on-main", "nixpkgs", "r1")], gh, now); // an older revision: still held
  assert.deepEqual(await states(gh), ["open"]);
  await issues.apply([obs("on-main", "nixpkgs", "r2")], gh, now); // r2 got published; its test-passed was lost
  assert.deepEqual(await states(gh), ["closed"]);
});

test("issues: bump-waiting closes only when flake.lock moves on main, never on the same revision", async () => {
  const gh = new Fake();
  const waiting = obs("bump-waiting", "nixpkgs", "r1", "not on cache.nixos.org yet: x86_64-linux: gtk+3");
  await issues.apply([waiting, obs("on-main", "nixpkgs", "r1")], gh, now);
  assert.deepEqual(await states(gh), ["open"], "opened, and main's routine on-main doesn't close it");
  await issues.apply([obs("on-main", "nixpkgs", "r1")], gh, now);
  assert.deepEqual(await states(gh), ["open"], "still stuck at r1");
  await issues.apply([waiting, obs("on-main", "nixpkgs", "r2")], gh, now);
  assert.deepEqual(await states(gh), ["open"], "reported again in the same run: stays open");
  await issues.apply([obs("on-main", "nixpkgs", "r2")], gh, now);
  assert.deepEqual(await states(gh), ["closed"], "a publish moved flake.lock to r2");
  const [issue] = await gh.issues();
  assert.match(issue.comments?.at(-1) ?? "", /nixpkgs moved on to r2/);
  // A test failure held at r2 is untouched by the other rule.
  const gh2 = new Fake();
  await issues.apply([obs("test-failed", "nixpkgs", "r3", "d")], gh2, now);
  await issues.apply([obs("on-main", "nixpkgs", "r2")], gh2, now);
  assert.deepEqual(await states(gh2), ["open"]);
});

test("narrow: a browser pin's failure names its Chromium version, from the candidate", () => {
  const one = [{ name: "browser-unstable", files: [], from: "a".repeat(40), to: "b".repeat(40), note: "Chromium 158.0.1 (nixos-unstable)" }];
  result(tmp, "candidate", "x86_64-linux", false);
  result(tmp, "candidate", "aarch64-linux", false);
  both(tmp, "main", true);
  const o = narrow.decide(one, narrow.load(tmp)).observations[0];
  assert.deepEqual([o.kind, o.version], ["test-failed", "b".repeat(40)]);
  assert.match(o.detail, /^Chromium 158\.0\.1 \(nixos-unstable\): fails on its own/);
});

test("candidate: a browser pin's input carries its Chromium as a note", () => {
  const repo = new Repo({ grok: "1" });
  writeFileSync(join(repo.work, "versions", "browser-unstable.json"), JSON.stringify({ name: "browser-unstable", version: "b".repeat(40), assets: {},
    channel: "nixos-unstable", rev: "b".repeat(40), chromium: "158.0.1" }));
  const dir = join(tmp, "c");
  candidate.make(dir);
  assert.deepEqual(candidate.load(dir).inputs.map((i) => [i.name, i.note]), [["browser-unstable", "Chromium 158.0.1 (nixos-unstable)"]]);
  // A Chrome-only move names Chrome's version.
  writeFileSync(join(repo.work, "versions", "browser-unstable.json"), JSON.stringify({ name: "browser-unstable", version: "c".repeat(40), assets: {},
    channel: "nixos-unstable", rev: "c".repeat(40), chromium: "158.0.1",
    browsers: { chromium: { version: "158.0.1", outPaths: {} }, "google-chrome": { version: "158.0.4", outPaths: {} } } }));
  const dir2 = join(tmp, "c2");
  candidate.make(dir2);
  assert.deepEqual(candidate.load(dir2).inputs.map((i) => i.note), ["ungoogled-chromium 158.0.1, Chromium 158.0.1, Chrome 158.0.4 (nixos-unstable)"]);
});

test("issues: browser pins at one revision are separate inputs; waiting keeps a hold; publishing closes bump-waiting", async () => {
  const X = "x".repeat(40), Y = "y".repeat(40);
  const gh = new Fake();
  await issues.apply([obs("test-failed", "browser-stable", X, "d")], gh, now);
  await issues.apply([obs("pass", "browser-unstable", X)], gh, now);
  assert.deepEqual(await states(gh), ["open"], "the other pin's success at the same revision closes nothing");
  await issues.apply([obs("waiting", "browser-stable", Y, "not cached yet")], gh, now);
  assert.deepEqual(await states(gh), ["open"], "a held revision followed by an uncached one: still held");
  const gh2 = new Fake();
  await issues.apply([obs("bump-waiting", "browser-unstable", X, "not on cache.nixos.org yet"), obs("on-main", "browser-unstable", X)], gh2, now);
  await issues.apply([obs("on-main", "browser-unstable", X)], gh2, now);
  assert.deepEqual(await states(gh2), ["open"]);
  await issues.apply([obs("on-main", "browser-unstable", Y)], gh2, now);
  assert.deepEqual(await states(gh2), ["closed"], "the pin's file moved on main");
  const gh3 = new Fake();
  await issues.apply([obs("resolve-failed", "browser-unstable", null, "nix eval failed")], gh3, now);
  await issues.apply([obs("waiting", "browser-unstable", Y, "not cached yet")], gh3, now);
  assert.deepEqual(await states(gh3), ["closed"], "waiting proves the source resolves");
});

test("candidate: a change under versions/stable/ is refused (only the publish job moves the snapshot)", () => {
  const repo = new Repo({ grok: "1" });
  mkdirSync(join(repo.work, "versions", "stable"));
  writeFileSync(join(repo.work, "versions", "stable", "grok.json"), pinText("grok", "2"));
  assert.throws(() => candidate.make(join(tmp, "c")), /written only by the publish job/);
});

// ---- NixOS stable -----------------------------------------------------------

const T = (c: string) => c.repeat(40);
/** A stable result file (stable.ts) for a set on one system. */
function stableResult(dir: string, set: string, system: string, r: {
  tree?: string; failed?: string[]; complete?: boolean; next?: { complete: boolean; failed: string[] }; drvs?: string; base?: string | null;
  behind?: boolean; move?: { ok: boolean; tree: string; reason: string };
} = {}) {
  writeFileSync(join(dir, `stable-${set}-${system}.json`), JSON.stringify({
    set, system, tree: r.tree ?? T("a"), stable: { complete: r.complete ?? true, failed: r.failed ?? [] }, stableNext: r.next,
    drvs: r.drvs ?? "d", base: r.base === undefined ? "d" : r.base, behind: r.behind ?? false, move: r.move,
  }));
}
const stableBoth = (dir: string, set: string, r: Parameters<typeof stableResult>[3] = {}) => SYSTEMS.forEach((s) => stableResult(dir, set, s, r));
const stableInput: candidate.Input = { name: "nixpkgs-stable", files: [], from: "r1", to: "r2" };
const kinds = (o: { kind: string }[]) => o.map((x) => x.kind);

test("stable: stable results aren't default results, and a malformed one is refused", () => {
  both(tmp, "candidate", true);
  stableBoth(tmp, "candidate", { failed: ["stable-unit"] });
  assert.equal(narrow.plan(inputs, narrow.load(tmp), narrow.loadStable(tmp)), null, "other inputs never wait for the stable groups");
  writeFileSync(join(tmp, `stable-candidate-x86_64-linux.json`), JSON.stringify({ set: "candidate", system: "x86_64-linux", tree: T("a"),
    stable: { complete: true, failed: ["<b>x</b>"] }, drvs: "d", behind: false }));
  assert.throws(() => narrow.loadStable(tmp), /not a stable test result/);
});

test("stable: a candidate with nixpkgs-stable narrows until its stable group passes completely", () => {
  const ins = [...inputs, stableInput];
  both(tmp, "candidate", true);
  stableResult(tmp, "candidate", "x86_64-linux"); // aarch64 has no stable result
  assert.deepEqual(narrow.plan(ins, narrow.load(tmp), narrow.loadStable(tmp)), ["main", "grok", "codex", "nixpkgs-stable"]);
  assert.deepEqual(narrow.stableSets(["main", "grok", "codex", "nixpkgs-stable"]), ["main", "nixpkgs-stable"]);
  stableBoth(tmp, "candidate");
  assert.equal(narrow.plan(ins, narrow.load(tmp), narrow.loadStable(tmp)), null);
});

test("stable: decide holds a failing nixpkgs-stable, leaves an incomplete one out, and never holds others for it", () => {
  const ins = [...inputs, stableInput];
  for (const s of ["main", "grok", "codex", "nixpkgs-stable"]) both(tmp, s, true);
  stableBoth(tmp, "main");
  stableBoth(tmp, "nixpkgs-stable", { failed: ["stable-t3-smoke"], base: "other" });
  let d = narrow.decide(ins, narrow.load(tmp), narrow.loadStable(tmp));
  assert.deepEqual(d.final, ["grok", "codex"]);
  const held = d.observations.find((o) => o.kind === "test-failed")!;
  assert.equal(held.package, "nixpkgs-stable");
  assert.match(held.detail, /on NixOS stable: aarch64-linux: stable-t3-smoke, x86_64-linux: stable-t3-smoke$/);
  assert.ok(kinds(d.observations).includes("stable-ok"), "main's own stable result is evidence");
  // Incomplete: left out, not held.
  stableResult(tmp, "nixpkgs-stable", "aarch64-linux", { complete: false });
  stableResult(tmp, "nixpkgs-stable", "x86_64-linux");
  d = narrow.decide(ins, narrow.load(tmp), narrow.loadStable(tmp));
  assert.deepEqual(d.final, ["grok", "codex"]);
  assert.ok(!kinds(d.observations).includes("test-failed"));
  assert.match(d.observations.find((o) => o.kind === "update-failed")!.detail, /nixpkgs-stable \(no complete NixOS-stable result\)/);
});

test("stable: nixpkgs-stable answers only for the NixOS-stable failures main doesn't have", () => {
  const ins = [...inputs, stableInput];
  for (const s of ["main", "grok", "codex", "nixpkgs-stable"]) both(tmp, s, true);
  // Main's old snapshot broke in place (stable-b); the bump fails only that.
  stableBoth(tmp, "main", { failed: ["stable-a", "stable-b"], base: null });
  stableBoth(tmp, "nixpkgs-stable", { failed: ["stable-b"], base: "other" });
  let d = narrow.decide(ins, narrow.load(tmp), narrow.loadStable(tmp));
  assert.deepEqual(d.final, ["grok", "codex", "nixpkgs-stable"]);
  assert.ok(!kinds(d.observations).includes("test-failed"));
  // A failure of its own still holds it, named alone.
  stableBoth(tmp, "nixpkgs-stable", { failed: ["stable-b", "stable-c"], base: "other" });
  d = narrow.decide(ins, narrow.load(tmp), narrow.loadStable(tmp));
  assert.deepEqual(d.final, ["grok", "codex"]);
  assert.match(d.observations.find((o) => o.kind === "test-failed")!.detail, /on NixOS stable: aarch64-linux: stable-c, x86_64-linux: stable-c$/);
  // The same check failing on another system is its own.
  stableResult(tmp, "main", "aarch64-linux", { failed: [], base: null });
  stableBoth(tmp, "nixpkgs-stable", { failed: ["stable-b"], base: "other" });
  assert.deepEqual(narrow.decide(ins, narrow.load(tmp), narrow.loadStable(tmp)).final, ["grok", "codex"]);
  // The final's verdict, given main's result, publishes it the same way.
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  both(tmp, "final", true);
  for (const sys of SYSTEMS) writeFileSync(join(tmp, `tree-final-${sys}.txt`), T("a"));
  stableBoth(tmp, "final", { failed: ["stable-b"], drvs: "x", base: "d" });
  assert.equal(narrow.verdict(ins, tmp, "final", ["grok", "nixpkgs-stable"]).ok, false, "without main's result, nothing is taken off");
  stableBoth(tmp, "main", { failed: ["stable-b"], base: null });
  assert.equal(narrow.verdict(ins, tmp, "final", ["grok", "nixpkgs-stable"]).ok, true);
});

test("stable: main's stable result opens and closes stable-broken only when complete", () => {
  stableBoth(tmp, "main", { failed: ["stable-codex"], base: null });
  assert.deepEqual(narrow.stableEvidence(narrow.loadStable(tmp), "main").map((o) => [o.kind, o.detail]),
    [["stable-broken", "aarch64-linux: stable-codex, x86_64-linux: stable-codex"]]);
  // A candidate whose stable derivations aren't main's says nothing about main.
  stableBoth(tmp, "candidate", { drvs: "d2", base: "d" });
  assert.deepEqual(narrow.stableEvidence(narrow.loadStable(tmp), "candidate"), []);
  stableBoth(tmp, "candidate");
  assert.deepEqual(kinds(narrow.stableEvidence(narrow.loadStable(tmp), "candidate")), ["stable-ok"]);
  // Incomplete: nothing either way.
  stableResult(tmp, "candidate", "aarch64-linux", { complete: false });
  assert.deepEqual(narrow.stableEvidence(narrow.loadStable(tmp), "candidate"), []);
  // The detail is cut at a limit, with a count of the rest.
  stableBoth(tmp, "main", { failed: Array.from({ length: 30 }, (_, i) => `stable-c${String(i).padStart(2, "0")}`), base: null });
  assert.match(narrow.stableEvidence(narrow.loadStable(tmp), "main")[0].detail, / and 40 more$/);
});

test("stable: the plan command writes the candidate's evidence for the workflow", () => {
  const repo = new Repo({ grok: "1" });
  const dir = repo.candidate({ grok: "2" });
  const results = join(tmp, "results");
  mkdirSync(results);
  both(results, "candidate", true);
  stableBoth(results, "candidate", { failed: ["stable-unit"] });
  const script = join(import.meta.dirname, "..", "scripts", "ci", "narrow.ts");
  const out = join(tmp, "obs.json");
  assert.equal(execFileSync(process.execPath, [script, "plan", dir, results, out], { encoding: "utf8" }).trim(), "failed=false");
  assert.deepEqual(kinds(JSON.parse(readFileSync(out, "utf8")).observations), ["stable-broken"]);
});

test("stable: a final with nixpkgs-stable whose stable group isn't a complete pass publishes nothing", () => {
  const ins = [...inputs, stableInput];
  both(tmp, "final", true);
  for (const s of SYSTEMS) writeFileSync(join(tmp, `tree-final-${s}.txt`), T("a"));
  stableBoth(tmp, "final", { failed: ["stable-unit"], drvs: "x", base: "d" });
  let v = narrow.verdict(ins, tmp, "final", ["grok", "nixpkgs-stable"]);
  assert.equal(v.ok, false);
  assert.deepEqual(kinds(v.observations), ["update-failed"], "a flaky stable check holds nothing");
  // Without nixpkgs-stable, the same stable failure doesn't stop the publish.
  v = narrow.verdict(ins, tmp, "final", ["grok"]);
  assert.equal(v.ok, true);
  // A stable result from another tree doesn't count for this set.
  stableBoth(tmp, "final", { tree: T("b") });
  assert.equal(narrow.verdict(ins, tmp, "final", ["grok", "nixpkgs-stable"]).ok, false);
  stableBoth(tmp, "final");
  v = narrow.verdict(ins, tmp, "final", ["grok", "nixpkgs-stable"]);
  assert.equal(v.ok, true);
  assert.ok(v.observations.some((o) => o.kind === "test-passed" && o.package === "nixpkgs-stable"));
});

test("stable: when publishing moves the snapshot, and why not", () => {
  const move = (r: Parameters<typeof stableResult>[3]) => { stableBoth(tmp, "candidate", r); return narrow.moveOf(narrow.loadStable(tmp), "candidate"); };
  const ok = { ok: true, tree: T("c"), reason: "" };
  assert.deepEqual(move({}), { behind: false, tree: null, reason: "" });
  assert.deepEqual(move({ behind: true, next: { complete: true, failed: [] }, move: ok }), { behind: true, tree: T("c"), reason: "" });
  assert.match(move({ behind: true, next: { complete: true, failed: ["stable-next-unit"] } }).reason, /^stable-next failed: .*stable-next-unit/);
  assert.equal(move({ behind: true, next: { complete: false, failed: [] } }).reason, "stable-next had no complete result");
  assert.equal(move({ behind: true }).reason, "stable-next had no complete result");
  assert.match(move({ behind: true, next: { complete: true, failed: [] }, move: { ok: false, tree: T("c"), reason: "moving the snapshot changes default checks: unit" } }).reason,
    /^the equivalence step refused the move: moving/);
  assert.match(move({ behind: true, next: { complete: true, failed: [] }, move: { ok: false, tree: T("c"), reason: "the stable-next set needs nixpkgs builds cache.nixos.org lacks: x" } }).reason,
    /^the stable-next set needs nixpkgs builds cache.nixos.org lacks/);
  assert.equal(move({ behind: true, next: { complete: true, failed: [] }, move: { ok: false, tree: T("c"), reason: "incomplete: the cache couldn't be checked" } }).reason,
    "stable-next had no complete result");
  move({ behind: true, next: { complete: true, failed: [] }, move: ok });
  stableResult(tmp, "candidate", "aarch64-linux", { behind: true, next: { complete: true, failed: [] }, move: { ...ok, tree: T("d") } });
  assert.match(narrow.moveOf(narrow.loadStable(tmp), "candidate").reason, /moved trees differ/);
});

/** Put a snapshot (name -> version) on main. */
function snapshot(repo: Repo, pins: Record<string, string>) {
  mkdirSync(join(repo.work, "versions", "stable"), { recursive: true });
  for (const [n, v] of Object.entries(pins)) writeFileSync(join(repo.work, "versions", "stable", `${n}.json`), pinText(n, v));
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "snapshot");
  git(repo.work, "push", "-q", "origin", "main");
}

test("stable: publish moves the snapshot only to the tree the tests recorded", async () => {
  const repo = new Repo({ t3code: "0.1.9", grok: "1", "t3code-nightly": "0.2.0-n" });
  snapshot(repo, { t3code: "0.1.9", grok: "1" });
  let dir = repo.candidate({ t3code: "0.2.0" });
  const tested = candidate.tree(dir, "t3code");
  const out: { trees?: { tested: string; published: string; moved: boolean } } = {};
  const want = (() => { process.chdir(repo.work); return moved(tested); })();
  const o = await publish(dir, ["t3code"], tested, new Fake(), env(), "origin", { behind: true, tree: want, reason: "" }, out);
  assert.deepEqual(kinds(o), ["published", "stable-current"]);
  assert.deepEqual(out.trees, { tested, published: want, moved: true });
  const main = repo.originMain();
  assert.equal(JSON.parse(git(repo.work, "show", `${main}:versions/stable/t3code.json`)).version, "0.2.0");
  assert.throws(() => git(repo.work, "show", `${main}:versions/stable/t3code-nightly.json`));
  assert.match(git(repo.work, "log", "-1", "--format=%B", main), /the snapshot moves/);
  // A recorded tree that isn't this move's: the tested tree, snapshot left behind.
  git(repo.work, "fetch", "-q", "origin");
  git(repo.work, "reset", "-q", "--hard", "origin/main");
  dir = repo.candidate({ grok: "2" });
  const t2 = candidate.tree(dir, "grok");
  const o2 = await publish(dir, ["grok"], t2, new Fake(), env(), "origin", { behind: true, tree: T("f"), reason: "" }, out);
  assert.equal(out.trees!.published, t2);
  assert.equal(out.trees!.moved, false);
  const behind = o2.find((x) => x.kind === "stable-behind")!;
  assert.match(behind.detail, /^grok: 1\n\nwhy: the moved tree [0-9a-f]+ isn't the tested one f{40}$/);
});

test("stable: publish without a move says why the snapshot is behind", async () => {
  const repo = new Repo({ t3code: "0.1.9", grok: "1" });
  snapshot(repo, { t3code: "0.1.9", grok: "1" });
  const dir = repo.candidate({ t3code: "0.2.0" });
  const tested = candidate.tree(dir, "t3code");
  const o = await publish(dir, ["t3code"], tested, new Fake(), env(), "origin", { behind: true, tree: null, reason: "stable-next failed: x86_64-linux: stable-next-unit" });
  assert.equal(git(repo.work, "rev-parse", `${repo.originMain()}^{tree}`), tested);
  assert.equal(o.find((x) => x.kind === "stable-behind")!.detail, "t3code: 0.1.9\n\nwhy: stable-next failed: x86_64-linux: stable-next-unit");
});

test("stable: the issues open and close on their own evidence", async () => {
  const gh = new Fake();
  await issues.apply([obs("stable-behind", null, null, "t3code: 0.1.9\n\nwhy: x"), obs("stable-broken", null, null, "x86_64-linux: stable-unit"),
    obs("stable-unfetchable", null, null, "https://x/y")], gh, now);
  assert.deepEqual(await states(gh), ["open", "open", "open"]);
  // The same run's evidence never closes what it reported.
  await issues.apply([obs("stable-ok"), obs("stable-broken", null, null, "x86_64-linux: stable-unit")], gh, hours(1));
  assert.deepEqual(await states(gh), ["open", "open", "open"]);
  await issues.apply([obs("stable-current"), obs("stable-ok"), obs("fetchable")], gh, hours(2));
  assert.deepEqual(await states(gh), ["closed", "closed", "closed"]);
  assert.equal(issues.heldVersions(gh.issueList).length, 0, "none of them holds anything");
});

test("stable: the release notes say which set NixOS stable has at that commit", () => {
  const repo = new Repo({ t3code: "0.1.9", codex: "1.0", "t3code-nightly": "n1" });
  assert.deepEqual(stableNote(repo.head()), [], "a commit from before the snapshot says nothing");
  snapshot(repo, { t3code: "0.1.9", codex: "1.0" });
  assert.match(stableNote(repo.head())[0], /^NixOS stable \(`programs\.t3code\.nixpkgs = "stable"`\) has this set\.$/);
  repo.bump("t3code", "0.2.0");
  repo.bump("grok", "1");
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "x");
  assert.equal(stableNote(repo.head())[0],
    'NixOS stable (`programs.t3code.nixpkgs = "stable"`) is on an earlier set: grok (not yet) (here 1), t3code 0.1.9 (here 0.2.0).');
  // The same shown version with new details: a newer build, not "1.0 (here 1.0)".
  snapshot(repo, { t3code: "0.2.0", codex: "1.0", grok: "1" });
  const path = join(repo.work, "versions", "codex.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), tag: "rust-v1.0-rebuilt" }));
  git(repo.work, "commit", "-qam", "details");
  assert.equal(stableNote(repo.head())[0],
    'NixOS stable (`programs.t3code.nixpkgs = "stable"`) is on an earlier set: codex 1.0 (here a newer build of it).');
});

test("stable: one system failing and the other incomplete opens nothing, but still holds a nixpkgs-stable bump for its own failure", () => {
  stableResult(tmp, "main", "x86_64-linux", { failed: ["stable-unit"], base: null });
  stableResult(tmp, "main", "aarch64-linux", { complete: false, base: null });
  assert.deepEqual(narrow.stableEvidence(narrow.loadStable(tmp), "main"), []);
  const ins = [...inputs, stableInput];
  for (const s of ["main", "grok", "codex", "nixpkgs-stable"]) both(tmp, s, true);
  stableResult(tmp, "nixpkgs-stable", "x86_64-linux", { failed: ["stable-unit", "stable-smoke"] });
  stableResult(tmp, "nixpkgs-stable", "aarch64-linux", { complete: false });
  let d = narrow.decide(ins, narrow.load(tmp), narrow.loadStable(tmp));
  assert.equal(d.observations.find((o) => o.kind === "test-failed")?.package, "nixpkgs-stable");
  // Failing only main's check, and incomplete elsewhere: left out, unheld.
  stableResult(tmp, "nixpkgs-stable", "x86_64-linux", { failed: ["stable-unit"] });
  d = narrow.decide(ins, narrow.load(tmp), narrow.loadStable(tmp));
  assert.ok(!kinds(d.observations).includes("test-failed"));
  assert.deepEqual(d.final, ["grok", "codex"]);
});

test("stable: env-broken comes from the default results only", () => {
  // main fails; the lone nixpkgs-stable input passes the default but fails on stable.
  both(tmp, "main", false);
  both(tmp, "candidate", true);
  stableBoth(tmp, "candidate", { failed: ["stable-unit"], base: "other" });
  const d = narrow.decide([stableInput], narrow.load(tmp), narrow.loadStable(tmp));
  assert.ok(!kinds(d.observations).includes("env-broken"));
  assert.ok(kinds(d.observations).includes("test-failed"));
});

test("issues: a late watcher problem from an earlier reading doesn't undo newer healthy checks", async () => {
  const gh = new Fake();
  const at = (h: number) => new Date(Date.UTC(2026, 10, 14, h)).toISOString();
  await issues.apply([obs("watcher-stalled")], gh, hours(1), "", null, at(1));
  await issues.apply([obs("watcher-healthy")], gh, hours(3), "", null, at(3));
  await issues.apply([obs("watcher-healthy")], gh, hours(4), "", null, at(4));
  // Delivered late: read at 02:00, before both healthy checks.
  await issues.apply([obs("watcher-stalled")], gh, hours(4.5), "", null, at(2));
  assert.deepEqual(await states(gh), ["open"]);
  await issues.apply([obs("watcher-healthy")], gh, hours(5), "", null, at(5));
  assert.deepEqual(await states(gh), ["closed"], "three newer healthy checks in a row");
});

test("issues: a no-match issue closes when its package is gone; the release stream's never does that way", async () => {
  const gh = new Fake();
  await issues.apply([obs("no-match", "removed-provider", null, "no complete release found on the latest channel"), obs("no-match", "t3code-releases", "v9", "fits no channel")], gh, now);
  await issues.apply([], gh, hours(1), "", new Set(["codex"]), hours(1).toISOString());
  assert.deepEqual(await states(gh), ["closed", "open"]);
});

test("issues: another watcher problem restarts a recovery from its reading, and one reading counts once", async () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 14, h)).toISOString();
  let gh = new Fake();
  await issues.apply([obs("watcher-auth")], gh, hours(0), "", null, at(0));
  await issues.apply([obs("watcher-healthy")], gh, hours(1), "", null, at(1));
  await issues.apply([obs("watcher-stalled")], gh, hours(5), "", null, at(5));
  for (const h of [2, 3, 4]) await issues.apply([obs("watcher-healthy")], gh, hours(5.5), "", null, at(h)); // late, from before 05:00
  assert.deepEqual(await states(gh), ["open", "open"], "healthy checks from before the interruption don't close it");
  // The same reading replayed counts once.
  gh = new Fake();
  await issues.apply([obs("watcher-stalled")], gh, hours(0), "", null, at(0));
  for (let i = 0; i < 3; i++) await issues.apply([obs("watcher-healthy")], gh, hours(1), "", null, at(1));
  assert.deepEqual(await states(gh), ["open"]);
});

test("issues: a bump-waiting issue closes when its pin is gone", async () => {
  const gh = new Fake();
  await issues.apply([obs("bump-waiting", "browser-stable", "abc", "waiting 14 days"), obs("bump-waiting", "nixpkgs", "def", "waiting")], gh, now);
  await issues.apply([], gh, hours(1), "", new Set(["codex"]), hours(1).toISOString());
  assert.deepEqual(await states(gh), ["closed", "open"], "nixpkgs isn't a package that can disappear");
});

test("issues: a bump-waiting opened before the pin existed (no version) closes once a revision is on main", async () => {
  const gh = new Fake();
  await issues.apply([obs("bump-waiting", "browser-stable", null, "versions/browser-stable.json isn't on main yet")], gh, now);
  await issues.apply([obs("on-main", "browser-stable", "R1"), obs("pass", "browser-stable", "R1")], gh, hours(1));
  assert.deepEqual(await states(gh), ["closed"]);
});

test("issues: a re-run's replayed cache verdict doesn't reopen what a newer publish fixed; the run's own failure still counts", async () => {
  const gh = new Fake();
  const at = (h: number) => new Date(Date.UTC(2026, 10, 14, h)).toISOString();
  const licence = obs("update-failed", null, null, "on the cache allowlist but not free: fx; nothing pushed", "x86_64-linux");
  await issues.apply([licence], gh, hours(1), "", null, at(1));
  await issues.apply([obs("cache-ok", null, null, "", "x86_64-linux")], gh, hours(2), "", null, at(2));
  await issues.apply([licence], gh, hours(3), "", null, at(1)); // R1 re-run, read at 01:00
  assert.deepEqual(await states(gh), ["closed"], "an earlier reading's verdict");
  await issues.apply([obs("update-failed", null, null, "a job failed or was cancelled")], gh, hours(4), "", null, at(1));
  assert.deepEqual(await states(gh), ["closed", "open"], "the run's own failure always counts");
});

test("issues: the same watcher key reporting again restarts its recovery", async () => {
  const gh = new Fake();
  await issues.apply([obs("watcher-stalled", null, null, "x")], gh, hours(0));
  await issues.apply([obs("watcher-healthy")], gh, hours(1));
  await issues.apply([obs("watcher-healthy")], gh, hours(2));
  await issues.apply([obs("watcher-stalled", null, null, "x")], gh, hours(3)); // same detail, within a day
  await issues.apply([obs("watcher-healthy")], gh, hours(4));
  assert.deepEqual(await states(gh), ["open"], "two healthy checks before the problem don't count");
  await issues.apply([obs("watcher-healthy")], gh, hours(5));
  await issues.apply([obs("watcher-healthy")], gh, hours(6));
  assert.deepEqual(await states(gh), ["closed"]);
});

test("issues: a late problem of another watcher key from an earlier reading doesn't reset a recovery", async () => {
  const gh = new Fake();
  const at = (h: number) => new Date(Date.UTC(2026, 10, 14, h)).toISOString();
  await issues.apply([obs("watcher-stalled")], gh, hours(0), "", null, at(0));
  await issues.apply([obs("watcher-healthy")], gh, hours(2), "", null, at(2));
  await issues.apply([obs("watcher-healthy")], gh, hours(3), "", null, at(3));
  await issues.apply([obs("watcher-auth")], gh, hours(3.5), "", null, at(1)); // read before both healthy checks
  await issues.apply([obs("watcher-healthy")], gh, hours(4), "", null, at(4));
  assert.equal(gh.issueList[0].state, "closed", "the stalled issue's three newer healthy checks still close it");
});

test("workflow: agent-browser's variants run after publish on the published tree, report-only, and their issues apart", () => {
  const wf = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "update.yml"), "utf8");
  const job = (name: string) => wf.slice(wf.indexOf(`\n  ${name}:\n`) + 1).split(/\n  [a-z-]+:\n/)[0];
  const variants = job("variants"), issuesJob = job("variant-issues");
  assert.match(variants, /needs: \[resolve, publish\]/);
  assert.doesNotMatch(variants, /permissions:|secrets\./, "runs vendor code: no write permission, no secrets");
  assert.match(variants, /snapshot\.ts checkout "\$TREE" "\$\{PUBLISHED_TREE:-\$TREE\}"/, "the published tree, as the cache job rebuilds it");
  const smoke = variants.slice(variants.indexOf("- name: Smoke the optional browsers"));
  assert.match(smoke, /continue-on-error: true/);
  assert.match(smoke, /timeout-minutes: \d+/);
  assert.match(issuesJob, /needs: \[resolve, publish, variants\]/);
  assert.match(issuesJob, /issues: write/);
  assert.match(issuesJob, /nix: false/, "never runs vendor code");
  assert.match(issuesJob, /variants\.ts observations "\$PUBLISHED_TREE"/, "only the published tree's results, filtered");
  assert.ok(!job("issues").includes("variants"), "the run's other issues never wait for the browsers");
  // A publish that asks for no variants still uploads a (empty) result, and
  // none found is no evidence, never a failed run.
  assert.match(variants, /echo '\{"results": \[\]\}' > "\$RUNNER_TEMP\/variants\/variants-\$\{\{ matrix\.system \}\}\.json"/);
  const download = issuesJob.slice(issuesJob.indexOf("download-artifact@")).split("\n      - ")[0];
  assert.match(download, /continue-on-error: true/);
  const resolve = job("resolve");
  assert.match(resolve, /held\.ts "\$RUNNER_TEMP\/held\.json" "\$RUNNER_TEMP\/retest\.json"/);
});

test("workflow: branch CI runs NixOS stable in a job of its own, and `tested` needs both jobs", () => {
  const ci = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  // A job's text, up to the blank line before the next job (or its comment).
  const jobOf = (name: string) => ci.slice(ci.indexOf(`\n  ${name}:\n`) + 1).split(/\n\n  (?=[#a-z])/)[0];
  const test = jobOf("test"), stable = jobOf("stable"), tested = jobOf("tested");
  const matrix = (body: string) => /\n    strategy:\n[\s\S]*?\n    runs-on: .*\n/.exec(body)?.[0];
  assert.ok(matrix(stable), "stable has a matrix");
  assert.equal(matrix(stable), matrix(test), "the same matrix, runners and fail-fast: false");
  assert.match(stable, /\n      fail-fast: false\n/);
  assert.match(stable, /\n    needs: one-commit\n/);
  // Both jobs need main under the branch's commit (HEAD~1).
  for (const job of [test, stable]) assert.match(job, /uses: actions\/checkout@[0-9a-f]{40} # .*\n\s+with:\n\s+fetch-depth: 2\n\s+persist-credentials: false\n/);
  assert.match(stable, /uses: \.\/\.github\/actions\/setup\n\s+with:\n\s+userns: true\n/);
  assert.doesNotMatch(stable, /desktop-tools/, "stable.ts builds its smokes' tools itself");
  // The same store cache as `test`, restored only, after setup (it needs
  // setup's Nix) and before stable.ts.
  const cache = (body: string) => /uses: nix-community\/cache-nix-action@.*\n\s+with:\n((?:\s+[a-z-]+: .*\n)+)/.exec(body)?.[1];
  assert.equal(cache(stable), cache(test));
  assert.match(cache(stable) ?? "", /primary-key: nix-test-\$\{\{ matrix\.system \}\}-\$\{\{ hashFiles\('flake\.lock', 'pkgs\/\*\*', 'lib\/\*\*'\) \}\}\n/);
  assert.match(cache(stable) ?? "", /restore-prefixes-first-match: nix-test-\$\{\{ matrix\.system \}\}-\n/);
  assert.match(cache(stable) ?? "", /save: false/);
  const at = (needle: string) => stable.indexOf(needle);
  assert.ok(at("actions/setup") < at("cache-nix-action@") && at("cache-nix-action@") < at("node scripts/ci/stable.ts"), "setup, the cache, then stable.ts");
  // The step as it was, with its limit; the job leaves 20 minutes over it.
  const step = stable.slice(at("- name: NixOS stable")).split(/\n      - /)[0];
  assert.match(step, /^- name: NixOS stable\n\s+timeout-minutes: 45\n\s+run: \|\n/);
  assert.match(step, /\n\s+node scripts\/ci\/stable\.ts branch \$\{\{ matrix\.system \}\} results --next --branch --parent=HEAD~1\n/);
  const jobLimit = Number(/\n    timeout-minutes: (\d+)/.exec(stable)?.[1]);
  const steps = [...stable.matchAll(/\n {8}timeout-minutes: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(steps.length >= 1 && jobLimit - steps.reduce((a, b) => a + b, 0) >= 20, `stable: steps ${steps.join("+")}, job ${jobLimit}`);
  // A successful job has written and uploaded its own result: the check
  // runs after stable.ts and before the upload, on every success.
  const guard = stable.slice(at("- name: The result was written")).split(/\n      - /)[0];
  assert.equal(guard, "- name: The result was written\n        run: test -s results/stable-branch-${{ matrix.system }}.json", "no condition or continue-on-error");
  assert.ok(at("node scripts/ci/stable.ts") < at("- name: The result was written") && at("- name: The result was written") < at("upload-artifact@"));
  for (const [job, name] of [[test, "results-${{ matrix.system }}"], [stable, "results-${{ matrix.system }}-stable"]]) {
    const upload = job.slice(job.indexOf("upload-artifact@")).split(/\n      - /)[0];
    assert.match(upload, new RegExp(`\\n\\s+name: ${name.replace(/[$.{}]/g, "\\$&")}\\n`));
    assert.match(upload, /if-no-files-found: error\n/);
    assert.match(upload, /if: \$\{\{ !cancelled\(\) \}\}\n/);
    assert.match(upload, /\n\s+path: results\n/);
  }
  assert.doesNotMatch(test, /stable\.ts/, "the default job no longer runs it");
  // The runner line and sampler, in both jobs, the same step: after the
  // checkout (which cleans the folder), before setup (whose Nix build
  // counts). The script reads /proc only and leaves its loop to the runner,
  // which ends it with the job.
  for (const [name, job] of [["test", test], ["stable", stable]] as const) {
    const sampler = job.slice(job.indexOf("- name: The runner, and a sampler for the job's length")).split(/\n      - /)[0];
    assert.equal(sampler, '- name: The runner, and a sampler for the job\'s length\n        run: scripts/ci/sample.sh "results/sampler-$GITHUB_JOB-${{ matrix.system }}.txt"', name);
    assert.ok(job.indexOf("actions/checkout@") < job.indexOf("- name: The runner, and a sampler") && job.indexOf("- name: The runner, and a sampler") < job.indexOf("actions/setup"), name);
  }
  const sample = readFileSync(join(import.meta.dirname, "..", "scripts", "ci", "sample.sh"), "utf8").split("\n").filter((l) => l && (!l.startsWith("#") || l.startsWith("#!"))).join("\n");
  assert.equal(sample, [
    "#!/usr/bin/env bash",
    "set -eu",
    "file=$1",
    "cpu=$(sed -n 's/^model name[[:space:]]*: //p' /proc/cpuinfo | head -1)",
    "[ -n \"$cpu\" ] || cpu=$(sed -n 's/^CPU \\(implementer\\|part\\)[[:space:]]*: /\\1 /p' /proc/cpuinfo | head -2 | paste -sd ' ')",
    'echo "CPU: $cpu; image: ${ImageOS:-} ${ImageVersion:-}"',
    'mkdir -p "$(dirname "$file")"',
    "sample() {",
    "  while :; do",
    '    echo "$(date +%s%3N) $(head -1 /proc/stat) $(awk \'NR > 2 && $1 != "lo:" { r += $2; t += $10 } END { print r, t }\' /proc/net/dev)"',
    "    sleep 1",
    "  done",
    "}",
    'sample > "$file" 2>/dev/null &',
  ].join("\n"), "the sampler script, exactly (it runs on every branch CI job)");
  // `test` checks its own result was written before the upload, as `stable` does.
  const written = test.slice(test.indexOf("- name: The result was written")).split(/\n      - /)[0];
  assert.equal(written, "- name: The result was written\n        run: test -s results/branch-${{ matrix.system }}.json");
  assert.ok(test.indexOf("node scripts/ci/test.ts") < test.indexOf("- name: The result was written") && test.indexOf("- name: The result was written") < test.indexOf("upload-artifact@"));
  // `tested` needs both and checks each job's own result as well as the files.
  assert.match(tested, /\n    needs: \[one-commit, test, stable\]\n/);
  // The posting step runs whatever happened, with each job's result and the
  // download's outcome (a tolerated download failure is `failure` there).
  const post = tested.slice(tested.indexOf("- name: Post `tested`")).split("        run: |\n")[0];
  assert.match(post, /^- name: Post `tested` if the suite passed on both systems\n\s+if: always\(\)\n/);
  for (const line of ["ONE_COMMIT: ${{ needs.one-commit.result }}", "TEST: ${{ needs.test.result }}",
    "STABLE: ${{ needs.stable.result }}", "DOWNLOAD: ${{ steps.download.outcome }}"]) assert.ok(post.includes(`\n          ${line}\n`), line);
  assert.match(tested, /\[ "\$TEST" = success \] && \[ "\$STABLE" = success \]/);
  assert.match(tested, /\n    if: always\(\)\n/);
  assert.match(tested, /pattern: results-\*\n\s+path: results\n\s+merge-multiple: true\n/);

  // The status script itself, run with each job's result and the files.
  const script = tested.slice(tested.indexOf("        run: |\n", tested.indexOf("- name: Post `tested`")) + "        run: |\n".length)
    .split("\n").filter((l) => l.startsWith("          ") || l === "").map((l) => l.slice(10)).join("\n");
  assert.match(script, /gh api -X POST/);
  const posted = (env: Record<string, string>, files: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "tested-"));
    try {
      mkdirSync(join(dir, "results")); mkdirSync(join(dir, "bin"));
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "results", name), JSON.stringify(body));
      // Run in the fixture folder, so nothing in the shell code names its path.
      writeFileSync(join(dir, "bin", "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > posted\n`);
      chmodSync(join(dir, "bin", "gh"), 0o755);
      let code = 0;
      try {
        // No profile or bashrc, so the machine running the tests can't change
        // what the script sees (a bash given a pipe for stdin may read the
        // user's bashrc otherwise).
        execFileSync("bash", ["--noprofile", "--norc", "-e", "-c", script], { cwd: dir, stdio: "pipe",
          env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", SHA: "abc", URL: "u", GH_TOKEN: "t",
            ONE_COMMIT: "success", TEST: "success", STABLE: "success", DOWNLOAD: "success", ...env } });
      } catch (e: any) { code = e.status; }
      const args = existsSync(join(dir, "posted")) ? readFileSync(join(dir, "posted"), "utf8") : "";
      return { code, state: /state=(\w+)/.exec(args)?.[1] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const good: Record<string, unknown> = {};
  for (const system of SYSTEMS) {
    good[`branch-${system}.json`] = { passed: true, failed: [] };
    good[`stable-branch-${system}.json`] = { branch: [] };
  }
  const without = (name: string) => Object.fromEntries(Object.entries(good).filter(([k]) => k !== name));
  assert.deepEqual(posted({}, good), { code: 0, state: "success" });
  const failing: Record<string, string>[] = [{ STABLE: "failure" }, { STABLE: "cancelled" }, { TEST: "failure" }, { ONE_COMMIT: "failure" }, { DOWNLOAD: "failure" }];
  for (const env of failing)
    assert.deepEqual(posted(env, good), { code: 1, state: "failure" }, JSON.stringify(env));
  for (const files of [without("stable-branch-aarch64-linux.json"), without("branch-x86_64-linux.json"),
    { ...good, "stable-branch-x86_64-linux.json": { branch: ["stable-t3"] } }, { ...good, "branch-aarch64-linux.json": { passed: false, failed: ["t3"] } }])
    assert.deepEqual(posted({}, files), { code: 1, state: "failure" }, Object.keys(files).join(" "));
});

test("workflow: branch CI runs the variants only when what they're built or run from changed", () => {
  const ci = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const step = ci.slice(ci.indexOf("- name: agent-browser's optional browsers")).split(/\n      - /)[0];
  assert.match(step, /git diff --quiet HEAD~1 HEAD -- flake\.nix flake\.lock pkgs lib versions\/agent-browser\.json \\\n\s+'versions\/browser-\*\.json' scripts\/agent-browser-smoke\.ts scripts\/ci\/variants\.ts;/);
  assert.match(step, /variants\.ts branch \$\{\{ matrix\.system \}\} .* --parent=HEAD~1/);
  // variants.ts's helpers from elsewhere in scripts/ aren't on the list (they
  // change often, and their own tests cover them); a new import is a
  // deliberate choice to add it to the list or not.
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "ci", "variants.ts"), "utf8");
  // Each save carries the record of Nix calls so far (util.ts).
  assert.match(src, /const save = \(\) => writeJson\(outFile, \{ results, nixCalls \}\);/);
  const imports = [...src.matchAll(/from "\.\.?\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["agent-browser-smoke.ts", "lib/util.ts", "stable.ts", "update.ts"].sort());
});
