// Branch CI and the update runs' test and final jobs run the default suite
// and NixOS stable in parts, each on a runner of its own, so they wait for
// the slowest part instead of the whole. Which part a check belongs to is
// decided here, once, for test.ts and stable.ts; given no part (the update
// runs' narrowing), they run everything.
//
// - The default suite (test.ts) in three: `desktop` (the T3 Code desktop
//   apps, `t3code*`, and their desktop smokes), `rest1` (the agent-browser
//   checks, `agent-browser*`, and the agent-browser smoke, which needs them
//   built) and `rest2` (also the evaluations without flakes, lazily and of
//   NixOS stable, which build nothing, and agent-browser's optional
//   browsers); every other check goes to rest1 or rest2 by a hash of its
//   name, so adding a check moves no other.
// - NixOS stable (stable.ts) in two: `a` (the checks the runner smokes need,
//   the desktop app and agent-browser, and the smokes themselves; in branch
//   CI also the check that moving the snapshot leaves the default checks
//   alone) and `b` (every other check), for both the stable and the
//   stable-next group (in the update runs, each group a job of its own).
import { createHash } from "node:crypto";

export const TEST_PARTS = ["desktop", "rest1", "rest2"] as const;
export type TestPart = (typeof TEST_PARTS)[number];
export const STABLE_PARTS = ["a", "b"] as const;
export type StablePart = (typeof STABLE_PARTS)[number];

/** 0 or 1, the same for a name every time. */
const half = (name: string) => createHash("sha256").update(name).digest()[0] % 2;

export function testPart(name: string): TestPart {
  if (name.startsWith("t3code")) return "desktop";
  if (name.startsWith("agent-browser")) return "rest1";
  return half(name) === 0 ? "rest1" : "rest2";
}

export function stablePart(name: string): StablePart {
  return /t3code|agent-browser/.test(name) ? "a" : "b";
}

/** The part given on the command line (`--part=NAME`), checked against the
 * script's parts; undefined when none is given (the whole suite). */
export function partArg<P extends string>(argv: string[], parts: readonly P[]): P | undefined {
  const args = argv.filter((a) => a === "--part" || a.startsWith("--part="));
  if (args.length === 0) return undefined;
  if (args.length > 1) throw new Error("--part given more than once");
  const part = args[0].slice("--part=".length) as P;
  if (!parts.includes(part)) throw new Error(`--part must be one of ${parts.join(", ")}, not ${JSON.stringify(part)}`);
  return part;
}
