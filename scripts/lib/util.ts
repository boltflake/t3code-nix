// Small helpers shared by the scripts. Node's standard library only: no npm
// dependencies to keep up to date.
import { createHash } from "node:crypto";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VERSIONS = join(ROOT, "versions");
export const SYSTEMS = ["x86_64-linux", "aarch64-linux"] as const;
export const UA = "t3code-nix (https://github.com/swsammy/t3code-nix)";

/** One package's failure; callers catch it so the others carry on. */
export class Failed extends Error {}

export function fail(message: string): never {
  throw new Failed(message);
}

export interface Asset {
  url: string;
  hash: string;
  assetId?: number;
  digest?: string;
  checksumSource?: string;
  md5?: string | null;
}

export interface Pin {
  name: string;
  version: string;
  tag?: string;
  assets: Record<string, Asset>;
  licenses?: Record<string, { url: string; hash: string }>;
  /** t3code's pins only: the headless browser that release uses. */
  browser?: BrowserPin;
  /** t3code's pins only: the speech model the dictation checks use. */
  speech?: SpeechPin;
  /** t3code's desktop pins only: the Electron version the release bundles
   * (apps/desktop/package.json), or null when it isn't a plain X.Y.Z. */
  electron?: string | null;
  /** When upstream released this version, and what kind of time that is
   * (the status page; see settleReleased). */
  released?: Released;
}

/** `published`: a GitHub release's published_at; `uploaded`: the file's
 * Last-Modified (grok), often hours before the version is announced (the
 * `stable` pointer moves later); `built`: a manifest's build time, before the
 * release (claude); `seen`: no time from the source, so the update run that
 * wrote the pin. */
export interface Released {
  at: string;
  kind: "published" | "uploaded" | "built" | "seen";
}

const sameFiles = (a: Record<string, { hash: string }>, b: Record<string, { hash: string }>) => {
  const sa = Object.keys(a).sort(), sb = Object.keys(b).sort();
  return sa.join() === sb.join() && sa.every((s) => a[s].hash === b[s].hash);
};
/** Same downloads: the assets, and a t3code pin's browser archives and
 * speech model. Adding a browser or speech record to a pin that had none
 * changes no bytes. */
export const sameBytes = (old: Pin, next: Pin) =>
  sameFiles(old.assets, next.assets) && (!old.browser || (!!next.browser && sameFiles(old.browser.assets, next.browser.assets)))
  && (!old.speech || (!!next.speech && old.speech.url === next.speech.url && old.speech.sha256 === next.speech.sha256));

/** A pin's version as people should see it: a browser pin's is a nixpkgs
 * revision, so its browsers' versions and channel instead: ungoogled-chromium
 * (the default), chromium and google-chrome, each named, with any system one
 * isn't available on (a pin from before they were recorded: ungoogled's
 * version and the channel, as before). */
export const shownVersion = (pin: Pin & { chromium?: string; channel?: string; rev?: string; browsers?: Record<string, any> }) => {
  if (typeof pin.channel !== "string") return pin.version;
  if (typeof pin.chromium !== "string") return `${pin.channel} ${(pin.rev ?? pin.version).slice(0, 12)}`;
  if (!pin.browsers) return `${pin.chromium} (${pin.channel})`;
  const named = ([["chromium", "Chromium"], ["google-chrome", "Chrome"]] as const).map(([key, title]) => {
    const b = pin.browsers![key];
    const gone = Object.keys(b?.unavailable ?? {}).sort();
    const version = typeof b?.version === "string" ? b.version : "unknown";
    return `${title} ${version}${gone.length ? ` (unavailable on ${gone.join(", ")})` : ""}`;
  });
  return `ungoogled-chromium ${pin.chromium}, ${named.join(", ")} (${pin.channel})`;
};

/** A change that keeps the version and every download: only details (a URL,
 * an asset ID, grok's MD5). Never held, so the pin stays current. */
export const detailsOnly = (old: Pin | null, next: Pin) => !!old && old.version === next.version && sameBytes(old, next);

