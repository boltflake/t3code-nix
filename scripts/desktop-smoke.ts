// Start the packaged T3 Code desktop app headless in a throwaway home and
// check it comes up: main window created, no crash, still running after
// 30 s. While it runs, also check that
//   - its window's WM_CLASS is the StartupWMClass of our desktop entry, so
//     docks group the window under the launcher
//   - its backend runs in the home folder, not the read-only store (a
//     packaged app does; a generic Electron one doesn't, nixpkgs #575673)
//   - its folder dialog opens and closes without crashing the app: with no
//     portal file chooser here, that is GTK's own dialog, which aborts the
//     app when GTK's GSettings schemas can't be found (the app's own
//     desktopBridge.pickFolder, called over the remote debugging port)
// Then report what it wrote to the home folder (the t3code:// handler,
// the ~/.t3/bin/t3 command, any ~/.local/bin/t3 link), so a run shows
// what the app sets up in a user's home.
//
//   node desktop-smoke.ts PACKAGE BIN_NAME
//
// Needs xvfb-run, dbus-run-session, xdotool and unshare (util-linux) on
// PATH, and unprivileged user namespaces. Runs on real machines and CI
// runners, not in the Nix sandbox. Never passes --no-sandbox: that would
// test something users don't run. The app runs in a PID namespace of its
// own, so no process it starts outlives the test. One at a time: two apps
// at once collide on their backend port and X display.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { exitText, freePort, killChildNamespaces, ownPidNamespace, procStat, readRegular, removeTree, sleep, sleepSync, stopGroup, within } from "./lib/proc.ts";

/** How long the app must stay up. */
export const RUN_MS = 30_000;

/** What a crash or a missing library leaves in the log. */
const CRASHES = [
  // glibc's loader: a library missing, of the wrong version, or lacking a symbol
  /error while loading shared libraries|symbol lookup error|relocation error/i,
  /version `(?:GLIBC|GLIBCXX|CXXABI)_[0-9.]+' not found/,
  // Chromium's FATAL messages, and a child program's `fatal:` (not `nonfatal:`)
  /(?<!\w)fatal:/i,
  // Node's and V8's fatal errors
  /FATAL ERROR:/i,
  /^# Fatal error in/m,
  // GLib's ERROR level always aborts (GIO's: no GSettings schemas)
  /GLib-GIO-ERROR/i,
  // The shell's report of a child killed by a crash signal (never its
  // "Killed": the test's own clean-up sends SIGKILL)
  /segmentation fault|trace\/breakpoint trap/i,
  /(?<!\w)\d+ (?:Aborted|Illegal instruction|Bus error|Floating point exception|Bad system call)(?!\w)/,
  // Chromium's crash handler: SIGILL, SIGTRAP, SIGABRT, SIGBUS, SIGFPE, SIGSEGV, SIGSYS
  /Received signal (?:[4-8]|11|31)(?!\w)/,
];

/** True if the app's log shows a crash or a missing library. */
export function crashed(log: string): boolean {
  return CRASHES.some((crash) => crash.test(log));
}

/** A problem with the package's program or desktop entry, or null. */
export function checkPackage(pkg: string, bin: string): string | null {
  const exe = join(pkg, "bin", bin);
  if (!existsSync(exe)) return `${exe} doesn't exist`;
  const entry = join(pkg, "share", "applications", `${bin}.desktop`);
  if (!existsSync(entry)) return `${entry} doesn't exist`;
  const exec = `Exec=${bin} %U`;
  if (!mainGroup(readFileSync(entry, "utf8")).includes(exec)) {
    return `${entry} has no line ${exec} in its [Desktop Entry] group (the entry must start ${bin} from the profile)`;
  }
  return null;
}

interface App {
  /** Still up after RUN_MS. */
  running: boolean;
  /** unshare's pid, its process group's id. */
  pid: number | undefined;
  /** True while the started process hasn't exited. */
  alive: () => boolean;
  /** Settles once Node has seen the process close (or fail to start). */
  closed: Promise<void>;
  /** Lets go of the started process, so Node can exit while it still runs. */
  release: () => void;
  /** Why it couldn't be started. */
  startError?: Error;
  /** How it ended, if it ended before RUN_MS. */
  exit?: { code: number | null; signal: NodeJS.Signals | null };
}

