// guard-review issues' words (scripts/ci/guard-issue.ts), from the guard
// checks' items (lib/checks.nix `item`).
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as guard from "../scripts/ci/guard-issue.ts";

const line = (kind: string, ctx: string, ...names: string[]) => [kind, ctx, ...names].join("\t");
const URL = "https://github.com/o/r/actions/runs/1";

test("guard-issue: a new t3 command, as worded", () => {
  const d = line("t3-command", "", "workflow withdraw");
  assert.equal(guard.title("t3-nightly", d), "t3-nightly: new command not checked yet");
  assert.equal(guard.body("t3-nightly", "0.1.12-nightly.20261125.5230", d, URL), [
    "t3-nightly 0.1.12-nightly.20261125.5230 has a command that t3code-nix hasn't checked:",
    "- `t3 workflow withdraw`",
    "t3code-nix blocks `t3` commands that install or update T3 Code outside Nix. Someone needs to read this command and"
      + " decide whether to block it. This did not hold up the release.",
    "To fix it: read the command in the release's bundle. If it installs or updates T3 Code or its service, block it in"
      + " `refuseT3` in `lib/guard.nix`. Then add it to `t3Commands`"
      + " in the same file, as `\"workflow withdraw\"`.",
    "This issue closes when the bot next publishes an update and t3-nightly has no unchecked commands.",
    `Found by [this run](${URL}).`,
  ].join("\n\n"));
  assert.equal(guard.reopened("t3-nightly", "5230", d), "Reopened: t3-nightly 5230 has a command that t3code-nix hasn't checked: `t3 workflow withdraw`");
  assert.equal(guard.reopenedSame("t3-nightly", "5230", d), "Reopened: still not checked in t3-nightly 5230: `t3 workflow withdraw`");
  assert.equal(guard.reminder("t3-nightly", "5230", d), "Still not checked: `t3 workflow withdraw`");
  assert.equal(guard.closed("t3-nightly", "5231"), "Closed: everything in t3-nightly 5231 has been checked.");
});

