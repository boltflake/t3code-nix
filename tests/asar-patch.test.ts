// asar-patch.ts (and scripts/lib/asar.ts): our reason for the desktop app's
// updates being off, and the update notice, on small archives laid out as
// Electron's are, with the web UI and main.cjs lines cut from real releases
// (tests/fixtures/update-notice/: 0.1.10, 0.1.13 and a nightly).
// Run: node --test tests/*.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { Asar } from "../scripts/lib/asar.ts";
import { escapeRegExp, patchSidebar, patchTooltip } from "../scripts/asar-patch.ts";

const script = join(import.meta.dirname, "../scripts/asar-patch.ts");
const shimPath = join(import.meta.dirname, "../pkgs/t3code/update-notice.cjs");
const fixtures = join(import.meta.dirname, "fixtures/update-notice");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const OLD = "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
const NEW = "Nix manages this install. Please rebuild your system to update T3 Code.";
/** A string as a JavaScript literal for the fixtures' code, with the
 * characters that could end a script or a line escaped. */
const lit = (s: string) => JSON.stringify(s).replace(/[<>/\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const BLOCK = 64;
const MAIN = "apps/desktop/dist-electron/main.cjs";
const BOOT = "apps/desktop/dist-electron/boot.cjs";
const SHIM = "apps/desktop/dist-electron/nix-update-notice.cjs";
const SIDEBAR = "apps/server/dist/client/assets/main-Abc123.js";
const LOGIC = "apps/server/dist/client/assets/desktopUpdate.logic-Def456.js";
const OTHER = "apps/server/dist/client/assets/other-Ghi789.js";
const tmp = mkdtempSync(join(tmpdir(), "asar-patch-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

type Integrity = { algorithm: string; hash: string; blockSize: number; blocks: string[] };
type Node = { files?: Record<string, Node>; size?: number; offset?: string; integrity?: Integrity; unpacked?: boolean };

/** As electron/asar 3.2.4 hashes: a last block always, empty when the size
 * is a whole number of blocks. */
function integrity(b: Buffer, block = BLOCK, lastEmpty = true): Integrity {
  const blocks = [];
  for (let i = 0; lastEmpty ? i <= b.length : i < b.length; i += block) blocks.push(sha256(b.subarray(i, i + block)));
  return { algorithm: "SHA256", hash: sha256(b), blockSize: block, blocks };
}

/** An archive of `files` (path -> text), in that order, as Chromium pickles
 * it, plus one unpacked add-on; `edit` changes the header before it's
 * written. */
function archive(files: Record<string, string>, edit = (_: Node) => {}, block = BLOCK): string {
  const header: Node = { files: {} };
  const data: Buffer[] = [];
  let offset = 0;
  const put = (path: string, entry: Node) => {
    const parts = path.split("/");
    let at = header;
    for (const p of parts.slice(0, -1)) at = at.files![p] ??= { files: {} };
    at.files![parts.at(-1)!] = entry;
  };
  for (const [path, text] of Object.entries(files)) {
    const b = Buffer.from(text);
    put(path, { size: b.length, offset: String(offset), integrity: integrity(b, block) });
    data.push(b);
    offset += b.length;
  }
  put("node_modules/addon/addon.node", { size: 12, unpacked: true, integrity: integrity(Buffer.alloc(12), block) });
  edit(header);
  const json = Buffer.from(JSON.stringify(header));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + padded.length, 4);
  head.writeUInt32LE(4 + padded.length, 8);
  head.writeUInt32LE(json.length, 12);
  const path = join(mkdtempSync(join(tmp, "a-")), "app.asar");
  writeFileSync(path, Buffer.concat([head, padded, ...data]));
  return path;
}

const fixture = (version: string) => {
  const f = (n: string) => readFileSync(join(fixtures, version, n), "utf8");
  return { [MAIN]: f("main.cjs"), [BOOT]: f("boot.cjs"), [OTHER]: "export const other = 1;\n", [SIDEBAR]: f("sidebar.js"), [LOGIC]: f("logic.js") };
};

const run = (path: string, withShim = true, from = OLD, to = NEW) =>
  spawnSync(process.execPath, [script, path, from, to, `${path}.marker`, ...(withShim ? [shimPath] : [])], { encoding: "utf8" });
const marker = (path: string) => readFileSync(`${path}.marker`, "utf8");

/** Every packed file's contents, read back (and integrity-checked). */
function contents(path: string): Record<string, string> {
  const a = Asar.read(path);
  return Object.fromEntries(a.list().map((p) => [p, a.text(p)]));
}

/** Fails as `message` says, leaving the archive byte for byte. */
function refuses(path: string, message: RegExp, from = OLD, to = NEW) {
  const before = readFileSync(path);
  const r = run(path, false, from, to);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, message);
  assert.deepEqual(readFileSync(path), before);
}

const cjs = (sentence: string, pad = "") =>
  `"use strict";${pad}\nfunction reason(args) {\n  if (args.disabledByEnv) return ${JSON.stringify(sentence)};\n  return null;\n}\nmodule.exports = { reason };\n`;
const plain = (main: string, rest: Record<string, string> = {}) => ({ [MAIN]: main, [OTHER]: "other();\n", ...rest });

// The reason (always applied).

for (const [name, block] of [
  ["a file of several blocks", BLOCK],
  ["a file of one block, whose hash is its block's", 4096],
] as const) {
  test(`swaps the returned sentence and rewrites the file's hashes: ${name}`, () => {
    const main = cjs(OLD);
    const path = archive(plain(main), undefined, block);
    const before = readFileSync(path);
    const r = run(path, false);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(marker(path), "off: no shim given\n");
    const a = Asar.read(path);
    const body = a.text(MAIN);
    assert.equal(body, main.replace(JSON.stringify(OLD), JSON.stringify(NEW)));
    // Still valid CommonJS, and it returns the new sentence.
    const mod = { exports: {} as { reason: (a: object) => string } };
    new Script(`(function (module) {${body}\n})`).runInThisContext()(mod);
    assert.equal(mod.exports.reason({ disabledByEnv: true }), NEW);
    assert.deepEqual(a.entry(MAIN)!.integrity, integrity(Buffer.from(body), block));
    // The other file keeps its bytes where they were; the old data is kept.
    assert.equal(a.entry(OTHER)!.offset, new Asar(before).entry(OTHER)!.offset);
    assert.equal(a.text(OTHER), "other();\n");
    const oldData = before.subarray(8 + before.readUInt32LE(4));
    const now = readFileSync(path);
    assert.deepEqual(now.subarray(8 + now.readUInt32LE(4), 8 + now.readUInt32LE(4) + oldData.length), oldData);
  });
}

test("refuses when the sentence isn't returned as a string exactly once", () => {
  const once = /expected the text exactly once/;
  refuses(archive(plain("return 'no such sentence';\n")), once);
  refuses(archive(plain(`a = ${lit(OLD)}; b = ${lit(OLD)};\n`)), once);
  refuses(archive(plain(`return \`${OLD}\`;\n`)), once);
  refuses(archive(plain(`// it said ${lit(OLD)}\nreturn "something else";\n`)), once);
  refuses(archive(plain(`const message = ${lit(OLD)};\n`)), once);
  // Returned with more after it: the start of a longer reason.
  refuses(archive(plain(`function f(s) { return ${lit(OLD)} + s; }\n`)), once);
  refuses(archive(plain(`function f(s) { return ${lit(OLD)}, s; }\n`)), once);
  // A line end might not end it.
  refuses(archive(plain(`function f(s) { return ${lit(OLD)}\n  + s; }\n`)), once);
  // In the file, and in another file too.
  refuses(archive(plain(cjs(OLD), { [OTHER]: `// ${OLD}\n` })), once);
});

test("takes a statement ending in a brace, and a sentence with escapes", () => {
  const brace = archive(plain(`function f() { return ${lit(OLD)}}\n`));
  assert.equal(run(brace, false).status, 0);
  assert.match(contents(brace)[MAIN], new RegExp(`return ${lit(NEW)}}`));
  const old = 'A "quoted" switch\\';
  const escaped = archive(plain(`function f() { return ${lit(old)}; }\n`));
  assert.equal(run(escaped, false, old, "Short.").status, 0);
  assert.match(contents(escaped)[MAIN], /return "Short\.";/);
});

test("takes a file of a whole number of blocks, with or without a last empty block, and keeps that convention", () => {
  // Blocks of 2 bytes: main.cjs is a whole number of them before the swap
  // and after it (the sentences differ by 2), so the two conventions differ
  // by one block on both sides.
  const block = 2;
  const main = cjs(OLD) + (cjs(OLD).length % 2 ? " " : "");
  assert.equal((main.length - OLD.length + NEW.length) % block, 0);
  for (const lastEmpty of [true, false]) {
    const path = archive(
      plain(main),
      (h) => {
        const i = h.files!.apps.files!.desktop.files!["dist-electron"].files!["main.cjs"].integrity!;
        if (!lastEmpty) i.blocks.pop();
      },
      block,
    );
    const r = run(path, false);
    assert.equal(r.status, 0, r.stderr);
    const now = Buffer.from(contents(path)[MAIN]);
    assert.deepEqual(Asar.read(path).entry(MAIN)!.integrity, integrity(now, block, lastEmpty));
  }
});

test("refuses an empty old reason, or too few arguments, leaving the archive", () => {
  const path = archive(plain(cjs(OLD)));
  const before = readFileSync(path);
  for (const args of [[path, "", NEW, `${path}.marker`], [path, OLD, NEW]]) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /usage: asar-patch.ts/);
  }
  assert.deepEqual(readFileSync(path), before);
});