/** Where the app's session bus listens: in /tmp, since a socket path in
 * the home folder can be too long, and named after the home so cleanup can
 * remove it (a bus killed with SIGKILL leaves its socket behind). */
const busSocket = (home: string) => `/tmp/${basename(home)}.bus`;

/** The app's session bus: a config of the smoke's own. Without one,
 * nixpkgs' dbus-run-session reads /etc/dbus-1/session.conf, which NixOS has
 * but GitHub's Ubuntu runners don't. No service folders: nothing on the
 * host (a desktop portal, say) can be started on it, so the folder dialog
 * is GTK's own everywhere. */
const sessionBus = (home: string) => `<busconfig>
  <type>session</type>
  <listen>unix:path=${busSocket(home)}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;

/** Starts the app headless, in a process group and PID namespace of its
 * own, its output in <home>/startup.log, and waits until it exits, can't
 * start, or RUN_MS. */
export async function launch(exe: string, home: string, port: number, cwd: string): Promise<App> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    T3CODE_HOME: join(home, ".t3"),
  };
  const bus = join(home, "session-bus.conf");
  writeFileSync(bus, sessionBus(home));
  const [unshare, ...args] = [
    ...ownPidNamespace, "dbus-run-session", `--config-file=${bus}`, "--", "xvfb-run", "-a", "-s", "-screen 0 1280x800x24", exe,
    "--ozone-platform=x11", "--disable-gpu", "--enable-logging=stderr",
    `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, "electron")}`,
  ];
  const log = openSync(join(home, "startup.log"), "w");
  let proc: ChildProcess;
  try {
    proc = spawn(unshare, args, { env, cwd, stdio: ["ignore", log, log], detached: true });
  } catch (e) {
    const startError = e instanceof Error ? e : new Error(String(e));
    return { running: false, pid: undefined, alive: () => false, closed: Promise.resolve(), release: () => {}, startError };
  } finally {
    // The child has its own copy.
    closeSync(log);
  }
  let startError: Error | undefined;
  const closed = new Promise<void>((resolve) => {
    proc.once("close", () => resolve());
    // A process that never started never closes.
    proc.once("error", (e) => proc.pid === undefined && ((startError = e), resolve()));
  });
  const alive = () => proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null;
  let timer: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RUN_MS);
    proc.once("exit", () => resolve());
    closed.then(resolve);
  });
  clearTimeout(timer);
  const running = alive();
  return {
    running,
    pid: proc.pid,
    alive,
    closed,
    // Its stdio are files, not pipes: the process handle is all that's held.
    release: () => proc.unref(),
    startError,
    exit: running ? undefined : { code: proc.exitCode, signal: proc.signalCode },
  };
}

/** Why the startup failed (and whether to show the log), or null. */
export function startupProblem(app: App, log: string): { why: string; showLog: boolean } | null {
  if (app.startError) return { why: `couldn't start the app: ${app.startError.message}`, showLog: false };
  if (!app.running) {
    return { why: `the app exited before ${RUN_MS / 1000} s (${exitText(app.exit?.code ?? null, app.exit?.signal ?? null)})`, showLog: true };
  }
  if (crashed(log)) return { why: "the app crashed or misses a library", showLog: true };
  if (!log.split("\n").some((l) => l.includes("main window created"))) return { why: "main window never created", showLog: true };
  return null;
}

function walk(dir: string, skip: Set<string>, out: string[] = []): string[] {
  let entries;
  // A folder the app left that can't be read is skipped: the report must not crash.
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (skip.has(path)) continue;
    if (entry.isDirectory()) walk(path, skip, out);
    else out.push(path);
  }
  return out;
}

interface Proc { pid: number; ppid: number; pgid: number; argv: string[] }

/** Every process descended from `root`, found by parent PID (the app starts
 * its backend in a process group of its own). */
export function descendants(root: number): Proc[] {
  const all: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const { ppid, pgid } = procStat(`/proc/${name}/stat`);
      all.push({ pid: Number(name), ppid, pgid, argv: readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean) });
    } catch { /* gone meanwhile */ }
  }
  const found = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (!found.has(p.pid) && found.has(p.ppid)) (found.add(p.pid), (grew = true));
  }
  return all.filter((p) => found.has(p.pid) && p.pid !== root);
}

