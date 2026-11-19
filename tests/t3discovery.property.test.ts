// t3code release discovery, by property: for
// random release sets (latest-channel, nightly, preview, unknown, draft; complete or
// not; required files on any asset page; a release created between list
// pages), what the updater (fetchT3code + select) and the watcher
// (github.read) pick with paging equals what select() picks with every asset
// visible, or, when a page fails or the budget runs out, the updater fails and
// the watcher reports no t3code entry.
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as u from "../scripts/update.ts";
import { classify, isComplete, requiredAssets, select, type Release } from "../shared/channels.ts";
import { T3_MAX_PAGES } from "../shared/sources.ts";
import { github, SOFT_ERROR } from "../watcher/src/watcher.ts";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Full { tagName: string; isPrerelease: boolean; isDraft: boolean; createdAt: string; assets: string[] }
interface World { releases: Full[]; latest: string | null; assetPage: number; listPage: number; fail: Set<string>; shift: Full | null }

function makeWorld(r: () => number): World {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const n = 1 + Math.floor(r() * 10);
  const releases: Full[] = [];
  let minor = 1, patch = 0, day = 10, build = 1;
  for (let i = 0; i < n; i++) {
    const kind = pick(["latest", "nightly", "nightly", "nightly", "preview", "unknown", "draft", "latestpre"]);
    let tagName: string, isPrerelease = true, isDraft = false;
    if (kind === "latest" || kind === "latestpre") { patch++; tagName = `v0.${minor}.${patch}`; isPrerelease = kind === "latestpre"; }
    else if (kind === "nightly") tagName = `v0.${minor}.${patch + 1}-nightly.202611${day++}.${build++}`;
    else if (kind === "preview") tagName = `v0.${minor}.${patch + 1}-preview.${build++}`;
    else if (kind === "draft") { tagName = `v0.${minor}.${patch + 1}-nightly.202611${day++}.${build++}`; isDraft = true; }
    else tagName = `weird-${build++}`;
    const required = requiredAssets(tagName);
    const have = r() < 0.7 ? required : required.filter((_, k) => k !== Math.floor(r() * required.length));
    const filler = Array.from({ length: Math.floor(r() * 12) }, (_, k) => `extra-${k}.zip`);
    const assets = [...have, ...filler].sort(() => r() - 0.5);
    releases.push({ tagName, isPrerelease, isDraft, createdAt: new Date(Date.UTC(2026, 10, 1, i)).toISOString(), assets });
  }
  releases.reverse(); // newest first, as GitHub lists them (CREATED_AT DESC)
  const latestChannelReleases = releases.filter((x) => classify(x) === "latest");
  const latest = latestChannelReleases.length && r() < 0.9 ? (r() < 0.8 ? latestChannelReleases[0] : pick(latestChannelReleases)).tagName : null;
  const fail = new Set<string>();
  if (r() < 0.15) fail.add(pick(releases).tagName);
  const shift = r() < 0.3 ? { tagName: `v9.9.9-preview.${build}`, isPrerelease: true, isDraft: false, createdAt: "2026-11-30T00:00:00Z", assets: [] } : null;
  return { releases, latest, assetPage: 2 + Math.floor(r() * 3), listPage: 1 + Math.floor(r() * 4), fail, shift };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** A fake GitHub GraphQL for one world; `shift`: a release created after the
 * first list page (everything moves down one, so a page repeats an entry). */
function server(w: World) {
  let list = [...w.releases];
  let listed = 0;
  const node = (f: Full): Release => ({
    tagName: f.tagName, isPrerelease: f.isPrerelease, isDraft: f.isDraft, createdAt: f.createdAt,
    releaseAssets: { nodes: f.assets.slice(0, w.assetPage).map((name) => ({ name })),
      pageInfo: { hasNextPage: f.assets.length > w.assetPage, endCursor: `${f.tagName}@${w.assetPage}` } },
  });
  let failed = false;
  const served: Full[] = [];
  return {
    served,
    get failed() { return failed; },
    answer(q: string): any {
      const tag = /release\(tagName: "([^"]+)"\)/.exec(q)?.[1];
      if (tag) {
        if (w.fail.has(tag)) { failed = true; return { data: { repository: { release: null } } }; }
        const f = list.find((x) => x.tagName === tag)!;
        const off = Number(/after: "[^"]*@(\d+)"/.exec(q)![1]);
        return { data: { repository: { release: { releaseAssets: { nodes: f.assets.slice(off, off + w.assetPage).map((name) => ({ name })),
          pageInfo: { hasNextPage: f.assets.length > off + w.assetPage, endCursor: `${tag}@${off + w.assetPage}` } } } } } };
      }
      const off = Number(/releases\(first: \d+, after: "r(\d+)"/.exec(q)?.[1] ?? 0);
      served.push(...list.slice(off, off + w.listPage));
      const releases = { nodes: list.slice(off, off + w.listPage).map(node),
        pageInfo: { hasNextPage: list.length > off + w.listPage, endCursor: `r${off + w.listPage}` } };
      if (listed++ === 0 && w.shift) list = [w.shift, ...list];
      const latest = w.latest ? node(list.find((x) => x.tagName === w.latest)!) : null;
      const repo = q.includes("t3: repository") ? { t3: { ...(q.includes("latestRelease") ? { latestRelease: latest } : {}), releases } }
        : { repository: { latestRelease: latest, releases } };
      return { data: clone(repo) };
    },
  };
}

const full = (f: Full): Release => ({ ...f, releaseAssets: { nodes: f.assets.map((name) => ({ name })) } });
const latestOf = (w: World) => (w.latest ? full(w.releases.find((x) => x.tagName === w.latest)!) : null);
/** The reference for the releases a run actually listed (a shifted list
 * repeats one and loses one at the window's end), every asset visible. */
const idealOf = (w: World, served: Full[]) => select({ latestRelease: latestOf(w), releases: { nodes: served.map(full) } });
/** The reference: the updater's own paging rule, with every asset visible. */
function ideal(w: World) {
  const nodes: Release[] = [];
  for (let page = 0; page < T3_MAX_PAGES; page++) {
    nodes.push(...w.releases.slice(page * w.listPage, (page + 1) * w.listPage).map(full));
    if (nodes.some((x) => classify(x) === "nightly" && isComplete(x)) || w.releases.length <= (page + 1) * w.listPage) break;
  }
  return select({ latestRelease: latestOf(w), releases: { nodes } });
}

const env = { GITHUB_TOKEN: "t", HEALTH_TOKEN: "h", REPO: "o/r", STATE: { get: async () => null, put: async () => {} } } as any;

test("t3code discovery: paged picks equal the all-assets-visible picks, or nothing", async () => {
  process.env.GH_TOKEN = "test";
  const bad: string[] = [];
  for (let seed = 1; seed <= 20000 && bad.length < 5; seed++) {
    const w = makeWorld(rng(seed));
    const ctx = JSON.stringify({ seed, latest: w.latest, assetPage: w.assetPage, listPage: w.listPage, fail: [...w.fail], shift: !!w.shift,
      releases: w.releases.map((x) => [x.tagName, x.isPrerelease, x.isDraft, requiredAssets(x.tagName).every((a) => x.assets.includes(a)), x.assets.length]) });

    // The updater.
    const s1 = server(w);
    let got: ReturnType<typeof select> | null = null;
    try { got = select(await u.fetchT3code(async (_url: string, body?: any) => s1.answer(body.query))); } catch (e: any) {
      if (!s1.failed) bad.push(`updater threw without a failure: ${e.message} ${ctx}`);
    }
    const want1 = w.shift ? idealOf(w, s1.served) : ideal(w);
    if (got && (got.latest !== want1.latest || got.nightly !== want1.nightly)) {
      bad.push(`updater picked ${got.latest}/${got.nightly}, want ${want1.latest}/${want1.nightly} ${ctx}`);
    }
    const inc = (p: ReturnType<typeof select>) => p.incomplete.map((x) => x.tagName).sort().join();
    if (got && inc(got) !== inc(want1)) bad.push(`updater incomplete ${inc(got)}, want ${inc(want1)} ${ctx}`);

    // The watcher.
    const s2 = server(w);
    const f = async (url: string, init?: RequestInit) => url === "https://api.github.com/graphql"
      ? Response.json(s2.answer(JSON.parse(init!.body as string).query)) : new Response("no", { status: 404 });
    const seen: any = await github.read(f as any, env, Date.UTC(2026, 10, 14));
    const soft = seen[SOFT_ERROR];
    if (soft) {
      if (seen["t3code/latest"] || seen["t3code/nightly"]) bad.push(`watcher soft error but t3code entries ${ctx}`);
      if (!s2.failed && !/budget/.test(soft.error.message)) bad.push(`watcher soft error without a failure: ${soft.error.message} ${ctx}`);
    } else {
      const want2 = w.shift ? idealOf(w, s2.served) : ideal(w);
      const v = (t: string | null) => (t ? t.replace(/^v/, "") : undefined);
      if (seen["t3code/latest"] !== v(want2.latest) || seen["t3code/nightly"] !== v(want2.nightly)) {
        bad.push(`watcher saw ${seen["t3code/latest"]}/${seen["t3code/nightly"]}, want ${want2.latest}/${want2.nightly} ${ctx}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
