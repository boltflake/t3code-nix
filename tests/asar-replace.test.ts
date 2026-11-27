// asar-replace.ts, which gives the desktop app our reason for its updates
// being off, on small archives laid out as Electron's are.
// Run: node --test tests/*.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";

const script = join(import.meta.dirname, "../scripts/asar-replace.ts");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const OLD = "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
const NEW = "Nix manages this install. Please rebuild your system to update T3 Code.";
const BLOCK = 64;
const tmp = mkdtempSync(join(tmpdir(), "asar-replace-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

type Integrity = { algorithm: string; hash: string; blockSize: number; blocks: string[] };
type Header = { files: Record<string, { files: Record<string, { size: number; offset: string; integrity: Integrity }> }> };

/** As electron/asar 3.2.4 hashes: a last block always, empty when the size
 * is a whole number of blocks. */
function integrity(b: Buffer, block = BLOCK): Integrity {
  const blocks = [];
  for (let i = 0; i <= b.length; i += block) blocks.push(sha256(b.subarray(i, i + block)));
  return { algorithm: "SHA256", hash: sha256(b), blockSize: block, blocks };
}

/** An archive of dist/other.js then dist/main.cjs (at a nonzero offset), as
 * Chromium pickles it, in blocks of `block`; `edit` changes the header
 * before it's written. */
function archive(main: string, other = "other();\n", edit = (_: Header) => {}, block = BLOCK): string {
  const [o, m] = [Buffer.from(other), Buffer.from(main)];
  const header: Header = {
    files: {
      dist: {
        files: {
          "other.js": { size: o.length, offset: "0", integrity: integrity(o, block) },
          "main.cjs": { size: m.length, offset: String(o.length), integrity: integrity(m, block) },
        },
      },
    },
  };
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
  writeFileSync(path, Buffer.concat([head, padded, o, m]));
  return path;
}

function read(path: string) {
  const asar = readFileSync(path);
  const header: Header = JSON.parse(asar.subarray(16, 16 + asar.readUInt32LE(12)).toString());
  const start = 8 + asar.readUInt32LE(4);
  const file = (name: string) => {
    const e = header.files.dist.files[name];
    const at = start + Number(e.offset);
    return { body: asar.subarray(at, at + e.size), integrity: e.integrity };
  };
  return { asar, main: file("main.cjs"), other: file("other.js") };
}

const replace = (path: string, from = OLD, to = NEW, inner = "dist/main.cjs") =>
  spawnSync(process.execPath, [script, path, inner, from, to], { encoding: "utf8" });

/** Fails as `message` says, leaving the archive byte for byte. */
function refuses(path: string, message: RegExp, ...args: Parameters<typeof replace> extends [string, ...infer R] ? R : never) {
  const before = readFileSync(path);
  const r = replace(path, ...args);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, message);
  assert.deepEqual(readFileSync(path), before);
}

const cjs = (sentence: string, pad = "") =>
  `"use strict";${pad}\nfunction reason(args) {\n  if (args.disabledByEnv) return ${JSON.stringify(sentence)};\n  return null;\n}\nmodule.exports = { reason };\n`;

for (const [name, block] of [
  ["a file of several blocks", BLOCK],
  ["a file of one block, whose hash is its block's", 4096],
] as const) {
  test(`swaps the returned sentence, padded to its length, and updates the hashes: ${name}`, () => {
    const main = cjs(OLD);
    const path = archive(main, undefined, undefined, block);
    const before = read(path);
    assert.equal(before.main.integrity.blocks.length > 1, block === BLOCK);
    const r = replace(path);
    assert.equal(r.status, 0, r.stderr);
    const now = read(path);
    assert.equal(now.asar.length, before.asar.length);
    const body = now.main.body.toString();
    assert.equal(body, main.replace(JSON.stringify(OLD), JSON.stringify(NEW) + " ".repeat(OLD.length - NEW.length)));
    // Still valid CommonJS, and it returns the new sentence.
    const mod = { exports: {} as { reason: (a: object) => string } };
    new Script(`(function (module) {${body}\n})`).runInThisContext()(mod);
    assert.equal(mod.exports.reason({ disabledByEnv: true }), NEW);
    assert.deepEqual(now.main.integrity, integrity(now.main.body, block));
    if (block === BLOCK) assert.equal(now.main.integrity.blocks[0], before.main.integrity.blocks[0]);
    assert.deepEqual(now.other, before.other);
  });
}

test("refuses when the sentence isn't returned as a string exactly once", () => {
  const once = /expected the text exactly once/;
  refuses(archive("return 'no such sentence';\n"), once);
  refuses(archive(`a = ${JSON.stringify(OLD)}; b = ${JSON.stringify(OLD)};\n`), once);
  refuses(archive(`return \`${OLD}\`;\n`), once);
  refuses(archive(`// it said ${JSON.stringify(OLD)}\nreturn "something else";\n`), once);
  refuses(archive(`const message = ${JSON.stringify(OLD)};\n`), once);
  // Returned with more after it: the start of a longer reason.
  refuses(archive(`function f(s) { return ${JSON.stringify(OLD)} + s; }\n`), once);
  refuses(archive(`function f(s) { return ${JSON.stringify(OLD)}, s; }\n`), once);
  // In the file, and in another file too.
  refuses(archive(cjs(OLD), `// ${OLD}\n`), once);
});

test("refuses a longer sentence and a missing or unpacked file", () => {
  refuses(archive(cjs(OLD)), /longer than the old/, OLD, OLD + "!");
  refuses(archive(cjs(OLD)), /no dist\/nope.cjs in the archive/, OLD, NEW, "dist/nope.cjs");
  refuses(archive(cjs(OLD)), /no dist\/constructor in the archive/, OLD, NEW, "dist/constructor");
  refuses(
    archive(cjs(OLD), undefined, (h) => Object.assign(h.files.dist.files["main.cjs"], { unpacked: true })),
    /isn't a file packed in the archive/,
  );
  refuses(
    archive(cjs(OLD), undefined, (h) => (h.files.dist.files["main.cjs"].size += 10)),
    /isn't a file packed in the archive/,
  );
  // A negative size, which Buffer.subarray would count from the end.
  refuses(
    archive(cjs(OLD), undefined, (h) => (h.files.dist.files["main.cjs"].size = -1)),
    /isn't a file packed in the archive/,
  );
});

test("refuses hashes that don't match the file", () => {
  const stale = /integrity in the header doesn't match/;
  // A changed byte of main.cjs (not the sentence's).
  const path = archive(cjs(OLD, "/*" + "a".repeat(100) + "*/"));
  const changed = readFileSync(path);
  changed[changed.length - 2] ^= 1;
  writeFileSync(path, changed);
  refuses(path, stale);
  // A wrong block hash beside a right whole-file hash, and missing blocks.
  const pad = "/*" + "a".repeat(100) + "*/";
  refuses(archive(cjs(OLD, pad), undefined, (h) => (h.files.dist.files["main.cjs"].integrity.blocks[1] = "0".repeat(64))), stale);
  refuses(archive(cjs(OLD, pad), undefined, (h) => h.files.dist.files["main.cjs"].integrity.blocks.pop()), stale);
  refuses(archive(cjs(OLD, pad), undefined, (h) => (h.files.dist.files["main.cjs"].integrity.blocks = [])), stale);
});

test("refuses a file that isn't an asar archive", () => {
  const path = join(mkdtempSync(join(tmp, "a-")), "app.asar");
  writeFileSync(path, "not an archive at all");
  refuses(path, /not an asar archive/);
});

test("refuses integrity that isn't SHA256 in whole blocks", () => {
  const shape = /isn't SHA256 in blocks/;
  const set = (patch: Partial<Integrity>) => (h: Header) => Object.assign(h.files.dist.files["main.cjs"].integrity, patch);
  refuses(archive(cjs(OLD), undefined, set({ blockSize: 0 })), shape);
  refuses(archive(cjs(OLD), undefined, set({ blockSize: 1.5 })), shape);
  refuses(archive(cjs(OLD), undefined, set({ algorithm: "SHA1" })), shape);
});

test("patches a file without integrity, leaving the header as it was", () => {
  const path = archive(cjs(OLD), undefined, (h) => {
    delete (h.files.dist.files["main.cjs"] as { integrity?: Integrity }).integrity;
  });
  const before = readFileSync(path);
  const headerEnd = 8 + before.readUInt32LE(4);
  const r = replace(path);
  assert.equal(r.status, 0, r.stderr);
  const now = readFileSync(path);
  assert.deepEqual(now.subarray(0, headerEnd), before.subarray(0, headerEnd));
  assert.match(now.toString(), new RegExp(`return ${JSON.stringify(NEW)} +;`));
});

test("refuses a header it couldn't write back the same way", () => {
  const path = archive(cjs(OLD));
  const asar = readFileSync(path);
  const length = asar.readUInt32LE(12);
  const json = asar.subarray(16, 16 + length).toString();
  // The same header with a space after its first colon, in the same bytes:
  // the padding after the JSON takes the extra one.
  const spaced = Buffer.from(json.replace(":", ": "));
  assert.ok(16 + spaced.length <= 8 + asar.readUInt32LE(4), "the fixture's padding fits a byte");
  spaced.copy(asar, 16);
  asar.writeUInt32LE(spaced.length, 12);
  writeFileSync(path, asar);
  refuses(path, /isn't in JSON.stringify's form/);
});

test("refuses header sizes that don't add up", () => {
  const sizes = /header sizes don't add up/;
  const broken = (at: number, delta: number) => {
    const path = archive(cjs(OLD));
    const asar = readFileSync(path);
    asar.writeUInt32LE(asar.readUInt32LE(at) + delta, at);
    writeFileSync(path, asar);
    return path;
  };
  refuses(broken(8, 4), sizes); // payload size isn't the pickle's
  refuses(broken(12, 4096), sizes); // JSON past the header
  const path = archive(cjs(OLD));
  const asar = readFileSync(path);
  asar.writeUInt32LE(asar.length, 4);
  asar.writeUInt32LE(asar.length - 4, 8);
  writeFileSync(path, asar);
  refuses(path, sizes); // header past the end of the file
  // Four more bytes of padding than the JSON needs, consistently declared.
  const padded = archive(cjs(OLD));
  const extra = readFileSync(padded);
  extra.writeUInt32LE(extra.readUInt32LE(4) + 4, 4);
  extra.writeUInt32LE(extra.readUInt32LE(8) + 4, 8);
  writeFileSync(padded, extra);
  refuses(padded, sizes);
});

test("takes a statement ending in a brace, not at a line end", () => {
  const path = archive(`function f() { return ${JSON.stringify(OLD)}}\n`);
  const r = replace(path);
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(path).main.body.toString(), new RegExp(`return ${JSON.stringify(NEW)} +}`));
  // A line end might not end it: `return "<old>"` then `+ s` on the next line.
  refuses(archive(`function f(s) { return ${JSON.stringify(OLD)}\n  + s; }\n`), /expected the text exactly once/);
});