/** SIGTERM the app's Xvfb and wait, up to `ms`, for it to end, so it
 * removes its display's lock and socket from the shared /tmp: ending the
 * namespace SIGKILLs it, and the lock it leaves names a PID inside the
 * namespace, so that display would stay taken for good. Done first, while
 * everything around it still runs. */
function stopDisplay(root: number, ms: number): void {
  const xvfb = () => descendants(root).filter((p) => p.argv[0]?.endsWith("Xvfb"));
  for (const p of xvfb()) {
    try { process.kill(p.pid, "SIGTERM"); } catch { /* gone */ }
  }
  for (const end = Date.now() + ms; xvfb().length && Date.now() < end;) sleepSync(50);
}

/** The checks made while the app runs: the problems found, if any, and the
 * display's environment for the dialog check. */
function whileRunning(root: number, home: string, wmClass: string): { problems: string[]; env?: NodeJS.ProcessEnv } {
  const procs = descendants(root);
  const problems: string[] = [];
  const backend = procs.find((p) => p.argv.some((a) => a.endsWith("apps/server/dist/bin.mjs")));
  if (!backend) problems.push("no backend process (apps/server/dist/bin.mjs) found");
  else {
    const cwd = readlinkSync(`/proc/${backend.pid}/cwd`);
    if (cwd !== realpathSync(home)) problems.push(`the backend runs in ${cwd}, not the home folder`);
    else console.log("desktop: backend runs in the home folder");
  }
  // The display and its auth file, from xvfb-run's Xvfb (Chromium overwrites
  // its own environment, so the app's can't be read).
  const xvfb = procs.find((p) => p.argv[0]?.endsWith("Xvfb"));
  const display = xvfb?.argv.find((a) => /^:\d+$/.test(a));
  if (!xvfb || !display) return { problems: [...problems, "no Xvfb display found"] };
  const auth = xvfb.argv[xvfb.argv.indexOf("-auth") + 1];
  const env = { ...process.env, DISPLAY: display, XAUTHORITY: xvfb.argv.includes("-auth") ? auth : "" };
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
  const window = run("xdotool", ["search", "--onlyvisible", "--name", "T3 Code"]).stdout?.trim().split("\n")[0];
  if (!window) return { problems: [...problems, "no visible T3 Code window found (xdotool)"], env };
  // The class part of WM_CLASS, which docks match.
  const got = run("xdotool", ["getwindowclassname", window]).stdout?.trim();
  if (got !== wmClass) problems.push(`the window's WM_CLASS class is ${JSON.stringify(got)}, the entry's StartupWMClass ${JSON.stringify(wmClass)}`);
  else console.log(`desktop: window class ${got} matches StartupWMClass`);
  return { problems, env };
}

/** A desktop entry's main group: the lines after its `[Desktop Entry]`
 * header, up to the next group's header. Other groups (an action's) don't
 * describe the launcher. */
export function mainGroup(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf("[Desktop Entry]");
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("["));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Open the app's folder dialog through its own bridge and close it again:
 * the problems found, if any. `alive` says whether the app still runs. */