/** The nixpkgs revision a flake.lock (as text, or parsed) locks, or null. */
export function nixpkgsRev(lock: string | object | null): string | null {
  try {
    const doc: any = typeof lock === "string" ? JSON.parse(lock) : lock;
    const rev = doc?.nodes?.nixpkgs?.locked?.rev;
    return typeof rev === "string" ? rev : null;
  } catch {
    return null;
  }
}

/** The pin as it's kept: `released` copied from the old pin at the same
 * version (so a same-version resolve compares equal); for a new version,
 * the source's time when it's a real time not after `now`, unknown (left
 * out) when it isn't, and `seen` at `now` when the source gives none or the
 * version moved back (its original release time would show a gap of weeks). */
export function settleReleased(next: Pin, old: Pin | null, now: Date, movedBack: boolean): Pin {
  const { released, ...rest } = next;
  if (old && old.version === next.version) return old.released ? { ...rest, released: old.released } : rest;
  if (movedBack || !released) return { ...rest, released: { at: now.toISOString(), kind: "seen" } };
  const t = Date.parse(released.at);
  if (!Number.isFinite(t) || t > now.getTime()) return rest;
  return { ...rest, released: { at: new Date(t).toISOString(), kind: released.kind } };
}

/** The upstream release page of a pin downloaded from a GitHub release
 * (the status page, release bodies), or null. */
export function releaseNotes(pin: Pin): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\//.exec(Object.values(pin.assets ?? {})[0]?.url ?? "");
  return m && pin.tag ? `https://github.com/${m[1]}/releases/tag/${encodeURIComponent(pin.tag)}` : null;
}

/** The speech model the dictation checks transcribe with: whisper-tiny.en
 * from the release's own catalog (scripts/lib/speech.ts). */
export interface SpeechPin {
  /** Hugging Face repository, revision and file, as the catalog has them. */
  id: string;
  revision: string;
  filename: string;
  size: number;
  /** Hex SHA-256, as the catalog has it. */
  sha256: string;
  url: string;
  /** The catalog this record came from. */
  source: string;
  /** The catalog last read (the release's commit); differs from `source`
   * only when that catalog had no whisper-tiny.en and this one was kept. */
  checked: string;
  /** False when kept from an earlier catalog: the drift check then skips
   * it, since the release doesn't carry this model. */
  fromCatalog: boolean;
}

export interface BrowserPin {
  version: string;
  /** The file it was read from, at the release's commit. */
  source: string;
  assets: Record<string, { url: string; hash: string }>;
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** writeJson for a file the script writes again later: written next to it
 * and renamed over it, so the file is the old one or the new one, never half
 * of either (a temporary file left by a failed rename is removed). */
export function rewriteJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function currentPin(name: string, dir = VERSIONS): Pin | null {
  const file = join(dir, `${name}.json`);
  return existsSync(file) ? readJson<Pin>(file) : null;
}

export function sri(algo: "sha256" | "sha512", hex: string): string {
  const len = algo === "sha256" ? 64 : 128;
  if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex ?? "")) fail(`not a ${algo} checksum: ${JSON.stringify(hex)}`);
  return `${algo}-${Buffer.from(hex, "hex").toString("base64")}`;
}

/** The SHA-256s a checksum file gives for `asset`, from "<hash>  <name>"
 * lines (a leading "*" or a path is ignored), plus bare-hash lines if
 * `bare`. */
export function checksumsFor(text: string, asset: string, bare: boolean): string[] {
  const matches: string[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0] || !/^[0-9a-fA-F]{64}$/.test(parts[0])) continue;
    const named = parts.length > 1 && parts[parts.length - 1].replace(/^\*/, "").split("/").pop() === asset;
    if (named || (bare && parts.length === 1)) matches.push(parts[0].toLowerCase());
  }
  return matches;
}

/** {store path: narHash} from `nix path-info --json` (an array or an
 * object, depending on the Nix version). */
