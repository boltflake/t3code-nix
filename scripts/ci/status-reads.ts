// The status page's reads that need no secret (pages.yml's `live` job): the
// unfinished update.yml runs on main and what each one's candidate tests,
// and the open t3code-nix issues. Writes {runs, issues} as JSON, validated,
// for the build job (scripts/status-live.ts).
//
//   node status-reads.ts OUT_JSON
//
// A candidate artifact comes from a run whose other jobs run vendor code and
// hold the run's artifact token, so it is untrusted data: only its
// inputs.json member is read, in memory, within size caps; nothing is
// written to disk; a zip that isn't plainly well formed (see inputsJson), or
// has an absolute, `..` or symlink entry, is ignored;
// an entry counts only for a pin name versions/ has and a version that reads
// as one. A run whose artifact fails any of this is kept with no inputs: one
// bad artifact never ends the live view. Listing the runs or the issues
// failing does (the script exits 1).
//
// Needs GH_TOKEN with actions: read and issues: read.
import { readdirSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { plausibleVersion } from "../../shared/sources.ts";
import { UA, VERSIONS } from "../lib/util.ts";
import type { OpenIssue, Run } from "../status-live.ts";
import { GitHub, REPO } from "./gh.ts";
import { metaOf } from "./issues.ts";

/** The statuses of a run that hasn't finished (one query each). */
export const UNFINISHED = ["requested", "waiting", "pending", "queued", "in_progress"];
/** Caps on a candidate: the zip, and inputs.json packed and unpacked. */
export const MAX_ZIP = 1 << 20, MAX_MEMBER = 64 << 10;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** inputs.json's bytes from a zip held in memory, or null unless the zip
 * is plainly well formed: one disk, an end record with nothing after it, a
 * central directory exactly where and as long as it says, holding exactly
 * the entries it counts, each with a local header that agrees with it; no
 * ZIP64; no entry absolute, climbing out with `..`, or a symlink; and
 * inputs.json stored or deflated, unencrypted, within the caps and exactly
 * its stated size. Nothing touches the disk. */
export function inputsJson(zip: Buffer): Buffer | null {
  if (zip.length > MAX_ZIP || zip.length < 22) return null;
  // The end record: the last 22 bytes, or before a comment that runs to
  // the end exactly.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const disk = zip.readUInt16LE(end + 4), cdDisk = zip.readUInt16LE(end + 6);
  const here = zip.readUInt16LE(end + 8), count = zip.readUInt16LE(end + 10);
  const cdSize = zip.readUInt32LE(end + 12), cdStart = zip.readUInt32LE(end + 16);
  if (disk !== 0 || cdDisk !== 0 || here !== count || count === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff) return null;
  if (cdStart + cdSize !== end) return null;
  let at = cdStart;
  let found: { method: number; size: number; packed: number; start: number } | null = null;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50) return null;
    const madeBy = zip.readUInt16LE(at + 4), flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28), extraLen = zip.readUInt16LE(at + 30), commentLen = zip.readUInt16LE(at + 32);
    const startDisk = zip.readUInt16LE(at + 34), external = zip.readUInt32LE(at + 38), local = zip.readUInt32LE(at + 42);
    const next = at + 46 + nameLen + extraLen + commentLen;
    if (next > end || startDisk !== 0 || packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return null;
    const nameBytes = zip.subarray(at + 46, at + 46 + nameLen);
    const name = nameBytes.toString("utf8");
    const symlink = madeBy >> 8 === 3 && ((external >>> 16) & 0o170000) === 0o120000;
    if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0") || name.split("/").includes("..") || symlink) return null;
    // Its local header, before the central directory, with the same name.
    if (local + 30 > cdStart || zip.readUInt32LE(local) !== 0x04034b50) return null;
    const localNameLen = zip.readUInt16LE(local + 26), localExtra = zip.readUInt16LE(local + 28);
    const start = local + 30 + localNameLen + localExtra;
    if (localNameLen !== nameLen || !zip.subarray(local + 30, local + 30 + nameLen).equals(nameBytes)) return null;
    // Data descriptors (bit 3) are fine: the sizes come from the central entry.
    if (start + packed > cdStart) return null;
    if (name === "inputs.json") {
      if (found || flags & 1 || (method !== 0 && method !== 8) || packed > MAX_MEMBER || size > MAX_MEMBER) return null;
      found = { method, size, packed, start };
    }
    at = next;
  }
  if (at !== end || !found) return null;
  const data = zip.subarray(found.start, found.start + found.packed);
  try {
    const out = found.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: MAX_MEMBER });
    return out.length === found.size ? out : null;
  } catch {
    return null;
  }
}

