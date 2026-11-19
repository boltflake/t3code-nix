// Smoke-test a wrapped `t3` in a throwaway home, in the Nix sandbox (the
// t3-smoke check): `t3 --version`, the server answering on loopback, `t3
// pair` minting a pairing URL, every bundled provider at its pinned version
// (EXPECTED_JSON: driver id -> version; only cursor and antigravity may
// report none before sign-in, and the drivers t3code reports must be exactly
// these), no codex copy under ~/.codex, and the HTML-preview browser at
// t3code's own path drawing text, with `t3 browser setup` calling the host
// ready. Nothing may be left running afterwards.
//
//   node t3-smoke.ts T3_BINARY EXPECTED_JSON BROWSER_PLATFORM BROWSER_VERSION
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { asPidNamespaceInit, exitText, freePort, killOthers, readRegular, removeTree, runGrouped, sleep, stopGroup, within } from "./lib/proc.ts";

const DEADLINE_MS = 120_000;
const NO_VERSION_BEFORE_SIGN_IN = new Set(["cursor", "antigravity"]);

export const finished = (s: any) => {
  const message = s?.message ?? "";
  return s?.installed !== undefined && s?.installed !== null && s.status !== "disabled"
    && !message.includes("not been checked") && !message.startsWith("Checking");
};
export const found = (driver: string, s: any, version: string) =>
  finished(s) && s.installed === true
  && (s.version === version || (s.version == null && NO_VERSION_BEFORE_SIGN_IN.has(driver)));

/** Why a command run by runGrouped with a 30 s limit failed, or undefined. */
function failure(what: string, r: ReturnType<typeof runGrouped>): string | undefined {
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return `${what} timed out after 30 s`;
  if (r.error) return `${what}: ${r.error.message}`;
  if (r.status !== 0) return `${what} exited with ${exitText(r.status, r.signal)}`;
  if (!r.reaped) return `${what} left processes that outlived SIGKILL`;
  return undefined;
}

/** `<binary> --version`, shown on the terminal; throws unless it exits 0
 * within 30 s. */
export function checkVersion(binary: string, env: NodeJS.ProcessEnv, cwd: string): void {
  const why = failure(`${binary} --version`, runGrouped(binary, ["--version"], {
    env, cwd, stdio: ["ignore", "inherit", "inherit"], timeout: 30_000,
  }));
  if (why) throw new Error(why);
}

/** One plain GET of `url`, given `ms`: `ok` if it answered 200 (directly;
 * a redirect isn't followed), else what happened instead. */
function attempt(url: string, ms: number): Promise<{ ok: boolean; outcome: string }> {
  return new Promise((resolve) => {
    const done = (ok: boolean, outcome: string) => {
      clearTimeout(timer);
      req.destroy();
      resolve({ ok, outcome });
    };
    const req = request(url, { agent: false }, (res) => done(res.statusCode === 200, `HTTP status ${res.statusCode}`));
    const timer = setTimeout(() => done(false, `no answer within ${ms} ms`), ms);
    req.on("error", (e: NodeJS.ErrnoException) =>
      done(false, `${e.code === "ECONNREFUSED" ? "connection refused" : "error"} (${e.message})`));
    req.end();
  });
}

interface Server { stop(): Promise<boolean>; running(): boolean }

/** Starts `t3 serve` on a free loopback port, in a process group of its
 * own, its output in `logFile`; resolves once it answers HTTP 200, throws
 * if it can't start, exits first, or `deadline` passes. */
