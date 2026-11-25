// The text of guard-review issues and their comments, from the guard checks'
// items (lib/checks.nix `item`): one line each, `KIND<TAB>CONTEXT<TAB>NAME...`,
// the names from upstream's help (in code wherever they're shown).
//
// Every kind says what changed, what the guard does, what could go wrong,
// and how to fix it. A line of another shape (an older check's free text)
// is shown as it is, in code.
import { code, plain } from "./markdown.ts";

export interface Block {
  kind: string;
  /** A codex level (`app-server daemon`), a provider's program, or the
   * check whose log to read. */
  ctx: string;
  names: string[];
}

// Kinds that list no names; any other kind without names is a cut-off line.
const BARE = new Set(["unreadable", "codex-level-arguments"]);
/** The line `clip` adds when it left items out. */
const CUT = "cut\t";
/** A context is ours (a codex level, a program, a check's name), never
 * upstream's text, so it's shown as it is: a line whose context isn't one
 * of these is shown as other lines are, in code. */
const CONTEXT = /^[A-Za-z0-9 .-]*$/;

/** Whether a line is an item (else it's shown as text). */
const isItem = (line: string, kind: string, ctx: string) => Object.hasOwn(KINDS, kind) && line.includes("\t") && CONTEXT.test(ctx);

/** The items in a detail, one block per kind and context, names sorted. */
export function parse(detail: string): Block[] {
  const blocks = new Map<string, Block>();
  for (const line of detail.split("\n")) {
    if (!line.trim() || line === CUT) continue;
    const [kind, ctx = "", ...names] = line.split("\t");
    const known = isItem(line, kind, ctx);
    const key = known ? `${kind}\t${ctx}` : `\t${line}`;
    if (!blocks.has(key)) blocks.set(key, known ? { kind, ctx, names: [] } : { kind: "", ctx: line, names: [] });
    const b = blocks.get(key)!;
    for (const n of names) if (n && !b.names.includes(n)) b.names.push(n);
  }
  for (const b of blocks.values()) b.names.sort();
  return [...blocks.values()].filter((b) => !b.kind || b.names.length || BARE.has(b.kind));
}

/** A detail in one form whatever its lines (one per system, or joined):
 * a line per kind and context, names sorted, so the same items cut the
 * same way. */
export const canonical = (detail: string) => [...parse(detail)
  .map((b) => (b.kind ? [b.kind, b.ctx, ...b.names].join("\t") : b.ctx)), ...(cutShort(detail) ? [CUT] : [])].join("\n");

/** Whether `clip` left items out of a detail. */
export const cutShort = (detail: string) => detail.split("\n").includes(CUT);

/** A detail cut to at most `max` characters between whole items: a line
 * keeps its kind and context and as many names as fit (a cut name would
 * read as a real one), and a line of another shape is cut as text. */
export function clip(detail: string, max: number): string {
  if (detail.length <= max) return detail;
  // Room for the line that says it was cut.
  max -= CUT.length + 1;
  let out = "";
  for (const line of detail.split("\n")) {
    const join = (more: string) => (out ? `${out}\n${more}` : more);
    if (join(line).length <= max) { out = join(line); continue; }
    const [kind, ctx = "", ...names] = line.split("\t");
    if (isItem(line, kind, ctx)) {
      let kept = `${kind}\t${ctx}`;
      let any = false;
      for (const n of names) {
        if (join(`${kept}\t${n}`).length > max) break;
        kept = `${kept}\t${n}`;
        any = true;
      }
      if (any) out = join(kept);
    } else if (max - join("").length > 0 && !(Object.hasOwn(KINDS, kind) && line.includes("\t"))) {
      // Text is cut as text; a line that starts like an item but isn't one
      // is left out, so no cut of it can read as an item.
      out = join(line).slice(0, max);
    }
    break;
  }
  return out ? `${out}\n${CUT}` : max >= 0 ? CUT : "";
}

