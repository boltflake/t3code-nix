// Repairs that run on every update run (the reconcile job). Builds nothing.
//
//   node reconcile.ts [HISTORY_REF]
//
// HISTORY_REF (default HEAD) is main's history; the workflow runs the
// dispatched revision's script against origin/main, so a branch's dry run
// exercises its own reconcile. Environment: DRY_RUN.
//
// - Every latest-channel t3code version on main's history has its tag t3code-v<version>
//   at the commit that first published it. A missing tag is created there; a
//   tag pointing anywhere else is reported (tag-mismatch), never moved.
// - Candidate refs (bot/candidate/<run>) are deleted by the run that made
//   them (publish.ts). One left behind (a killed runner) is deleted here
//   once its run has finished, never while it runs (it may still be
//   publishing; reconcile also runs in the run that made it).
// - The scheduled workflows (SCHEDULED) are re-enabled if GitHub disabled
//   them after 60 quiet days.
// - Each verified t3code-v* tag (one at its first-publication commit) gets a
//   GitHub Release: created once, never edited or deleted, in history order.
//   GitHub's Latest marker is on the release for the latest-channel version
//   main pins now, so after a rollback upstream it moves back with main.
//   Reconcile is the only writer of releases, and its job's concurrency group
//   keeps two reconciles from overlapping.
//
// The reads (tags, candidate refs, the scheduled workflows' states, the
// releases and GitHub's Latest-marked one, each leftover run) start together; each
// result is used where it was always read, so a failed read stops the run
// at the same point, after the same writes. Writes stay one at a time, in
// order.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TOOLS, BROWSER_PINS } from "../lib/packages.ts";
import { differing, pinsOf } from "../lib/snapshot.ts";
import { electronInfo } from "../lib/electron-fallback.ts";
import { early, git, releaseNotes, shownVersion, tryRun } from "../lib/util.ts";
import { compareVersions, obs, type Observation } from "../update.ts";
import { client, REPO, type Client, type Release } from "./gh.ts";

/** Scheduled workflows GitHub disables after 60 quiet days, each with the
 * observation reconcile makes when it re-enables one. */
export const SCHEDULED: [string, string][] = [
  ["health.yml", "backstop-enabled"],
  ["pages.yml", "pages-enabled"],
  ["tooling.yml", "tooling-enabled"],
];

/** {version: first commit on ref's history where `path` had it}. */
export function firstPublications(path = "versions/t3code.json", ref = "HEAD"): Map<string, string> {
  const firsts = new Map<string, string>();
  for (const sha of git("log", "--reverse", "--format=%H", ref, "--", path).split("\n").filter(Boolean)) {
    const shown = tryRun("git", ["show", `${sha}:${path}`]);
    if (shown.status !== 0) continue;
    try {
      const version = JSON.parse(shown.stdout).version;
      if (version && !firsts.has(version)) firsts.set(version, sha);
    } catch {
      // not JSON at that commit; skip
    }
  }
  return firsts;
}

/** The latest channel's T3 Code version at a commit, or null if versions/t3code.json
 * is missing, not JSON, or has no string version. */
