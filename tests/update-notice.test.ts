// pkgs/t3code/update-notice.cjs, the desktop app's update notice, with
// Electron stubbed: what it fetches, what it tells the window, and when.
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const shim = require("../pkgs/t3code/update-notice.cjs");

const UNMANAGED = { mode: "auto", feedUrl: undefined, allowNightly: true, message: null };
const URL_ = "https://boltflake.github.io/t3code-nix/updates/t3code.json";
const T3 = "T3 Code 0.1.14 is now available. Update t3code-nix and rebuild your system to install the update.";
/** The state's notice for T3 Code 0.1.14 alone. */
const N14 = { version: "0.1.14", providers: [], summary: T3 };

/** A fake clock: timers run only when `run` says. */
function clock() {
  let id = 0;
  const pending = new Map<number, { fn: () => void; at: number; every?: number }>();
  let now = 0;
  return {
    setTimeout: (fn: () => void, ms: number) => (pending.set(++id, { fn, at: now + ms }), id),
    clearTimeout: (i: number) => void pending.delete(i),
    setInterval: (fn: () => void, ms: number) => (pending.set(++id, { fn, at: now + ms, every: ms }), id),
    clearInterval: (i: number) => void pending.delete(i),
    /** Moves time on by `ms`, running what falls due. */
    run(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [i, t] = due;
        now = t.at;
        if (t.every) t.at += t.every;
        else pending.delete(i);
        t.fn();
      }
      now = end;
    },
    pending: () => pending.size,
  };
}

type Reply = { status?: number; body?: string | ReadableStream; error?: Error; hang?: boolean; throwNow?: boolean };

function setup({ version = "0.1.13", env = { T3CODE_NIX_UPDATE_URL: URL_ } as Record<string, string | undefined>, replies = [] as Reply[], files = {} as Record<string, string> } = {}) {
  const handlers = new Map<string, (...a: any[]) => any>();
  const listeners = new Map<string, ((...a: any[]) => void)[]>();
  const dialogs: any[] = [];
  const requests: { url: string; init: any }[] = [];
  const logs: string[] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  let closeDialog: (() => void) | null = null;
  const queue = [...replies];
  const windows: any[] = [];
  const electron = {
    app: {
      getVersion: () => version,
      on: (ev: string, fn: (...a: any[]) => void) => listeners.set(ev, [...(listeners.get(ev) ?? []), fn]),
      whenReady: () => ready,
    },
    ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
    dialog: {
      showMessageBox: (...a: any[]) => {
        dialogs.push(a.length === 2 ? a[1] : a[0]);
        return new Promise<void>((r) => (closeDialog = r));
      },
    },
    BrowserWindow: {
      getAllWindows: () => windows,
      fromWebContents: (wc: any) => windows.find((w) => w.webContents === wc),
      getFocusedWindow: () => windows[0] ?? null,
    },
    session: {
      fromPartition: (name: string) => {
        assert.equal(name, "t3code-nix-update-check");
        return {
          setUserAgent: (ua: string) => assert.equal(ua, "t3code-nix update check"),
          fetch: (url: string, init: any) => {
            requests.push({ url, init });
            const r = queue.shift() ?? { status: 200, body: JSON.stringify({ version }) };
            if (r.hang) {
              return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
            }
            if (r.throwNow) throw new Error("session broke");
            if (r.error) return Promise.reject(r.error);
            return Promise.resolve(new Response(r.body ?? "", { status: r.status ?? 200 }));
          },
        };
      },
    },
  };
  const timers = clock();
  const readFile = (path: string) => {
    if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  };
  const notice = shim.create({ electron, env, log: (...a: unknown[]) => logs.push(a.join(" ")), timers, readFile });
  const emit = (ev: string, ...a: unknown[]) => (listeners.get(ev) ?? []).forEach((fn) => fn(...a));
  /** A window whose page records what it's sent. */
  const window = () => {
    const sent: any[] = [];
    const wc: any = { destroyed: false, isDestroyed: () => wc.destroyed, send: (ch: string, ...a: unknown[]) => sent.push([ch, ...a]) };
    emit("web-contents-created", {}, wc);
    const w = { destroyed: false, isDestroyed: () => w.destroyed, webContents: wc, sent };
    windows.push(w);
    return w;
  };
  // Upstream's handlers, registered through the (wrapped) ipcMain.
  const upstreamState = { status: "disabled", message: "Nix manages this install.", enabled: false };
  electron.ipcMain.handle("desktop:update-get-state", async () => upstreamState);
  electron.ipcMain.handle("desktop:update-check", async (event: any) => {
    if (event?.untrusted) throw new Error("untrusted sender");
    return { checked: false, state: upstreamState };
  });
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    notice, handlers, dialogs, requests, logs, timers, env, window, emit, settle, upstreamState,
    ready: async () => (resolveReady(), settle()),
    closeDialog: () => closeDialog?.(),
    /** Runs time on and lets the request finish. */
    async after(ms: number) {
      timers.run(ms);
      for (let i = 0; i < 10; i++) await settle();
    },
  };
}

