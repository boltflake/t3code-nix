// Publish a tested candidate to main (the publish job).
//
//   node publish.ts CANDIDATE_DIR FINAL_NAMES EXPECTED_TREE [MOVE_JSON] [--electron=CHANNELS]
//
// --electron: the Electron fallback channels decide chose for this final
// (candidate.ts generates ci/electron-fallback.json from the tree for them,
// exactly as the final job did).
//
// Runs in a checkout of the candidate's base, with push credentials.
// Environment: RUN_ID, RUN_URL, ATTEMPT, DRY_RUN.
//
// 1. Build the tree of the base plus exactly the final inputs and check it is
//    the tree the tests ran on (EXPECTED_TREE); commit that tree on the base.
//    With MOVE_JSON (narrow.ts verdict's `move`: {behind, tree, reason}), the
//    NixOS-stable snapshot moves: the commit's tree is the tested tree with
//    versions/stable/ replaced by its pins, but only when that tree's hash is
//    the one the tests recorded (else the tested tree, snapshot untouched).
//    It reports both hashes and whether the snapshot moved, and
//    `stable-current` when the published snapshot equals the published pins,
//    else the `stable-behind` problem (the packages that differ, the
//    snapshot's versions of them, and why it didn't move).
// 2. Push it to refs/heads/bot/candidate/<run> and post the `tested` status.
// 3. Push the same commit to main, without force, in one atomic push with the
//    tag t3code-v<version> if t3code on the latest channel moved to a new version
//    (not a details-only or same-version change: that version's tag belongs
//    on the commit that first published it, which reconcile tags) and that
//    tag doesn't exist yet. An existing tag is never moved.
//
// Only a run on main publishes (GITHUB_REF): a real run dispatched on a
// branch would fast-forward main over the branch's untested commits. The
// gate stops such a run before any job; this is the last line.
// 4. Delete the candidate ref, and start pages.yml (the status page).
//
// A rejected push: fetch main. If main moved, re-dispatch the workflow
// (attempt + 1, at most 3 in a row); the new run tests against the new main,
// and a tested candidate is never rebased. If main didn't move, the rejection
// is a real failure (the ruleset, the token): exit 1.
//
// Prints {observations, dryRun}. With DRY_RUN=true nothing is pushed or
// posted; the steps are recorded instead.
import { Failed, git, shownVersion, tryRun } from "../lib/util.ts";
import { differing, moved, SNAPSHOT } from "../lib/snapshot.ts";
import { obs, type Observation } from "../update.ts";
import { load, tree, type Input } from "./candidate.ts";
import { client, type Client } from "./gh.ts";
import { parseChannels, type Channel } from "../lib/electron-fallback.ts";

export const MAX_ATTEMPTS = 3;
const BOT = ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"];

export function latestChannelTag(inputs: Input[], final: string[]): string | null {
  const t = inputs.find((i) => i.name === "t3code" && final.includes(i.name) && i.to && i.to !== i.from);
  return t ? `t3code-v${t.to}` : null;
}

export const commitMessage = (inputs: Input[], final: string[]) =>
  "Update " + inputs.filter((i) => final.includes(i.name)).map((i) => `${i.name} ${i.from ?? "new"} -> ${i.to}`).join(", ");

export interface Move { behind: boolean; tree: string | null; reason: string }
export interface Trees { tested: string; published: string; moved: boolean }

/** The tree to publish: the tested tree, or with the snapshot moved when the
 * tests recorded that exact tree; and what that says about the snapshot. */
export function snapshotOf(tested: string, move: Move | null): { trees: Trees; observation: Observation } {
  let published = tested, why = move?.reason || "";
  if (move?.tree) {
    const m = moved(tested);
    if (m === move.tree) published = m;
    else why = `the moved tree ${m} isn't the tested one ${move.tree}`;
  }
  const differ = differing(published);
  if (!differ.length) return { trees: { tested, published, moved: published !== tested }, observation: obs("stable-current", null, null, "") };
  const was = (n: string) => {
    const r = tryRun("git", ["show", `${published}:${SNAPSHOT}/${n}.json`]);
    if (r.status !== 0) return `${n}: not in the snapshot`;
    try { return `${n}: ${shownVersion(JSON.parse(r.stdout))}`; } catch { return `${n}: unreadable`; }
  };
  const detail = `${differ.map(was).join("\n")}\n\nwhy: ${why || "no move was proposed"}`;
  return { trees: { tested, published, moved: published !== tested }, observation: obs("stable-behind", null, null, detail) };
}

