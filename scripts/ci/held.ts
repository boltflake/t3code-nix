// Write the versions held by open issues, for the updater (the resolve job).
//
//   node held.ts OUT_JSON [RETEST_JSON]
//
// Reads the repository's t3code-nix issues and writes [{package, version}]
// for every open hold (see HOLD_KINDS in issues.ts), and [{package, since}]
// for every browser pin's open wait (browser-waiting); and to RETEST_JSON,
// the scopes whose agent-browser variants have an open browser-failed issue
// (retested at the next publish, ci/variants.ts). Needs GH_TOKEN with
// issues: read.
import { writeJson } from "../lib/util.ts";
import { GitHub } from "./gh.ts";
import { heldVersions, retestScopes, waitingStarts } from "./issues.ts";

/** Write the open holds and browser waits to `out` (and the retest scopes
 * to `retestOut`, if given); returns what it found. */
export async function writeHeld(out: string, gh: Pick<GitHub, "issues">, retestOut?: string) {
  const issues = await gh.issues();
  const held = heldVersions(issues);
  const waits = waitingStarts(issues);
  writeJson(out, [...held, ...waits]);
  if (retestOut) writeJson(retestOut, retestScopes(issues));
  return { held, waits };
}

if (import.meta.main) {
  const [out, retestOut] = process.argv.slice(2);
  if (!out) {
    console.error("usage: held.ts OUT_JSON [RETEST_JSON]");
    process.exit(2);
  }
  const { held, waits } = await writeHeld(out, new GitHub(), retestOut);
  console.log(`${held.length} held version(s)${held.length ? ": " + held.map((h) => `${h.package} ${h.version}`).join(", ") : ""}`);
  if (waits.length) console.log(`browser waits: ${waits.map((w) => `${w.package} since ${w.since}`).join(", ")}`);
}
