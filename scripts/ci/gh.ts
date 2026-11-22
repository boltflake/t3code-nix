// The one place the update workflow talks to GitHub. Two implementations
// (and tests/fake-gh.ts) share one interface:
//   GitHub  the real REST API, with fetch and the workflow's GH_TOKEN
//   DryRun  reads through a real client, records every write instead of doing
//           it (the workflow's dry_run input); nothing on GitHub changes
//
// Refs are always full names ("refs/heads/...", "refs/tags/...").
import { Failed, UA } from "../lib/util.ts";

export const REPO = process.env.GITHUB_REPOSITORY ?? "boltflake/t3code-nix";
export const LABEL = "t3code-nix";

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  comments?: string[];
}

/** An update.yml run, for health's lag check:
 * - `read`: about when it read upstream: its resolve job's start (a few
 *   steps before the read; a re-run of failed jobs keeps the old one), or
 *   for a run not looked into, when the run started or was made
 * - `running` (in progress, for under MAX_RUN_MS), `waiting` (queued, pending, waiting or requested)
 * - `done`: completed having done its work, by its jobs: its issues job ran
 *   in the latest attempt (a run the gate re-dispatched skips it; a run
 *   cancelled mid-way still runs it), and it made no retry (a publish that
 *   found main moved re-dispatches one)
 * - `ran`: completed after any of its jobs started (a waiting run replaced
 *   by a newer dispatch never did): a waiting run takes over from it
 * - `finished`: when it completed, or null */
export interface UpdateRun {
  read: string;
  running: boolean;
  waiting: boolean;
  done: boolean;
  ran?: boolean;
  finished: string | null;
}

/** update.yml's run-names of real runs: a run, or publish's re-dispatch. */
const REAL_TITLE = /^update( \(retry \d+\))?$/;
const WAITING = new Set(["queued", "pending", "waiting", "requested"]);
/** update.yml's job ids (jobs without a `name:` are listed by id); the
 * workflows test checks they're still there and unnamed. */
export const UPDATE_JOBS = { resolve: "resolve", issues: "issues" };
/** The longest an update run can be working: its jobs' time limits along
 * the longest path (about 10 hours), with slack. */
export const MAX_RUN_MS = 12 * 60 * 60_000;
/** Cancelled runs looked into: until this many that ran are found, in at
 * most CANCELLED_LOOKED_INTO requests. */
const CANCELLED_RAN = 3;
const CANCELLED_LOOKED_INTO = 30;
/** Jobs requests for one health check at most (GITHUB_TOKEN allows 1,000
 * an hour for the repository), and how many at once. */
const JOB_REQUESTS = 150;
const CONCURRENT = 5;
/** Finished runs looked into (their jobs): those that finished within the
 * longest run's time, and an hour more (and, in updateRuns, any that ended
 * after the oldest unfinished run was made). */
const LOOKED_INTO_MS = MAX_RUN_MS + 60 * 60_000;

export interface Client {
  issues(): Promise<Issue[]>;
  createIssue(title: string, body: string): Promise<Issue>;
  comment(number: number, body: string): Promise<void>;
  editIssue(number: number, change: { title?: string; body?: string; state?: "open" | "closed" }): Promise<void>;
  createStatus(sha: string, state: string, description: string, url: string, context?: string): Promise<void>;
  dispatch(workflow: string, ref: string, inputs: Record<string, string>): Promise<void>;
  workflowState(workflow: string): Promise<string>;
  /** Whether the workflow run with this ID has finished. */
  runCompleted(id: string): Promise<boolean>;
  /** The newest real (not dry) update.yml runs on main. */
  updateRuns(): Promise<UpdateRun[]>;
  enableWorkflow(workflow: string): Promise<void>;
  /** {full ref: sha} for refs under a short prefix ("tags/t3code-v"). */
  refs(prefix: string): Promise<Record<string, string>>;
  createRef(ref: string, sha: string): Promise<void>;
  deleteRef(ref: string): Promise<void>;
  /** Every published GitHub release (all pages, drafts left out): tag, id,
   * and whether it's a prerelease (which GitHub won't mark latest). */
  releases(): Promise<Release[]>;
  /** GitHub's latest release: the one marked latest, else the newest
   * published one; null when there's none (a 404). Making a release with
   * make_latest "false" leaves it; "false" on the latest doesn't clear it. */
  latestRelease(): Promise<Release | null>;
  /** The release for this tag, or null. */
  releaseByTag(tag: string): Promise<Release | null>;
  /** Create a release for an existing tag at `target`, never marked latest.
   * Raises GitHub's error as it is (a 422 when one exists already). */
  createRelease(r: { tag: string; target: string; name: string; body: string }): Promise<Release>;
  /** Mark this release latest, changing nothing else about it. */
  markLatest(r: Release): Promise<void>;
  /** Writes recorded by a dry run, or null. */
  actions?: Record<string, unknown>[] | null;
}