/** Each item as one string, for telling a new item from one seen before. */
export const items = (detail: string) => new Set(parse(detail).flatMap((b) =>
  b.names.length ? b.names.map((n) => `${b.kind}\t${b.ctx}\t${n}`) : [`${b.kind}\t${b.ctx}`]));

interface Text {
  title: string;
  /** What changed; ends with a colon when the list follows. */
  head: string;
  /** The names as shown, one per bullet (none: no list). */
  list: string[];
  /** The names for a comment, when the head holds them instead of a list. */
  names?: string[];
  /** What the guard does and what could go wrong. */
  why: string;
  fix: string;
}
interface Kind {
  (b: Block, at: string, pkg: string): Text;
}

/** Names as Nix strings, to paste into lib/guard.nix. */
const quoted = (names: string[]) => names.map((n) => code(`"${n.replace(/[\\"]/g, "\\$&").replace(/\$\{/g, "\\${")}"`)).join(", ");
const s = (n: number, one: string, many: string) => (n === 1 ? one : many);
const T3 = "t3code-nix blocks `t3` commands that install or update T3 Code outside Nix.";
const CODEX = "t3code-nix blocks `codex` commands that install or update codex outside Nix: `codex update`, and the"
  + " installers under `codex app-server daemon` and `codex remote-control`.";
/** Added (`+name`) and removed (`-name`) names, as a list. */
const changes = (b: Block, prefix: string) => [
  ...b.names.filter((n) => n.startsWith("+")).map((n) => `new: ${code(prefix + n.slice(1))}`),
  ...b.names.filter((n) => n.startsWith("-")).map((n) => `gone: ${code(prefix + n.slice(1))}`),
];
const added = (b: Block) => b.names.some((n) => n.startsWith("+"));

// t3's and codex's value options, and those that no longer take a separate one.
// `known`: an option the tool has always had, with a value, for the example;
// `risk`: what the guard would do with a line that has the new option `x`.
const valueOption = (tool: string, known: string, list: string, guard: string, risk: (x: string) => string): Kind => (b, at) => {
  const n = b.names.length, x = b.names[0];
  return {
    title: s(n, "new option not checked yet", "new options not checked yet"),
    head: `${at} has ${s(n, "an option that takes a value, and the guard doesn't know it yet:",
      `${n} options that take a value, and the guard doesn't know them yet:`)}`,
    list: b.names.map(code),
    why: `${guard} To find the command in a line like ${code(`${tool} ${known} update`)}, the guard skips each option`
      + ` and its value. Until it knows ${code(x)}, ${risk(x)}`,
    fix: `To fix it: add ${quoted(b.names)} to ${code(list)} in \`lib/guard.nix\`.`,
  };
};
const flagOption = (tool: string, list: string, guard: string, channels: boolean): Kind => (b, at) => {
  const n = b.names.length, x = b.names[0];
  return {
    title: s(n, "option no longer takes a value", "options no longer take a value"),
    head: `In ${at}, ${s(n, "this option no longer takes a separate value, but the guard still skips the word after it:",
      `these ${n} options no longer take a separate value, but the guard still skips the word after them:`)}`,
    list: b.names.map(code),
    why: `${guard} The guard would take ${code(`${tool} ${x} update`)} to be ${code(x)} with the value \`update\`, and let`
      + " `update` through.",
    fix: `To fix it: take ${quoted(b.names)} out of ${code(list)} in \`lib/guard.nix\`.`
      + (channels ? ` If the other t3 channel still takes a value for ${s(n, "it", "them")}, leave this open until both channels agree.` : ""),
  };
};