export async function publish(dir: string, final: string[], expectedTree: string, gh: Client,
  env: NodeJS.ProcessEnv, remote = "origin", move: Move | null = null, out: { trees?: Trees } = {},
  electron: Channel[] = []): Promise<Observation[]> {
  const c = load(dir);
  const dry = env.DRY_RUN === "true";
  const runId = env.RUN_ID ?? "local";
  const attempt = Number(env.ATTEMPT || 0);

  if (!dry && env.GITHUB_REF && env.GITHUB_REF !== "refs/heads/main") throw new Failed(`a real run publishes only from main, not ${env.GITHUB_REF}`);
  if (git("rev-parse", "HEAD") !== c.base) throw new Failed(`checkout is not the candidate's base ${c.base}`);
  const t = tree(dir, final.join(","), electron);
  if (t !== expectedTree) throw new Failed(`tree ${t} is not the tested tree ${expectedTree}`);
  const snap = snapshotOf(t, move);
  out.trees = snap.trees;
  const message = commitMessage(c.inputs, final) + (snap.trees.moved ? "\n\nNixOS stable: the snapshot moves to these pins." : "");
  const sha = git(...BOT, "commit-tree", snap.trees.published, "-p", c.base, "-m", message);

  let tag = latestChannelTag(c.inputs, final);
  if (tag && git("ls-remote", "--tags", remote, `refs/tags/${tag}`)) tag = null; // published before: never moved
  const candidateRef = `refs/heads/bot/candidate/${runId}`;

  if (dry) {
    await gh.createRef(candidateRef, sha);
    await gh.createStatus(sha, "success", "full suite passed on every system", env.RUN_URL ?? "");
    await gh.createRef("refs/heads/main", sha);
    if (tag) await gh.createRef(`refs/tags/${tag}`, sha);
    await gh.deleteRef(candidateRef);
    await gh.dispatch("pages.yml", "main", {});
    return [snap.observation];
  }

  // This run's own ref: forced, so a re-run of a killed publish job replaces
  // the commit its first attempt left there.
  git("push", "-q", remote, `+${sha}:${candidateRef}`);
  let result;
  try {
    await gh.createStatus(sha, "success", "full suite passed on every system", env.RUN_URL ?? "");
    const push = ["push", "--atomic", remote, `${sha}:refs/heads/main`];
    if (tag) {
      git(...BOT, "tag", "-a", tag, "-m", `T3 Code ${tag.replace(/^t3code-v/, "")}`, sha);
      push.push(`refs/tags/${tag}`);
    }
    result = tryRun("git", push);
  } finally {
    // Ours to remove, whatever happened; if this fails, reconcile removes it
    // once this run has finished.
    const del = tryRun("git", ["push", "-q", remote, "--delete", candidateRef]);
    if (del.status !== 0) console.warn(`publish: couldn't delete ${candidateRef}: ${del.stderr}`);
  }
  if (result.status === 0) {
    // The status page (pages.yml) rebuilds from the new main; best effort,
    // since its hourly run would catch up anyway.
    try {
      await gh.dispatch("pages.yml", "main", {});
    } catch (e: any) {
      console.warn(`publish: couldn't start pages.yml: ${e?.message ?? e}`);
    }
    return [obs("published", null, sha, message), snap.observation];
  }

  git("fetch", "-q", remote, "main");
  if (git("rev-parse", "FETCH_HEAD") === c.base) throw new Failed(`push rejected although main didn't move:\n${result.stderr}`);
  if (attempt + 1 >= MAX_ATTEMPTS) {
    return [obs("update-failed", null, null, `main kept moving during ${MAX_ATTEMPTS} runs in a row; giving up until the next trigger`)];
  }
  await gh.dispatch("update.yml", "main", { attempt: String(attempt + 1) });
  return [obs("redispatched", null, null, `main moved during the run; attempt ${attempt + 1}`)];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [dir, names, expected, moveJson] = args.filter((a) => !a.startsWith("--electron="));
  const electron = parseChannels(args.find((a) => a.startsWith("--electron="))?.slice(11));
  if (!dir || names === undefined || !expected) {
    console.error("usage: publish.ts CANDIDATE_DIR FINAL_NAMES EXPECTED_TREE [MOVE_JSON] [--electron=CHANNELS]");
    process.exit(2);
  }
  const gh = client();
  const out: { trees?: Trees } = {};
  const move = moveJson ? (JSON.parse(moveJson) as Move | null) : null;
  const observations = await publish(dir, names.split(",").filter(Boolean), expected, gh, process.env, "origin", move, out, electron);
  console.log(JSON.stringify({ observations, trees: out.trees ?? null, dryRun: gh.actions ?? null }, null, 2));
}
