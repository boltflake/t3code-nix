"use strict";
// The desktop app's update notice for Nix installs. scripts/asar-patch.ts puts
// this file next to main.cjs in app.asar and has boot.cjs require it first.
//
// Upstream's updater stays off (T3CODE_DISABLE_AUTO_UPDATE). This only learns
// whether t3code-nix has a newer T3 Code, or newer versions of the providers
// this build bundles, from one small JSON file ({"version": "<x.y.z>",
// "providers": {"<package>": "<version>", …}}) at T3CODE_NIX_UPDATE_URL, which
// the package's wrapper sets to its own flavour's file on t3code-nix's site.
// The bundled providers and their versions are in the JSON file
// T3CODE_NIX_PROVIDERS names (the wrapper's providers.json). It tells the
// window: it adds `nixManaged` and `nixUpdate` to the update state the web
// UI gets (patched to show its update icon for a notice). Clicking the icon,
// or the menu's "Check for Updates…", shows what's new and how to get it.
// Nothing is downloaded or installed, and nothing is written to disk.
//
// Active only with a URL and upstream's own update policy unmanaged (handed
// over by main.cjs; a managed or unusable policy keeps this off).

const STATE = "desktop:update-state";
const GET = "desktop:update-get-state";
const CHECK = "desktop:update-check";
const FIRST_CHECK_MS = 15_000;
const POLL_MS = 4 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 4096;
const USER_AGENT = "t3code-nix update check";
const PARTITION = "t3code-nix-update-check";

const NUM = "0|[1-9]\\d*";
const PRE = `(?:${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE}(?:\\.${PRE})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`);

/** The version's parts, or null when it isn't SemVer. */
function parseVersion(v) {
  const m = typeof v === "string" && v.length <= 256 ? SEMVER.exec(v) : null;
  return m ? { core: [m[1], m[2], m[3]].map(BigInt), pre: m[4] === undefined ? [] : m[4].split(".") } : null;
}

/** SemVer precedence: <0, 0 or >0 (exact for any size of number). */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const [p, q] = [a.pre[i], b.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [np, nq] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (np && nq) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (np !== nq) return np ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// Provider versions, as scripts/update.ts orders them (a copy: the updater's
// own changes then don't rebuild the desktop app; tests/update-notice.test.ts
// checks the two agree). Numeric parts first, then a release above its own
// prerelease; vendor suffixes (cursor-agent's 2026.11.22-e9042b2, muse's
// 1.4.25-R9361.1) can't be ordered.
const PRERELEASE = /^(alpha|beta|rc|pre|preview|nightly|canary|dev)\b/i;

/** A provider version's numeric parts and suffix, or null when it can't be
 * read (also when it's over 256 characters, where the updater has no limit:
 * no real version comes near it). */
function parseLoose(v) {
  const m = typeof v === "string" && v.length <= 256 ? /^v?(\d+(?:\.\d+)*)(?:-([^+]*))?(?:\+.*)?$/.exec(v) : null;
  return m ? { nums: m[1].split(".").map(Number), pre: m[2] ?? null } : null;
}

/** -1, 0 or 1, or null when the two can't be ordered (or read). */
function compareLoose(a, b) {
  const pa = parseLoose(a), pb = parseLoose(b);
  if (!pa || !pb) return null;
  const width = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < width; i++) {
    const x = pa.nums[i] ?? 0, y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null && pb.pre && PRERELEASE.test(pb.pre)) return 1;
  if (pb.pre === null && pa.pre && PRERELEASE.test(pa.pre)) return -1;
  return null;
}

/** Whether main's provider version is an update over the installed one:
 * ordered above it, or another vendor build of the same version (equal
 * numbers, different strings, no prerelease on either side). */
function providerUpdate(main, installed) {
  const c = compareLoose(main, installed);
  if (c !== null) return c === 1;
  const pm = parseLoose(main), pi = parseLoose(installed);
  if (!pm || !pi || main === installed) return false;
  const pre = (p) => p.pre !== null && PRERELEASE.test(p.pre);
  return !pre(pm) && !pre(pi);
}

const LABELS = {
  antigravity: "Antigravity",
  "claude-code": "Claude Code",
  codex: "Codex",
  "cursor-agent": "Cursor Agent",
  fx: "fx",
  grok: "Grok",
  "kiro-cli": "Kiro CLI",
  muse: "Muse",
  opencode: "OpenCode",
  pi: "pi",
};
const labelOf = (name) => (Object.hasOwn(LABELS, name) ? LABELS[name] : name);

const isRecordOfStrings = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

/** The version file's contents, checked: {version, providers (null when the
 * file has none, an older site)}; throws when it isn't one. */
function validateFeed(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not a JSON object");
  if (!parseVersion(body.version)) throw new Error("no SemVer version in the file");
  if (body.providers === undefined) return { version: body.version, providers: null };
  if (!isRecordOfStrings(body.providers)) throw new Error("providers isn't an object of strings");
  return { version: body.version, providers: body.providers };
}

