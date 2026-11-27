// Patches the T3 Code desktop app's app.asar, in place:
//
//   node asar-patch.ts <app.asar> <old reason> <new reason> <marker> [<shim.cjs>]
//
// Two groups of changes, each all or nothing:
//
// - The reason (always): upstream's sentence for why its updates are off,
//   returned as a string in apps/desktop/dist-electron/main.cjs, becomes
//   ours. It must appear exactly once in the whole archive, in that file, as
//   a double-quoted string right after `return `, ending the statement. If
//   not, this fails and writes nothing.
// - The update notice (with a shim): the shim is added next to main.cjs and
//   required first by boot.cjs; main.cjs hands it the update policy and the
//   menu's "Check for Updates…"; the web UI's sidebar update button hides
//   unless there is an update, and shows this flake's newer version
//   (update-notice.cjs adds it to the update state). The web UI is minified,
//   so its edits are found by shape, with the minifier's names captured and
//   checked against each other. If any edit doesn't match exactly once, none
//   of this group is applied and the app is today's.
//
// The marker file gets `on`, or `off: <why>`. Changed and added files are
// appended after the archive's data (scripts/lib/asar.ts).
import { writeFileSync, readFileSync } from "node:fs";
import { Asar, AsarError } from "./lib/asar.ts";

const MAIN = "apps/desktop/dist-electron/main.cjs";
const BOOT = "apps/desktop/dist-electron/boot.cjs";
const SHIM = "apps/desktop/dist-electron/nix-update-notice.cjs";
const ASSETS = "apps/server/dist/client/assets";

export class Miss extends Error {}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const bufCount = (haystack: Buffer, needle: Buffer) => {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
};

/** main.cjs's text with upstream's reason swapped for ours, or an AsarError. */
export function swapReason(bytes: Buffer, text: string, oldText: string, newText: string): string {
  const returned = `return ${JSON.stringify(oldText)}`;
  const at = text.indexOf(returned);
  // What follows must end the statement, so `return "<old>" + more` isn't
  // taken for it (nor across a line break, which might not end it).
  const ends = at !== -1 && count(text, returned) === 1 && [";", "}"].includes(text[at + returned.length]);
  // The text as it's written inside the string (escapes and all), once in
  // the whole archive.
  const inner = Buffer.from(JSON.stringify(oldText).slice(1, -1));
  if (bufCount(bytes, inner) !== 1 || !ends) {
    throw new AsarError(`expected the text exactly once, returned as a string in ${MAIN}: ${oldText}`);
  }
  return text.slice(0, at) + `return ${JSON.stringify(newText)}` + text.slice(at + returned.length);
}

/** One exact text, once, with `insert` put before or after it. */
function around(text: string, what: string, name: string, find: string, insert: string, where: "before" | "after"): string {
  const n = count(text, find);
  if (n !== 1) throw new Miss(`${name}: ${n} matches in ${what}`);
  return text.replace(find, () => (where === "before" ? insert + find : find + insert));
}

const ID = "[\\w$]+";

/** `text` as a regular expression that matches exactly it. */
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The single match of `re` in `text`, or a Miss. */
function only(text: string, re: RegExp, name: string): RegExpMatchArray {
  const all = [...text.matchAll(new RegExp(re.source, "g"))];
  if (all.length !== 1) throw new Miss(`${name}: ${all.length} matches`);
  return all[0];
}

/** The one asset whose text matches `re` exactly once, or a Miss. */
function assetWith(a: Asar, re: RegExp, name: string): { path: string; text: string } {
  const found = [];
  for (const path of a.list(ASSETS)) {
    if (!path.endsWith(".js")) continue;
    const text = a.text(path);
    if (new RegExp(re.source, "g").test(text)) found.push({ path, text });
  }
  if (found.length !== 1) throw new Miss(`${name}: in ${found.length} web UI files`);
  return found[0];
}

// The notice's sentence, which the shim (update-notice.cjs) writes into the
// state: the web UI edits carry no wording of their own.
const NOTICE = (v: string) => `${v}.nixUpdate.summary`;

