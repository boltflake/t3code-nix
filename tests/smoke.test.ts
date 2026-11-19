// The smoke tests' building blocks on their own: scripts/lib/proc.ts, and the
// pure parts of scripts/t3-smoke.ts and scripts/desktop-smoke.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { exitText, freePort, killOthers, runGrouped, within } from "../scripts/lib/proc.ts";

// Running, not a zombie waiting to be collected.
const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch {
    return false;
  }
};

test("proc: freePort gives a port that can be listened on", async () => {
  const port = await freePort();
  const srv = createServer();
  await new Promise<void>((resolve, reject) => srv.once("error", reject).listen(port, "127.0.0.1", resolve));
  srv.close();
});

test("proc: within and exitText", async () => {
  assert.equal(await within(50, new Promise(() => {})), null);
  assert.equal(await within(1000, Promise.resolve(7)), 7);
  assert.equal(exitText(3, null), "code 3");
  assert.equal(exitText(null, "SIGKILL"), "signal SIGKILL");
});

test("proc: runGrouped: a command that ended isn't a timeout; a timed-out one is killed with its group", () => {
  // The left-behind child keeps the output open, so Node waits for the
  // timeout; the command itself exited 0, so that's no error, and the child
  // is left for the test's final sweep.
  const left = runGrouped("sh", ["-c", "sleep 100 & echo $!"], { encoding: "utf8", timeout: 1000 });
  assert.equal(left.error, undefined);
  assert.equal(left.status, 0);
  const child = Number(`${left.stdout}`.trim());
  assert.ok(alive(child), "the left-behind sleep is the sweep's to find");
  process.kill(child, "SIGKILL");
  // A command that crashed while a child held its output keeps its signal.
  // (5 s: a crash handler such as Ubuntu's apport can take a second to dump the core.)
  const crash = runGrouped("sh", ["-c", "sleep 100 & echo $!; kill -SEGV $$"], { encoding: "utf8", timeout: 5000 });
  assert.equal(crash.error, undefined);
  assert.equal(crash.signal, "SIGSEGV");
  process.kill(Number(`${crash.stdout}`.trim()), "SIGKILL");
  // More output than maxBuffer (1 MiB by default) is an error, as with Node's own pipes.
  const flood = runGrouped("sh", ["-c", "head -c 5000000 /dev/zero"], { encoding: "utf8", timeout: 10_000 });
  assert.equal((flood.error as any)?.code, "ENOBUFS");
  assert.ok(flood.stdout.length < 2 * 1024 * 1024);
  const slow = runGrouped("sh", ["-c", "trap '' TERM; sleep 100"], { encoding: "utf8", timeout: 300 });
  assert.equal((slow.error as any)?.code, "ETIMEDOUT");
  assert.equal(slow.reaped, true);
});

test("t3-smoke: a provider counts once probed, at its version (or none before sign-in)", async () => {
  const { found, finished } = await import("../scripts/t3-smoke.ts");
  assert.ok(!finished({ installed: true, status: "ready", message: "Checking codex" }));
  assert.ok(!finished({ installed: true, status: "disabled" }));
  assert.ok(found("codex", { installed: true, version: "1.0", status: "ready" }, "1.0"));
  assert.ok(!found("codex", { installed: true, version: "0.9", status: "ready" }, "1.0"));
  assert.ok(!found("codex", { installed: true, version: null, status: "ready" }, "1.0"));
  assert.ok(found("cursor", { installed: true, version: null, status: "warning" }, "2026.1"));
});