test("finds a sentence with escapes, as written in the string", () => {
  const old = 'A "quoted" switch\\';
  const path = archive(`function f() { return ${JSON.stringify(old)}; }\n`);
  const r = replace(path, old, "Short.");
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(path).main.body.toString(), /return "Short\." +;/);
});

test("takes a file of a whole number of blocks, with or without a last empty block", () => {
  const body = cjs(OLD);
  const main = body + "/*" + "a".repeat(BLOCK * 4 - body.length - 5) + "*/\n";
  assert.equal(main.length, BLOCK * 4);
  for (const trailing of [true, false]) {
    const path = archive(main, undefined, (h) => {
      if (!trailing) h.files.dist.files["main.cjs"].integrity.blocks.pop();
    });
    assert.equal(read(path).main.integrity.blocks.length, trailing ? 5 : 4);
    const r = replace(path);
    assert.equal(r.status, 0, r.stderr);
    const now = read(path);
    const expected = integrity(now.main.body);
    if (!trailing) expected.blocks.pop();
    assert.deepEqual(now.main.integrity, expected);
  }
});

test("refuses an empty old text with its usage", () => {
  const path = archive(cjs(OLD));
  const before = readFileSync(path);
  const r = replace(path, "");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
  assert.deepEqual(readFileSync(path), before);
});