export async function startServer(binary: string, env: NodeJS.ProcessEnv, cwd: string, state: string, logFile: string, deadline: number): Promise<Server> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const log = openSync(logFile, "w");
  let logOpen = true;
  const closeLog = () => logOpen && ((logOpen = false), closeSync(log));
  const cantStart = (e: unknown) => {
    closeLog();
    return new Error(`couldn't start ${binary} serve: ${(e as Error)?.message ?? e}`);
  };
  let server: ChildProcess;
  try {
    server = spawn(binary, ["serve", "--base-dir", state, "--host", "127.0.0.1", "--port", String(port)], {
      env, cwd, stdio: ["ignore", log, log], detached: true,
    });
  } catch (e) {
    throw cantStart(e);
  }
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
  const startError = await new Promise<Error | undefined>((resolve) => {
    server.once("spawn", () => resolve(undefined));
    server.once("error", resolve);
  });
  if (startError) throw cantStart(startError);
  const running = () => server.exitCode === null && server.signalCode === null;

  let stopping: Promise<boolean> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const ok = await stopGroup(server.pid);
      if (ok) await closed;
      // A process that outlived SIGKILL may never close: let go of it.
      else if ((await within(3000, closed.then(() => true))) === null) server.unref();
      closeLog();
      return ok;
    })());
  const fail = async (why: string): Promise<never> => {
    const ok = await stop();
    throw new Error(ok ? why : `${why} (and its processes outlived SIGKILL)`);
  };

  let ok = false;
  let last = "no attempt was made";
  for (;;) {
    // Also checked after a 200: it counts only if no exit was seen first.
    if (!running()) return fail(`t3 serve exited (${exitText(server.exitCode, server.signalCode)}) before answering 200 on ${url}`);
    if (ok) break;
    if (Date.now() > deadline) return fail(`t3 serve didn't answer 200 on ${url} before the deadline (${last})`);
    const r = await attempt(url, 1000);
    ok = r.ok;
    last = `last attempt: ${r.outcome}`;
    if (!ok) await sleep(250);
  }
  console.log(`server: answered 200 on ${url}`);
  return { stop, running };
}

/** True for a line `Pairing URL: <url>` (then only trailing spaces): an
 * http(s) URL, as written, with a host, the path /pair and the fragment
 * `token=<letters, digits, - or _>`; parsing checks the host and port. */
export function pairingLine(line: string): boolean {
  const url = /^Pairing URL: +([Hh][Tt][Tt][Pp][Ss]?:\/\/[^/?#\\\s]+\/pair#token=[\w-]+) *$/.exec(line)?.[1];
  return url !== undefined && URL.canParse(url);
}

/** `t3 pair` mints a pairing URL within 30 s: the problems found. */
export function pair(binary: string, env: NodeJS.ProcessEnv, cwd: string, state: string): string[] {
  const r = runGrouped(binary, ["pair", "--base-dir", state, "--ttl", "1m"], {
    env, cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30_000,
  });
  // Each stream on its own, so one's last line doesn't run into the other's first.
  const lines = [r.stdout, r.stderr].flatMap((s) => `${s ?? ""}`.split(/\r?\n/));
  const why = failure("t3 pair", r) ?? (lines.some(pairingLine) ? undefined : "t3 pair printed no pairing URL");
  if (why) {
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(-500);
    return [tail ? `${why}: ${tail}` : why];
  }
  console.log("pair: t3 pair minted a pairing URL");
  return [];
}

/** Codex didn't copy its own package into `home`'s ~/.codex: the problems
 * found. Only "doesn't exist" counts as absent: any other error while
 * looking is a problem, so the check never passes without having looked. */
export function codexCopies(home: string): string[] {
  const codex = join(home, ".codex");
  const copy = (p: string) => [`codex copied itself into the home folder: ${p} exists`];
  // ENOTDIR too: a part of the path is no folder, so the path doesn't exist.
  const absent = (e: any) => e?.code === "ENOENT" || e?.code === "ENOTDIR";
  const errors: string[] = [];
  const packages = join(codex, "packages");
  try {
    lstatSync(packages);
    return copy(packages);
  } catch (e: any) {
    if (!absent(e)) errors.push(`codex: couldn't inspect ${packages}: ${e?.message ?? e}`);
  }
  // Links aren't walked into (out of ~/.codex, or a loop); one named
  // `releases` counts if it points to a directory.
  const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  for (const dirs = [codex]; dirs.length;) {
    const dir = dirs.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e: any) {
      if (!absent(e)) errors.push(`codex: couldn't read ${dir}: ${e?.message ?? e}`);
      continue;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.name === "releases" && (e.isDirectory() || (e.isSymbolicLink() && isDir(path)))) return copy(path);
      if (e.isDirectory()) dirs.push(path);
    }
  }
  if (errors.length) return errors;
  console.log("codex: no copy of codex in ~/.codex");
  return [];
}

/** A PNG's size and its pixels (8-bit images, not interlaced: what
 * Chromium writes), or why it isn't one. Rows are unfiltered, so two
 * pictures compare by what they show, not how they were encoded. */
