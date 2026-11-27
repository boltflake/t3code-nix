// Replaces one returned string in one file of an Electron app.asar, in place:
//
//   node asar-replace.ts <app.asar> <path/in/asar> <old text> <new text>
//
// The old text must appear exactly once in the whole archive, in that file,
// as a double-quoted string right after `return `, ending the statement (a
// `;` or `}` next). The new string must be no longer; it is padded with
// spaces after its closing quote, so the file keeps its size and every
// offset in the archive stays valid. When the header holds the file's
// SHA-256 integrity (whole file and every block), it is checked and
// rewritten to match. When any of that doesn't hold, it fails before
// writing anything.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [asarPath, inner, oldText, newText] = process.argv.slice(2);
if (newText === undefined || oldText === "") {
  console.error("usage: asar-replace.ts <app.asar> <path/in/asar> <old text> <new text>");
  process.exit(2);
}
const fail = (message: string): never => {
  console.error(`asar-replace: ${asarPath}: ${message}`);
  process.exit(1);
};

const asar = readFileSync(asarPath);
// Chromium pickles, as electron/asar writes them: [4][header pickle size],
// then the header pickle: [payload size][JSON length][JSON, padded to 4].
if (asar.length < 16 || asar.readUInt32LE(0) !== 4) fail("not an asar archive");
const headerPickleSize = asar.readUInt32LE(4);
const jsonLength = asar.readUInt32LE(12);
const dataStart = 8 + headerPickleSize;
if (
  asar.readUInt32LE(8) !== headerPickleSize - 4 ||
  headerPickleSize !== 8 + Math.ceil(jsonLength / 4) * 4 ||
  dataStart > asar.length
) {
  fail("its header sizes don't add up");
}
const headerText = asar.subarray(16, 16 + jsonLength).toString("utf8");

type Integrity = { algorithm: string; hash: string; blockSize: number; blocks: string[] };
type Entry = { files?: Record<string, Entry>; size?: number; offset?: string; unpacked?: boolean; integrity?: Integrity };
const header: Entry = JSON.parse(headerText);
// The header is rewritten by serializing it again, so it must be what
// JSON.stringify gives (electron/asar writes it so).
if (JSON.stringify(header) !== headerText) fail("its header isn't in JSON.stringify's form");
let entry = header;
for (const part of inner.split("/")) {
  const next = entry.files && Object.hasOwn(entry.files, part) ? entry.files[part] : undefined;
  entry = next ?? fail(`no ${inner} in the archive`);
}
const offset = Number(entry.offset);
const size = entry.size;
if (
  entry.unpacked ||
  typeof entry.offset !== "string" ||
  !/^\d+$/.test(entry.offset) ||
  !Number.isSafeInteger(offset) ||
  !Number.isSafeInteger(size) ||
  size! < 0 ||
  dataStart + offset + size! > asar.length
) {
  fail(`${inner} isn't a file packed in the archive`);
}
const start = dataStart + offset;
const file = asar.subarray(start, start + size!);

const indexes = (haystack: Buffer, needle: Buffer) => {
  const found = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) found.push(i);
  return found;
};
const returned = Buffer.from(`return ${JSON.stringify(oldText)}`);
const oldLiteral = Buffer.from(JSON.stringify(oldText));
const newLiteral = Buffer.from(JSON.stringify(newText));
const at = indexes(file, returned);
// What follows must end the statement, so `return "<old>" + more` isn't
// taken for it (nor across a line break, which might not end it).
const ends = at.length === 1 && [";", "}"].includes(String.fromCharCode(file[at[0] + returned.length]));
// The text as it's written inside the string (escapes and all).
if (indexes(asar, oldLiteral.subarray(1, -1)).length !== 1 || !ends) {
  fail(`expected the text exactly once, returned as a string in ${inner}: ${oldText}`);
}
if (newLiteral.length > oldLiteral.length) fail(`the new text is longer than the old`);

const patched = Buffer.from(file);
Buffer.concat([newLiteral, Buffer.alloc(oldLiteral.length - newLiteral.length, " ")]).copy(
  patched,
  at[0] + "return ".length,
);

const integrity = entry.integrity;
if (integrity !== undefined) {
  const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const { blockSize, blocks } = integrity;
  if (integrity.algorithm !== "SHA256" || !Number.isSafeInteger(blockSize) || blockSize <= 0) {
    fail(`${inner}'s integrity in the header isn't SHA256 in blocks`);
  }
  const blockOf = (b: Buffer, i: number) => b.subarray(i * blockSize, (i + 1) * blockSize);
  if (
    integrity.hash !== sha256(file) ||
    !Array.isArray(blocks) ||
    // electron/asar (3.2.4) hashes a last, empty block when the size is a
    // whole number of blocks; without it, the count is rounded up.
    ![Math.floor(size! / blockSize) + 1, Math.max(1, Math.ceil(size! / blockSize))].includes(blocks.length) ||
    blocks.some((hash, i) => hash !== sha256(blockOf(file, i)))
  ) {
    fail(`${inner}'s integrity in the header doesn't match the file`);
  }
  integrity.hash = sha256(patched);
  integrity.blocks = blocks.map((_, i) => sha256(blockOf(patched, i)));
}
const newHeader = Buffer.from(JSON.stringify(header), "utf8");
if (newHeader.length !== jsonLength) fail("the rewritten header changed length");

patched.copy(asar, start);
newHeader.copy(asar, 16);
writeFileSync(asarPath, asar);
