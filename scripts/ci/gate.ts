// Is this run's workflow definition still current? (the gate job)
//
//   node gate.ts WORKFLOW_SHA REF_HEAD
//
// A run that waited in the queue while someone changed the workflow or its
// scripts must not run an old job graph with new scripts. If .github/ or
// scripts/ differ between the commit the workflow definition came from
// (github.workflow_sha) and the ref's current head, re-dispatch the workflow
// on that ref; the run then ends as a success with every later job skipped.
//
// Prints `current=true|false` (for $GITHUB_OUTPUT). Environment: DRY_RUN,
// ATTEMPT (passed on), GITHUB_REF_NAME, RUNNER_TEMP.
import { join } from "node:path";
import { tryRun, writeJson } from "../lib/util.ts";
import { client } from "./gh.ts";

export function current(workflowSha: string, head: string): boolean {
  if (workflowSha === head) return true;
  return tryRun("git", ["diff", "--quiet", workflowSha, head, "--", ".github", "scripts"]).status === 0;
}

if (import.meta.main) {
  const [workflowSha, head] = process.argv.slice(2);
  if (!workflowSha || !head) {
    console.error("usage: gate.ts WORKFLOW_SHA REF_HEAD");
    process.exit(2);
  }
  if (current(workflowSha, head)) {
    console.log("current=true");
  } else {
    const gh = client();
    await gh.dispatch("update.yml", process.env.GITHUB_REF_NAME ?? "main", {
      attempt: process.env.ATTEMPT ?? "0",
      dry_run: process.env.DRY_RUN ?? "false",
    });
    console.log("current=false");
    if (gh.actions) writeJson(join(process.env.RUNNER_TEMP ?? ".", "dry-run-gate.json"), gh.actions);
  }
}