export function pngPixels(png: Buffer): { width: number; height: number; color: number; data: Buffer } | string {
  if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "not a PNG";
  const idat: Buffer[] = [];
  let width = 0, height = 0, depth = 0, color = -1, interlace = 0, ended = false;
  for (let at = 8; at + 12 <= png.length && !ended;) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (body.length !== length || (type === "IHDR" && length < 13)) return "a truncated chunk";
    if (type === "IHDR") [width, height, depth, color, interlace] = [body.readUInt32BE(0), body.readUInt32BE(4), body[8], body[9], body[12]];
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") ended = true;
    at += 12 + length;
  }
  if (!ended || !width || !height || !idat.length) return "an incomplete PNG";
  // Bytes per pixel for 8-bit grey, RGB, grey+alpha, RGBA.
  const bpp = depth === 8 && !interlace ? ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color] : undefined;
  if (!bpp) return `an unexpected PNG format (depth ${depth}, colour type ${color}, interlace ${interlace})`;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (e: any) {
    return `undecodable image data (${e?.message ?? e})`;
  }
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) return "image data of the wrong size";
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[(y - 1) * stride + x - bpp] : 0;
      const p = left + up - upLeft;
      const paeth = [left, up, upLeft].reduce((best, c) => (Math.abs(p - c) < Math.abs(p - best) ? c : best));
      const base = [0, left, up, (left + up) >> 1, paeth][filter];
      if (base === undefined) return `an unknown row filter ${filter}`;
      out[y * stride + x] = (row[x] + base) & 0xff;
    }
  }
  return { width, height, color, data: out };
}

/** Problems with the preview browser at t3code's path under `state`. */
function previewBrowser(binary: string, env: NodeJS.ProcessEnv, base: string, state: string, browser: { platform: string; version: string }): string[] {
  const dir = join(state, "tools", "chrome-headless-shell", browser.platform, browser.version);
  const exe = join(dir, "chrome-headless-shell");
  if (!existsSync(exe)) return [`preview browser: nothing at t3code's path ${dir}`];
  // A page with text and the same page without: different pictures mean
  // text was drawn.
  // Each command in its own process group, SIGKILLed with that group at
  // the deadline (a browser may ignore SIGTERM); whatever one leaves after
  // it ended is for the final check.
  const run = (cmd: string, args: string[]) => runGrouped(cmd, args, { env, cwd: base, timeout: 60_000, encoding: "utf8" });
  const why = (r: ReturnType<typeof run>) => (r as any).error?.code === "ETIMEDOUT" ? "timed out after 60 s"
    : r.error ? r.error.message : `${r.status === 0 ? "exited 0 without writing a screenshot" : `ended with ${exitText(r.status, r.signal)}`}: ${`${r.stdout}${r.stderr}`.trim().slice(-500)}`;
  const shot = (name: string, body: string) => {
    const file = join(base, `${name}.png`);
    const r = run(exe, ["--headless", "--disable-gpu", `--screenshot=${file}`, "--window-size=400,200",
      `data:text/html,<body style="margin:0;background:white">${body}</body>`]);
    if (r.error || r.status !== 0 || !existsSync(file)) return why(r);
    try { return readRegular(file); } catch (e: any) { return e?.message ?? String(e); }
  };
  const text = shot("text", "<h1>t3code-nix</h1>");
  const blank = shot("blank", "");
  if (typeof text === "string" || typeof blank === "string") return [`preview browser: no screenshot (${typeof text === "string" ? text : blank})`];
  const [a, b] = [pngPixels(text), pngPixels(blank)];
  if (typeof a === "string" || typeof b === "string") return [`preview browser: the screenshot is ${typeof a === "string" ? a : b}`];
  if (a.width !== b.width || a.height !== b.height || a.color !== b.color) {
    return [`preview browser: the screenshots differ in size or colour type (${a.width}x${a.height}/${a.color}, ${b.width}x${b.height}/${b.color})`];
  }
  if (a.data.equals(b.data)) return ["preview browser: the screenshot shows no text (no font?)"];
  console.log("browser: screenshot with text, through t3code's path");
  const setup = run(binary, ["browser", "setup", "--base-dir", state]);
  if (setup.error || setup.status !== 0 || !`${setup.stdout}`.includes("This host is ready for T3's browser.")) {
    return [`preview browser: t3 browser setup failed: ${why(setup)}`];
  }
  console.log("browser: t3 browser setup says the host is ready");
  return [];
}

/** Waits until t3code reports every expected driver, or the deadline:
 * the problems found. */