export function narHashes(json: string): Map<string, string> {
  const data = JSON.parse(json);
  return new Map(Array.isArray(data) ? data.map((d: any) => [d.path, d.narHash]) : Object.entries<any>(data).map(([p, d]) => [p, d.narHash]));
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function headers(url: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": UA, ...extra };
  if (url.startsWith("https://api.github.com/") && process.env.GH_TOKEN) {
    h.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  return h;
}

export const RETRIES = 3;

/** The detail of an unverified same-version change (one text, so the issue
 * isn't "changed" from run to run). */
export const UNVERIFIED = "files changed without a new version, and the vendor publishes no checksum; kept the old pin (check the file, then `node scripts/pin.ts vendor <name>` on a branch)";
const RETRY_AFTER_CAP_MS = 30_000;
/** Waits between attempts; tests replace it. */
export const timing = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), backoffMs: 1000 };

/** How long a Retry-After header asks us to wait: seconds, or an HTTP date.
 * Null if absent or unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS) : null;
}

/** GET (or POST with a JSON body) and read the whole body; fails on a non-2xx
 * reply. Reads (GET, and POSTs marked `read`, like GraphQL queries) are
 * retried on network errors (including a connection dropped while the body
 * arrives), 429 and 5xx, with back-off and honouring Retry-After; any other
 * error fails at once. */
export async function request(url: string,
  init: { body?: unknown; method?: string; accept?: string; read?: boolean; onHeaders?: (h: Headers) => void; timeoutMs?: number } = {}): Promise<Buffer> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const attempts = method === "GET" || method === "HEAD" || init.read ? RETRIES : 1;
  // timeoutMs is one deadline for all attempts and the waits between them
  // (a large download); without it, each attempt gets 60 s.
  const deadline = init.timeoutMs ? Date.now() + init.timeoutMs : null;
  for (let attempt = 1; ; attempt++) {
    let status: number | null = null;
    let retryAfter: string | null = null;
    let error: unknown = null;
    try {
      const res = await fetch(url, {
        method,
        headers: headers(url, {
          ...(init.accept ? { Accept: init.accept } : url.startsWith("https://api.github.com/") ? { Accept: "application/vnd.github+json" } : {}),
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        }),
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(deadline ? Math.max(1, deadline - Date.now()) : 60_000),
      });
      status = res.status;
      retryAfter = res.headers.get("retry-after");
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer());
        init.onHeaders?.(res.headers);
        return body;
      }
      await res.body?.cancel();
    } catch (e) {
      error = e;
    }
    const transient = error !== null || status === 429 || (status !== null && status >= 500);
    const wait = retryAfterMs(retryAfter) ?? timing.backoffMs * 2 ** (attempt - 1);
    if (!transient || attempt >= attempts || (deadline !== null && Date.now() + wait >= deadline)) {
      fail(`${method} ${url}: ${error !== null ? (error as Error)?.message ?? error : `HTTP ${status}`}`);
    }
    await timing.sleep(wait);
  }
}

// Within one run, a URL is fetched once: the four t3code pins share two
// releases, and their SHA256SUMS, tags and licenses are the same files.
const fetched = new Map<string, Promise<Buffer>>();

/** The body of a GET, fetched once per run. A failed fetch isn't kept. */
export function getBytes(url: string): Promise<Buffer> {
  let p = fetched.get(url);
  if (!p) {
    p = request(url);
    p.catch(() => fetched.delete(url));
    fetched.set(url, p);
  }
  return p;
}

export async function getText(url: string): Promise<string> {
  return (await getBytes(url)).toString("utf8");
}

/** Fetches JSON: GET, or POST with a JSON body. Tests pass fakes of this. */
export type FetchJson = (url: string, body?: unknown) => Promise<any>;

/** GET JSON (fetched once per run), or POST a read query (GraphQL). */
export const getJson: FetchJson = async (url, body) =>
  body === undefined ? JSON.parse(await getText(url)) : JSON.parse((await request(url, { body, read: true })).toString("utf8"));