/** The sidebar component (main-*.js): its new text. */
export function patchSidebar(text: string): string {
  // The button hides unless (upstream) desktop || plan || run. Now: a
  // notice || plan || run || upstream's update dialog open (it renders
  // below this return, so hiding mustn't unmount it).
  const hide = only(
    text,
    new RegExp(`if\\(!(${ID})&&!(${ID})&&!(${ID})\\)return null;let ${ID}=${ID}\\?${ID}:${ID},${ID}=(${ID})\\?\\.downloadPercent\\?\\?null`),
    "hide check",
  );
  const [, , plan, run, state] = hide;
  // Everything else in the same component: from its `function` to the next
  // (minified components have no inner function declarations), so a look-
  // alike elsewhere in the bundle is never edited.
  const start = text.lastIndexOf("function ", hide.index!);
  if (start === -1) throw new Miss("hide check: not in a function");
  const nextFn = text.indexOf("function ", hide.index!);
  const component = text.slice(start, nextFn === -1 ? text.length : nextFn);
  const at = hide.index! - start;
  const esc = escapeRegExp;
  const before = component.slice(0, at);
  // Its state and plan are the component's own bindings, and its click
  // checks upstream's state (the shim answers that check).
  for (const [what, name] of [["state", state], ["plan", plan]] as const) {
    if (!new RegExp(`[,;{]${esc(name)}=`).test(before)) throw new Miss(`hide check: its ${what} isn't the component's own`);
  }
  if (!/[\w$]\.checkForUpdate\(\)\.then\(/.test(component)) throw new Miss("click: the component doesn't check for updates");
  // Upstream's update dialog: its open state, a useState of the component
  // (declared before the check), and the dialog after it.
  const dialog = only(component.slice(at), new RegExp(`\\{open:(${ID}),onOpenChange:(${ID}),version:`), "update dialog");
  const [, open, setOpen] = dialog;
  const declared = new RegExp(`\\[${esc(open)},${esc(setOpen)}\\]=\\(0,${ID}\\.useState\\)\\(`);
  if (!declared.test(before)) throw new Miss("update dialog: its open state isn't the component's own");
  /** The single match of `re` in the component, at its offset in `text`. */
  const inComponent = (re: RegExp, name: string) => {
    const m = only(component, re, name);
    m.index! += start;
    return m;
  };
  // Disabled (not clickable) unless upstream says so; never with a notice.
  const guard = inComponent(new RegExp(`(${ID})=(${ID})\\?!0:(${ID})\\?!1:(${ID})\\?(${ID})\\((${ID})\\):!(${ID})\\(\\6\\)`), "click guard");
  if (guard[3] !== plan || guard[6] !== state) throw new Miss("click guard: other names than the hide check's");
  // The icon: upstream's "update available" look for a notice.
  const icon = only(
    text,
    new RegExp(
      `function (${ID})\\(\\{action:(${ID}),showsEverything:(${ID}),run:(${ID}),isDownloading:(${ID}),showCheckIcon:(${ID})\\}\\)\\{let (${ID})=\\2!==\`none\`\\|\\|\\3\\|\\|\\4!==null\\|\\|\\5;return\\{iconStatus:`,
    ),
    "icon helper",
  );
  const [iconHead, iconFn, , , , , checking, shows] = icon;
  const bodyStart = icon.index! + iconHead.length;
  const bodyEnd = text.indexOf("}}", bodyStart) + 2;
  let body = text.slice(bodyStart, bodyEnd);
  if (count(body, "===`download`?`available`:`idle`") !== 1) throw new Miss("icon helper: its `available` branch");
  body = body.replace("===`download`?`available`:`idle`", "===`download`||__t3nix?`available`:`idle`");
  const stateEnd = `showUpdateIconState:${shows}&&!${checking}}}`;
  if (!body.endsWith(stateEnd)) throw new Miss("icon helper: its showUpdateIconState");
  body = body.slice(0, -stateEnd.length) + `showUpdateIconState:(${shows}||__t3nix)&&!${checking}}}`;
  const head = iconHead.replace(`showCheckIcon:${checking}})`, `showCheckIcon:${checking},__t3nix})`);
  const call = inComponent(
    new RegExp(`(?<![\\w$])${esc(iconFn)}\\(\\{action:${ID},showsEverything:(${ID}),run:${ID},isDownloading:${ID},showCheckIcon:${ID}\\}\\)`),
    "icon helper's call",
  );
  if (call[1] !== plan) throw new Miss("icon helper's call: other names than the hide check's");
  // Upstream's plan (a provider installed outside Nix, a self-updating
  // server) keeps its tooltip, with the notice after it: "Update 1 provider.
  // T3 Code <v> is now available. Update t3code-nix and rebuild …".
  const summary = inComponent(new RegExp(`(${ID})=(${ID})\\?(${ID})\\.summary:`), "summary tooltip");
  if (summary[2] !== plan) throw new Miss("summary tooltip: other names than the hide check's");

  // Apply from the end, so earlier offsets stay valid.
  const edits = [
    { at: hide.index!, len: hide[0].indexOf("let "), to: `if(!${state}?.nixUpdate&&!${plan}&&!${run}&&!${open})return null;` },
    { at: guard.index!, len: guard[0].length, to: `${guard[0]}&&!${state}?.nixUpdate` },
    { at: icon.index!, len: bodyEnd - icon.index!, to: head + body },
    { at: call.index!, len: call[0].length, to: `${call[0].slice(0, -2)},__t3nix:!!${state}?.nixUpdate})` },
    {
      at: summary.index!,
      len: summary[0].length,
      to: `${summary[1]}=${plan}?${summary[3]}.summary+(${state}?.nixUpdate?\`. \`+${NOTICE(state)}:\`\`):`,
    },
  ].sort((x, y) => y.at - x.at);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].at + edits[i].len > edits[i - 1].at) throw new Miss("sidebar edits overlap");
  }
  let out = text;
  for (const e of edits) out = out.slice(0, e.at) + e.to + out.slice(e.at + e.len);
  return out;
}