export interface Release {
  id: number;
  tag: string;
  /** GitHub can't mark a prerelease latest. */
  prerelease: boolean;
}

/** A release as the API returns it, as Client's methods give it. */
const release = (r: any): Release => ({ id: r.id, tag: r.tag_name, prerelease: r.prerelease === true });

export class GitHub implements Client {
  readonly repo: string;
  readonly token: string;

  constructor(repo = REPO, token = process.env.GH_TOKEN ?? "") {
    this.repo = repo;
    this.token = token;
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`https://api.github.com/repos/${this.repo}/${path}`, {
      method,
      headers: {
        "User-Agent": UA,
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Failed(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  /** Every page of a list endpoint. */
  private async all(path: string): Promise<any[]> {
    const items: any[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.api("GET", `${path}${sep}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  async updateRuns(now = new Date()): Promise<UpdateRun[]> {
    // Dry runs are left out by their title (update.yml's run-name). They're
    // listed too, so page on until enough real runs that weren't cancelled
    // are seen (a burst of dry runs or of replaced waiting runs can't hide
    // a real one), at most 5 pages.
    const runs: any[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch: any[] = (await this.api("GET", `actions/workflows/update.yml/runs?branch=main&per_page=100&page=${page}`))?.workflow_runs ?? [];
      runs.push(...batch.filter((x: any) => REAL_TITLE.test(String(x?.display_title)) && typeof x.created_at === "string"));
      if (batch.length < 100 || runs.filter((x) => x.conclusion !== "cancelled").length >= 20) break;
    }
    // Runs in progress, asked for on their own: newer dispatches (replaced
    // waiting runs) can push one past the pages above.
    const busy: any[] = (await this.api("GET", "actions/workflows/update.yml/runs?branch=main&status=in_progress&per_page=100"))?.workflow_runs ?? [];
    const ids = new Set(runs.map((x) => x.id));
    for (const x of busy) {
      if (x?.status === "in_progress" && !ids.has(x.id) && REAL_TITLE.test(String(x?.display_title)) && typeof x.created_at === "string") runs.push(x);
    }
    // In progress for longer than any run can work (a job waiting for a
    // runner GitHub can't give it, or a stuck run) isn't going any more.
    const isRunning = (x: any) => x.status === "in_progress" && !(now.getTime() - Date.parse(x.run_started_at ?? x.created_at) >= MAX_RUN_MS);
    // A finished run that ended after the oldest open one (running or
    // waiting) was made, the run it may have handed over to, is always
    // looked into.
    const oldestOpen = Math.min(...runs.filter((x) => isRunning(x) || WAITING.has(x.status)).map((x) => Date.parse(x.created_at)));
    const endedOf = (x: any) => (typeof x.updated_at === "string" ? x.updated_at : x.run_started_at ?? x.created_at);
    // Only ones that finished within LOOKED_INTO_MS (an old run's failed
    // jobs may have been re-run lately), or after the oldest open run was
    // made, matter.
    const matters = (x: any) => x.status === "completed" && x.conclusion !== "skipped"
      && (now.getTime() - Date.parse(endedOf(x)) < LOOKED_INTO_MS || Date.parse(endedOf(x)) >= oldestOpen);
    // A run's jobs: whether the issues job ran (done), whether any job
    // started (ran), and when resolve read upstream. Every attempt's jobs
    // (filter=all): GitHub copies the jobs a re-run of failed jobs didn't
    // re-run into the new attempt with their old times, so the latest
    // resolve that started is when upstream was read either way; the latest
    // attempt decides `done`. A history past 5 pages (many re-runs) isn't
    // trusted: not done, so health waits rather than take an old attempt's
    // evidence.
    // Every jobs page counts against a budget (the cancelled ones against
    // their own as well); a run past it isn't looked into.
    const evidence = new Map<number, { done: boolean; ran: boolean; read: string | null }>();
    const budget = { all: JOB_REQUESTS, cancelled: CANCELLED_LOOKED_INTO };
    const lookInto = async (x: any) => {
      const jobs: any[] = [];
      let whole = false;
      for (let page = 1; page <= 5; page++) {
        const isCancelled = x.conclusion === "cancelled";
        if (budget.all <= 0 || (isCancelled && budget.cancelled <= 0)) {
          if (page === 1) return null;
          break;
        }
        budget.all--;
        if (isCancelled) budget.cancelled--;
        const r = await this.api("GET", `actions/runs/${x.id}/jobs?filter=all&per_page=100&page=${page}`);
        const batch: any[] = r?.jobs ?? [];
        jobs.push(...batch);
        if (batch.length < 100 || jobs.length >= (r?.total_count ?? 0)) {
          whole = true;
          break;
        }
      }
      const attempt = typeof x.run_attempt === "number" ? x.run_attempt
        : Math.max(0, ...jobs.map((j) => (typeof j?.run_attempt === "number" ? j.run_attempt : 0)));
      const starts = jobs.filter((j) => j?.name === UPDATE_JOBS.resolve && j.conclusion !== "skipped" && Number.isFinite(Date.parse(j.started_at ?? "")))
        .map((j) => j.started_at as string).sort();
      const found = {
        done: whole && jobs.some((j) => j?.name === UPDATE_JOBS.issues && j.conclusion !== "skipped" && (j.run_attempt ?? 0) === attempt),
        ran: jobs.some((j) => Number.isFinite(Date.parse(j?.started_at ?? ""))),
        read: starts.length ? starts[starts.length - 1] : null,
      };
      evidence.set(x.id, found);
      return found;
    };
    // A few at a time: GitHub limits concurrent requests.
    const pool = async (list: any[]) => {
      const out: (Awaited<ReturnType<typeof lookInto>>)[] = [];
      for (let i = 0; i < list.length; i += CONCURRENT) out.push(...await Promise.all(list.slice(i, i + CONCURRENT).map(lookInto)));
      return out;
    };
    await pool(runs.filter((x) => matters(x) && x.conclusion !== "cancelled"));
    // Cancelled ones too (a run cancelled mid-way, or timed out, did its
    // work), most recently finished first, until CANCELLED_RAN that ran are
    // found: runs go one at a time, so those hold the newest evidence; the
    // rest are waiting runs replaced by newer dispatches, which never ran.
    // At most CANCELLED_LOOKED_INTO requests.
    const cancelled = runs.filter((x) => matters(x) && x.conclusion === "cancelled")
      .sort((a, b) => Date.parse(endedOf(b)) - Date.parse(endedOf(a))).slice(0, CANCELLED_LOOKED_INTO);
    for (let i = 0, found = 0; i < cancelled.length && found < CANCELLED_RAN && budget.cancelled > 0; i += CONCURRENT) {
      found += (await pool(cancelled.slice(i, i + CONCURRENT))).filter((e) => e?.ran).length;
    }
    const listed = runs.map((x: any) => {
      const completed = x.status === "completed";
      // Not looked into: a finished run counts as done (and as having run)
      // unless cancelled or skipped.
      const plain = completed && x.conclusion !== "cancelled" && x.conclusion !== "skipped";
      const e = evidence.get(x.id);
      const read = e?.read ?? (typeof x.run_started_at === "string" ? x.run_started_at : x.created_at);
      const ran = e ? e.ran : plain;
      return { read, running: isRunning(x), waiting: WAITING.has(x.status), done: e ? e.done : plain, ...(completed ? { ran } : {}),
        finished: completed && typeof x.updated_at === "string" ? x.updated_at : null };
    });
    // A run whose publish found main moved made a retry after reading and
    // published nothing: not done, so health waits for the retry.
    return listed.map((r, i) => {
      if (!r.done || r.finished === null) return r;
      const from = Date.parse(r.read), to = Date.parse(r.finished);
      const retried = runs.some((y, j) => j !== i && /\(retry \d+\)$/.test(y.display_title)
        && Date.parse(y.created_at) >= from && Date.parse(y.created_at) <= to);
      return retried ? { ...r, done: false } : r;
    });
  }

  /** Open issues only (the status page). */
  async openIssues(): Promise<Issue[]> {
    const items = await this.all(`issues?labels=${LABEL}&state=open`);
    return items.filter((i) => !i.pull_request && i.state === "open")
      .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", state: "open" as const }));
  }
  async issues() {
    const items = await this.all(`issues?labels=${LABEL}&state=all`);
    return items.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", state: i.state }));
  }
  async createIssue(title: string, body: string) {
    const i = await this.api("POST", "issues", { title, body, labels: [LABEL] });
    return { number: i.number, title, body, state: "open" as const };
  }
  async comment(number: number, body: string) {
    await this.api("POST", `issues/${number}/comments`, { body });
  }
  async editIssue(number: number, change: { title?: string; body?: string; state?: "open" | "closed" }) {
    await this.api("PATCH", `issues/${number}`, change);
  }
  async createStatus(sha: string, state: string, description: string, url: string, context = "tested") {
    await this.api("POST", `statuses/${sha}`, { state, description: description.slice(0, 140), target_url: url, context });
  }
  async dispatch(workflow: string, ref: string, inputs: Record<string, string>) {
    await this.api("POST", `actions/workflows/${workflow}/dispatches`, { ref, inputs });
  }
  async workflowState(workflow: string) {
    return (await this.api("GET", `actions/workflows/${workflow}`)).state;
  }
  async runCompleted(id: string) {
    // A run that no longer exists (deleted, or a hand-pushed ref) has finished.
    const run = await this.maybe(`actions/runs/${encodeURIComponent(id)}`);
    return run === null || run.status === "completed";
  }
  async enableWorkflow(workflow: string) {
    await this.api("PUT", `actions/workflows/${workflow}/enable`);
  }
  // matching-refs answers [] when nothing matches; any error (auth, rate
  // limit, outage) is raised, never mistaken for "no refs". It isn't
  // paginated: one request returns every match (paging it would repeat the
  // whole list forever once there are 100 tags).
  async refs(prefix: string) {
    const items: any[] = (await this.api("GET", `git/matching-refs/${prefix}`)) ?? [];
    return Object.fromEntries(items.map((r) => [r.ref, r.object.sha]));
  }
  async createRef(ref: string, sha: string) {
    await this.api("POST", "git/refs", { ref, sha });
  }
  async deleteRef(ref: string) {
    await this.api("DELETE", `git/${ref}`);
  }
  async releases() {
    // Drafts aren't releases yet: releases/tags/<tag> doesn't find them, and
    // one can't be marked latest. A hand-made draft doesn't block the real one.
    return (await this.all("releases")).filter((r) => !r.draft).map(release);
  }
  /** GET, or null on a 404. */
  private async maybe(path: string): Promise<any | null> {
    try {
      return await this.api("GET", path);
    } catch (e: any) {
      if (/: HTTP 404 /.test(String(e?.message))) return null;
      throw e;
    }
  }
  async latestRelease() {
    const r = await this.maybe("releases/latest");
    return r ? release(r) : null;
  }
  async releaseByTag(tag: string) {
    const r = await this.maybe(`releases/tags/${encodeURIComponent(tag)}`);
    return r ? release(r) : null;
  }
  async createRelease(r: { tag: string; target: string; name: string; body: string }) {
    const made = await this.api("POST", "releases", {
      tag_name: r.tag, target_commitish: r.target, name: r.name, body: r.body, make_latest: "false",
    });
    return release(made);
  }
  async markLatest(r: Release) {
    await this.api("PATCH", `releases/${r.id}`, { make_latest: "true" });
  }
}

export class DryRun implements Client {
  readonly reader: Client | null;
  actions: Record<string, unknown>[] = [];

  constructor(reader: Client | null = null) {
    this.reader = reader;
  }
  private record(action: string, args: Record<string, unknown>) {
    this.actions.push({ action, ...args });
  }
  async issues() { return this.reader ? this.reader.issues() : []; }
  async workflowState(workflow: string) { return this.reader ? this.reader.workflowState(workflow) : "active"; }
  async runCompleted(id: string) { return this.reader ? this.reader.runCompleted(id) : false; }
  async updateRuns() { return this.reader ? this.reader.updateRuns() : []; }
  async refs(prefix: string) { return this.reader ? this.reader.refs(prefix) : {}; }
  async releases() { return this.reader ? this.reader.releases() : []; }
  async latestRelease() { return this.reader ? this.reader.latestRelease() : null; }
  async releaseByTag(tag: string) { return this.reader ? this.reader.releaseByTag(tag) : null; }
  async createRelease(r: { tag: string; target: string; name: string; body: string }) {
    this.record("create_release", { tag: r.tag, target: r.target, name: r.name, make_latest: "false", body: r.body });
    return { id: -this.actions.length, tag: r.tag, prerelease: false };
  }
  async markLatest(r: Release) { this.record("mark_latest", { tag: r.tag }); }
  async createIssue(title: string, body: string) {
    this.record("create_issue", { title, body });
    return { number: -this.actions.length, title, body, state: "open" as const };
  }
  async comment(number: number, body: string) { this.record("comment", { number, body }); }
  async editIssue(number: number, change: { title?: string; body?: string; state?: string }) { this.record("edit_issue", { number, ...change }); }
  async createStatus(sha: string, state: string, description: string, url: string, context = "tested") {
    this.record("create_status", { sha, state, description, target_url: url, context });
  }
  async dispatch(workflow: string, ref: string, inputs: Record<string, string>) { this.record("dispatch", { workflow, ref, inputs }); }
  async enableWorkflow(workflow: string) { this.record("enable_workflow", { workflow }); }
  async createRef(ref: string, sha: string) { this.record("create_ref", { ref, sha }); }
  async deleteRef(ref: string) { this.record("delete_ref", { ref }); }
}

/** The client for this run: DryRun when DRY_RUN=true, else the real API. */
export function client(): Client {
  const real = new GitHub();
  return process.env.DRY_RUN === "true" ? new DryRun(real) : real;
}