/** Runs independent tasks together. Resolves to their results in order, or
 * rejects with the error of the first task (in order) that failed: the
 * error running them one after another would have raised. */
export async function allInOrder<T>(tasks: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  for (const s of settled) if (s.status === "rejected") throw s.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
}

/** Starts a task now; its error is raised only where its result is used, so
 * independent reads can run together and still fail at the point where
 * reading them one after another would have. */
export function early<T>(p: Promise<T>): () => Promise<T> {
  const settled = p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
  return async () => {
    const r = await settled;
    if (!r.ok) throw r.error;
    return r.value;
  };
}

/** Forget everything fetched (tests). */
export function clearFetched(): void {
  fetched.clear();
}

/** One Nix call (`nix`, `nix-store`, `nix-instantiate`, `nix-env`) that
 * `run` made: when it started and ended (wall clock, epoch milliseconds, so
 * it lines up with the Actions API's step times), the program, for `nix`
 * its subcommand, its arguments (shortened), its exit status and whether
 * its time limit ended it. The CI scripts write them into
 * their result files as `nixCalls`; nothing in CI reads them. */
export interface NixCall { start: number; end: number; cmd: string; sub: string; label: string; status: number; timedOut: boolean }
const NIX_PROGRAMS = new Set(["nix", "nix-store", "nix-instantiate", "nix-env"]);
/** The Nix calls made so far in this process, in order (calls run one at a
 * time: `run` is synchronous). */
export const nixCalls: NixCall[] = [];
/** The clock the record uses (tests replace it). */
export const nixClock = { now: () => Date.now() };

/** What a Nix call was: for `nix`, its subcommand (the first word that isn't
 * a flag, past any `--option NAME VALUE`); and its arguments as given,
 * shortened (whoever reads the record classifies them). */
function describe(cmd: string, args: string[]): { sub: string; label: string } {
  const text = args.join(" ").replace(/\s+/g, " ").trim();
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--option") i += 2;
    else if (!args[i].startsWith("-")) words.push(args[i]);
  }
  return {
    sub: cmd === "nix" ? (words[0] ?? "") : "",
    label: text.length > 200 ? `${text.slice(0, 197)}...` : text,
  };
}

/** Run a program; returns trimmed stdout. Throws on a non-zero exit. */
export function run(cmd: string, args: string[], opts: ExecFileSyncOptions = {}): string {
  const record = NIX_PROGRAMS.has(basename(cmd));
  const start = record ? nixClock.now() : 0;
  let status = 0, timedOut = false;
  try {
    // With stdio "inherit" there is no captured output: execFileSync returns null.
    // A generous buffer: verbose Nix output must not kill a command.
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, ...opts });
    return out == null ? "" : String(out).trim();
  } catch (e: any) {
    status = typeof e.status === "number" && e.status !== 0 ? e.status : 1;
    timedOut = e.code === "ETIMEDOUT";
    throw e;
  } finally {
    if (record) {
      const call: NixCall = { start, end: nixClock.now(), cmd: basename(cmd), ...describe(basename(cmd), args), status, timedOut };
      nixCalls.push(call);
      // One line as it ends, with the same fields, so a step killed by its
      // own time limit (which writes no result file) still shows the calls
      // it finished.
      console.error(`nix call: ${JSON.stringify(call)}`);
    }
  }
}

/** Like run, but returns { status, stdout, stderr } instead of throwing. */
export function tryRun(cmd: string, args: string[], opts: ExecFileSyncOptions = {}): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: run(cmd, args, opts), stderr: "" };
  } catch (e: any) {
    // Any exception is a failure: a spawn error can carry status 0.
    const status = typeof e.status === "number" && e.status !== 0 ? e.status : 1;
    const stderr = [String(e.stderr ?? "").trim(), e.code || e.signal ? `(${e.code ?? e.signal}: ${e.message})` : ""].filter(Boolean).join("\n");
    return { status, stdout: String(e.stdout ?? "").trim(), stderr };
  }
}

export const git = (...args: string[]) => run("git", args);