// The other providers' new commands. `listed`: the provider's refused
// commands are its providerRefused entry (lib/guard.nix), as for all but pi
// (its own guard) and muse (none yet). A command in providerCommands lets
// the line after it through, so a refused one goes in both.
const provider = (b: Block, at: string, pkg: string, listed: boolean): Text => {
  const n = b.names.length, bin = b.ctx;
  return {
    title: s(n, "new command not checked yet", "new commands not checked yet"),
    head: `${at} has ${s(n, "a command", `${n} commands`)} that t3code-nix hasn't checked:`,
    list: b.names.map((c) => code(`${bin} ${c}`)),
    why: `t3code-nix blocks commands that make ${bin} update or reinstall itself outside Nix. Someone needs to read`
      + ` ${s(n, "this command and decide whether to block it.", "these commands and decide whether to block each one.")}`,
    fix: `To fix it: read what ${s(n, "the command does", "each command does")}. If ${s(n, "it", "one")} installs or updates ${bin}, `
      + (listed
        ? `add it to ${code(`providerRefused."${pkg}"`)} in \`lib/guard.nix\`.`
        : `block it in ${pkg}'s package: ${pkg} has no ${code(`providerRefused."${pkg}"`)} list in \`lib/guard.nix\`.`)
      + ` Then add ${s(n, "it", "each one")} to ${code(`providerCommands."${pkg}"`)} in \`lib/guard.nix\`, as ${quoted(b.names)}.`,
  };
};