export function latestChannelPin(commit: string): string | null {
  const shown = tryRun("git", ["show", `${commit}:versions/t3code.json`]);
  if (shown.status !== 0) return null;
  try {
    const version = JSON.parse(shown.stdout)?.version;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

/** Pins at a commit: name -> pin. */
function pinsAt(commit: string): Map<string, any> {
  const pins = new Map<string, any>();
  for (const path of git("ls-tree", "--name-only", commit, "versions/").split("\n").filter((f) => f.endsWith(".json"))) {
    try {
      const pin = JSON.parse(git("show", `${commit}:${path}`));
      if (pin?.name) pins.set(pin.name, pin);
    } catch {
      // unreadable at that commit; left out
    }
  }
  return pins;
}

/** What NixOS stable has at that commit (its snapshot): this set, or an
 * earlier one with the packages that differ. Nothing for a commit from
 * before the snapshot existed. No issue link: the release can be made
 * before the issues job runs (the status page has it). */
export function stableNote(commit: string): string[] {
  const tree = git("rev-parse", `${commit}^{tree}`);
  if (!pinsOf(tree).snapshot.size) return [];
  const differ = differing(tree);
  if (!differ.length) return ["NixOS stable (`programs.t3code.nixpkgs = \"stable\"`) has this set.", ""];
  const version = (path: string) => {
    try { return shownVersion(JSON.parse(git("show", `${tree}:${path}`))); } catch { return null; }
  };
  const each = differ.map((n) => {
    const stable = version(`versions/stable/${n}.json`), here = version(`versions/${n}.json`);
    // The same shown version: here has a newer build of it (a browser pin's
    // channel revision, or new details).
    return stable !== null && stable === here ? `${n} ${stable} (here a newer build of it)` : `${n} ${stable ?? "(not yet)"} (here ${here ?? "none"})`;
  });
  return [`NixOS stable (\`programs.t3code.nixpkgs = "stable"\`) is on an earlier set: ${each.join(", ")}.`, ""];
}

/** The desktop app's Electron at that commit: the one the flake's own
 * package runs, from the commit's record (ci/electron-runtime.json), or
 * what git alone says without one; and how to get upstream's. */
export function electronLine(commit: string): string[] {
  const info = electronInfo((path) => {
    const r = tryRun("git", ["show", `${commit}:${path}`]);
    return r.status === 0 ? `${r.stdout}\n` : null;
  }, "t3code");
  if (!info) return [];
  if (!info.recorded) return [`${info.words} (\`electron = "bundled"\` forces it; see the README).`, ""];
  return [`${info.words}; \`electron = "bundled"\` forces upstream's ${info.bundled ?? "bundled Electron"} (see the README).`, ""];
}

/** The body of t3code-v<version>'s release: every package at its commit,
 * how to pin it, and what changed since the previous release. */
export function releaseBody(version: string, commit: string, previous: { version: string; commit: string } | null, repo = REPO): string {
  // T3 Code and the providers by name, then the agent tools in their own
  // group (they aren't part of T3 Code).
  const tool = (p: any) => Object.hasOwn(AGENT_TOOLS, p.name) || Object.hasOwn(BROWSER_PINS, p.name);
  const sorted = [...pinsAt(commit).values()].sort((a, b) => Number(tool(a)) - Number(tool(b)) || a.name.localeCompare(b.name));
  const firstTool = sorted.findIndex(tool);
  let nixpkgs = "";
  try {
    nixpkgs = JSON.parse(git("show", `${commit}:flake.lock`)).nodes?.nixpkgs?.locked?.rev ?? "";
  } catch {
    nixpkgs = "";
  }
  const lines = [
    `T3 Code ${version} with the packages t3code-nix published in [${commit.slice(0, 12)}](https://github.com/${repo}/commit/${commit}).`,
    "",
    `To use exactly this set: \`github:${repo}/t3code-v${version}\`.`,
    "",
    "| Package | Version |",
    "| --- | --- |",
    ...sorted.flatMap((p, i) => [...(i === firstTool ? ["| *Agent tools* | |"] : []), `| ${p.name} | ${shownVersion(p)} |`]),
    ...(nixpkgs ? [`| nixpkgs | ${nixpkgs} |`] : []),
    "",
    ...stableNote(commit),
    ...electronLine(commit),
    previous ? `## Changed since t3code-v${previous.version}` : "## Release notes",
    "",
    `- T3 Code ${version}: [release notes](https://github.com/pingdotgg/t3code/releases/tag/v${version})`,
  ];
  if (previous) {
    const before = pinsAt(previous.commit);
    for (const p of sorted) {
      // T3 Code's notes cover t3; the nightlies aren't latest-channel releases.
      if (["t3code", "t3"].includes(p.name) || p.name.endsWith("-nightly")) continue;
      const was = before.get(p.name);
      if ((was?.version ?? null) === p.version) continue;
      const old = was ? shownVersion(was) : null, now = shownVersion(p);
      const notes = releaseNotes(p);
      const change = old ? `${p.name} ${old} → ${now}` : `${p.name} ${now} (new)`;
      lines.push(notes ? `- ${change}: [release notes](${notes})` : `- ${change}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Releases for the verified tags (version -> commit, in history order):
 * create the missing ones, then put GitHub's Latest marker on the one for
 * `pin`, main's latest-channel version (null: unreadable). Creation stops at the first failure, so
 * releases are made in history order; "latest" is still set from the
 * releases that exist, then that failure is raised. */
async function releases(gh: Client, verified: Map<string, string>, list: Release[], latestMarker: Release | null, pin: string | null,
  log: (m: string) => void) {
  const have = new Map(list.map((r) => [r.tag, r]));
  const versions = [...verified.keys()];
  let failure: unknown = null;
  for (const [i, version] of versions.entries()) {
    const tag = `t3code-v${version}`;
    if (have.has(tag)) continue;
    // The previous release: of the versions published before this one, the
    // highest below it; where those can't be ordered, the one just before it
    // in history. Only earlier ones, so the body doesn't depend on when it
    // was first made (a later rollback to a lower version isn't "previous").
    const earlier = versions.slice(0, i);
    const orderable = earlier.every((v) => compareVersions(v, version) !== null);
    let prev: string | null = orderable ? null : earlier.at(-1) ?? null;
    if (orderable) {
      for (const v of earlier) {
        if (compareVersions(v, version) === -1 && (prev === null || compareVersions(v, prev) === 1)) prev = v;
      }
    }
    const body = releaseBody(version, verified.get(version)!, prev ? { version: prev, commit: verified.get(prev)! } : null);
    try {
      have.set(tag, await gh.createRelease({ tag, target: verified.get(version)!, name: `T3 Code ${version}`, body }));
    } catch (e) {
      // It exists already (made in between): fine once it's really there.
      // Otherwise the creation's error is the one raised.
      let there: Release | null = null;
      try {
        there = await gh.releaseByTag(tag);
      } catch (lookup: any) {
        log(`::warning::couldn't re-read ${tag}'s release: ${lookup?.message ?? lookup}`);
      }
      if (!there) {
        failure = e;
        break;
      }
      have.set(tag, there);
    }
  }

  try {
    await moveLatestMarker(gh, verified, have, latestMarker, pin, log);
  } catch (e: any) {
    if (!failure) throw e;
    log(`::warning::couldn't move GitHub's Latest marker: ${e?.message ?? e}`);
  }
  if (failure) throw failure;
}

/** GitHub's Latest marker goes on the release for main's latest-channel
 * version `pin`: only a published (not prerelease) release of a verified tag
 * can have it. Without one for the pin, the highest such release below it; a
 * version that can't be ordered against the pin is skipped, and two at the
 * top that can't be ordered leave the marker as it is. A marker on a tag
 * that isn't t3code-v* was set by hand and stays. */
async function moveLatestMarker(gh: Client, verified: Map<string, string>, have: Map<string, Release>, latestMarker: Release | null,
  pin: string | null, log: (m: string) => void) {
  if (pin === null) {
    log("::warning::main's versions/t3code.json can't be read; GitHub's Latest marker is left as it is");
    return;
  }
  const eligible = (v: string) => {
    const r = verified.has(v) ? have.get(`t3code-v${v}`) : undefined;
    return r && !r.prerelease ? r : null;
  };
  let target = eligible(pin);
  if (!target) {
    if (have.get(`t3code-v${pin}`)?.prerelease) log(`::warning::t3code-v${pin} is a prerelease, which GitHub can't mark latest`);
    const below = [...verified.keys()].filter((v) => eligible(v) && compareVersions(v, pin) === -1);
    const top = below.filter((v) => !below.some((w) => compareVersions(w, v) === 1));
    if (top.length !== 1) {
      log(top.length > 1
        ? `::warning::no release for ${pin}, and can't tell which of ${top.join(", ")} below it is highest; GitHub's Latest marker is left as it is`
        : `::warning::no release for ${pin} or below it; GitHub's Latest marker is left as it is`);
      return;
    }
    target = eligible(top[0])!;
  }
  if (latestMarker?.tag === target.tag) return;
  if (latestMarker && !latestMarker.tag.startsWith("t3code-v")) {
    log(`::warning::GitHub's Latest marker (on ${latestMarker.tag}) was set by hand; left as it is`);
    return;
  }
  await gh.markLatest(target);
}


/** Repairs, in order; observations go into `observations` as they're made,
 * so a failure later on (a release write, say) loses none of them. */
export async function reconcile(gh: Client, workflowsDir = ".github/workflows", historyRef = "HEAD",
  observations: Observation[] = [], log = console.error): Promise<Observation[]> {
  const tagsRead = early(gh.refs("tags/t3code-v"));
  const candidatesRead = early(gh.refs("heads/bot/candidate/").then((refs) =>
    Object.keys(refs).map((ref) => {
      const run = ref.slice("refs/heads/bot/candidate/".length);
      return { ref, completed: /^\d+$/.test(run) ? early(gh.runCompleted(run)) : null };
    })));
  const scheduled = SCHEDULED.filter(([w]) => existsSync(join(workflowsDir, w)))
    .map(([w, kind]) => ({ w, kind, state: early(gh.workflowState(w)) }));
  const releasesRead = early(gh.releases());
  const latestMarkerRead = early(gh.latestRelease());

  // One commit for the history and main's pin, read from git, not the
  // working tree (the job checks out resolve's older head).
  const head = git("rev-parse", `${historyRef}^{commit}`);
  const tags = await tagsRead();
  let mismatched = false;
  // Tags at their first-publication commit, which get releases.
  const verified = new Map<string, string>();
  for (const [version, sha] of firstPublications(undefined, head)) {
    const ref = `refs/tags/t3code-v${version}`;
    if (!(ref in tags)) {
      await gh.createRef(ref, sha);
      observations.push(obs("tag-created", "t3code", version, sha, "latest"));
      verified.set(version, sha);
      continue;
    }
    if (tags[ref] === sha) {
      verified.set(version, sha);
      continue;
    }
    // An annotated tag's ref points at the tag object; compare commits.
    const peeled = tryRun("git", ["rev-parse", `${tags[ref]}^{commit}`]);
    const target = peeled.status === 0 ? peeled.stdout : tags[ref];
    if (target !== sha) {
      mismatched = true;
      observations.push(obs("tag-mismatch", "t3code", version,
        `t3code-v${version} points at ${target}, but the version was first published in ${sha}; left as it is`, "latest"));
    } else {
      verified.set(version, sha);
    }
  }
  if (!mismatched) observations.push(obs("tag-ok"));

  for (const { ref, completed } of await candidatesRead()) {
    if (completed && (await completed())) await gh.deleteRef(ref);
  }

  for (const { w, kind, state } of scheduled) {
    if ((await state()) !== "disabled_inactivity") continue;
    await gh.enableWorkflow(w);
    observations.push(obs(kind, null, null, `GitHub had disabled ${w} after 60 days without activity`));
  }

  // Last, so a failing release write leaves everything above done.
  await releases(gh, verified, await releasesRead(), await latestMarkerRead(), latestChannelPin(head), log);
  return observations;
}

if (import.meta.main) {
  const gh = client();
  // A failure still writes what was observed, then fails.
  const observations: Observation[] = [];
  let failure: unknown = null;
  try {
    await reconcile(gh, undefined, process.argv[2] ?? "HEAD", observations);
  } catch (e) {
    failure = e;
  }
  console.log(JSON.stringify({ observations, dryRun: gh.actions ?? null }, null, 2));
  if (failure) {
    console.error(`reconcile: ${(failure as any)?.stack ?? failure}`);
    process.exitCode = 1;
  }
}
