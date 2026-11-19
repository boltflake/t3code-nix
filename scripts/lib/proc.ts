// Processes, process groups and the other chores the smoke tests share.
// Only Node built-ins: lib/checks.nix copies just this file next to
// t3-smoke.ts and acp-check.ts.
import { spawn, spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, closeSync, constants as fsConstants, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** `promise`'s value, or null after `ms`; the timer is cleared either way. */
export async function within<T>(ms: number, promise: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** A loopback port nothing listens on (the kernel's pick, released). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** Remove a throwaway folder, even one a program under test made
 * unreadable (folders are given their owner's rights back first). */
export function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    const fix = (d: string) => {
      try { chmodSync(d, 0o700); } catch { /* not ours */ }
      for (const e of (() => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } })()) {
        if (e.isDirectory()) fix(join(d, e.name));
      }
    };
    fix(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A regular file's contents, read without ever waiting: opened without
 * blocking and checked after opening, so anything else in its place (a
 * FIFO a program under test left there, a folder, a device) throws instead
 * of hanging the test. */
export function readRegular(path: string): Buffer;
export function readRegular(path: string, encoding: BufferEncoding): string;
export function readRegular(path: string, encoding?: BufferEncoding): Buffer | string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} isn't a regular file`);
    const data = readFileSync(fd);
    return encoding ? data.toString(encoding) : data;
  } finally {
    closeSync(fd);
  }
}

/** How a process ended, for messages: "code 3" or "signal SIGKILL". */
export const exitText = (code: number | null, signal: string | null) =>
  code === null ? `signal ${signal}` : `code ${code}`;

/** Signal a whole process group; it may already be gone. */
export function killGroup(pid: number, signal: NodeJS.Signals | 0): void {
  try {
    process.kill(-pid, signal);
  } catch { /* already gone */ }
}

/** A /proc stat file's state letter ("Z" for a zombie), parent and process
 * group (`path`: /proc/<pid>/stat, or a thread's); throws if it's gone. The
 * command name before ")" may hold spaces and parentheses. */
export function procStat(path: string): { state: string; ppid: number; pgid: number } {
  const stat = readFileSync(path, "latin1");
  const [state, ppid, pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state, ppid: Number(ppid), pgid: Number(pgid) };
}

/** True if `pid` is gone or a zombie: every one of its threads has
 * exited (a process whose main thread alone exited still runs). */
function gone(pid: number): boolean {
  let tasks: string[];
  try { tasks = readdirSync(`/proc/${pid}/task`); } catch { return true; }
  return tasks.every((t) => {
    try {
      return procStat(`/proc/${pid}/task/${t}/stat`).state === "Z";
    } catch {
      return true;
    }
  });
}

/** True while any process in the group is left. Zombies don't count: they
 * only wait for a parent (perhaps a reaper outside the test) to collect
 * them. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
  } catch (e: any) {
    return e?.code === "EPERM";
  }
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (procStat(`/proc/${name}/stat`).pgid === pid && !gone(Number(name))) return true;
    } catch { /* gone meanwhile */ }
  }
  return false;
}

/** SIGTERM the group, then SIGKILL whatever is left after graceMs, and wait
 * until no process in it remains (the leader exiting isn't enough: a child
 * may ignore SIGTERM). False if something is still there after killMs. */
export async function stopGroup(pid: number | undefined, graceMs = 5000, killMs = 5000): Promise<boolean> {
  if (pid === undefined) return true;
  const gone = async (ms: number) => {
    for (const end = Date.now() + ms; groupAlive(pid) && Date.now() < end;) await sleep(50);
    return !groupAlive(pid);
  };
  killGroup(pid, "SIGTERM");
  if (await gone(graceMs)) return true;
  killGroup(pid, "SIGKILL");
  return gone(killMs);
}

/** spawnSync in a process group of its own. At the timeout the whole group
 * gets SIGKILL and is waited for, up to 5 s (`reaped` is false if something
 * outlived that). A command that ended by itself isn't a timeout, even when
 * a child it left kept its output open (Node then reports how the command
 * ended); what it left running is for the test's final check to find,
 * kill and report. (A command that kills itself with SIGKILL while a child
 * holds its output looks just like a timeout, and is reported as one.) */