const KINDS: Record<string, Kind> = {
  "t3-command": (b, at) => {
    const n = b.names.length;
    // `connect`'s own subcommands are listed apart (lib/guard.nix).
    const connect = b.names.filter((c) => /^connect [^ ]+$/.test(c)).map((c) => c.slice("connect ".length));
    const rest = b.names.filter((c) => !/^connect [^ ]+$/.test(c));
    return {
      title: s(n, "new command not checked yet", "new commands not checked yet"),
      head: `${at} has ${s(n, "a command", `${n} commands`)} that t3code-nix hasn't checked:`,
      list: b.names.map((c) => code(`t3 ${c}`)),
      why: `${T3} Someone needs to read ${s(n, "this command and decide whether to block it.",
        "these commands and decide whether to block each one.")}`,
      fix: [`To fix it: read ${s(n, "the command", "each command")} in the release's bundle.`,
        rest.length ? `If ${s(n, "it", "one")} installs or updates T3 Code or its service, block it in \`refuseT3\` in`
          + ` \`lib/guard.nix\`. Then add ${s(rest.length, "it", "each one")} to \`t3Commands\` in the same file, as ${quoted(rest)}.` : "",
        // t3ConnectSubcommands and t3ConnectRefused make up t3Commands'
        // `connect` ones; refuseT3 blocks any other `connect` subcommand.
        connect.length ? `The guard blocks a \`t3 connect\` subcommand it doesn't know, so until then ${s(connect.length,
          "that one is", "those are")} blocked. Add ${quoted(connect)} to \`t3ConnectSubcommands\` in \`lib/guard.nix\` if`
          + ` ${s(connect.length, "it's", "they're")} safe, or to \`t3ConnectRefused\` if ${s(connect.length, "it installs", "one installs")}`
          + " or updates T3 Code or its service." : "",
      ].filter(Boolean).join(" "),
    };
  },
  "t3-value-option": valueOption("t3", "--log-level info", "t3ValueFlags", T3, (x) =>
    `it would take ${code(`t3 ${x} work update`)} to be a command called \`work\`, and could let \`update\` through.`),
  "t3-flag-option": flagOption("t3", "t3ValueFlags", T3, true),
  "t3-boolean-word": (b, at) => {
    const n = b.names.length, w = b.names[0];
    return {
      title: s(n, "new yes/no word not checked yet", "new yes/no words not checked yet"),
      head: `${at} accepts ${s(n, "a word", `${n} words`)} as the value of a yes/no option, and the guard doesn't`
        + ` know ${s(n, "it", "them")} yet:`,
      list: b.names.map(code),
      why: `${T3} The guard skips these words after an option, as in \`t3 --lan true up\`. Until it knows ${code(w)}, it`
        + ` would take ${code(`t3 --lan ${w} up`)} to be a command called ${code(w)}, and let \`up\` through.`,
      fix: `To fix it: add ${quoted(b.names)} to \`t3BooleanWords\` in \`lib/guard.nix\`.`,
    };
  },
  "codex-commands": (b, at) => ({
    title: "command list changed",
    head: `${at}'s commands don't match the guard's list:`,
    list: changes(b, "codex "),
    why: `${CODEX} The guard uses this list to tell codex's commands apart from the words of a prompt, as in`
      + " `codex \"fix the update script\"`. An out-of-date list could let `codex update` through, or block ordinary use.",
    fix: "To fix it: " + (added(b) ? "read what each new command does. If one installs or updates codex, add it to"
      + " `codexRefused`. Then make" : "make") + " `codexCommands` in `lib/guard.nix` match"
      + `: ${[added(b) ? "add the new ones" : "", b.names.some((n) => n.startsWith("-")) ? "remove the gone ones" : ""].filter(Boolean).join(" and ")}.`,
  }),
  "codex-hidden-gone": (b, at) => {
    const n = b.names.length;
    return {
      title: s(n, "hidden command gone", "hidden commands gone"),
      head: n === 1
        ? `In ${at}, ${code(`codex ${b.names[0]} --help`)} no longer works, so the command looks gone. Its help never listed`
          + " that command, but the guard still has it on its list."
        : `In ${at}, \`--help\` no longer works for these commands, so they look gone. Its help never listed them, but the`
          + " guard still has them on its list:",
      names: b.names.map((c) => code(`codex ${c}`)),
      list: n === 1 ? [] : b.names.map((c) => code(`codex ${c}`)),
      why: `${CODEX} The guard reads the words after a command it knows as that command's own, so until`
        + ` ${s(n, "it's", "they're")} taken out, ${code(`codex ${b.names[0]} update`)} gets \`codex update\` past it.`,
      fix: `To fix it: check that ${s(n, "it's", "they're")} gone from the release's binary. If so, take ${quoted(b.names)} out`
        + " of `codexHiddenCommands` in `lib/guard.nix`.",
    };
  },
  "codex-level-new": (b, at) => {
    const n = b.names.length;
    return {
      title: s(n, "new command blocked until checked", "new commands blocked until checked"),
      head: `${at} has ${s(n, "a command", `${n} commands`)} under ${code(`codex ${b.ctx}`)} that t3code-nix hasn't checked:`,
      list: b.names.map((c) => code(`codex ${b.ctx} ${c}`)),
      why: `${CODEX} Here the guard blocks every command it hasn't checked, so for now ${s(n, "this one prints", "these print")}`
        + " the \"installed by Nix\" message.",
      fix: `To fix it: read what ${s(n, "the command does", "each command does")}. If it installs or updates codex, add it to`
        + ` \`codexInstallers\` under ${code(`"${b.ctx}"`)} in \`lib/guard.nix\`. Otherwise add it to \`codexAllowed\` there.`,
    };
  },
  "codex-app-server": (b, at) => ({
    title: "`codex app-server` commands changed",
    head: `${at}'s commands under \`codex app-server\` don't match the guard's list:`,
    list: changes(b, "codex app-server "),
    why: added(b)
      ? `${CODEX} The guard spots the daemon's installers by the name \`daemon\`. If a new command is another name for the`
        + " daemon, its installers get through."
      : `${CODEX} The guard's list of these commands is out of date.`,
    fix: added(b)
      ? "To fix it: read what each new command does. If one is another name for `daemon`, or installs codex, block it in"
        + " `refuseCodex`. Then make `codexAppServerCommands` in `lib/guard.nix` match."
      : "To fix it: make `codexAppServerCommands` in `lib/guard.nix` match.",
  }),
  "codex-level-arguments": (b, at) => ({
    title: `${code(`codex ${b.ctx}`)} now takes arguments`,
    head: `In ${at}, ${code(`codex ${b.ctx}`)} takes arguments of its own.`,
    list: [],
    why: `${CODEX} The guard reads the word after ${code(b.ctx.split(" ").at(-1)!)} as one of its commands. So it could take`
      + " an argument for a command, or miss a command that comes after one.",
    fix: "To fix it: make `refuseCodex` in `lib/guard.nix` skip those arguments.",
  }),
  // refuseCodex passes over words that aren't commands (a prompt), so only
  // a value that is a command misleads it.
  "codex-value-option": valueOption("codex", "--model gpt-5", "codexValueOptions", CODEX, (x) =>
    `it would take ${code(`codex ${x} exec update`)} to be \`codex exec\` with the prompt \`update\`, and let \`update\``
      + " through."),
  "codex-flag-option": flagOption("codex", "codexValueOptions", CODEX, false),
  "codex-multi-options": (b, at) => ({
    title: "options that take several values changed",
    head: `In ${at}, the options that take several values, like \`-i a.png b.png\`, don't match the guard's list:`,
    list: changes(b, ""),
    why: `${CODEX} The guard skips every value after one of these options, up to the next option. An out-of-date list`
      + " could let `codex update` through, or block ordinary use.",
    fix: "To fix it: make `codexMultiOptions` in `lib/guard.nix` match.",
  }),
  "codex-unskippable": (b, at) => {
    const n = b.names.length;
    return {
      title: s(n, "option the guard can't read", "options the guard can't read"),
      head: `${at} has ${s(n, "an option", `${n} options`)} in a form the guard can't skip, such as an optional value or two values:`,
      list: b.names.map(code),
      why: `${CODEX} The guard could misread the words after ${s(n, "it", "them")}, and let a blocked command through.`,
      fix: "To fix it: teach `refuseCodex` in `lib/guard.nix` to handle that form.",
    };
  },
  "codex-short-flag": (b, at) => {
    const n = b.names.length, f = b.names[0];
    return {
      title: s(n, "new short flag not checked yet", "new short flags not checked yet"),
      head: `${at} has ${s(n, "a short flag", `${n} short flags`)} that the guard doesn't know:`,
      list: b.names.map((x) => code(`-${x}`)),
      why: `${CODEX} The guard takes a group of short flags ending in \`h\`, like \`-yh\`, as a request for help. Until it`
        + ` knows ${code(`-${f}`)}, asking a blocked command for help as ${code(`-${f}h`)} gets the "installed by Nix" message`
        + " instead of the help.",
      fix: `To fix it: add ${quoted(b.names)} to \`codexShortFlags\` in \`lib/guard.nix\`.`,
    };
  },
  "codex-short-value": (b, at) => {
    const n = b.names.length, f = b.names[0];
    return {
      title: s(n, "short flag now takes a value", "short flags now take a value"),
      head: n === 1
        ? `In ${at}, ${code(`-${f}`)} takes a value, but the guard still treats it as a plain flag.`
        : `In ${at}, these short flags take a value, but the guard still treats them as plain flags:`,
      names: b.names.map((x) => code(`-${x}`)),
      list: n === 1 ? [] : b.names.map((x) => code(`-${x}`)),
      why: `${CODEX} The guard would take ${code(`-${f}h`)} as a request for help, while codex reads it as ${code(`-${f}`)}`
        + ` with the value \`h\`. So a blocked command with ${code(`-${f}h`)} after it would get through.`,
      fix: `To fix it: take ${quoted(b.names)} out of \`codexShortFlags\` in \`lib/guard.nix\`.`,
    };
  },
  "provider-command": (b, at, pkg) => provider(b, at, pkg, true),
  "provider-command-own": (b, at, pkg) => provider(b, at, pkg, false),
  unreadable: (b, at) => ({
    title: "guard check couldn't run",
    head: `The guard check couldn't read ${at}'s help, so it couldn't tell whether this release has anything t3code-nix needs to check.`,
    list: [],
    why: "",
    fix: `To fix it: the ${code(b.ctx)} log in the run below says why. Usually the help's layout changed, and the check's`
      + " reader needs updating.",
  }),
};