test("guard-issue: several commands, and several kinds", () => {
  const two = line("t3-command", "", "workflow withdraw", "feedback");
  assert.equal(guard.title("t3", two), "t3: new commands not checked yet");
  const b = guard.body("t3", "1", two, "");
  assert.match(b, /^t3 1 has 2 commands that t3code-nix hasn't checked:\n\n- `t3 feedback`\n- `t3 workflow withdraw`\n/);
  assert.match(b, /decide whether to block each one\. This did not hold up the release\./);
  assert.match(b, /Then add each one to `t3Commands` in the same file, as `"feedback"`, `"workflow withdraw"`\./);
  assert.ok(!b.includes("Found by"), "no run, no link");
  // Two kinds: each in full, a rule between, the release line once.
  const mixed = `${line("codex-value-option", "", "--x")}\n${line("codex-short-flag", "", "q")}\n${line("codex-short-flag", "", "r")}`;
  assert.equal(guard.title("codex", mixed), "codex: 2 things to check");
  const m = guard.body("codex", "0.172.0", mixed, URL);
  assert.equal(m.split("\n\n---\n\n").length, 2);
  assert.equal(m.split("This did not hold up the release.").length, 2);
  assert.match(m, /has 2 short flags that the guard doesn't know:\n\n- `-q`\n- `-r`/, "items of one kind merge");
  assert.match(m, /This did not hold up the release\.\n\nThis issue closes when the bot next publishes an update and codex has nothing left to check\.\n\nFound by/);
});

test("guard-issue: every kind reads as a whole text", () => {
  const cases: [string, string, string[], RegExp][] = [
    ["t3-command", "", ["up"], /- `t3 up`.*`refuseT3`.*as `"up"`\./s],
    ["t3-value-option", "", ["--profile"], /like `t3 --log-level info update`.*take `t3 --profile work update` to be a command called `work`.*add `"--profile"` to `t3ValueFlags`/s],
    ["t3-flag-option", "", ["--json"], /take `t3 --json update` to be `--json` with the value `update`.*leave this open until both channels agree/s],
    ["t3-boolean-word", "", ["on"], /accepts a word as the value of a yes\/no option.*`t3 --lan on up`.*`t3BooleanWords`/s],
    ["codex-commands", "", ["+cloud-sync", "-proto"], /- new: `codex cloud-sync`\n- gone: `codex proto`.*`codexRefused`.*add the new ones and remove the gone ones\./s],
    ["codex-hidden-gone", "", ["debug-x"], /`codex debug-x --help` no longer works, so the command looks gone\. Its help never listed.*`codex debug-x update` gets `codex update` past it.*take `"debug-x"` out of `codexHiddenCommands`/s],
    ["codex-level-new", "app-server daemon", ["logs"], /under `codex app-server daemon` that.*- `codex app-server daemon logs`.*`codexInstallers` under `"app-server daemon"`/s],
    ["codex-app-server", "", ["+d"], /- new: `codex app-server d`.*another name for `daemon`/s],
    ["codex-level-arguments", "app-server daemon", [], /`codex app-server daemon` takes arguments of its own\..*after `daemon`/s],
    ["codex-value-option", "", ["--sandbox-dir"], /like `codex --model gpt-5 update`.*take `codex --sandbox-dir exec update` to be `codex exec` with the prompt `update`.*`codexValueOptions`/s],
    ["codex-flag-option", "", ["--oss"], /no longer takes a separate value, but the guard still skips the word after it.*take `"--oss"` out of `codexValueOptions` in `lib\/guard\.nix`\.\n/s],
    ["codex-multi-options", "", ["+--attach"], /several values, like `-i a\.png b\.png`, don't match the guard's list:\n\n- new: `--attach`/],
    ["codex-unskippable", "", ["--pair"], /a form the guard can't skip.*- `--pair`.*teach `refuseCodex`/s],
    ["codex-short-flag", "", ["q"], /asking a blocked command for help as `-qh` gets the "installed by Nix" message instead of the help.*add `"q"` to `codexShortFlags`/s],
    ["codex-short-value", "", ["y"], /`-y` takes a value, but the guard still treats it as a plain flag\..*a blocked command with `-yh` after it would get through/s],
    ["provider-command", "claude", ["sync"], /- `claude sync`\n\nt3code-nix blocks commands that make claude update or reinstall itself.*add it to `providerRefused\."claude-code"` in `lib\/guard\.nix`\. Then add it to `providerCommands\."claude-code"` in `lib\/guard\.nix`, as `"sync"`\./s],
    ["provider-command-own", "pi", ["sync"], /- `pi sync`.*block it in pi's package: pi has no `providerRefused\."pi"` list.*`providerCommands\."pi"`/s],
    ["unreadable", "codex-guard-flags", [], /couldn't read codex 1's help.*This did not hold up the release\.\n\nTo fix it: the `codex-guard-flags` log in the run below says why/s],
  ];
  for (const k of guard.KNOWN) assert.ok(cases.some(([c]) => c === k), `a case for ${k}`);
  for (const [kind, ctx, names, want] of cases) {
    const pkg = kind === "provider-command" ? "claude-code" : kind === "provider-command-own" ? "pi" : kind.startsWith("t3") ? "t3" : "codex";
    const b = guard.body(pkg, "1", line(kind, ctx, ...names), URL);
    assert.match(b, want, kind);
    assert.match(b, /This did not hold up the release\./, kind);
    assert.ok(!/undefined|\$\{/.test(b + guard.title(pkg, line(kind, ctx, ...names))), kind);
    assert.doesNotMatch(guard.title(pkg, line(kind, ctx, ...names)), /things to check|something/, kind);
  }
});

test("guard-issue: upstream's names stay in code, and other lines are shown as they are", () => {
  const b = guard.body("t3", "1", line("t3-command", "", "x`@someone <b>"), "");
  assert.match(b, /- `` t3 x`@someone <b> ``/);
  assert.ok(!/(^|[^`])@someone/.test(b.replace(/``.*?``|`[^`]*`/g, "")), "no bare mention");
  // A version with Markdown in it is in code too.
  assert.match(guard.body("t3", "1*2*", line("t3-command", "", "up"), ""), /^t3 ` 1\*2\* ` has/);
  // An older check's free text: shown in code, never dropped.
  assert.equal(guard.title("t3", "new command: up"), "t3: something to check");
  assert.match(guard.body("t3", "1", "new command: up", ""), /The guard check noted:\n\n- `new command: up`/);
});

test("guard-issue: names that would break the text or the fix", () => {
  // A carriage return can't end the code span.
  const cr = guard.body("t3", "1", line("t3-command", "", "a\r\r@someone"), "");
  assert.match(cr, /- ` t3 a @someone `\n/);
  // A name for Nix is a Nix string.
  assert.match(guard.body("t3", "1", line("t3-command", "", 'a"b\\${c}'), ""), /as `"a\\"b\\\\\\\$\{c\}"`\./);
  // A kind named like an Object property is no kind.
  assert.equal(guard.title("t3", line("constructor", "", "x")), "t3: something to check");
  // A version with emphasis in it is in code.
  assert.match(guard.body("t3", "_1_", line("t3-command", "", "up"), ""), /^t3 ` _1_ ` has/);
});

test("guard-issue: a new `t3 connect` subcommand goes in connect's lists", () => {
  const b = guard.body("t3", "1", line("t3-command", "", "connect login"), "");
  assert.match(b, /The guard blocks a `t3 connect` subcommand it doesn't know, so until then that one is blocked\. Add `"login"` to `t3ConnectSubcommands` in `lib\/guard\.nix` if it's safe, or to `t3ConnectRefused`/);
  assert.doesNotMatch(b, /`t3Commands`/);
  // With another command: each goes where it belongs.
  const both = guard.body("t3", "1", line("t3-command", "", "connect login", "workflow withdraw"), "");
  assert.match(both, /add it to `t3Commands` in the same file, as `"workflow withdraw"`\./);
  assert.match(both, /Add `"login"` to `t3ConnectSubcommands`/);
  // Deeper under connect: an ordinary command.
  assert.match(guard.body("t3", "1", line("t3-command", "", "connect login token"), ""), /as `"connect login token"`\./);
});

test("guard-issue: a long detail is cut between items, never through a name", () => {
  const long = [line("t3-command", "", ...Array.from({ length: 40 }, (_, i) => `command-${i}`)), line("unreadable", "t3-guard-flags")].join("\n");
  for (const max of [5, 20, 23, 300, 301, 302, long.length - 1]) {
    const clipped = guard.clip(long, max);
    assert.ok(clipped.length <= max, `${max}`);
    assert.ok(clipped.endsWith("cut\t"), `${max}: says it was cut`);
    const cut = clipped.replace(/\n?cut\t$/, "");
    for (const b of guard.parse(cut)) for (const n of b.names) assert.match(n, /^command-\d+$/);
    assert.ok(long.startsWith(cut), `${max}: a prefix`);
    const names = guard.parse(cut).flatMap((b) => b.names);
    assert.ok(names.every((n) => long.includes(`\t${n}\t`) || long.includes(`\t${n}\n`)), `${max}: whole names`);
  }
  assert.equal(guard.clip(long, long.length), long);
  // Cut right after a kind: no "0 commands", and never a stray kind name.
  assert.deepEqual(guard.parse("t3-command\t"), []);
  assert.equal(guard.clip(line("t3-command", "", "a-very-long-name"), 15), "cut\t");
  assert.equal(guard.clip(line("t3-command", "", "a-very-long-name"), 3), "");
  // Free text from an older check is cut as text, not lost.
  assert.equal(guard.clip("x".repeat(50), 10), `${"x".repeat(5)}\ncut\t`);
  // The same items, however they're grouped, keep the same ones.
  const names = Array.from({ length: 100 }, (_, i) => `c${String(i).padStart(3, "0")}`);
  const one = guard.clip(guard.canonical(line("t3-command", "", ...names)), 300);
  const many = guard.clip(guard.canonical(names.map((n) => line("t3-command", "", n)).join("\n")), 300);
  assert.equal(one, many);
});

test("guard-issue: a context that isn't ours, an empty detail, a cut list", () => {
  // A program name with Markdown in it: the line is shown in code.
  const evil = guard.body("x", "1", line("provider-command", "@octocat [x](http://e) <img src=x>", "sync"), "");
  assert.doesNotMatch(evil.replace(/``.*?``|`[^`]*`/g, ""), /@octocat|<img|\]\(/);
  // Nothing to show is never "0 things to check".
  assert.equal(guard.title("t3", ""), "t3: something to check");
  assert.match(guard.body("t3", "1", "", ""), /The guard check noted:\n\n- `\(no detail\)`/);
  // A cut list says so, and the cut survives the canonical form.
  const long = line("t3-command", "", ...Array.from({ length: 400 }, (_, i) => `command-${i}`)) + "\n" + line("unreadable", "t3-guard-flags");
  const cut = guard.clip(guard.canonical(long), 2000);
  assert.ok(cut.length <= 2000);
  assert.equal(guard.canonical(cut), cut);
  assert.match(guard.body("t3", "1", cut, "u"), /This list was cut short; the check's log in the run below has the rest\./);
  assert.doesNotMatch(guard.body("t3", "1", line("t3-command", "", "a"), "u"), /cut short/);
  assert.ok(![...guard.items(cut)].some((i) => i.startsWith("cut")));
  // Comments name list-less kinds by their title, and each name once.
  assert.equal(guard.reminder("t3", "1", `${line("unreadable", "t3-guard-flags")}\n${line("t3-value-option", "", "-m")}\n${line("t3-value-option", "", "-m")}`),
    "Still not checked: guard check couldn't run, `-m`");
});

test("guard-issue: comments name what the head holds, and a cut-only detail", () => {
  assert.equal(guard.reminder("codex", "1", line("codex-hidden-gone", "", "debug-x")), "Still not checked: `codex debug-x`");
  assert.equal(guard.reopenedSame("codex", "1", line("codex-short-value", "", "y")), "Reopened: still not checked in codex 1: `-y`");
  // Nothing but the cut: not shown as a finding called "cut".
  assert.match(guard.body("t3", "1", "cut\t", ""), /- `\(too long to show here\)`[\s\S]*This list was cut short/);
  // A line that starts like an item but isn't one (its context isn't ours)
  // is left out when it doesn't fit, so no cut of it reads as an item.
  assert.equal(guard.clip(`provider-command\tbad_ctx\t${"n".repeat(2100)}`, 2000), "cut\t");
  // Nor can a cut of such a line read as an item.
  assert.equal(guard.clip(`unreadable\tcodex-guard-flags ${"!x".repeat(40)}`, 34), "cut\t");
  // A program name with emphasis in it isn't ours.
  assert.equal(guard.title("x", line("provider-command", "_tool_", "a")), "x: something to check");
});

test("guard-issue: items tell a new name from one seen before", () => {
  const before = guard.items(line("t3-command", "", "a", "b"));
  assert.ok([...guard.items(line("t3-command", "", "b"))].every((i) => before.has(i)));
  assert.ok(![...guard.items(line("t3-command", "", "c"))].every((i) => before.has(i)));
  assert.deepEqual([...guard.items(line("unreadable", "t3-guard-flags"))], ["unreadable\tt3-guard-flags"]);
});

test("guard-issue: lib/checks.nix notes only kinds that have a text", () => {
  const nix = readFileSync(join(import.meta.dirname, "..", "lib", "checks.nix"), "utf8")
    .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const used = new Set([...nix.matchAll(/\bitem (?:\$\{[^}]+\}|\S+) ("?)([a-z0-9-]+)\1(?=\s)/g)].map((m) => m[2]));
  for (const m of nix.matchAll(/\$\{(?:reviewed|takesValue "help\.txt") pkg "([a-z0-9-]+)"/g)) used.add(m[1]);
  for (const m of nix.matchAll(/differ ([a-z0-9-]+) want/g)) used.add(m[1]);
  for (const m of nix.matchAll(/providerRefused \? \$\{pkg\} then "([a-z0-9-]+)" else "([a-z0-9-]+)"/g)) { used.add(m[1]); used.add(m[2]); }
  used.delete("k"); // the self-test's
  assert.ok(used.size >= 15, `found ${[...used]}`);
  for (const k of used) assert.ok(guard.KNOWN.includes(k), `${k} has no text in guard-issue.ts`);
  for (const k of guard.KNOWN) assert.ok(used.has(k), `${k} is never noted`);
});
