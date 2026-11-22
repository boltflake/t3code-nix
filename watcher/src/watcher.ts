// The release watcher's logic (MAINTAINING.md, "The release
// watcher"). Two cron triggers, both every minute, each poll their own sources
// and keep their own state in one KV key. A new version starts the update
// workflow (workflow_dispatch); what gets pinned is decided there, so
// triggering is at least once: a lost or repeated trigger only delays an update
// or starts a run with nothing to do.
//
// Each run reads its key once and writes it back only when something
// changed: a version, a long backoff starting, the dispatch being sent, the
// deployed version, or 15 minutes have passed (the heartbeat the backstop
// checks). Errors and recoveries wait for the heartbeat, so writes stay
// near 200 a day for both keys in normal running (the free plan allows
// 1,000 for the account). The heartbeat waits for a run in which every
// source is due, so it always saves a fresh result for each (cursor is read
// every 5th minute); it slips by at most 4 minutes.
//
// While KV writes fail (the quota spent, an outage), polling and
// dispatching go on, and a new version is dispatched every minute until a
// write succeeds; the update workflow's concurrency group keeps one waiting.
//
// KV is eventually consistent: a run can read a key a little old. Then it
// may see a version again as new, dispatch once more (harmless) and give it
// a firstSeen up to that delay later, which only delays the backstop's lag
// check by as much.
//
// Pure apart from the injected fetch, KV and clock, so tests run it in Node.
import { appendPage, decisive, fillRules, isComplete, classify, select, type Repository } from "../../shared/channels.ts";
import { BOAT, channelUrl, cursorVersion, GITHUB, highestTag, isReleased, latestRelease, NIXOS_UNSTABLE, plausibleVersion, previousRelease, RECENT, T3_MAX_PAGES,
  T3_RELEASE, t3Releases, VENDOR_URLS, versionOfTag, fillAssets } from "../../shared/sources.ts";

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
export interface Env {
  STATE: KV;
  /** Fine-grained token: Actions write on the repo (dispatch); public
   * repositories readable (GraphQL). */
  GITHUB_TOKEN: string;
  HEALTH_TOKEN: string;
  /** The repo to dispatch, owner/name. */
  REPO: string;
  CF_VERSION?: { id: string };
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const UA = "t3code-nix-watcher (https://github.com/boltflake/t3code-nix)";
const TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 15 * 60_000;
/** The longest a server may make a source wait: a Retry-After or reset
 * further off is cut to this, so one bad header can't silence a source for
 * days (or, unparsable, stop the cron). */
export const MAX_BACKOFF_MS = 60 * 60_000;
/** A retry time from a server, or null: only a real time in the future, at
 * most MAX_BACKOFF_MS away. */
export const backoffUntil = (at: number | null, now: number): number | null =>
  at !== null && Number.isFinite(at) && at > now ? Math.min(at, now + MAX_BACKOFF_MS) : null;

export type ErrorKind = "auth" | "rate-limit" | "http" | "network" | "timeout" | "parse";
export class SourceError extends Error {
  kind: ErrorKind;
  retryAt: number | null;
  constructor(kind: ErrorKind, message: string, retryAt: number | null = null) {
    super(message);
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

/** One request with a timeout, sorted into an error kind on failure. A 403
 * with rate-limit headers is a rate limit, not an auth error. */
export async function request(f: Fetch, url: string, now: number, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, { ...init, headers: { "User-Agent": UA, ...init.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e: any) {
    throw new SourceError(e?.name === "TimeoutError" ? "timeout" : "network", `${url}: ${e?.message ?? e}`);
  }
  if (res.ok) return res;
  const after = res.headers.get("retry-after");
  const reset = res.headers.get("x-ratelimit-reset");
  const limited = res.status === 429 || (res.status === 403 && (after !== null || res.headers.get("x-ratelimit-remaining") === "0"));
  await res.body?.cancel();
  if (limited) {
    // Retry-After is seconds or an HTTP date; GitHub also sends the reset time.
    const date = after && !/^\d+$/.test(after) ? Date.parse(after) : NaN;
    const at = after && /^\d+$/.test(after) ? now + Number(after) * 1000
      : Number.isFinite(date) ? date
      : reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : null;
    throw new SourceError("rate-limit", `${url}: HTTP ${res.status}`, backoffUntil(at, now));
  }
  throw new SourceError(res.status === 401 || res.status === 403 ? "auth" : "http", `${url}: HTTP ${res.status}`);
}

async function body<T>(res: Response, json: boolean): Promise<T> {
  try {
    return (json ? await res.json() : await res.text()) as T;
  } catch (e: any) {
    throw new SourceError(json ? "parse" : "network", `${res.url}: ${e?.message ?? e}`);
  }
}

/** A source returns the versions it sees, by entry key. A key left out (an
 * incomplete release, or no `tags` match in the window) keeps its old
 * version and is checked next minute. */
interface Source {
  name: string;
  due?: (now: Date) => boolean;
  read: (f: Fetch, env: Env, now: number) => Promise<Record<string, string>>;
}

const vendorText = (name: string, url: string, pick: (text: string) => string | null): Source => ({
  name,
  async read(f, _env, now) {
    const v = pick(await body<string>(await request(f, url, now), false));
    if (!v) throw new SourceError("parse", `${url}: no version`);
    return { [name]: v };
  },
});
const vendorJson = (name: string, url: string): Source =>
  vendorText(name, url, (text) => {
    try {
      return plausibleVersion(JSON.parse(text)?.version);
    } catch {
      return null;
    }
  });

/** Further t3code asset pages one run may fetch (the free Worker allows 50
 * outside requests a run; the rest of the run needs most of them). */
export const ASSET_BUDGET = 4;
/** A source's "read, but not all of it" (see run()): a symbol key, so it's
 * never taken for an entry. Its value: the error (kind and back-off kept)
 * and the prefix of the entries left unread. */
export const SOFT_ERROR = Symbol("soft error");
export interface SoftError { error: SourceError; unread: string }

const graphql = async (f: Fetch, env: Env, now: number, query: string): Promise<any> => {
  const res = await request(f, "https://api.github.com/graphql", now, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const doc = await body<any>(res, true);
  // An HTTP 200 with errors is a failure too, sorted by the error type;
  // except repositories that weren't found (renamed or gone), which leave
  // the rest of the data good: their packages are just not seen this time.
  const errors: any[] = Array.isArray(doc?.errors) ? doc.errors : doc?.errors ? [doc.errors] : [];
  if (doc?.data && errors.length && errors.every((e) => e?.type === "NOT_FOUND")) return doc.data;
  if (errors.length || !doc?.data) {
    const types = new Set<string>((Array.isArray(doc?.errors) ? doc.errors : []).map((e: any) => e?.type));
    const kind = types.has("RATE_LIMITED") ? "rate-limit" : types.has("FORBIDDEN") || types.has("UNAUTHORIZED") ? "auth" : "parse";
    // GitHub's GraphQL limit comes as HTTP 200 with RATE_LIMITED; wait for its reset.
    const reset = kind === "rate-limit" ? backoffUntil(Number(res.headers.get("x-ratelimit-reset")) * 1000 || null, now) : null;
    throw new SourceError(kind, `GraphQL: ${JSON.stringify(doc?.errors ?? doc).slice(0, 300)}`, reset);
  }
  return doc.data;
};

/** One GraphQL query for every GitHub-released package (step 0: cheapest by
 * far). The assets that don't name the version are checked by exact name. */
export const github: Source = {
  name: "github",
  async read(f, env, now) {
    const pkgs = Object.entries(GITHUB);
    const parts = pkgs.map(([, { repo, wanted, tags }], i) => {
      const [owner, name] = repo.split("/");
      const assets = Object.values(wanted).map((a, j) => `a${j}: releaseAssets(first: 1, name: ${JSON.stringify(a)}) { totalCount }`);
      const fields = `tagName isDraft isPrerelease ${assets.join(" ")}`;
      const releases = tags
        ? `releases(first: ${RECENT}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${fields} } }`
        : `latestRelease { ${fields} }`;
      return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${releases} }`;
    });
    const data = await graphql(f, env, now,
      `query { t3: repository(owner: "pingdotgg", name: "t3code") { latestRelease { ${T3_RELEASE} } ${t3Releases(null)} } ${parts.join(" ")} }`);
    const seen: Record<string, string> = {};
    pkgs.forEach(([pkg, { wanted, tags }], i) => {
      const complete = (r: any) => r && !r.isDraft && !r.isPrerelease && Object.keys(wanted).every((_, j) => r[`a${j}`]?.totalCount > 0);
      const tag = tags
        ? highestTag((data[`p${i}`]?.releases?.nodes ?? []).filter(complete).map((r: any) => r.tagName), tags)
        : complete(data[`p${i}`]?.latestRelease) ? data[`p${i}`].latestRelease.tagName : null;
      if (tag) seen[pkg] = versionOfTag(tag);
    });

    // t3code: page on until a complete nightly turns up (the updater's rule).
    // Not found (renamed or gone): nothing seen, and the others still count.
    // Its further pages (releases, then the deciding releases' assets within
    // a small budget: the Worker's request limit) can fail on their own: then
    // this run sees no t3code version (rather than a wrong one), says why as
    // a soft error that keeps the error's kind and back-off, and the other
    // packages' entries above still count.
    const repo: Repository = data.t3 ?? { releases: { nodes: [] } };
    try {
      for (let page = 1; page < T3_MAX_PAGES; page++) {
        const info = repo.releases?.pageInfo;
        if (!info?.hasNextPage || repo.releases!.nodes.some((r) => classify(r) === "nightly" && isComplete(r))) break;
        const more = await graphql(f, env, now, `query { t3: repository(owner: "pingdotgg", name: "t3code") { ${t3Releases(info.endCursor)} } }`);
        appendPage(repo, more.t3?.releases?.nodes ?? []);
        repo.releases!.pageInfo = more.t3?.releases?.pageInfo;
      }
      await fillAssets(decisive(repo), (q) => graphql(f, env, now, q), { ...fillRules, budget: ASSET_BUDGET });
    } catch (e: any) {
      const err = e instanceof SourceError ? e : new SourceError("parse", String(e?.message ?? e));
      const soft: SoftError = { error: new SourceError(err.kind, `t3code not read this run: ${err.message.slice(0, 200)}`, err.retryAt), unread: "t3code/" };
      (seen as any)[SOFT_ERROR] = soft;
      return seen;
    }
    const picked = select(repo);
    if (picked.latest) seen["t3code/latest"] = versionOfTag(picked.latest);
    if (picked.nightly) seen["t3code/nightly"] = versionOfTag(picked.nightly);
    // A release no channel rule knows: the updater opens a no-match issue.
    if (picked.unknown.length) seen["t3code/unknown"] = picked.unknown[0].tagName;
    return seen;
  },
};

/** NixOS channels, for agent-browser's browser pins: nixos-unstable's
 * revision, and the newest released stable channel's, found by asking
 * whether the newest release by date is out of beta. Three small requests.
 * The entries (nixos/<channel>) match no pin, so the backstop's lag check
 * and the status page pass them by; a change dispatches a run, and the
 * updater decides whether a pin moves. */
export const nixos: Source = {
  name: "nixos",
  async read(f, _env, now) {
    const rev = async (channel: string) => {
      const text = (await body<string>(await request(f, `${channelUrl(channel)}/git-revision`, now), false)).trim();
      if (!/^[0-9a-f]{40}$/.test(text)) throw new SourceError("parse", `${channel}: git-revision is ${JSON.stringify(text.slice(0, 60))}`);
      return text;
    };
    const latest = latestRelease(new Date(now));
    const [unstable, released] = await Promise.all([rev(NIXOS_UNSTABLE), (async () => {
      let res: Response;
      try {
        res = await f(channelUrl(latest), { method: "HEAD", redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e: any) {
        throw new SourceError(e?.name === "TimeoutError" ? "timeout" : "network", `${channelUrl(latest)}: ${e?.message ?? e}`);
      }
      await res.body?.cancel();
      if (res.status !== 404 && (res.status < 300 || res.status >= 400)) throw new SourceError("http", `${channelUrl(latest)}: HTTP ${res.status}`);
      return isReleased(res.status, res.headers.get("location"));
    })()]);
    const stable = released ? latest : previousRelease(latest);
    return { [`nixos/${NIXOS_UNSTABLE}`]: unstable, [`nixos/${stable}`]: await rev(stable) };
  },
};

// Moving a source to the other cron leaves its old entry in the old key
// until it is cleared by hand; the backstop then sees both.
export const CRONS: Record<string, { key: string; sources: Source[] }> = {
  "* * * * *": {
    key: "state:a",
    sources: [
      github,
      vendorText("claude-code", `${VENDOR_URLS.claude}/latest`, (t) => plausibleVersion(t)),
      vendorText("grok", `${VENDOR_URLS.grok}/stable`, (t) => plausibleVersion(t)),
      nixos,
    ],
  },
  "*/1 * * * *": {
    key: "state:b",
    sources: [
      vendorJson("muse", VENDOR_URLS.museChannel),
      vendorJson("antigravity", `${VENDOR_URLS.antigravity}/linux_amd64.json`),
      vendorJson("kiro-cli", `${VENDOR_URLS.kiro}/latest/manifest.json`),
      // x64's answer; the updater checks both platforms agree.
      vendorJson("boat", BOAT.endpoint("linux-x64")),
      // A page on cursor.com, not an update endpoint: every 5th minute.
      { ...vendorText("cursor-agent", VENDOR_URLS.cursorInstall, cursorVersion), due: (now) => now.getUTCMinutes() % 5 === 0 },
    ],
  },
};

/** `unread`: a partial failure: only the entries starting with it weren't
 * read this time; the source's other entries are fresh (health uses them). */
interface Failure { kind: ErrorKind; message: string; since: string; unread?: string }
export interface State {
  entries: Record<string, { version: string; firstSeen: string }>;
  sources: Record<string, { error?: Failure; retryAt?: string }>;
  dispatch: { pending: boolean; error?: Failure; retryAt?: string };
  deployed: string | null;
  /** When this key was last written (the backstop's liveness check). */
  written: string | null;
  /** When it was last written by a run in which every source was due:
   * heartbeats are timed from this, so other writes can't put them off. */
  swept?: string | null;
}
const empty = (): State => ({ entries: {}, sources: {}, dispatch: { pending: false }, deployed: null, written: null, swept: null });

function load(raw: string | null): State {
  try {
    const s = raw ? JSON.parse(raw) : null;
    return s && typeof s === "object" && s.entries && s.sources && s.dispatch ? s : empty();
  } catch {
    return empty();
  }
}

// A stored retry time beyond MAX_BACKOFF_MS (saved before the cap, or edited
// by hand) is ignored, so a source can't stay silent for good.
const later = (at: string | undefined, now: number) => {
  const t = at === undefined ? NaN : Date.parse(at);
  return t > now && t <= now + MAX_BACKOFF_MS;
};

/** One cron run. Returns the state, and whether it was written. */
export async function run(cron: string, env: Env, now: Date, f: Fetch = fetch): Promise<{ state: State; written: boolean }> {
  const job = CRONS[cron];
  if (!job) throw new Error(`unknown cron ${cron}`);
  const t = now.getTime();
  const iso = now.toISOString();
  const state = load(await env.STATE.get(job.key));
  let write = false;

  // Errors are saved with the heartbeat, never on their own, so errors that
  // come and go can't spend the write quota. `since` is when this run of
  // failures began, whatever its kinds. A partial one names what's unread.
  const fail = (s: State["sources"][string], err: SourceError, unread?: string) => {
    if (s.error?.kind !== err.kind || s.error.unread !== unread) {
      s.error = { kind: err.kind, message: err.message, since: s.error?.since ?? iso, ...(unread ? { unread } : {}) };
    }
    if (err.retryAt) {
      // A backoff longer than a heartbeat is saved at once, so stale runs
      // don't keep asking; shorter ones end before it would matter.
      if (err.retryAt - t >= HEARTBEAT_MS) write = true;
      s.retryAt = new Date(err.retryAt).toISOString();
    }
  };
  await Promise.all(job.sources.map(async (source) => {
    const s = (state.sources[source.name] ??= {});
    if ((source.due && !source.due(now)) || later(s.retryAt, t)) return;
    try {
      const seen = await source.read(f, env, t);
      delete s.retryAt;
      // A soft error: part of the source couldn't be read. What was read
      // counts; the error is kept as for a failure (its kind, its back-off),
      // marked partial so health still trusts the entries that were read.
      const soft = (seen as any)[SOFT_ERROR] as SoftError | undefined;
      if (soft) {
        fail(s, soft.error, soft.unread);
      } else {
        delete s.error;
      }
      for (const [key, version] of Object.entries(seen)) {
        if (state.entries[key]?.version === version) continue;
        state.entries[key] = { version, firstSeen: iso };
        state.dispatch.pending = true;
        write = true;
      }
    } catch (e: any) {
      fail(s, e instanceof SourceError ? e : new SourceError("parse", String(e?.message ?? e)));
    }
  }));

  const d = state.dispatch;
  if (d.pending && !later(d.retryAt, t)) {
    try {
      const res = await request(f, `https://api.github.com/repos/${env.REPO}/actions/workflows/update.yml/dispatches`, t, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      });
      await res.body?.cancel();
      state.dispatch = { pending: false };
      write = true;
    } catch (e: any) {
      const err = e instanceof SourceError ? e : new SourceError("network", String(e?.message ?? e));
      if (d.error?.kind !== err.kind) d.error = { kind: err.kind, message: err.message, since: d.error?.since ?? iso };
      if (err.retryAt) {
        if (err.retryAt - t >= HEARTBEAT_MS) write = true;
        d.retryAt = new Date(err.retryAt).toISOString();
      }
    }
  }

  const deployed = env.CF_VERSION?.id ?? null;
  if (state.deployed !== deployed) {
    state.deployed = deployed;
    write = true;
  }
  const allDue = job.sources.every((s) => !s.due || s.due(now));
  if (!state.written || (allDue && !(t - Date.parse(state.swept ?? "") < HEARTBEAT_MS))) write = true;
  if (!write) return { state, written: false };
  state.written = iso;
  if (allDue) state.swept = iso;
  try {
    await env.STATE.put(job.key, JSON.stringify(state));
  } catch (e: any) {
    // Polling and dispatching go on; the stale heartbeat makes the backstop
    // report the watcher stalled.
    console.error(`KV write failed: ${e?.message ?? e}`);
    return { state, written: false };
  }
  return { state, written: true };
}

/** Equal strings, compared in time that doesn't depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** GET /health with the bearer token: the deployed version and both keys'
 * state. Anything else is a 404 that reads no KV, so nobody else can spend
 * the read quota. */
export async function health(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname !== "/health" || !env.HEALTH_TOKEN || !same(auth, `Bearer ${env.HEALTH_TOKEN}`)) {
    return new Response("not found", { status: 404 });
  }
  const keys = Object.values(CRONS).map((c) => c.key);
  const states = await Promise.all(keys.map(async (k) => [k, load(await env.STATE.get(k))] as const));
  return Response.json({ deployed: env.CF_VERSION?.id ?? null, keys: Object.fromEntries(states) });
}