/** The update tooltip helper (desktopUpdate.logic-*.js): its new text. */
export function patchTooltip(text: string): string {
  const tip = only(
    text,
    new RegExp(
      `function (${ID})\\((${ID}),(${ID}),(${ID})=(${ID})\\)\\{let (${ID})=(${ID})\\(\\2,\\3,\\4\\);return \\6\\?\\{title:${ID}\\(${ID}\\(\`Updates unavailable\`\\)\\)`,
    ),
    "tooltip helper",
  );
  const state = tip[2];
  const at = tip.index! + tip[0].indexOf("{let ") + 1;
  return text.slice(0, at) + `if(${state}?.nixUpdate)return{title:\`Update available\`,detail:${NOTICE(state)}};` + text.slice(at);
}

/** Applies the notice group to `a` (main.cjs given as text), all or nothing:
 * the new main.cjs text, or a Miss. */
export function applyNotice(a: Asar, main: string, shim: Buffer): string {
  // The update IPC channels the shim hooks (update-notice.cjs), as upstream
  // names them: renamed, the shim would see nothing.
  for (const line of [
    'const UPDATE_STATE_CHANNEL = "desktop:update-state";',
    'const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";',
    'const UPDATE_CHECK_CHANNEL = "desktop:update-check";',
  ]) {
    const n = count(main, line);
    if (n !== 1) throw new Miss(`update channels: ${n} matches of ${line}`);
  }
  const menu = around(main, "main.cjs", "menu hook", "const handleCheckForUpdatesMenuClick = gen(function* () {", "\n\tif (globalThis.__t3codeNixUpdateNotice?.menu()) return;", "after");
  const policy = around(menu, "main.cjs", "policy hook", "\tconst policy = yield* DesktopUpdatePolicy;\n", "\tglobalThis.__t3codeNixUpdateNotice?.policy(policy);\n", "after");
  const boot = around(a.text(BOOT), "boot.cjs", "shim require", 'require("./compileCache.cjs");', 'require("./nix-update-notice.cjs");\n', "before");
  const sidebar = assetWith(a, /if\(![\w$]+&&![\w$]+&&![\w$]+\)return null;let [\w$]+=[\w$]+\?[\w$]+:[\w$]+,[\w$]+=[\w$]+\?\.downloadPercent\?\?null/, "hide check");
  const sidebarText = patchSidebar(sidebar.text);
  const logic = assetWith(a, /\?\{title:[\w$]+\([\w$]+\(`Updates unavailable`\)\)/, "tooltip helper");
  // One file for both (a bundler that folds them together): both edits on it.
  const same = logic.path === sidebar.path;
  const logicText = patchTooltip(same ? sidebarText : logic.text);
  if (a.entry(SHIM)) throw new Miss(`${SHIM} is already in the archive`);
  // Everything matched: only now is the archive changed.
  a.set(BOOT, boot);
  if (!same) a.set(sidebar.path, sidebarText);
  a.set(logic.path, logicText);
  a.add(SHIM, shim);
  return policy;
}

export function patch(asarPath: string, oldText: string, newText: string, markerPath: string, shimPath?: string): string {
  const bytes = readFileSync(asarPath);
  const a = new Asar(bytes);
  let main = swapReason(bytes, a.text(MAIN), oldText, newText);
  let marker = "off: no shim given";
  if (shimPath !== undefined) {
    const shim = readFileSync(shimPath);
    try {
      // Changes `a` only when every edit of the group matched.
      main = applyNotice(a, main, shim);
      marker = "on";
    } catch (e) {
      // A file it needs gone, unpacked or unreadable (an AsarError) is a
      // release it doesn't fit, too.
      if (!(e instanceof Miss || e instanceof AsarError)) throw e;
      marker = `off: ${e.message}`;
    }
  }
  a.set(MAIN, main);
  a.write(asarPath);
  writeFileSync(markerPath, `${marker}\n`);
  return marker;
}

if (import.meta.main) {
  const [asarPath, oldText, newText, markerPath, shimPath] = process.argv.slice(2);
  if (markerPath === undefined || oldText === "") {
    console.error("usage: asar-patch.ts <app.asar> <old reason> <new reason> <marker> [<shim.cjs>]");
    process.exit(2);
  }
  try {
    const marker = patch(asarPath, oldText, newText, markerPath, shimPath);
    if (marker !== "on") console.error(`warning: asar-patch: ${asarPath}: the update notice is ${marker}`);
  } catch (e) {
    if (!(e instanceof AsarError)) throw e;
    console.error(`asar-patch: ${asarPath}: ${e.message}`);
    process.exit(1);
  }
}