const textOf = (b: Block, at: string, pkg: string): Text => b.kind
  ? KINDS[b.kind](b, at, pkg)
  : { title: "something to check", head: "The guard check noted:", list: [code(b.ctx)], why: "", fix: "" };
/** The blocks to show: an empty detail (a tampered or cut one) is shown as
 * other lines are, never as "0 things to check". */
const blocksOf = (detail: string): Block[] => {
  const blocks = parse(detail);
  const shown = detail.split("\n").filter((l) => l !== CUT).join("\n").trim();
  return blocks.length ? blocks : [{ kind: "", ctx: shown || (cutShort(detail) ? "(too long to show here)" : "(no detail)"), names: [] }];
};
const atOf = (pkg: string, version: string | null) => (version ? `${pkg} ${plain(version)}` : pkg);
const bullets = (list: string[]) => list.map((x) => `- ${x}`).join("\n");
/** The head with its list on the same line, for a comment. */
const oneLine = (t: Text) => (t.list.length ? `${t.head} ${t.list.join(", ")}` : t.head);
/** The names (or, for a kind without, its head). */
const named = (t: Text) => (t.list.length ? t.list : t.names ?? [t.title]);
/** Every block's names, once each. */
const allNamed = (texts: Text[]) => [...new Set(texts.flatMap(named))].join(", ");