test("versions compare by SemVer, prereleases before their release", () => {
  const v = (s: string) => shim.parseVersion(s);
  const cmp = (a: string, b: string) => Math.sign(shim.compareVersions(v(a), v(b)));
  assert.equal(cmp("0.1.14", "0.1.13"), 1);
  assert.equal(cmp("0.1.13", "0.1.13"), 0);
  assert.equal(cmp("0.2.0", "0.10.0"), -1);
  assert.equal(cmp("0.1.14-nightly.20261127.5332", "0.1.13"), 1);
  assert.equal(cmp("0.1.14-nightly.20261127.5332", "0.1.14"), -1);
  assert.equal(cmp("0.1.14-nightly.20261127.5332", "0.1.14-nightly.20261127.5319"), 1);
  assert.equal(cmp("0.1.14-nightly.20261128.1", "0.1.14-nightly.20261127.5332"), 1);
  assert.equal(cmp("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(cmp("1.0.0-alpha.beta", "1.0.0-alpha.1"), 1);
  assert.equal(cmp("1.0.0+build", "1.0.0"), 0);
  // Exact beyond 2^53, where Numbers would round to equal.
  assert.equal(cmp("9007199254740993.0.0", "9007199254740992.0.0"), 1);
  assert.equal(cmp("1.0.0-9007199254740993", "1.0.0-9007199254740992"), 1);
  for (const bad of ["", "1.2", "01.2.3", "v1.2.3", "1.2.3-", "1.2.3 ", 1, null, "9".repeat(300)]) {
    assert.equal(shim.parseVersion(bad), null, String(bad));
  }
});

test("only https URLs, or loopback http for tests, are fetched", () => {
  assert.ok(shim.checkUrl(URL_));
  assert.ok(shim.checkUrl("http://127.0.0.1:8080/feed.json"));
  for (const bad of ["http://boltflake.github.io/x.json", "http://localhost/x.json", "file:///etc/passwd", "https://u:p@example.com/x", "nonsense", ""]) {
    assert.equal(shim.checkUrl(bad), null, bad);
  }
});

test("it removes its variables from the environment the app's children get", () => {
  const s = setup({ env: { T3CODE_NIX_UPDATE_URL: URL_, T3CODE_NIX_UPDATE_FIRST_CHECK_MS: "5", OTHER: "x" } });
  assert.deepEqual(s.env, { OTHER: "x" });
});

test("a newer version in the file: the window gets the notice", async () => {
  const s = setup({ replies: [{ body: '{"version":"0.1.14"}' }] });
  const w = s.window();
  s.notice.policy(UNMANAGED);
  await s.ready();
  assert.equal(s.requests.length, 0, "nothing before the first check");
  await s.after(14_999);
  assert.equal(s.requests.length, 0);
  await s.after(1);
  assert.equal(s.requests.length, 1);
  const { url, init } = s.requests[0];
  assert.equal(url, URL_);
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.equal(init.credentials, "omit");
  assert.equal(init.headers["User-Agent"], "t3code-nix update check");
  // Upstream's state is broadcast once one was seen: get-state first.
  const got = await s.handlers.get("desktop:update-get-state")!();
  assert.deepEqual(got, { ...s.upstreamState, nixManaged: true, nixUpdate: N14 });
  // A later upstream send is decorated too.
  w.webContents.send("desktop:update-state", { status: "disabled" });
  assert.deepEqual(w.sent.at(-1), ["desktop:update-state", { status: "disabled", nixManaged: true, nixUpdate: N14 }]);
  // Other channels pass through as they are.
  w.webContents.send("other", 1);
  assert.deepEqual(w.sent.at(-1), ["other", 1]);
});

test("the same or an older version clears the notice; a failure keeps the last good one", async () => {
  const s = setup({
    replies: [
      { body: '{"version":"0.1.14"}' },
      { status: 503 },
      { body: "x".repeat(5000) },
      { body: '{"version":"latest"}' },
      { body: "not json" },
      { error: new Error("offline") },
      { body: '{"version":"0.1.12"}' },
    ],
  });
  s.window();
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.handlers.get("desktop:update-get-state")!();
  await s.after(15_000);
  assert.equal(s.notice.state.notice.version, "0.1.14");
  for (const why of ["HTTP 503", "more than 4096 bytes", "no SemVer version", "JSON", "offline"]) {
    await s.notice.check();
    assert.equal(s.notice.state.outcome, "failed");
    assert.equal(s.notice.state.notice.version, "0.1.14", why);
    assert.match(s.logs.at(-1)!, new RegExp(why), s.logs.at(-1)!);
  }
  await s.notice.check();
  assert.equal(s.notice.state.outcome, "current");
  assert.equal(s.notice.state.notice, null);
  const got = await s.handlers.get("desktop:update-get-state")!();
  assert.equal(got.nixUpdate, null);
  assert.equal(got.nixManaged, true);
});

test("it polls every 4 hours, one request at a time", async () => {
  const s = setup();
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.after(15_000);
  assert.equal(s.requests.length, 1);
  await s.after(4 * 60 * 60 * 1000);
  assert.equal(s.requests.length, 2);
  // Overlapping triggers share the request.
  const [a, b] = [s.notice.check(), s.notice.check()];
  assert.equal(a, b);
  await a;
  assert.equal(s.requests.length, 3);
});

test("a request that hangs times out after 15 s", async () => {
  const s = setup({ replies: [{ hang: true }] });
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.after(15_000);
  assert.equal(s.requests.length, 1);
  await s.after(15_000);
  assert.equal(s.notice.state.outcome, "failed");
  assert.match(s.logs.at(-1)!, /timed out/);
});

test("the policy decides: only upstream's unmanaged one turns it on, and nothing runs until it's handed over", async () => {
  for (const p of [
    { mode: "off", feedUrl: undefined, allowNightly: false, message: "Updates are managed by Acme." },
    { mode: "auto", feedUrl: "https://updates.acme.example/", allowNightly: true, message: "Managed by Acme." },
    { mode: "auto", feedUrl: undefined, allowNightly: false, message: "Managed by Acme." },
    { mode: "off", feedUrl: undefined, allowNightly: false, message: "Updates are off because T3 Code cannot use the managed policy at /etc/t3code/policy.json." },
    null,
  ]) {
    const s = setup();
    s.notice.policy(p);
    await s.ready();
    await s.after(60_000);
    assert.equal(s.requests.length, 0, JSON.stringify(p));
    const got = await s.handlers.get("desktop:update-get-state")!();
    assert.equal(got.nixManaged, undefined);
    assert.equal(s.notice.menu(), false, "the menu stays upstream's");
  }
  const never = setup();
  await never.ready();
  await never.after(60_000);
  assert.equal(never.requests.length, 0, "no policy handed over: off");
});

test("without a URL (the option off) it changes nothing", async () => {
  for (const env of [{}, { T3CODE_NIX_UPDATE_URL: "  " }, { T3CODE_NIX_UPDATE_URL: "http://example.com/x.json" }]) {
    const s = setup({ env });
    s.notice.policy(UNMANAGED);
    await s.ready();
    await s.after(60_000);
    assert.equal(s.requests.length, 0);
    const got = await s.handlers.get("desktop:update-get-state")!();
    assert.equal(got, s.upstreamState);
    assert.equal(s.notice.menu(), false);
  }
});

test("the first check comes sooner only for a loopback URL (tests)", async () => {
  const loop = setup({ env: { T3CODE_NIX_UPDATE_URL: "http://127.0.0.1:9/f.json", T3CODE_NIX_UPDATE_FIRST_CHECK_MS: "1000" } });
  loop.notice.policy(UNMANAGED);
  await loop.ready();
  await loop.after(1000);
  assert.equal(loop.requests.length, 1);
  const real = setup({ env: { T3CODE_NIX_UPDATE_URL: URL_, T3CODE_NIX_UPDATE_FIRST_CHECK_MS: "1000" } });
  real.notice.policy(UNMANAGED);
  await real.ready();
  await real.after(1000);
  assert.equal(real.requests.length, 0);
});

test("the icon's click: upstream's sender check first, a dialog only with a notice, always a refresh", async () => {
  const s = setup({ replies: [{ body: '{"version":"0.1.13"}' }, { body: '{"version":"0.1.14"}' }, { body: '{"version":"0.1.14"}' }] });
  const w = s.window();
  s.notice.policy(UNMANAGED);
  await s.ready();
  const check = s.handlers.get("desktop:update-check")!;
  await assert.rejects(check({ untrusted: true, sender: w.webContents }), /untrusted sender/);
  assert.equal(s.requests.length, 0, "a refused sender starts nothing");
  // No notice yet: no dialog, a refresh.
  const r1 = await check({ sender: w.webContents });
  assert.equal(r1.checked, true);
  assert.equal(r1.state.nixUpdate, null);
  await s.after(0);
  assert.equal(s.dialogs.length, 0);
  assert.equal(s.requests.length, 1);
  await check({ sender: w.webContents });
  await s.after(0);
  assert.equal(s.notice.state.notice.version, "0.1.14");
  assert.equal(s.dialogs.length, 0, "the notice came with that refresh, after the click");
  // Now a notice: the dialog at once.
  await check({ sender: w.webContents });
  assert.equal(s.dialogs.length, 1);
  assert.equal(s.dialogs[0].title, "Update available");
  assert.equal(s.dialogs[0].message, "T3 Code 0.1.14 is now available");
  assert.equal(s.dialogs[0].detail, "T3 Code 0.1.14 (you have 0.1.13)\n\nUpdate t3code-nix and rebuild your system to install the update.");
  assert.deepEqual(s.dialogs[0].buttons, ["OK"]);
  // One dialog at a time, from the sidebar or the menu.
  await check({ sender: w.webContents });
  assert.equal(s.notice.menu(), true);
  await s.after(0);
  assert.equal(s.dialogs.length, 1);
  s.closeDialog();
  await s.after(0);
  await check({ sender: w.webContents });
  assert.equal(s.dialogs.length, 2);
});

test("the menu: checks, then says what it found", async () => {
  const s = setup({ replies: [{ body: '{"version":"0.1.13"}' }, { body: '{"version":"0.1.14"}' }, { status: 500 }] });
  s.window();
  s.notice.policy(UNMANAGED);
  await s.ready();
  for (const [title, extra] of [
    ["You're up to date!", undefined],
    ["Update available", undefined],
    ["Update check failed", "The last check found: T3 Code 0.1.14 is now available."],
  ] as const) {
    assert.equal(s.notice.menu(), true);
    await s.after(0);
    assert.equal(s.dialogs.at(-1).title, title);
    if (extra) assert.equal(s.dialogs.at(-1).detail, extra);
    s.closeDialog();
    await s.after(0);
  }
});

test("a destroyed window doesn't stop the others getting the notice", async () => {
  const s = setup({ replies: [{ body: '{"version":"0.1.14"}' }] });
  const [gone, broken, ok] = [s.window(), s.window(), s.window()];
  gone.destroyed = true;
  broken.webContents.send = () => {
    throw new Error("render frame disposed");
  };
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.handlers.get("desktop:update-get-state")!();
  await s.after(15_000);
  assert.equal(gone.sent.length, 0);
  assert.deepEqual(ok.sent.at(-1)[1].nixUpdate, N14);
  assert.ok(s.logs.some((l) => /couldn't update a window/.test(l)));
});

test("a window that reloads gets the known notice with get-state", async () => {
  const s = setup({ replies: [{ body: '{"version":"0.1.14"}' }] });
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.after(15_000);
  const got = await s.handlers.get("desktop:update-get-state")!();
  assert.deepEqual(got.nixUpdate, N14);
});

test("quitting stops the timers and the request", async () => {
  const s = setup({ replies: [{ hang: true }] });
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.after(15_000);
  assert.equal(s.requests.length, 1);
  s.emit("will-quit");
  await s.after(0);
  assert.equal(s.timers.pending(), 0);
  assert.equal(s.notice.state.outcome, "failed");
  assert.ok(!s.logs.some((l) => /check failed/.test(l)), "no failure logged for a quit");
  await s.notice.check();
  assert.equal(s.requests.length, 1, "no check after quitting");
});

test("a setup that throws at once doesn't stop later checks", async () => {
  const s = setup({ replies: [{ throwNow: true }, { body: '{"version":"0.1.14"}' }] });
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.notice.check();
  assert.equal(s.notice.state.outcome, "failed");
  assert.match(s.logs.at(-1)!, /session broke/);
  await s.notice.check();
  assert.equal(s.requests.length, 2);
  assert.equal(s.notice.state.notice.version, "0.1.14");
});

test("an error response's body is cancelled, not read", async () => {
  let cancelled = false;
  let pulled = 0;
  const body = new ReadableStream({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const s = setup({ replies: [{ status: 500, body }] });
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.notice.check();
  assert.equal(s.notice.state.outcome, "failed");
  assert.equal(cancelled, true);
  assert.ok(pulled <= 2, `read ${pulled} chunks`);
});

test("a menu check that quitting cuts short shows no dialog", async () => {
  const s = setup({ replies: [{ hang: true }] });
  s.window();
  s.notice.policy(UNMANAGED);
  await s.ready();
  assert.equal(s.notice.menu(), true);
  await s.after(0);
  assert.equal(s.requests.length, 1);
  s.emit("will-quit");
  await s.after(0);
  assert.equal(s.dialogs.length, 0);
});

test("upstream's relaunch (a settings change) gets the variables back, so the relaunched app checks too", () => {
  const relaunched: any[] = [];
  const env: Record<string, string | undefined> = { T3CODE_NIX_UPDATE_URL: URL_, T3CODE_NIX_UPDATE_FIRST_CHECK_MS: "5" };
  const app: any = { getVersion: () => "0.1.13", on() {}, whenReady: () => new Promise(() => {}), relaunch: (o: unknown) => relaunched.push({ o, env: { ...env } }) };
  const electron = { app, ipcMain: { handle() {} }, dialog: {}, BrowserWindow: { getAllWindows: () => [] }, session: {} };
  shim.create({ electron, env, log: () => {} });
  assert.deepEqual(env, {}, "gone while it runs");
  app.relaunch({ args: ["--x"] });
  assert.deepEqual([...relaunched], [{ o: { args: ["--x"] }, env: { T3CODE_NIX_UPDATE_URL: URL_, T3CODE_NIX_UPDATE_FIRST_CHECK_MS: "5" } }]);
  // Never put in when the app started without them (the option off).
  const bare: Record<string, string | undefined> = {};
  const app2: any = { ...app, relaunch: () => relaunched.push({ env: { ...bare } }) };
  shim.create({ electron: { ...electron, app: app2 }, env: bare, log: () => {} });
  app2.relaunch();
  assert.deepEqual(relaunched.at(-1), { env: {} });
});

test("provider versions: ordered as the updater orders them, and the same answers as update.ts", async () => {
  const { compareVersions: updater } = await import("../scripts/update.ts");
  const { readdirSync, readFileSync } = await import("node:fs");
  const names = Object.values(JSON.parse(readFileSync(new URL("../pkgs/t3code/provider-names.json", import.meta.url), "utf8"))) as string[];
  // Every bundled provider's pin in versions/ (the unit check's copy has no
  // versions/stable), and the edge cases.
  const pins = readdirSync(new URL("../versions/", import.meta.url))
    .filter((f) => names.includes(f.replace(/\.json$/, "")))
    .map((f) => JSON.parse(readFileSync(new URL(`../versions/${f}`, import.meta.url), "utf8")).version as string);
  assert.ok(pins.length > 0);
  for (const v of pins) assert.ok(shim.parseLoose(v), `the app can read ${v}`);
  const edge = ["1.0.0", "1.0.0-rc.1", "1.0.0-rc.2", "1.0", "1.0.1", "v1.0.0", "2026.11.22-e9042b2", "2026.11.22-a123456", "2026.11.23-b1", "1.4.25-R9361.1", "1.4.25-R9362.1", "x", ""];
  const all = [...pins, ...edge];
  for (const a of all) for (const b of all) assert.equal(shim.compareLoose(a, b), updater(a, b), `${a} vs ${b}`);
});

test("provider versions: which count as an update", () => {
  const up = (main: string, installed: string) => shim.providerUpdate(main, installed);
  assert.equal(up("0.173.0", "0.172.0"), true);
  assert.equal(up("0.172.0", "0.172.0"), false);
  assert.equal(up("0.171.0", "0.172.0"), false);
  assert.equal(up("1.0.0", "1.0.0-rc.1"), true, "a release over its own prerelease");
  assert.equal(up("1.0.0-rc.2", "1.0.0-rc.1"), false, "two prereleases of one version can't be ordered");
  // Another vendor build of the same version: main moved to it.
  assert.equal(up("2026.11.22-a123456", "2026.11.22-e9042b2"), true);
  assert.equal(up("1.4.25-R9362.1", "1.4.25-R9361.1"), true);
  assert.equal(up("2026.11.23-b1", "2026.11.22-e9042b2"), true);
  assert.equal(up("2026.11.21-b1", "2026.11.22-e9042b2"), false);
  assert.equal(up("weekly", "1.0.0"), false);
  assert.equal(up("1.0.0", "weekly"), false);
});

test("the notice's sentence, for T3 Code, providers or both", () => {
  const s = (v: string | null, n: number) => shim.summaryOf(v, n).summary;
  assert.equal(s("0.1.14", 0), T3);
  assert.equal(s(null, 1), "1 provider update is now available. Update t3code-nix and rebuild your system to install the update.");
  assert.equal(s(null, 2), "2 provider updates are now available. Update t3code-nix and rebuild your system to install the updates.");
  assert.equal(s("0.1.14", 1), "T3 Code 0.1.14 and 1 provider update are now available. Update t3code-nix and rebuild your system to install the updates.");
  assert.equal(s("0.1.14", 2), "T3 Code 0.1.14 and 2 provider updates are now available. Update t3code-nix and rebuild your system to install the updates.");
});

const LIST = "/nix/store/x-t3code/share/t3code-nix/t3code/providers.json";
const withList = (list: unknown, replies: Reply[]) =>
  setup({ env: { T3CODE_NIX_UPDATE_URL: URL_, T3CODE_NIX_PROVIDERS: LIST }, files: { [LIST]: JSON.stringify(list) }, replies });
const feed = (version: string, providers?: Record<string, string>) => ({ body: JSON.stringify(providers ? { version, providers } : { version }) });

test("bundled providers: a newer pin on main is a notice, told with T3 Code's", async () => {
  const s = withList({ "claude-code": "2.1.332", codex: "0.172.0", grok: "1.0.92" }, [
    // codex newer; claude-code the same; grok not in the file; boat not bundled.
    feed("0.1.13", { "claude-code": "2.1.332", codex: "0.173.0", boat: "9.9.9" }),
    feed("0.1.14", { "claude-code": "2.1.340", codex: "0.173.0" }),
    feed("0.1.13", { "claude-code": "2.1.332", codex: "0.172.0", grok: "1.0.92" }),
  ]);
  const w = s.window();
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.notice.check();
  let got = (await s.handlers.get("desktop:update-get-state")!()).nixUpdate;
  assert.deepEqual(got, {
    version: null,
    providers: [{ name: "codex", label: "Codex", version: "0.173.0", installed: "0.172.0" }],
    summary: "1 provider update is now available. Update t3code-nix and rebuild your system to install the update.",
  });
  await s.notice.check();
  got = (await s.handlers.get("desktop:update-get-state")!()).nixUpdate;
  assert.equal(got.summary, "T3 Code 0.1.14 and 2 provider updates are now available. Update t3code-nix and rebuild your system to install the updates.");
  // The icon's click: the dialog lists each, with what's installed (and a
  // refresh starts, which finds everything current).
  await s.handlers.get("desktop:update-check")!({ sender: w.webContents });
  assert.equal(s.dialogs.at(-1).title, "Update available");
  assert.equal(s.dialogs.at(-1).message, "T3 Code 0.1.14 and 2 provider updates are now available");
  assert.equal(
    s.dialogs.at(-1).detail,
    "T3 Code 0.1.14 (you have 0.1.13)\nClaude Code 2.1.340 (you have 2.1.332)\nCodex 0.173.0 (you have 0.172.0)\n\nUpdate t3code-nix and rebuild your system to install the updates.",
  );
  s.closeDialog();
  await s.after(0);
  assert.equal(s.notice.state.notice, null);
  // The menu: everything current is up to date.
  assert.equal(s.notice.menu(), true);
  await s.after(0);
  assert.equal(s.dialogs.at(-1).title, "You're up to date!");
});

test("bundled providers: an older site without providers, an empty list, and bad lists", async () => {
  // A file without providers: T3 Code only.
  let s = withList({ codex: "0.172.0" }, [feed("0.1.13")]);
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.notice.check();
  assert.equal(s.notice.state.outcome, "current");
  // An empty providers object is fine; inherited names (toString) aren't entries.
  s = withList({ toString: "1.0.0", codex: "0.172.0" }, [feed("0.1.13", {})]);
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.notice.check();
  assert.equal(s.notice.state.outcome, "current");
  // Bad remote providers: a failure that keeps the last notice.
  s = withList({ codex: "0.172.0" }, [
    feed("0.1.13", { codex: "0.173.0" }),
    { body: '{"version":"0.1.13","providers":["codex"]}' },
    { body: '{"version":"0.1.13","providers":null}' },
    { body: '{"version":"0.1.13","providers":{"codex":1}}' },
  ]);
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.notice.check();
  for (let i = 0; i < 3; i++) {
    await s.notice.check();
    assert.equal(s.notice.state.outcome, "failed");
    assert.equal(s.notice.state.notice.providers[0].version, "0.173.0");
    assert.match(s.logs.at(-1)!, /providers isn't an object of strings/);
  }
  // A version the app can't compare: no notice for it, logged once.
  s = withList({ codex: "0.172.0" }, [feed("0.1.13", { codex: "weekly" }), feed("0.1.13", { codex: "weekly" })]);
  s.notice.policy(UNMANAGED);
  await s.ready();
  await s.notice.check();
  await s.notice.check();
  assert.equal(s.notice.state.outcome, "current");
  assert.equal(s.logs.filter((l) => /can't compare codex weekly/.test(l)).length, 1);
  // A bad local list: logged, treated as none, T3 Code still checked.
  for (const files of [{ [LIST]: "[1]" }, { [LIST]: "nope" }, {}] as Record<string, string>[]) {
    const t = setup({ env: { T3CODE_NIX_UPDATE_URL: URL_, T3CODE_NIX_PROVIDERS: LIST }, files, replies: [feed("0.1.14", { codex: "9.9.9" })] });
    assert.ok(t.logs.some((l) => /ignoring T3CODE_NIX_PROVIDERS/.test(l)), JSON.stringify(files));
    t.notice.policy(UNMANAGED);
    await t.ready();
    await t.notice.check();
    assert.deepEqual(t.notice.state.notice.providers, []);
    assert.equal(t.notice.state.notice.version, "0.1.14");
  }
});

test("bundled providers: the list's variable leaves the environment and comes back for upstream's relaunch", () => {
  const relaunched: any[] = [];
  const env: Record<string, string | undefined> = { T3CODE_NIX_UPDATE_URL: URL_, T3CODE_NIX_PROVIDERS: LIST, OTHER: "x" };
  const app: any = { getVersion: () => "0.1.13", on() {}, whenReady: () => new Promise(() => {}), relaunch: (o: unknown) => relaunched.push({ o, env: { ...env } }), exit() {} };
  const electron = { app, ipcMain: { handle() {} }, dialog: {}, BrowserWindow: { getAllWindows: () => [] }, session: {} };
  shim.create({ electron, env, log: () => {}, readFile: () => "{}" });
  assert.deepEqual(env, { OTHER: "x" });
  // As upstream does for a settings change: relaunch, then exit.
  app.relaunch({ execPath: "/nix/store/x/bin/t3code", args: [] });
  app.exit(0);
  assert.deepEqual(relaunched[0].env, { T3CODE_NIX_UPDATE_URL: URL_, T3CODE_NIX_PROVIDERS: LIST, OTHER: "x" });
});