/** The notice's sentence: what's new, then how to get it. */
function summaryOf(version, count) {
  const updates = `${count} provider update${count === 1 ? "" : "s"}`;
  const first =
    version && count ? `T3 Code ${version} and ${updates} are now available`
    : version ? `T3 Code ${version} is now available`
    : `${updates} ${count === 1 ? "is" : "are"} now available`;
  const plural = Boolean(version) + count > 1;
  return { first, summary: `${first}. Update t3code-nix and rebuild your system to install the update${plural ? "s" : ""}.` };
}

/** The URL when it's one this may fetch: https, or loopback http (tests). */
function checkUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && u.hostname === "127.0.0.1") return u;
  return null;
}

const isUnmanaged = (p) =>
  p != null && typeof p === "object" && p.mode === "auto" && p.feedUrl === undefined && p.message === null;

/** Reads a response body as JSON, refusing more than MAX_BYTES. */
async function readJson(res) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`more than ${MAX_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The bundled providers' versions from the file at `path`: {} when there's
 * none, or (logged) when it can't be read as an object of strings. */
function readBundled(path, readFile, log) {
  if (!path || !path.trim()) return {};
  try {
    const list = JSON.parse(readFile(path.trim(), "utf8"));
    if (isRecordOfStrings(list)) return list;
    log("ignoring T3CODE_NIX_PROVIDERS: not an object of versions");
  } catch (e) {
    log("ignoring T3CODE_NIX_PROVIDERS:", String(e?.message ?? e));
  }
  return {};
}

const VARS = ["T3CODE_NIX_UPDATE_URL", "T3CODE_NIX_UPDATE_FIRST_CHECK_MS", "T3CODE_NIX_PROVIDERS"];

function create({ electron, env, log = (...a) => console.log("[update-notice]", ...a), timers = globalThis, readFile = require("node:fs").readFileSync }) {
  const { app, ipcMain, dialog, BrowserWindow, session } = electron;
  const saved = Object.fromEntries(VARS.map((k) => [k, env[k]]));
  const rawUrl = saved.T3CODE_NIX_UPDATE_URL;
  const raw = (rawUrl ?? "").trim();
  const rawFirst = saved.T3CODE_NIX_UPDATE_FIRST_CHECK_MS;
  // Not for what the app starts (its server, terminals, agents); put back
  // for upstream's own relaunch (a settings change), which starts the
  // unwrapped program with this environment.
  for (const k of VARS) delete env[k];
  const restore = () => {
    for (const k of VARS) if (env[k] === undefined && saved[k] !== undefined) env[k] = saved[k];
  };
  const url = raw ? checkUrl(raw) : null;
  if (raw && !url) log("ignoring T3CODE_NIX_UPDATE_URL: not an https URL");
  const firstCheckMs =
    url?.protocol === "http:" && /^\d{1,6}$/.test(rawFirst ?? "") ? Number(rawFirst) : FIRST_CHECK_MS;
  const bundled = url ? readBundled(saved.T3CODE_NIX_PROVIDERS, readFile, log) : {};
  /** "<name> <version>" pairs already logged as unreadable. */
  const unreadable = new Set();

  let active = false;
  let ready = false;
  let lastState = null;
  /** The last good check's notice ({version, installed, providers, first,
   * summary}), or null when nothing is newer. */
  let notice = null;
  /** "none" | "newer" | "current" | "failed": the last check's outcome. */
  let outcome = "none";
  let inflight = null;
  let controller = null;
  let dialogOpen = false;
  let firstTimer = null;
  let pollTimer = null;
  let quitting = false;

  const decorate = (state) => {
    if (!state || typeof state !== "object") return state;
    lastState = state;
    if (!active) return state;
    return {
      ...state,
      nixManaged: true,
      nixUpdate: notice && { version: notice.version, providers: notice.providers, summary: notice.summary },
    };
  };

  const broadcast = () => {
    if (!lastState) return;
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
        w.webContents.send(STATE, lastState);
      } catch (e) {
        log("couldn't update a window:", String(e));
      }
    }
  };

  const current = () => parseVersion(app.getVersion());

  /** One request at a time; overlapping triggers share it. */
  const check = () => {
    if (!active || quitting) return Promise.resolve();
    if (inflight) return inflight;
    // Set before it runs, and cleared only by the request it belongs to, so
    // a setup that throws at once can't leave it stuck.
    const request = run();
    inflight = request;
    void request.finally(() => {
      if (inflight === request) inflight = null;
    });
    return request;
  };

  const run = async () => {
    // After check() has set inflight, whatever setup does.
    await null;
    if (quitting) return;
    controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(new Error("timed out")), TIMEOUT_MS);
    try {
      const ses = session.fromPartition(PARTITION);
      ses.setUserAgent(USER_AGENT);
      const res = await ses.fetch(url.href, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Language": "en" },
        signal: controller.signal,
      });
      if (res.status < 200 || res.status > 299) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      const feed = validateFeed(await readJson(res));
      const mine = current();
      if (!mine) throw new Error(`the app's own version isn't SemVer: ${app.getVersion()}`);
      log(`checked: t3code-nix has ${feed.version}, this app is ${app.getVersion()}`);
      const t3 = compareVersions(parseVersion(feed.version), mine) > 0 ? feed.version : null;
      const providers = [];
      for (const name of Object.keys(bundled).sort()) {
        if (!feed.providers || !Object.hasOwn(feed.providers, name)) continue;
        const [latest, installed] = [feed.providers[name], bundled[name]];
        if (!parseLoose(latest) || !parseLoose(installed)) {
          const key = `${name} ${latest} ${installed}`;
          if (!unreadable.has(key)) log(`can't compare ${name} ${latest} with ${installed}`);
          unreadable.add(key);
          continue;
        }
        if (providerUpdate(latest, installed)) providers.push({ name, label: labelOf(name), version: latest, installed });
      }
      if (t3 || providers.length) {
        notice = { version: t3, installed: app.getVersion(), providers, ...summaryOf(t3, providers.length) };
        outcome = "newer";
      } else {
        notice = null;
        outcome = "current";
      }
    } catch (e) {
      // Keeps the last good result: an outage doesn't flicker the icon.
      outcome = "failed";
      if (!quitting) log("check failed:", String(e?.message ?? e));
    } finally {
      timers.clearTimeout(timer);
      controller = null;
      if (!quitting) broadcast();
    }
  };

  const show = async (win, options) => {
    // Not while quitting (a menu check its quit cut short), and one at a time.
    if (dialogOpen || quitting) return;
    dialogOpen = true;
    try {
      await (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
    } catch (e) {
      log("couldn't show the dialog:", String(e));
    } finally {
      dialogOpen = false;
    }
  };

  const noticeDialog = (n) => {
    const lines = [
      ...(n.version ? [`T3 Code ${n.version} (you have ${n.installed})`] : []),
      ...n.providers.map((p) => `${p.label} ${p.version} (you have ${p.installed})`),
    ];
    const plural = lines.length > 1;
    return {
      type: "info",
      title: "Update available",
      message: n.first,
      detail: `${lines.join("\n")}\n\nUpdate t3code-nix and rebuild your system to install the update${plural ? "s" : ""}.`,
      buttons: ["OK"],
    };
  };

  /** The menu's "Check for Updates…": true when this handled it. */
  const menu = () => {
    if (!active) return false;
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    void check().then(() => {
      if (outcome === "newer") return show(win, noticeDialog(notice));
      if (outcome === "current") return show(win, { type: "info", title: "You're up to date!", message: "You're up to date!", buttons: ["OK"] });
      return show(win, {
        type: "warning",
        title: "Update check failed",
        message: "Could not check for updates.",
        detail: notice ? `The last check found: ${notice.first}.` : undefined,
        buttons: ["OK"],
      });
    });
    return true;
  };

  const start = () => {
    if (!active || !ready || firstTimer || pollTimer) return;
    firstTimer = timers.setTimeout(() => {
      firstTimer = null;
      void check();
      pollTimer = timers.setInterval(() => void check(), POLL_MS);
      pollTimer?.unref?.();
    }, firstCheckMs);
    firstTimer?.unref?.();
  };

  const stop = () => {
    quitting = true;
    if (firstTimer) timers.clearTimeout(firstTimer);
    if (pollTimer) timers.clearInterval(pollTimer);
    firstTimer = pollTimer = null;
    controller?.abort(new Error("quitting"));
  };

  /** upstream's decoded update policy, from main.cjs. */
  const policy = (p) => {
    const was = active;
    active = Boolean(url) && isUnmanaged(p);
    if (url && !active) log("off: a managed policy decides this machine's updates");
    if (active && !was) start();
  };

  if (typeof app.relaunch === "function") {
    const relaunch = app.relaunch.bind(app);
    app.relaunch = (...args) => {
      restore();
      return relaunch(...args);
    };
  }

  if (url) {
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, fn) => {
      if (channel === GET) return handle(channel, async (...args) => decorate(await fn(...args)));
      if (channel === CHECK) {
        return handle(channel, async (event, ...args) => {
          // Upstream's handler first: it checks the sender (and, disabled,
          // returns at once). A refusal goes back as it is.
          const result = await fn(event, ...args);
          if (!active) return result;
          if (notice) void show(BrowserWindow.fromWebContents(event.sender) ?? undefined, noticeDialog(notice));
          void check();
          return { ...result, checked: true, state: decorate(result?.state) };
        });
      }
      return handle(channel, fn);
    };
    app.on("web-contents-created", (_event, wc) => {
      const send = wc.send.bind(wc);
      wc.send = (channel, ...args) => (channel === STATE ? send(channel, decorate(args[0])) : send(channel, ...args));
    });
    app.whenReady().then(() => {
      ready = true;
      start();
    });
    app.on("will-quit", stop);
  }

  return { menu, policy, check, stop, get state() { return { active, notice, outcome, lastState }; } };
}

module.exports = {
  create,
  parseVersion,
  compareVersions,
  parseLoose,
  compareLoose,
  providerUpdate,
  validateFeed,
  summaryOf,
  checkUrl,
  isUnmanaged,
};

if (process.versions.electron && process.type === "browser") {
  globalThis.__t3codeNixUpdateNotice = create({ electron: require("electron"), env: process.env });
}