test("refuses a missing or unpacked main.cjs", () => {
  refuses(archive({ [OTHER]: "x" }), /main.cjs isn't a file packed in the archive/);
  refuses(archive(plain(cjs(OLD)), (h) => Object.assign(h.files!.apps.files!.desktop.files!["dist-electron"].files!["main.cjs"], { unpacked: true })), /isn't a file packed/);
  refuses(archive(plain(cjs(OLD)), (h) => (h.files!.apps.files!.desktop.files!["dist-electron"].files!["main.cjs"].size! += 10)), /isn't a file packed/);
  // A negative size, which Buffer.subarray would count from the end.
  refuses(archive(plain(cjs(OLD)), (h) => (h.files!.apps.files!.desktop.files!["dist-electron"].files!["main.cjs"].size = -1)), /isn't a file packed/);
});

test("refuses hashes that don't match the file", () => {
  const stale = /integrity in the header doesn't match/;
  const pad = "/*" + "a".repeat(100) + "*/";
  const main = (h: Node) => h.files!.apps.files!.desktop.files!["dist-electron"].files!["main.cjs"].integrity!;
  const path = archive(plain(cjs(OLD, pad)));
  const changed = readFileSync(path);
  changed[changed.length - 12] ^= 1; // a byte of main.cjs, not of the sentence
  writeFileSync(path, changed);
  refuses(path, stale);
  refuses(archive(plain(cjs(OLD, pad)), (h) => (main(h).blocks[1] = "0".repeat(64))), stale);
  refuses(archive(plain(cjs(OLD, pad)), (h) => main(h).blocks.pop()), stale);
  refuses(archive(plain(cjs(OLD, pad)), (h) => (main(h).blocks = [])), stale);
  refuses(archive(plain(cjs(OLD)), (h) => (main(h).blockSize = 0)), stale);
  refuses(archive(plain(cjs(OLD)), (h) => (main(h).algorithm = "SHA1")), stale);
});

test("refuses what isn't an asar archive, or a header it couldn't write back", () => {
  const path = join(mkdtempSync(join(tmp, "a-")), "app.asar");
  writeFileSync(path, "not an archive at all");
  refuses(path, /not an asar archive/);
  const spaced = archive(plain(cjs(OLD)));
  const asar = readFileSync(spaced);
  const length = asar.readUInt32LE(12);
  const json = Buffer.from(asar.subarray(16, 16 + length).toString().replace(":", ": "));
  assert.ok(16 + json.length <= 8 + asar.readUInt32LE(4), "the fixture's padding fits a byte");
  json.copy(asar, 16);
  asar.writeUInt32LE(json.length, 12);
  writeFileSync(spaced, asar);
  refuses(spaced, /isn't in JSON.stringify's form/);
  const sizes = archive(plain(cjs(OLD)));
  const b = readFileSync(sizes);
  b.writeUInt32LE(b.readUInt32LE(8) + 4, 8);
  writeFileSync(sizes, b);
  refuses(sizes, /header sizes don't add up/);
});

test("a changed file without integrity gets none; an added one gets it", () => {
  const path = archive(fixture("0.1.13"), (h) => {
    delete h.files!.apps.files!.desktop.files!["dist-electron"].files!["main.cjs"].integrity;
  });
  assert.equal(run(path).status, 0);
  const a = Asar.read(path);
  assert.equal(a.entry(MAIN)!.integrity, undefined);
  assert.deepEqual(a.entry(SHIM)!.integrity, integrity(readFileSync(shimPath), 4 * 1024 * 1024));
});

// The update notice.

for (const version of ["0.1.13", "nightly"]) {
  test(`${version}: the notice applies, every edit once, and only those files change`, () => {
    const files = fixture(version);
    const path = archive(files);
    const r = run(path);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(marker(path), "on\n");
    assert.equal(r.stderr, "");
    const now = contents(path);
    assert.equal(now[SHIM], readFileSync(shimPath, "utf8"));
    assert.equal(now[BOOT], files[BOOT].replace('require("./compileCache.cjs");', 'require("./nix-update-notice.cjs");\nrequire("./compileCache.cjs");'));
    assert.match(now[MAIN], /const handleCheckForUpdatesMenuClick = gen\(function\* \(\) \{\n\tif \(globalThis\.__t3codeNixUpdateNotice\?\.menu\(\)\) return;\n/);
    assert.match(now[MAIN], /\tconst policy = yield\* DesktopUpdatePolicy;\n\tglobalThis\.__t3codeNixUpdateNotice\?\.policy\(policy\);\n/);
    assert.ok(now[MAIN].includes(`return ${lit(NEW)};`));
    assert.equal(now[OTHER], files[OTHER]);
    assert.deepEqual(Object.keys(now).sort(), [...Object.keys(files), SHIM].sort());
    // The unpacked add-on's entry is as it was.
    assert.deepEqual(Asar.read(path).entry("node_modules/addon/addon.node"), { size: 12, unpacked: true, integrity: integrity(Buffer.alloc(12)) });
    // The shim as packed loads on its own (no file beside it to require).
    const dir = mkdtempSync(join(tmpdir(), "packed-shim-"));
    try {
      writeFileSync(join(dir, "nix-update-notice.cjs"), now[SHIM]);
      const packed = createRequire(import.meta.url)(join(dir, "nix-update-notice.cjs"));
      for (const fn of ["create", "validateFeed", "providerUpdate", "summaryOf"]) assert.equal(typeof packed[fn], "function", fn);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** The patched hide check, as a function of what it reads. */
function hidePredicate(text: string) {
  const m = text.match(/if\(!([\w$]+)\?\.nixUpdate&&!([\w$]+)&&!([\w$]+)&&!([\w$]+)\)return null;/);
  assert.ok(m, "the patched hide check");
  return new Function(m[1], m[2], m[3], m[4], `return !(${m[0].slice(3, m[0].indexOf(")return null;"))});`) as (state: unknown, plan: boolean, run: unknown, open: boolean) => boolean;
}

/** The patched icon helper, evaluated (it reads only its arguments). */
function iconHelper(text: string) {
  const start = text.search(/function [\w$]+\(\{action:/);
  const end = text.indexOf("}}", start) + 2;
  return new Script(`(${text.slice(start, end)})`).runInThisContext() as (a: object) => { iconStatus: string; showUpdateDetails: boolean; showUpdateIconState: boolean };
}

for (const version of ["0.1.13", "nightly"]) {
  test(`${version}: the button shows only with an update, and keeps upstream's dialog mounted`, () => {
    const shown = hidePredicate(patchSidebar(fixture(version)[SIDEBAR]));
    const notice = { status: "disabled", nixUpdate: { version: "0.1.14" } };
    const none = { status: "disabled", nixUpdate: null };
    assert.equal(shown(notice, false, false, false), true, "a notice only");
    assert.equal(shown(none, true, false, false), true, "servers or providers only");
    assert.equal(shown(notice, true, false, false), true, "both");
    assert.equal(shown(none, false, false, false), false, "nothing");
    assert.equal(shown(null, false, false, false), false, "no state yet (or not the desktop app)");
    assert.equal(shown(none, false, true, false), true, "an update run in progress");
    assert.equal(shown(none, false, false, true), true, "upstream's dialog open with an emptied plan");
  });

  test(`${version}: the icon shows upstream's "available" look for a notice, and nothing else changes`, () => {
    const before = iconHelper(fixture(version)[SIDEBAR]);
    const now = iconHelper(patchSidebar(fixture(version)[SIDEBAR]));
    const base = { action: "none", showsEverything: false, run: null, isDownloading: false, showCheckIcon: false };
    assert.deepEqual(now({ ...base, __t3nix: true }), { iconStatus: "available", showUpdateDetails: false, showUpdateIconState: true });
    for (const c of [
      base,
      { ...base, showsEverything: true },
      { ...base, action: "download" },
      { ...base, action: "install" },
      { ...base, isDownloading: true },
      { ...base, showCheckIcon: true },
      { ...base, run: { localVersion: null } },
    ]) {
      assert.deepEqual(now({ ...c, __t3nix: false }), before(c), JSON.stringify(c));
    }
    // A run or a check still wins over the notice's look.
    assert.equal(now({ ...base, run: { localVersion: null }, __t3nix: true }).iconStatus, before({ ...base, run: { localVersion: null } }).iconStatus);
    assert.equal(now({ ...base, showCheckIcon: true, __t3nix: true }).iconStatus, "checking");
    assert.equal(now({ ...base, showsEverything: true, __t3nix: true }).iconStatus, "everything");
  });

  test(`${version}: the tooltips name the version`, () => {
    const sidebar = patchSidebar(fixture(version)[SIDEBAR]);
    const s = sidebar.match(/([\w$]+)=([\w$]+)\?([\w$]+)\.summary\+\(([\w$]+)\?\.nixUpdate\?`\. `\+(\4\.nixUpdate\.summary):``\):/);
    assert.ok(s, "the summary tooltip");
    const summary = new Function(s[2], s[3], s[4], `return ${s[2]}?${s[3]}.summary+(${s[4]}?.nixUpdate?\`. \`+${s[5]}:\`\`):"(not the plan)";`);
    const sentence = "T3 Code 0.1.14 is now available. Update t3code-nix and rebuild your system to install the update.";
    assert.equal(summary(true, { summary: "Update 2 providers" }, { nixUpdate: { version: "0.1.14", providers: [], summary: sentence } }), `Update 2 providers. ${sentence}`);
    assert.equal(summary(true, { summary: "Update 2 providers" }, { nixUpdate: null }), "Update 2 providers");
    // An update run still blocks the click, notice or not: upstream's
    // disabled flag ORs in the run after the (edited) guard.
    const hide = sidebar.match(/if\(![\w$]+\?\.nixUpdate&&![\w$]+&&!([\w$]+)&&![\w$]+\)return null;/)!;
    const guardVar = sidebar.match(/([\w$]+)=[\w$]+\?!0:[\w$]+\?!1:/)![1];
    assert.match(sidebar, new RegExp(`=${escapeRegExp(guardVar)}\\|\\|[\\w$]+\\|\\|${escapeRegExp(hide[1])}[,;]`));
    // The click guard: never disabled with a notice.
    assert.match(sidebar, /\?!0:[\w$]+\?!1:[\w$]+\?[\w$]+\([\w$]+\):![\w$]+\(([\w$]+)\)&&!\1\?\.nixUpdate/);
    const logic = patchTooltip(fixture(version)[LOGIC]);
    const fn = logic.match(/function ([\w$]+)\(([\w$]+),[\w$]+,[\w$]+=[\w$]+\)\{if\(\2\?\.nixUpdate\)return(\{title:.*?\});let /);
    assert.ok(fn, "the tooltip helper");
    assert.deepEqual(new Function(fn[2], `return ${fn[3]};`)({ nixUpdate: { version: null, providers: [{ name: "codex" }], summary: "1 provider update is now available." } }), {
      title: "Update available",
      detail: "1 provider update is now available.",
    });
  });
}

/** Ships without the notice: marker `off`, the archive's contents as with
 * the reason alone, from the same input. */
function skips(files: Record<string, string>, why: RegExp) {
  const path = archive(files);
  const reasonOnly = archive(files);
  const r = run(path);
  assert.equal(r.status, 0, r.stderr);
  assert.match(marker(path), /^off: /);
  assert.match(marker(path), why);
  assert.match(r.stderr, /warning: asar-patch: .*the update notice is off: /);
  assert.equal(run(reasonOnly, false).status, 0);
  assert.deepEqual(contents(path), contents(reasonOnly));
}

test("0.1.10's web UI doesn't fit: the notice is skipped whole", () => {
  skips(fixture("0.1.10"), /tooltip helper: in 0 web UI files/);
});

test("any one edit that doesn't fit skips the whole notice", () => {
  const f = fixture("0.1.13");
  const cases: [string, (f: Record<string, string>) => void, RegExp][] = [
    ["hide check changed", (x) => (x[SIDEBAR] = x[SIDEBAR].replace(/\)return null;(let [\w$]+=[\w$]+\?[\w$]+:[\w$]+,[\w$]+=[\w$]+\?\.downloadPercent)/, ")return void 0;$1")), /hide check: in 0 web UI files/],
    ["hide check twice", (x) => (x[OTHER] = x[SIDEBAR]), /hide check: in 2 web UI files/],
    ["click guard changed", (x) => (x[SIDEBAR] = x[SIDEBAR].replace(/\?!0:([\w$]+)\?!1:/, "?!0:$1?false:")), /click guard: 0 matches/],
    ["icon helper changed", (x) => (x[SIDEBAR] = x[SIDEBAR].replace("showUpdateIconState:a&&!i}}", "showUpdateIconState:!i&&a}}")), /icon helper: its showUpdateIconState/],
    ["icon call missing", (x) => (x[SIDEBAR] = x[SIDEBAR].replace(/\b(?<!function )([\w$]+)\(\{action:([\w$]+),showsEverything/, "$1({kind:$2,showsEverything")), /icon helper's call: 0 matches/],
    ["summary changed", (x) => (x[SIDEBAR] = x[SIDEBAR].replace(/\.summary:/, ".label:")), /summary tooltip: 0 matches/],
    ["dialog changed", (x) => (x[SIDEBAR] = x[SIDEBAR].replace("{open:", "{isOpen:")), /update dialog: 0 matches/],
    ["tooltip helper changed", (x) => (x[LOGIC] = x[LOGIC].replace("`Updates unavailable`", "`Updates are unavailable`")), /tooltip helper: in 0 web UI files/],
    ["menu hook missing", (x) => (x[MAIN] = x[MAIN].replace("handleCheckForUpdatesMenuClick", "onCheckForUpdates")), /menu hook: 0 matches/],
    ["policy hook missing", (x) => (x[MAIN] = x[MAIN].replace("yield* DesktopUpdatePolicy;", "yield* UpdatePolicy;")), /policy hook: 0 matches/],
    ["boot changed", (x) => (x[BOOT] = x[BOOT].replace("compileCache", "cache")), /shim require: 0 matches/],
    ["update channel renamed", (x) => (x[MAIN] = x[MAIN].replace('"desktop:update-get-state"', '"desktop:updates:get-state"')), /update channels: 0 matches of const UPDATE_GET_STATE_CHANNEL/],
  ];
  for (const [name, change, why] of cases) {
    const x = { ...f };
    change(x);
    assert.notDeepEqual(x, f, name);
    try {
      skips(x, why);
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
});

test("the sidebar and the tooltip helper in one file: both edits land on it", () => {
  const f = fixture("0.1.13");
  const { [LOGIC]: logic, ...rest } = f;
  const path = archive({ ...rest, [SIDEBAR]: `${logic}\n${f[SIDEBAR]}` });
  assert.equal(run(path).status, 0);
  assert.equal(marker(path), "on\n");
  const text = contents(path)[SIDEBAR];
  assert.match(text, /\?\.nixUpdate&&![\w$]+&&![\w$]+&&![\w$]+\)return null;/, "the hide check");
  assert.match(text, /,__t3nix\}\)\{let /, "the icon helper");
  assert.match(text, /\{if\([\w$]+\?\.nixUpdate\)return\{title:`Update available`/, "the tooltip helper");
});

test("a file the notice needs gone or unpacked skips it, rather than failing the build", () => {
  const f = fixture("0.1.13");
  const { [BOOT]: _, ...noBoot } = f;
  skips(noBoot, /boot.cjs isn't a file packed in the archive/);
  const unpacked = archive(f, (h) => Object.assign(h.files!.apps.files!.desktop.files!["dist-electron"].files!["boot.cjs"], { unpacked: true }));
  const r = run(unpacked);
  assert.equal(r.status, 0, r.stderr);
  assert.match(marker(unpacked), /^off: .*boot.cjs isn't a file packed/);
});

test("the dialog's open state must be the sidebar component's own", () => {
  const f = fixture("0.1.13");
  const m = f[SIDEBAR].match(/\{open:([\w$]+),onOpenChange:([\w$]+),version:/)!;
  // Upstream's dialog no longer bound to it, and another dialog after the component.
  const other = f[SIDEBAR].replace(m[0], `{open:!1,onOpenChange:${m[2]},version:`) + `function zz(){return{open:otherOpen,onOpenChange:setOther,version:1}}`;
  skips({ ...f, [SIDEBAR]: other }, /update dialog: 0 matches/);
  // The name not declared by the component's useState.
  skips({ ...f, [SIDEBAR]: f[SIDEBAR].replace(m[0], `{open:zz,onOpenChange:${m[2]},version:`) }, /update dialog: its open state isn't the component's own/);
});

test("look-alikes outside the sidebar component are never edited", () => {
  const f = fixture("0.1.13");
  const m = f[SIDEBAR].match(/([\w$]+)=([\w$]+)\?([\w$]+)\.summary:/)!;
  // The component's summary changed, and the same shape in another function
  // after it: the notice is skipped, never put into that function.
  const moved = f[SIDEBAR].replace(m[0], `${m[1]}=${m[2]}?String(${m[3]}.summary):`) + `function other(${m[2]},${m[3]}){let ${m[1]}=${m[2]}?${m[3]}.summary:"";return ${m[1]}}`;
  skips({ ...f, [SIDEBAR]: moved }, /summary tooltip: 0 matches/);
  // The click guard likewise.
  const g = f[SIDEBAR].match(/([\w$]+)=([\w$]+)\?!0:([\w$]+)\?!1:([\w$]+)\?([\w$]+)\(([\w$]+)\):!([\w$]+)\(\6\)/)!;
  skips({ ...f, [SIDEBAR]: f[SIDEBAR].replace(g[0], `${g[1]}=!0`) + `function other(){let ${g[0]};return ${g[1]}}` }, /click guard: 0 matches/);
});

test("the component's own state and plan, and its update check, or no notice", () => {
  const f = fixture("0.1.13");
  const plan = f[SIDEBAR].match(/if\(![\w$]+&&!([\w$]+)&&![\w$]+\)return null;/)![1];
  // The click no longer checks for updates.
  skips({ ...f, [SIDEBAR]: f[SIDEBAR].replace(/\.checkForUpdate\(\)\.then\(/, ".getUpdateState().then(") }, /click: the component doesn't check for updates/);
  // The plan's binding gone from the component (named only, not declared).
  const declared = new RegExp(`,${escapeRegExp(plan)}=`);
  assert.ok(declared.test(f[SIDEBAR]));
  skips({ ...f, [SIDEBAR]: f[SIDEBAR].replace(declared, `,${plan}x=`) }, /hide check: its plan isn't the component's own/);
});

test("names that don't agree between edits skip the notice", () => {
  // The click guard reading another plan than the hide check's.
  const f = fixture("0.1.13");
  const m = f[SIDEBAR].match(/([\w$]+)=([\w$]+)\?!0:([\w$]+)\?!1:/)!;
  skips({ ...f, [SIDEBAR]: f[SIDEBAR].replace(m[0], `${m[1]}=${m[2]}?!0:zz?!1:`) }, /click guard: other names than the hide check's/);
});
