// Reads and rewrites Electron's app.asar (electron/asar's layout: Chromium
// pickles, [4][header pickle size], then [payload size][JSON length][JSON,
// padded to 4], then the files' data). A rewrite keeps every byte of the
// existing data where it is and appends changed and new files after it, so
// only the header changes for files it doesn't touch; unpacked entries
// (data in app.asar.unpacked) are never touched.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export type Integrity = { algorithm: string; hash: string; blockSize: number; blocks: string[] };
export type Entry = {
  files?: Record<string, Entry>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  executable?: boolean;
  link?: string;
  integrity?: Integrity;
};

export class AsarError extends Error {}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** electron/asar (3.2.4) hashes a last, empty block when the size is a whole
 * number of blocks; Electron's own check accepts that count or the rounded
 * up one. */
export function integrityOf(b: Buffer, blockSize: number, lastEmpty = true): Integrity {
  const count = lastEmpty ? Math.floor(b.length / blockSize) + 1 : Math.max(1, Math.ceil(b.length / blockSize));
  const blocks = [];
  for (let i = 0; i < count; i++) blocks.push(sha256(b.subarray(i * blockSize, (i + 1) * blockSize)));
  return { algorithm: "SHA256", hash: sha256(b), blockSize, blocks };
}

export class Asar {
  readonly header: Entry;
  private readonly data: Buffer;
  private readonly changed = new Map<string, Buffer>();

  constructor(bytes: Buffer) {
    const fail = (m: string): never => {
      throw new AsarError(m);
    };
    if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) fail("not an asar archive");
    const headerPickleSize = bytes.readUInt32LE(4);
    const jsonLength = bytes.readUInt32LE(12);
    const dataStart = 8 + headerPickleSize;
    if (
      bytes.readUInt32LE(8) !== headerPickleSize - 4 ||
      headerPickleSize !== 8 + Math.ceil(jsonLength / 4) * 4 ||
      dataStart > bytes.length
    ) {
      fail("its header sizes don't add up");
    }
    const text = bytes.subarray(16, 16 + jsonLength).toString("utf8");
    this.header = JSON.parse(text);
    // The header is written back by serializing it again, so it must be
    // what JSON.stringify gives (electron/asar writes it so).
    if (JSON.stringify(this.header) !== text) fail("its header isn't in JSON.stringify's form");
    this.data = bytes.subarray(dataStart);
  }

  static read(path: string): Asar {
    return new Asar(readFileSync(path));
  }

  /** The entry at `path` (slash-separated), or undefined. */
  entry(path: string): Entry | undefined {
    let e: Entry | undefined = this.header;
    for (const part of path.split("/")) e = e?.files && Object.hasOwn(e.files, part) ? e.files[part] : undefined;
    return e;
  }

  /** The packed files under `dir` (slash-separated paths), in header order. */
  list(dir = ""): string[] {
    const out: string[] = [];
    const walk = (e: Entry, at: string) => {
      for (const [name, child] of Object.entries(e.files ?? {})) {
        const p = at ? `${at}/${name}` : name;
        if (child.files) walk(child, p);
        else if (!child.unpacked && child.link === undefined) out.push(p);
      }
    };
    const start = dir ? this.entry(dir) : this.header;
    if (start?.files) walk(start, dir);
    return out;
  }

  private packed(path: string): Entry & { size: number; offset: string } {
    const e = this.entry(path);
    const offset = Number(e?.offset);
    if (
      !e ||
      e.files ||
      e.unpacked ||
      typeof e.offset !== "string" ||
      !/^\d+$/.test(e.offset) ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(e.size) ||
      e.size! < 0 ||
      offset + e.size! > this.data.length
    ) {
      throw new AsarError(`${path} isn't a file packed in the archive`);
    }
    return e as Entry & { size: number; offset: string };
  }

  /** A packed file's bytes, as changed so far, its integrity checked when the
   * header has it. */
  file(path: string): Buffer {
    const now = this.changed.get(path);
    if (now) return now;
    const e = this.packed(path);
    const body = this.data.subarray(Number(e.offset), Number(e.offset) + e.size);
    const i = e.integrity;
    if (i !== undefined) {
      const counts = [Math.floor(e.size / i.blockSize) + 1, Math.max(1, Math.ceil(e.size / i.blockSize))];
      if (
        i.algorithm !== "SHA256" ||
        !Number.isSafeInteger(i.blockSize) ||
        i.blockSize <= 0 ||
        !Array.isArray(i.blocks) ||
        !counts.includes(i.blocks.length) ||
        i.hash !== sha256(body) ||
        i.blocks.some((h, n) => h !== sha256(body.subarray(n * i.blockSize, (n + 1) * i.blockSize)))
      ) {
        throw new AsarError(`${path}'s integrity in the header doesn't match the file`);
      }
    }
    return body;
  }

  text(path: string): string {
    return this.file(path).toString("utf8");
  }

  /** Replaces a packed file's contents. */
  set(path: string, body: Buffer | string): void {
    this.packed(path);
    this.changed.set(path, Buffer.from(body));
  }

  private readonly addedPaths = new Set<string>();

  /** Adds a new packed file in an existing folder. */
  add(path: string, body: Buffer | string): void {
    const at = path.lastIndexOf("/");
    const dir = at < 0 ? this.header : this.entry(path.slice(0, at));
    const name = path.slice(at + 1);
    if (!dir?.files) throw new AsarError(`no folder for ${path} in the archive`);
    if (Object.hasOwn(dir.files, name)) throw new AsarError(`${path} is already in the archive`);
    dir.files[name] = { size: 0, offset: "0" };
    this.addedPaths.add(path);
    this.changed.set(path, Buffer.from(body));
  }

  /** The archive with the changes: the old data as it is, then each changed
   * or added file, with sizes, offsets and integrity rewritten. */
  bytesOut(): Buffer {
    const header: Entry = structuredClone(this.header);
    const appended: Buffer[] = [];
    let next = this.data.length;
    for (const [path, body] of this.changed) {
      let e: Entry = header;
      for (const part of path.split("/")) e = e.files![part];
      const old = e.integrity;
      const blockSize = old?.blockSize ?? 4 * 1024 * 1024;
      // Keep the block count convention the archive was written with.
      const lastEmpty = old === undefined || old.blocks.length === Math.floor(e.size! / old.blockSize) + 1;
      const added = this.addedPaths.has(path);
      e.size = body.length;
      e.offset = String(next);
      // A changed file keeps integrity only if it had it; an added one gets
      // it, as electron/asar writes every file.
      if (old !== undefined || added) e.integrity = integrityOf(body, blockSize, lastEmpty);
      appended.push(body);
      next += body.length;
    }
    const json = Buffer.from(JSON.stringify(header), "utf8");
    const padded = Math.ceil(json.length / 4) * 4;
    const head = Buffer.alloc(16 + padded);
    head.writeUInt32LE(4, 0);
    head.writeUInt32LE(8 + padded, 4);
    head.writeUInt32LE(4 + padded, 8);
    head.writeUInt32LE(json.length, 12);
    json.copy(head, 16);
    return Buffer.concat([head, this.data, ...appended]);
  }

  write(path: string): void {
    writeFileSync(path, this.bytesOut());
  }
}