export async function folderDialog(port: number, env: NodeJS.ProcessEnv, alive: () => boolean, polls = 15): Promise<string[]> {
  let targets: any[];
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(10_000) })).json();
  } catch (e: any) {
    return [`couldn't list the app's pages on the remote debugging port: ${e?.message ?? e}`];
  }
  const page = targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  if (!page) return ["no page to call the folder dialog from"];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  // Every step has a deadline, and a closed socket settles whatever waits on
  // it, so the app's processes are always stopped afterwards.
  const replies = new Map<number, (reply: any) => void>();
  const settleAll = () => { for (const settle of replies.values()) settle(null); replies.clear(); };
  ws.addEventListener("close", settleAll);
  ws.addEventListener("error", settleAll);
  try {
    const opened = await within(10_000, new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => resolve(true), { once: true });
      ws.addEventListener("error", () => resolve(false), { once: true });
      ws.addEventListener("close", () => resolve(false), { once: true });
    }));
    if (!opened) return ["couldn't reach the page over the remote debugging port"];
    ws.addEventListener("message", (e: any) => {
      let reply: any;
      try { reply = JSON.parse(String(e.data)); } catch { return; }
      const settle = replies.get(reply?.id);
      if (settle) (replies.delete(reply.id), settle(reply));
    });
    let next = 0;
    // The reply, or null: no reply within `ms`, or the socket closed.
    const evaluate = (expression: string, ms: number, awaitPromise = false) => {
      const id = ++next;
      const reply = new Promise<any>((resolve) => replies.set(id, resolve));
      if (ws.readyState !== WebSocket.OPEN) settleAll();
      else ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise, returnByValue: true } }));
      return within(ms, reply).finally(() => replies.delete(id));
    };
    const probe = await evaluate("typeof window.desktopBridge?.pickFolder", 10_000);
    if (probe === null) return ["the page didn't answer over the remote debugging port"];
    const kind = probe.result?.result?.value;
    if (kind !== "function") return [`the app has no desktopBridge.pickFolder (${kind})`];
    // Settles when the dialog closes; given time for the steps below.
    const picked = evaluate("window.desktopBridge.pickFolder({})", 40_000, true);
    const run = (args: string[]) => spawnSync("xdotool", args, { env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" }).stdout?.trim() ?? "";
    let dialog = "";
    for (let i = 0; i < polls && !dialog && alive(); i++) {
      await sleep(1000);
      dialog = run(["search", "--onlyvisible", "--name", "^Select Folder$"]).split("\n")[0];
    }
    if (!alive()) return ["the app died opening its folder dialog"];
    if (!dialog) return ["the folder dialog never showed"];
    run(["windowfocus", "--sync", dialog]);
    run(["key", "Escape"]);
    const reply = await within(10_000, picked);
    if (!alive()) return ["the app died closing its folder dialog"];
    if (reply?.result?.result?.value !== null) return [`the cancelled folder dialog returned ${JSON.stringify(reply?.result?.result?.value)}, not null`];
    console.log("desktop: folder dialog opened and closed");
    return [];
  } finally {
    ws.close();
  }
}