export function runGrouped(cmd: string, args: string[], opts: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> & { reaped: boolean } {
  const killSignal = opts.killSignal ?? "SIGKILL";
  // Node passes `detached` on for spawnSync too; its typings leave it out.
  const r = spawnSync(cmd, args, { ...opts, killSignal, detached: true } as SpawnSyncOptions);
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (timedOut && (r.status !== null || r.signal !== killSignal)) delete r.error;
  let reaped = true;
  if (r.error && r.pid) {
    killGroup(r.pid, "SIGKILL");
    for (const end = Date.now() + 5000; groupAlive(r.pid) && Date.now() < end;) sleepSync(50);
    reaped = !groupAlive(r.pid);
  }
  return Object.assign(r, { reaped });
}

/** The command that runs a program as PID 1 of PID (and user) namespaces of
 * its own: every orphan inside is handed to it, nothing outside can be in
 * it, and the kernel ends everything in it when its PID 1 ends. With a /proc
 * of its own, so a program reading /proc/<its pid> finds itself (T3 Code's
 * backend checks its own identity there; with the host's /proc it read an
 * unrelated process's, or found none and exited). */
export const ownPidNamespace = ["unshare", "--user", "--map-current-user", "--pid", "--fork", "--kill-child", "--mount-proc", "--"];

/** Unless this script already is PID 1, run it again as PID 1 of a PID
 * namespace of its own (with its own /proc) and exit with its exit code:
 * resolves true only in there. Its TMPDIR is a folder made for the run and
 * removed afterwards. SIGINT, SIGTERM, SIGHUP or SIGQUIT to this outer process
 * SIGKILL the namespace (`unshare` passes it on to the inner script; the
 * kernel then ends everything in it), remove that folder, and exit with
 * 128 + the signal's number. Needs util-linux's unshare and unprivileged
 * user namespaces. */
export async function asPidNamespaceInit(): Promise<boolean> {
  if (process.pid === 1) return true;
  // Handlers first, so no signal finds the run half started.
  let signal: NodeJS.Signals | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) process.on(s, () => ((signal ??= s), child?.kill("SIGKILL")));
  const work = mkdtempSync(join(tmpdir(), "pidns-"));
  const [unshare, ...flags] = ownPidNamespace;
  child = spawn(unshare, [...flags, process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, TMPDIR: work } });
  if (signal) child.kill("SIGKILL");
  const code = await new Promise<number>((resolve) => {
    child!.once("error", (e) => (console.error(`couldn't start a PID namespace (util-linux's unshare): ${e.message}`), resolve(1)));
    // Ended by a signal from outside (an OOM kill, say): unshare passes it on.
    child!.once("close", (c, s) => {
      if (s && !signal) console.error(`the test's PID namespace ended by ${s}`);
      resolve(c ?? 128 + (s ? osConstants.signals[s] : 0));
    });
  });
  removeTree(work);
  process.exit(signal ? 128 + osConstants.signals[signal] : code);
}

/** SIGKILL this process's own `unshare` children, which, with
 * --kill-child, ends each one's PID namespace and everything in it, and
 * wait (up to 3 s) until their process groups are gone: what a test does
 * when it is told to stop while something it started runs. */
export function killChildNamespaces(): void {
  const read = (f: () => string) => { try { return f(); } catch { return ""; } };
  for (const pid of read(() => readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "latin1")).trim().split(/\s+/).map(Number).filter(Boolean)) {
    if (read(() => readFileSync(`/proc/${pid}/comm`, "latin1")).trim() !== "unshare") continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    killGroup(pid, "SIGKILL");
    for (const end = Date.now() + 3000; groupAlive(pid) && Date.now() < end;) sleepSync(50);
  }
}

/** In a PID namespace this script is PID 1 of (with its own /proc): every
 * other process still in it, or in a namespace nested in it, that isn't a
 * zombie, killed with SIGKILL, waited for up to 2 s and listed (PID and
 * command line, at most 10 lines). After the test's own clean-up, these are
 * what it left behind. Refuses unless this is PID 1. */
export async function killOthers(): Promise<string[]> {
  if (process.pid !== 1) throw new Error("killOthers: only PID 1 of a PID namespace of its own may empty it");
  const read = (f: () => string) => { try { return f(); } catch { return ""; } };
  const others = () => readdirSync("/proc").map(Number).filter((pid) => Number.isInteger(pid) && pid !== 1 && !gone(pid));
  const found = others();
  const lines = found.map((pid) => `${pid} ${read(() => readFileSync(`/proc/${pid}/cmdline`, "latin1")).split("\0").join(" ").trim()}`.slice(0, 200));
  for (const pid of found) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  for (const end = Date.now() + 2000; others().some((pid) => found.includes(pid)) && Date.now() < end;) await sleep(50);
  return lines.slice(0, 10).concat(lines.length > 10 ? [`and ${lines.length - 10} more`] : []);
}
