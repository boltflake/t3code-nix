// The GitHub client in memory, for tests.
import type { Client, Issue, Release, UpdateRun } from "../scripts/ci/gh.ts";

export class Fake implements Client {
  issueList: Issue[] = [];
  statuses: [string, string, string][] = [];
  dispatches: [string, string, Record<string, string>][] = [];
  workflows: Record<string, string> = {};
  refMap: Record<string, string> = {};

  // Newest first, as GitHub lists them.
  async issues() { return this.issueList.map((i) => ({ ...i, comments: [...(i.comments ?? [])] })).reverse(); }
  private find(number: number) { return this.issueList.find((i) => i.number === number)!; }
  async createIssue(title: string, body: string) {
    const issue: Issue = { number: this.issueList.length + 1, title, body, state: "open", comments: [] };
    this.issueList.push(issue);
    return { ...issue };
  }
  async comment(number: number, body: string) { this.find(number).comments!.push(body); }
  async editIssue(number: number, change: { title?: string; body?: string; state?: "open" | "closed" }) {
    Object.assign(this.find(number), Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)));
  }
  statusUrls: string[] = [];
  async createStatus(sha: string, state: string, _d: string, url: string, context = "tested") { this.statuses.push([sha, context, state]); this.statusUrls.push(url); }
  async dispatch(workflow: string, ref: string, inputs: Record<string, string>) { this.dispatches.push([workflow, ref, inputs]); }
  async workflowState(workflow: string) { return this.workflows[workflow] ?? "active"; }
  /** Run IDs that have finished. */
  completed = new Set<string>();
  async runCompleted(id: string) { return this.completed.has(id); }
  runList: UpdateRun[] = [];
  async updateRuns() { return this.runList; }
  async enableWorkflow(workflow: string) { this.workflows[workflow] = "active"; }
  // Like GitHub's matching-refs: a short prefix, full names back.
  async refs(prefix: string) {
    return Object.fromEntries(Object.entries(this.refMap).filter(([r]) => r.startsWith(`refs/${prefix}`)));
  }
  async createRef(ref: string, sha: string) { this.refMap[ref] = sha; }
  async deleteRef(ref: string) {
    if (!ref.startsWith("refs/")) throw new Error(`not a full ref: ${ref}`);
    delete this.refMap[ref];
  }
  /** Releases, with what they were made with, oldest first. */
  releaseList: { id: number; tag: string; target: string; name: string; body: string; prerelease?: boolean }[] = [];
  /** The tag marked latest (by markLatest, or set by a test), or null. */
  marked: string | null = null;
  /** GitHub's latest, as it answers: the marked one, else the newest
   * published (not prerelease) release; null when there's none. */
  get latest(): string | null {
    return this.marked ?? this.releaseList.filter((r) => !r.prerelease).at(-1)?.tag ?? null;
  }
  set latest(tag: string | null) { this.marked = tag; }
  /** A release made by someone else between the list and the create. */
  sneakIn: string | null = null;
  private static out = (r: { id: number; tag: string; prerelease?: boolean }) => ({ id: r.id, tag: r.tag, prerelease: r.prerelease === true });
  async releases() { return this.releaseList.map(Fake.out); }
  async latestRelease() {
    const r = this.releaseList.find((x) => x.tag === this.latest);
    return r ? Fake.out(r) : null;
  }
  async releaseByTag(tag: string) {
    const r = this.releaseList.find((x) => x.tag === tag);
    return r ? Fake.out(r) : null;
  }
  async createRelease(r: { tag: string; target: string; name: string; body: string }) {
    if (this.sneakIn === r.tag) this.releaseList.push({ id: 999, ...r, body: "someone else's" });
    if (this.releaseList.some((x) => x.tag === r.tag)) throw new Error("POST releases: HTTP 422 already_exists");
    if (!(`refs/tags/${r.tag}` in this.refMap)) throw new Error(`POST releases: HTTP 422 no tag ${r.tag}`);
    const made = { id: this.releaseList.length + 1, ...r };
    this.releaseList.push(made);
    return Fake.out(made);
  }
  /** Like GitHub: a prerelease can't be marked latest. */
  async markLatest(r: Release) {
    if (this.releaseList.find((x) => x.tag === r.tag)?.prerelease) throw new Error("PATCH releases: HTTP 422 a prerelease can't be latest");
    this.marked = r.tag;
  }
  cacheList: { id: number; key: string; ref: string; lastAccessed: string }[] = [];
  async caches(prefix: string, ref: string) {
    return this.cacheList.filter((c) => c.key.startsWith(prefix) && c.ref === ref).map(({ id, key, lastAccessed }) => ({ id, key, lastAccessed }));
  }
  async deleteCache(id: number, _key: string) { this.cacheList = this.cacheList.filter((c) => c.id !== id); }
}