/** True if the app passed. Prints what it found either way. */
export async function desktopSmoke(pkg: string, bin: string): Promise<boolean> {
  const fail = (why: string[], log = "") => {
    console.error(`FAILED: ${why.join("; ")}`);
    if (log) console.error(log.split("\n").slice(-40).join("\n"));
    return false;
  };
  const problem = checkPackage(pkg, bin);
  if (problem) return fail([problem]);
  const entry = join(pkg, "share", "applications", `${bin}.desktop`);
  const desktop = mainGroup(readFileSync(entry, "utf8")).join("\n");
  if (!/^MimeType=.*x-scheme-handler\/t3code;/m.test(desktop)) return fail([`${entry} doesn't register t3code://`]);
  const wmClass = /^StartupWMClass=(.+)$/m.exec(desktop)?.[1];
  if (!wmClass) return fail([`${entry} has no StartupWMClass`]);

  // For the remote debugging port (the app moves its user data folder, so
  // Chromium's DevToolsActivePort file can't be relied on).
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "desktop-smoke-"));
  // Told to stop meanwhile (Ctrl+C, Ctrl+\, SIGTERM, SIGHUP): end the
  // app's namespace, which is detached from this terminal, and its home,
  // then exit.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
  const onSignal = (s: NodeJS.Signals) => {
    stopDisplay(process.pid, 2000);
    killChildNamespaces();
    rmSync(busSocket(home), { force: true });
    removeTree(home);
    process.exit(128 + osConstants.signals[s]);
  };
  for (const s of signals) process.on(s, onSignal);
  try {
    // Started from elsewhere, so a backend that only inherited its cwd
    // can't pass the home-folder check.
    const launchDir = join(home, "launch");
    mkdirSync(launchDir);
    const logFile = join(home, "startup.log");
    // A log that can't be read is a problem, never a reason to skip the clean-up.
    let unreadable = "";
    const readLog = () => {
      try {
        return readRegular(logFile, "utf8");
      } catch (e: any) {
        unreadable = `couldn't read the app's log: ${e?.message ?? e}`;
        return "";
      }
    };
    const app = await launch(join(pkg, "bin", bin), home, port, launchDir);
    // The app runs in a PID namespace of its own (launch starts it under
    // unshare): every orphan is handed to its init, which is in the app's
    // tree, so the stop below reaches it, and the kernel ends whatever is
    // left in the namespace when its init ends.
    let problems: string[] = [];
    // Every process group the app started (its backend has one of its own)
    // is stopped afterwards, whatever the checks did.
    let groups: number[] = [];
    let text = "";
    try {
      if (app.running && app.pid !== undefined) {
        const found = whileRunning(app.pid, home, wmClass);
        problems = found.problems;
        if (!problems.length && found.env) problems = await folderDialog(port, found.env, app.alive);
        if (!app.alive()) problems.push("the app exited during the checks");
      }
    } catch (e: any) {
      problems = [`checking the running app failed: ${e?.message ?? e}`];
    } finally {
      if (app.pid !== undefined) groups = [...new Set([app.pid, ...descendants(app.pid).map((p) => p.pgid)])];
      // Judged on what the app wrote while it ran: stopping it can make it
      // log a fatal error of its own (a GPU process that won't relaunch).
      if (app.running) text = readLog();
    }
    if (app.pid !== undefined) stopDisplay(app.pid, 5000);
    let stopped = true;
    for (const g of groups) stopped = (await stopGroup(g)) && stopped;
    // A process that outlived SIGKILL may never close: wait for it only a
    // while, then let go of it so Node can exit.
    if (stopped) await app.closed;
    else if ((await within(5000, app.closed.then(() => true))) === null) app.release();
    if (!app.running) text = readLog();

    // With no log to judge, only how the app ended can be.
    const startup = unreadable && app.running ? null : startupProblem(app, text);
    // The app restarts a backend that died, so one can be gone and back by
    // the time it's looked for: the log says so either way.
    const backendCrashed = !startup && text.includes("backend exited unexpectedly");
    const failures = [
      ...(stopped ? [] : ["the app's processes outlived SIGKILL"]),
      ...(unreadable ? [unreadable] : []),
      ...(startup ? [startup.why] : []),
      ...(backendCrashed ? ['the backend crashed (the log says "backend exited unexpectedly")'] : []),
    ];
    if (failures.length) return fail(failures, startup?.showLog || backendCrashed ? text : "");
    console.log("desktop: main window created, still running after 30 s");
    if (problems.length) return fail(problems);

    // What it wrote to the home, relative to that throwaway home.
    const shown = (p: string) => `~/${relative(home, p)}`;
    const written = walk(home, new Set([join(home, "electron"), join(home, ".cache")]))
      .filter((p) => p.endsWith(".desktop") || p.endsWith("/bin/t3"));
    console.log(`--- written: ${written.map(shown).join(", ") || "nothing"}`);
    for (const p of written.filter((p) => p.endsWith(".desktop"))) {
      let text: string;
      try { text = readRegular(p, "utf8"); } catch (e: any) { text = `(${e?.message ?? e})`; }
      console.log(`--- ${shown(p)}: ${text.split("\n").filter((l) => /^(Exec|MimeType)=|^\(/.test(l)).join("; ")}`);
    }
    const shim = join(home, ".t3", "bin", "t3");
    if (existsSync(shim)) {
      let text: string;
      try { text = readRegular(shim, "utf8").trim(); } catch (e: any) { text = `(${e?.message ?? e})`; }
      console.log(`--- ~/.t3/bin/t3:\n${text}`);
    }
    const link = join(home, ".local", "bin", "t3");
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) console.log(`--- ~/.local/bin/t3 -> ${readlinkSync(link)}`);
    const updates = text.split("\n").filter((l) => /update/i.test(l)).slice(0, 5);
    if (updates.length) console.log(`--- update lines in log:\n${updates.join("\n")}`);
    return true;
  } finally {
    for (const s of signals) process.off(s, onSignal);
    rmSync(busSocket(home), { force: true });
    removeTree(home);
  }
}

if (import.meta.main) {
  const [pkg, bin] = process.argv.slice(2);
  if (!pkg || !bin) {
    console.error("usage: desktop-smoke.ts PACKAGE BIN_NAME");
    process.exit(2);
  }
  process.exitCode = (await desktopSmoke(pkg, bin)) ? 0 : 1;
}