test("t3-smoke: a status file that holds no status is a failure, not a pass", async () => {
  const { providers } = await import("../scripts/t3-smoke.ts");
  const state = mkdtempSync(join(tmpdir(), "providers-"));
  try {
    mkdirSync(join(state, "caches"));
    writeFileSync(join(state, "caches", "codex.json"), "null");
    writeFileSync(join(state, "caches", "claude.json"), JSON.stringify({ installed: true, version: "1", status: "ready" }));
    const failures = await providers(state, { codex: "1", claude: "1" }, Date.now() + 500);
    assert.deepEqual(failures, ["codex: its status file holds null, not a status"]);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("t3-smoke: screenshots compare by their pixels, not their bytes", async () => {
  const { pngPixels } = await import("../scripts/t3-smoke.ts");
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), body])));
    return Buffer.concat([head, Buffer.from(type), body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const sig = Buffer.from("89504e470d0a1a0a", "hex");
  // `pixels` is one scanline: its filter byte, then its bytes (none: 0).
  const raw = (scanline: number[], extra = Buffer.alloc(0)) =>
    Buffer.concat([sig, chunk("IHDR", ihdr), extra, chunk("IDAT", deflateSync(Buffer.from(scanline))), chunk("IEND", Buffer.alloc(0))]);
  const png = (pixels: number[], extra = Buffer.alloc(0)) => raw([0, ...pixels], extra);
  const data = (b: Buffer) => { const p = pngPixels(b); assert.equal(typeof p, "object", String(p)); return (p as any).data.toString("hex"); };
  const white = png([255, 255, 255, 255, 255, 255]);
  assert.equal(data(white), data(png([255, 255, 255, 255, 255, 255], chunk("tEXt", Buffer.from("Comment\0x")))), "metadata doesn't count");
  assert.notEqual(data(white), data(png([0, 0, 0, 255, 255, 255])));
  // The same two white pixels, encoded with the Sub filter: the same picture.
  assert.equal(data(raw([1, 255, 255, 255, 0, 0, 0])), data(white), "row filters don't count");
  assert.equal(pngPixels(raw([0])), "image data of the wrong size");
  assert.equal(pngPixels(Buffer.from("not a png")), "not a PNG");
  assert.equal(pngPixels(white.subarray(0, white.length - 20)), "a truncated chunk");
});

test("desktop smoke: the desktop entry's main group only", async () => {
  const { mainGroup } = await import("../scripts/desktop-smoke.ts");
  const entry = "[Desktop Entry]\nName=T3\nExec=/nix/store/x %U\n\n[Desktop Action new]\nExec=t3code %U\n";
  assert.deepEqual(mainGroup(entry).filter(Boolean), ["Name=T3", "Exec=/nix/store/x %U"]);
  assert.deepEqual(mainGroup("[Desktop Entry]x\nExec=t3code %U\n"), [], "a header with trailing text isn't the main group");
  assert.deepEqual(mainGroup("Exec=t3code %U\n"), []);
});

test("t3-smoke: a pairing URL is the labelled line T3 Code prints, nothing looser", async () => {
  const { pairingLine } = await import("../scripts/t3-smoke.ts");
  for (const line of [
    "Pairing URL: http://127.0.0.1:47113/pair#token=XMQKZKVYMZS9",
    "Pairing URL: https://box.tailnet.ts.net/pair#token=AB_c-9",
    "Pairing URL:   HTTPS://box/pair#token=a  ",
  ]) assert.ok(pairingLine(line), line);
  for (const line of [
    "Pairing URL: garbage", "Pairing URL:", "http://127.0.0.1:1/pair#token=a",
    "Pairing URL: http://127.0.0.1:1/pair", "Pairing URL: http://h/pair#token=", "Pairing URL: http://h/pair#other=x&token=y",
    "Pairing URL: ftp://h/pair#token=x", "Pairing URL: https://example.com/unrelated#token=x", "Pairing URL: https://host/pair?x=1#token=a",
    "Pairing URL: http:host/pair#token=a", "Pairing URL: https://host/a/../pair#token=a", "Pairing URL: https://host/pair/#token=a",
    "Pairing URL: https:\\\\host/pair#token=a", "Pairing URL: http://host:99999/pair#token=a", "Pairing URL: http://h/pair#token=a extra",
  ]) assert.ok(!pairingLine(line), line);
});