/** The pins and versions a candidate's inputs.json names, keeping only
 * pins in `pins` and versions that read as versions; null if it isn't a
 * candidate at all. */
export function candidateInputs(json: Buffer, pins: Set<string>): { name: string; version: string }[] | null {
  let data: any;
  try {
    data = JSON.parse(json.toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(data?.inputs)) return null;
  // A pin named twice can't say which version is tested: dropped.
  const names = data.inputs.map((i: any) => i?.name);
  return data.inputs.flatMap((i: any) => {
    const version = plausibleVersion(i?.to);
    const once = names.indexOf(i?.name) === names.lastIndexOf(i?.name);
    return typeof i?.name === "string" && pins.has(i.name) && version && once ? [{ name: i.name, version }] : [];
  });
}

/** A body read with a cap; null when it is longer. */
export async function capped(res: Response, max: number): Promise<Buffer | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    parts.push(Buffer.from(value));
  }
}

export async function readRuns(pins: Set<string>, repo = REPO, token = process.env.GH_TOKEN ?? "", f: Fetch = fetch,
  warn = (m: string) => console.error(`::warning::${m}`)): Promise<Run[]> {
  const headers = { "User-Agent": UA, Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` };
  const get = async (path: string) => {
    const res = await f(`https://api.github.com/repos/${repo}/${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };
  const byId = new Map<number, any>();
  for (const status of UNFINISHED) {
    const page = await get(`actions/workflows/update.yml/runs?branch=main&status=${status}&per_page=100`);
    for (const r of page?.workflow_runs ?? []) {
      // The run's own status wins over the query's, and a later query's over
      // an earlier one's; a run seen finished by now (a status outside
      // UNFINISHED) is left out, even if an earlier query had it unfinished.
      const own = r.status ?? status;
      if (!UNFINISHED.includes(own)) byId.delete(r.id);
      else if (!/dry run/i.test(String(r.display_title ?? ""))) byId.set(r.id, { ...r, status: own });
    }
  }
  const runs: Run[] = [];
  for (const r of byId.values()) {
    const run: Run = { id: Number(r.id), created: String(r.created_at), status: String(r.status), inputs: [] };
    runs.push(run);
    try {
      const list = await get(`actions/runs/${r.id}/artifacts?name=candidate&per_page=100`);
      const newest = (list?.artifacts ?? []).filter((a: any) => !a.expired)
        .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (!newest) continue;
      // The API answers with a redirect to storage: followed without the token.
      const res = await f(`https://api.github.com/repos/${repo}/actions/artifacts/${newest.id}/zip`, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const location = res.headers.get("location");
      const zipRes = location ? await f(location, { signal: AbortSignal.timeout(30_000) }) : res;
      if (!zipRes.ok) throw new Error(`artifact ${newest.id}: HTTP ${zipRes.status}`);
      const zip = await capped(zipRes, MAX_ZIP);
      const json = zip && inputsJson(zip);
      const inputs = json && candidateInputs(json, pins);
      if (!inputs) throw new Error(`artifact ${newest.id}: not a readable candidate`);
      run.inputs = inputs;
    } catch (e: any) {
      warn(`run ${r.id}: its candidate is ignored (${e?.message ?? e})`);
    }
  }
  return runs;
}

/** The open issues' numbers, keys and versions (malformed ones skipped). */
export async function readIssues(gh: Pick<GitHub, "openIssues"> = new GitHub()): Promise<OpenIssue[]> {
  return (await gh.openIssues()).filter((i) => i.state === "open").flatMap((i) => {
    const meta = metaOf(i);
    return meta ? [{ number: i.number, key: meta.key, version: meta.version }] : [];
  });
}

if (import.meta.main) {
  const [out] = process.argv.slice(2);
  if (!out) {
    console.error("usage: status-reads.ts OUT_JSON");
    process.exit(2);
  }
  const pins = new Set(readdirSync(VERSIONS).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
  const [runs, issues] = await Promise.all([readRuns(pins), readIssues()]);
  writeFileSync(out, `${JSON.stringify({ runs, issues })}\n`);
  console.log(`${runs.length} unfinished run(s), ${issues.length} open issue(s)`);
}