export function title(pkg: string, detail: string): string {
  const blocks = blocksOf(detail);
  return `${pkg}: ${blocks.length === 1 ? textOf(blocks[0], pkg, pkg).title : `${blocks.length} things to check`}`;
}

export function body(pkg: string, version: string | null, detail: string, runUrl: string): string {
  const at = atOf(pkg, version);
  const blocks = blocksOf(detail);
  const texts = blocks.map((b) => textOf(b, at, pkg));
  const held = "This did not hold up the release.";
  const part = (t: Text, one: boolean) => [
    t.head, bullets(t.list),
    [t.why, one ? held : ""].filter(Boolean).join(" "),
    t.fix,
  ].filter(Boolean).join("\n\n");
  const one = texts.length === 1;
  const commandsOnly = blocks.every((b) => b.kind === "t3-command");
  return [
    texts.map((t) => part(t, one)).join("\n\n---\n\n"),
    one ? "" : held,
    // Every published update runs every guard check (scripts/ci/narrow.ts
    // guardReview), whatever it changed.
    cutShort(detail) ? "This list was cut short; the check's log in the run below has the rest." : "",
    `This issue closes when the bot next publishes an update and ${pkg} ${commandsOnly ? "has no unchecked commands" : "has nothing left to check"}.`,
    runUrl ? `Found by [this run](${runUrl}).` : "",
  ].filter(Boolean).join("\n\n");
}

/** What a comment says about the items: one line, or a list of them. */
function summary(pkg: string, version: string | null, detail: string, lead: (at: string) => string): string {
  const at = atOf(pkg, version);
  const texts = blocksOf(detail).map((b) => textOf(b, at, pkg));
  return texts.length === 1
    ? `${lead(at)} ${oneLine(texts[0])}`
    : `${lead(at)}\n\n${bullets(texts.map(oneLine))}`;
}

/** Reopened for something new. */
export const reopened = (pkg: string, version: string | null, detail: string) => summary(pkg, version, detail, () => "Reopened:");

/** Reopened for what it closed with. */
export function reopenedSame(pkg: string, version: string | null, detail: string): string {
  const at = atOf(pkg, version);
  return `Reopened: still not checked in ${at}: ${allNamed(blocksOf(detail).map((b) => textOf(b, at, pkg)))}`;
}

/** Changed while open. */
export const changed = (pkg: string, version: string | null, detail: string) =>
  summary(pkg, version, detail, () => "Now to check:");

/** The daily reminder. */
export function reminder(pkg: string, version: string | null, detail: string): string {
  const at = atOf(pkg, version);
  return `Still not checked: ${allNamed(blocksOf(detail).map((b) => textOf(b, at, pkg)))}`;
}

/** Closed by a published release with nothing to check. */
export const closed = (pkg: string, version: string | null) => `Closed: everything in ${atOf(pkg, version)} has been checked.`;

/** The kinds of item this knows (lib/checks.nix notes only these). */
export const KNOWN = Object.keys(KINDS);