test("t3-smoke: codex copies under ~/.codex, and folders it couldn't look in", async () => {
  const { codexCopies } = await import("../scripts/t3-smoke.ts");
  const { symlinkSync, chmodSync } = await import("node:fs");
  const home = () => mkdtempSync(join(tmpdir(), "codex-"));
  const cases: [string, (h: string) => void, RegExp | null][] = [
    ["no ~/.codex", () => {}, null],
    ["other files only", (h) => { mkdirSync(join(h, ".codex/sessions"), { recursive: true }); writeFileSync(join(h, ".codex/config.toml"), ""); }, null],
    ["packages folder", (h) => mkdirSync(join(h, ".codex/packages/app-server-daemon"), { recursive: true }), /packages/],
    ["packages file", (h) => { mkdirSync(join(h, ".codex")); writeFileSync(join(h, ".codex/packages"), ""); }, /packages/],
    ["packages dangling link", (h) => { mkdirSync(join(h, ".codex")); symlinkSync("/nonexistent", join(h, ".codex/packages")); }, /packages/],
    ["nested releases", (h) => mkdirSync(join(h, ".codex/x/releases"), { recursive: true }), /releases/],
    ["a file named releases", (h) => { mkdirSync(join(h, ".codex")); writeFileSync(join(h, ".codex/releases"), ""); }, null],
  ];
  if (process.getuid?.() !== 0) {
    cases.push(["unreadable folder", (h) => { mkdirSync(join(h, ".codex/x/releases"), { recursive: true }); chmodSync(join(h, ".codex/x"), 0o000); }, /couldn't read .*EACCES/]);
  }
  for (const [name, make, want] of cases) {
    const h = home();
    try {
      make(h);
      const problems = codexCopies(h);
      if (want) assert.match(problems.join("\n"), want, name);
      else assert.deepEqual(problems, [], name);
    } finally {
      try { chmodSync(join(h, ".codex/x"), 0o755); } catch { /* not made */ }
      rmSync(h, { recursive: true, force: true });
    }
  }
});

test("desktop smoke: every crash rule, and the lines that look like one but aren't", async () => {
  const { crashed } = await import("../scripts/desktop-smoke.ts");
  for (const line of [
    "/nix/store/x/t3code: error while loading shared libraries: libgtk-3.so.0: cannot open shared object file",
    "/nix/store/x/t3code: symbol lookup error: /nix/store/y/libgtk-3.so.0: undefined symbol: z",
    "x: relocation error: /nix/store/y/libz.so.1: symbol inflateValidate not defined",
    "x: version `GLIBC_2.42' not found (required by y)", "x: version `GLIBCXX_3.4.32' not found (required by x)",
    "x: version `CXXABI_1.3.15' not found (required by y)",
    "[4105200:1116/145836.339652:FATAL:chrome/browser/process_singleton_posix.cc:335] Socket path too long",
    "fatal: not a git repository", "FATAL ERROR: Reached heap limit", "# Fatal error in ../../v8/src/heap/heap.cc, line 123",
    "(t3code:12): GLib-GIO-ERROR **: 01:35:32.569: No GSettings schemas are installed on the system",
    "/x/.xvfb-run-wrapped: line 181: 2385335 Segmentation fault      (core dumped) y",
    "/x/.xvfb-run-wrapped: line 181: 2385335 Trace/breakpoint trap   (core dumped) y",
    "/x/.xvfb-run-wrapped: line 181: 2385335 Aborted                    (core dumped) DISPLAY=:1",
    "/x: line 1: 42 Illegal instruction (core dumped) y", "/x: line 1: 42 Bus error (core dumped) y",
    "/x: line 1: 42 Floating point exception (core dumped) y", "/x: line 1: 42 Bad system call (core dumped) y",
    "Received signal 11 SEGV_MAPERR 000000000000", "[12:12:1116/101010.123456:ERROR:x.cc(1)] Received signal 6",
  ]) assert.ok(crashed(line), line);
  for (const line of [
    "request Aborted by the user", "3 aborted requests", "[info] fetch aborted: timeout", "job 7 Abortedly", "worker7 Aborted",
    "nonfatal: optional cache unavailable", "9fatal: x", "x_fatal: x", "retrying after a non-fatal error",
    "glibc version 2.42 found", "D-Bus error: org.freedesktop.DBus.Error.ServiceUnknown", "123 Bus errors",
    "/x: line 1: 123 Killed   foo", "dbus-daemon[1]: Received signal 15, exiting", "Received signal 2", "Received signal 111",
    "received signal 11", "Received signal 11foo",
    "[4107068:1116/145851.573680:ERROR:dbus/object_proxy.cc:589] Failed to call method",
    "(t3code:12): GLib-GIO-CRITICAL **: 01:35:32.569: g_settings_get: assertion failed",
    "[14:58:51.629] INFO (#1): main window created",
  ]) assert.ok(!crashed(line), line);
});

test("desktop smoke: the package check and the startup verdict", async () => {
  const { checkPackage, startupProblem, RUN_MS } = await import("../scripts/desktop-smoke.ts");
  const pkg = mkdtempSync(join(tmpdir(), "pkg-"));
  try {
    mkdirSync(join(pkg, "bin")); mkdirSync(join(pkg, "share/applications"), { recursive: true });
    const entry = (text: string) => writeFileSync(join(pkg, "share/applications/app.desktop"), text);
    assert.match(checkPackage(pkg, "app") ?? "", /doesn't exist/, "no bin/app");
    writeFileSync(join(pkg, "bin/app"), "");
    entry("[Desktop Entry]\nExec=/nix/store/x/bin/app %U\n\n[Desktop Action new]\nExec=app %U\n");
    assert.match(checkPackage(pkg, "app") ?? "", /Exec=app %U/, "Exec only in an action");
    entry("[Desktop Entry]\nName=App\nExec=app %U\n");
    assert.equal(checkPackage(pkg, "app"), null);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
  const app = (over: object) => ({ running: true, pid: 1, alive: () => true, closed: Promise.resolve(), release: () => {}, ...over });
  assert.match(startupProblem(app({ running: false, startError: new Error("ENOENT") }), "")!.why, /couldn't start/);
  assert.match(startupProblem(app({ running: false, exit: { code: 1, signal: null } }), "")!.why, new RegExp(`before ${RUN_MS / 1000} s`));
  assert.match(startupProblem(app({}), "x: line 1: 9 Aborted (core dumped)\nmain window created")!.why, /crashed/);
  assert.match(startupProblem(app({}), "nothing here")!.why, /main window never created/);
  assert.equal(startupProblem(app({}), "[1] INFO (#1): main window created"), null);
});

test("proc: removeTree removes a folder a test made unreadable", async () => {
  const { removeTree } = await import("../scripts/lib/proc.ts");
  const { chmodSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "tree-"));
  mkdirSync(join(dir, "a/b"), { recursive: true });
  writeFileSync(join(dir, "a/b/f"), "x");
  chmodSync(join(dir, "a"), 0o000);
  removeTree(dir);
  assert.ok(!existsSync(dir));
});

// A script that runs itself as PID 1 of a PID namespace of its own, prints
// `ready` and, given "leftovers", lists what killOthers finds.
const pidOne = (body: string) => {
  const proc = new URL("../scripts/lib/proc.ts", import.meta.url).pathname;
  return `const p = await import(${JSON.stringify(proc)}); if (await p.asPidNamespaceInit()) { ${body} }`;
};

test("proc: as PID 1 of its own namespace, killOthers finds what escaped, nested namespaces too; refused elsewhere", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = pidOne(`const { spawnSync } = await import("node:child_process");
    spawnSync("sh", ["-c", "setsid sleep 105 </dev/null >/dev/null 2>&1 &"]);
    spawnSync("sh", ["-c", "unshare --user --pid --fork sh -c 'sleep 106 & wait' </dev/null >/dev/null 2>&1 &"]);
    await p.sleep(500); console.log(JSON.stringify({ pid: process.pid, killed: await p.killOthers() }));`);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.pid, 1);
  for (const n of ["sleep 105", "sleep 106"]) assert.ok(out.killed.some((l: string) => l.endsWith(n)), `${n} in ${r.stdout}`);
  await assert.rejects(killOthers(), /only PID 1/);
});

test("proc: a signal ends the PID-1 script at once, at any moment, its folder removed and nothing left", async () => {
  const { existsSync, readFileSync: read } = await import("node:fs");
  // The inner script makes a folder in its TMPDIR (the run's own), starts a
  // child, then runs a slow synchronous command (a signal can't wait for it).
  const script = pidOne(`const { mkdtempSync, writeFileSync } = await import("node:fs"); const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(tmpdir() + "/run-"); writeFileSync(process.argv[1], dir);
    const cp = await import("node:child_process"); cp.spawn("sleep", ["300"], { stdio: "ignore", detached: true });
    cp.spawnSync("sleep", ["25"]); console.log("not stopped");`);
  const cases: [string, NodeJS.Signals, boolean, number][] = [
    ["SIGTERM to the outer process at once", "SIGTERM", false, 0], ["SIGTERM after 100 ms", "SIGTERM", false, 100],
    ["SIGTERM after 300 ms", "SIGTERM", false, 300], ["SIGINT to the group (Ctrl+C) during a slow command", "SIGINT", true, 1500],
    ["SIGHUP during a slow command", "SIGHUP", false, 1500],
    ["SIGQUIT to the group (Ctrl+\\) during a slow command", "SIGQUIT", true, 1500],
  ];
  for (const [how, sig, group, after] of cases) {
    const note = join(tmpdir(), `sig-${process.pid}-${after}`);
    const outer = spawn(process.execPath, ["--input-type=module", "-e", script, note], { stdio: ["ignore", "pipe", "inherit"], detached: true });
    try {
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => outer.once("exit", (code, signal) => resolve({ code, signal })));
      await new Promise((r) => setTimeout(r, after));
      if (group) process.kill(-outer.pid!, sig); else outer.kill(sig);
      const ended = await within(5000, done);
      assert.ok(ended !== null, `${how}: still running after 5 s`);
      // Before its handlers exist (the first moment), the signal's default action ends it.
      assert.ok(ended.code === 128 + osConstants.signals[sig] || ended.signal === sig, `${how}: ${JSON.stringify(ended)}`);
      const dir = existsSync(note) ? read(note, "utf8") : "";
      if (dir) assert.ok(!existsSync(dir), `${how}: its folder was removed`);
    } finally {
      try { process.kill(-outer.pid!, "SIGKILL"); } catch { /* gone */ }
      rmSync(note, { force: true });
    }
  }
});

test("proc: a signal in the first moments of a PID-1 run leaves no folder and no process", async () => {
  const { readdirSync } = await import("node:fs");
  const script = pidOne(`(await import("node:child_process")).spawnSync("sleep", ["20"]);`);
  for (const after of [0, 20, 40, 60, 80, 100, 120]) {
    const tmp = mkdtempSync(join(tmpdir(), "early-"));
    const outer = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore", env: { ...process.env, TMPDIR: tmp } });
    try {
      const done = new Promise<void>((resolve) => outer.once("exit", () => resolve()));
      await new Promise((r) => setTimeout(r, after));
      outer.kill("SIGTERM");
      assert.notEqual(await within(5000, done), null, `${after} ms: still running`);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(readdirSync(tmp), [], `${after} ms: the run's folder was removed`);
      const left = readdirSync("/proc").filter((p) => /^[0-9]+$/.test(p)).filter((p) => {
        try { return readFileSync(`/proc/${p}/environ`, "latin1").includes(`TMPDIR=${tmp}`); } catch { return false; }
      });
      assert.deepEqual(left, [], `${after} ms: nothing of the run is left`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});


test("proc: readRegular reads a regular file and throws at once for a FIFO or a folder", async () => {
  const { readRegular } = await import("../scripts/lib/proc.ts");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "regular-"));
  try {
    writeFileSync(join(dir, "f"), "text");
    assert.equal(readRegular(join(dir, "f"), "utf8"), "text");
    spawnSync("mkfifo", [join(dir, "fifo")]);
    const started = Date.now();
    assert.throws(() => readRegular(join(dir, "fifo")), /isn't a regular file/);
    assert.ok(Date.now() - started < 1000, "no wait for a writer");
    assert.throws(() => readRegular(dir), /isn't a regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proc: a PID-1 run killed from outside says so and exits 128 + the signal", async () => {
  const outer = spawn(process.execPath, ["--input-type=module", "-e", pidOne(`(await import("node:child_process")).spawnSync("sleep", ["20"]);`)],
    { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  outer.stderr!.on("data", (d) => (stderr += d));
  const done = new Promise<number | null>((resolve) => outer.once("exit", (code) => resolve(code)));
  const children = (pid: number) => { try { return readFileSync(`/proc/${pid}/task/${pid}/children`, "latin1").trim().split(/\s+/).map(Number).filter(Boolean); } catch { return []; } };
  // outer -> unshare -> the inner script (PID 1 inside).
  let inner: number | undefined;
  for (const end = Date.now() + 5000; !inner && Date.now() < end;) {
    inner = children(outer.pid!).flatMap(children)[0];
    if (!inner) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(inner, "found the inner script");
  await new Promise((r) => setTimeout(r, 300));
  process.kill(inner!, "SIGKILL");
  assert.equal(await within(5000, done), 137);
  assert.match(stderr, /ended by SIGKILL/);
});

test("proc: killChildNamespaces ends a child's PID namespace, escaped children too", async () => {
  const proc = new URL("../scripts/lib/proc.ts", import.meta.url).pathname;
  // A stand-in for the desktop smoke: an "app" in a namespace of its own,
  // detached, with a child in a new session; on SIGTERM, end it all.
  const script = `const p = await import(${JSON.stringify(proc)}); const { spawn } = await import("node:child_process");
    spawn(p.ownPidNamespace[0], [...p.ownPidNamespace.slice(1), "sh", "-c", "setsid sleep 301 </dev/null >/dev/null 2>&1 & exec sleep 302"], { stdio: "ignore", detached: true });
    process.on("SIGTERM", () => { p.killChildNamespaces(); process.exit(143); }); console.log("ready"); setInterval(() => {}, 1000);`;
  const smoke = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => smoke.stdout!.on("data", (d) => `${d}`.includes("ready") && resolve()));
  await new Promise((r) => setTimeout(r, 500));
  const done = new Promise<number | null>((resolve) => smoke.once("exit", (code) => resolve(code)));
  smoke.kill("SIGTERM");
  assert.equal(await within(5000, done), 143);
  const { readdirSync } = await import("node:fs");
  const left = readdirSync("/proc").filter((p) => /^[0-9]+$/.test(p)).filter((p) => {
    try { return /^sleep\0(301|302)\0$/.test(readFileSync(`/proc/${p}/cmdline`, "latin1")) && alive(Number(p)); } catch { return false; }
  });
  assert.deepEqual(left, [], "nothing of the namespace is left");
});

test("t3-smoke: startServer's failures name what happened", async () => {
  const { startServer } = await import("../scripts/t3-smoke.ts");
  const dir = mkdtempSync(join(tmpdir(), "serve-"));
  try {
    const fake = (name: string, body: string) => {
      const p = join(dir, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return p;
    };
    const env = { PATH: process.env.PATH, HOME: dir };
    const exits = fake("exits", "exit 3");
    await assert.rejects(startServer(exits, env, dir, dir, join(dir, "log1"), Date.now() + 5000), /exited \(code 3\)/);
    const redirect = fake("redirect", `for a; do port=$a; done; exec ${process.execPath} -e "require('http').createServer((q, r) => { r.statusCode = 302; r.setHeader('Location', '/x'); r.end(); }).listen($port, '127.0.0.1')"`);
    await assert.rejects(startServer(redirect, env, dir, dir, join(dir, "log2"), Date.now() + 2000), /last attempt: HTTP status 302/);
    const silent = fake("silent", "exec sleep 100");
    await assert.rejects(startServer(silent, env, dir, dir, join(dir, "log3"), Date.now() + 2000), /last attempt: connection refused/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