export async function providers(state: string, expected: Record<string, string>, deadline: number): Promise<string[]> {
  const failures: string[] = [];
  // t3code writes one status file per registered driver into caches/.
  const caches = join(state, "caches");
  let status: Record<string, any> = {};
  for (;;) {
    status = {};
    if (existsSync(caches)) {
      for (const f of readdirSync(caches).filter((f) => f.endsWith(".json"))) {
        try { status[f.slice(0, -5)] = JSON.parse(readRegular(join(caches, f), "utf8")); } catch { /* being written, or no regular file */ }
      }
    }
    const ok = Object.keys(expected).filter((d) => d in status && found(d, status[d], expected[d]));
    if (ok.length === Object.keys(expected).length || Date.now() > deadline) break;
    await sleep(1000);
  }

  const known = Object.keys(status).sort();
  const want = Object.keys(expected).sort();
  if (known.join() !== want.join()) {
    failures.push(`driver-coverage: t3code reports ${known.join(", ")}; we ship ${want.join(", ")}; `
      + `new: ${known.filter((d) => !want.includes(d)).join(", ") || "none"}, gone: ${want.filter((d) => !known.includes(d)).join(", ") || "none"}`);
  }
  for (const driver of want) {
    if (!(driver in status)) continue; // driver-coverage says so
    const s = status[driver];
    if (typeof s !== "object" || s === null) {
      failures.push(`${driver}: its status file holds ${JSON.stringify(s)}, not a status`);
      continue;
    }
    const good = found(driver, s, expected[driver]);
    console.log(`  ${driver.padEnd(12)} installed=${s.installed} version=${s.version} status=${s.status} ${good ? "ok" : "WRONG"}`);
    if (!finished(s)) failures.push(`${driver}: still not probed by the deadline (${s.message})`);
    else if (!good) failures.push(`${driver}: expected ${expected[driver]}, t3code found ${JSON.stringify(s.version)} (${s.message})`);
  }
  return failures;
}

async function main(binary: string, expectedFile: string, browser: { platform: string; version: string }): Promise<void> {
  const expected: Record<string, string> = JSON.parse(readFileSync(expectedFile, "utf8"));
  const base = mkdtempSync(join(tmpdir(), "t3-smoke-"));
  const logFile = join(base, "server.log");
  const failures: string[] = [];
  try {
    const state = join(base, "state");
    mkdirSync(join(state, "userdata"), { recursive: true });
    // t3code enables only codex and claude by default; switch them all on.
    const providerInstances = Object.fromEntries(Object.keys(expected).map((d) => [d, { driver: d, enabled: true }]));
    writeFileSync(join(state, "userdata", "settings.json"), JSON.stringify({ providerInstances }));

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, TZ: process.env.TZ, LANG: process.env.LANG,
      HOME: base, TMPDIR: base, XDG_CONFIG_HOME: join(base, ".config"),
      XDG_DATA_HOME: join(base, ".local/share"), XDG_CACHE_HOME: join(base, ".cache"),
      FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
    };
    checkVersion(binary, env, base);

    const deadline = Date.now() + DEADLINE_MS;
    const server = await startServer(binary, env, base, state, logFile, deadline);
    try {
      failures.push(...pair(binary, env, base, state));
      failures.push(...(await providers(state, expected, deadline)));
      if (!server.running()) failures.push("t3 serve exited by itself while the test ran");
    } finally {
      if (!(await server.stop())) failures.push("t3 serve's processes outlived SIGKILL");
    }
    failures.push(...codexCopies(base));
    failures.push(...previewBrowser(binary, env, base, state, browser));
  } catch (e: any) {
    // A step that can't go on (no version, no server): report it below too.
    failures.push(e?.message ?? String(e));
  } finally {
    // This test is PID 1 of a PID namespace of its own: anything else still
    // in it escaped every clean-up above.
    const left = await killOthers();
    if (left.length) failures.push(`processes outlived the test (killed now): ${left.join("; ")}`);
    if (failures.length) {
      try {
        if (existsSync(logFile)) process.stderr.write(readRegular(logFile, "utf8").slice(-4000));
      } catch (e: any) {
        failures.push(`couldn't read the server log: ${e?.message ?? e}`);
      }
      console.error(`FAILED:\n  ${failures.join("\n  ")}`);
      process.exitCode = 1;
    } else {
      console.log("all checks passed");
    }
    removeTree(base);
  }
}

if (import.meta.main && (await asPidNamespaceInit())) {
  const [binary, expected, platform, version] = process.argv.slice(2);
  if (!binary || !expected || !platform || !version) {
    console.error("usage: t3-smoke.ts T3_BINARY EXPECTED_JSON BROWSER_PLATFORM BROWSER_VERSION");
    process.exit(2);
  }
  await main(binary, expected, { platform, version });
}
