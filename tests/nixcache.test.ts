// The nixpkgs bump's cache check (scripts/lib/nixcache.ts), on made-up
// derivation graphs and a faked cache.nixos.org.
// Run: node --test tests/*.test.ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Budget, closure, compare, fetchNarinfo, nameOf, parseShow, walk, type Drv, type FetchNarinfo, type Narinfo } from "../scripts/lib/nixcache.ts";
import { timing } from "../scripts/lib/util.ts";

const S = "/nix/store/";
let n = 0;
/** A store path with a made-up 32-character hash. */
const sp = (name: string, tag = "") => `${S}${(String(n++).padStart(6, "0") + tag + name).replace(/[^a-z0-9]/gi, "").padEnd(32, "0").slice(0, 32).toLowerCase()}-${name}`;

/** A graph: name -> derivation; each has `out` (and `lib` if asked). */
class Graph {
  drvs = new Map<string, Drv>();
  add(name: string, inputs: [Drv & { path: string }, string[]][] = [], opts: { lib?: boolean; fixed?: boolean; tag?: string; hash?: string; local?: boolean } = {}) {
    const path = sp(name, opts.tag) + ".drv";
    const outputs: Record<string, string | null> = { out: opts.fixed ? null : sp(name, opts.tag) };
    if (opts.lib) outputs.lib = sp(`${name}-lib`, opts.tag);
    const d: Drv & { path: string } = { path, name, outputs, inputs: Object.fromEntries(inputs.map(([i, o]) => [i.path, o])), ...(opts.fixed ? { fixed: true } : {}),
      ...(opts.hash ? { hash: opts.hash } : {}), ...(opts.local ? { local: true } : {}) };
    this.drvs.set(path, d);
    return d;
  }
  show = (paths: string[]) => new Map(paths.filter((p) => this.drvs.has(p)).map((p) => [p, this.drvs.get(p)!]));
}

/** A cache holding these paths, with references; everything else 404. */
function cache(held: Map<string, string[]> | Set<string>, unknown = new Set<string>()): FetchNarinfo & { asked: string[] } {
  const asked: string[] = [];
  const f = (async (p: string): Promise<Narinfo> => {
    asked.push(p);
    if (unknown.has(p)) return { status: "unknown", error: `${p}: HTTP 503` };
    if (held instanceof Set ? held.has(p) : held.has(p)) return { status: "cached", references: held instanceof Set ? [] : held.get(p)! };
    return { status: "missing" };
  }) as FetchNarinfo & { asked: string[] };
  f.asked = asked;
  return f;
}

/** The flake's own work on top of some nixpkgs derivations: a vendor
 * download, a patched package built with a hook and gcc's lib output, and a
 * wrapper using a library. */
function flake(g: Graph, nixpkgs: { hook: Drv & { path: string }; gcc: Drv & { path: string }; gtk: Drv & { path: string } }) {
  const src = g.add("vendor-1.0.tar.gz", [], { fixed: true });
  const pkg = g.add("tool-unwrapped-1.0", [[src, ["out"]], [nixpkgs.hook, ["out"]], [nixpkgs.gcc, ["lib"]]]);
  return g.add("tool-1.0", [[pkg, ["out"]], [nixpkgs.gtk, ["out"]]]);
}
const outs = (...ds: Drv[]) => ds.flatMap((d) => Object.values(d.outputs).filter((p): p is string => !!p));

test("parseShow reads format 4 and the older layout, and marks downloads", () => {
  const four = parseShow(JSON.stringify({ version: 4, derivations: {
    "aaaa0000000000000000000000000000-x-1.drv": { name: "x-1", outputs: { out: { path: "bbbb0000000000000000000000000000-x-1" } },
      inputs: { drvs: { "cccc0000000000000000000000000000-gcc-16.drv": { outputs: ["lib"], dynamicOutputs: {} } }, srcs: [] } },
    "dddd0000000000000000000000000000-src.tar.gz.drv": { name: "src.tar.gz", outputs: { out: { hash: "abc", method: "flat" } }, inputs: { drvs: {}, srcs: [] } },
  } }));
  assert.deepEqual(four.get(`${S}aaaa0000000000000000000000000000-x-1.drv`),
    { name: "x-1", outputs: { out: `${S}bbbb0000000000000000000000000000-x-1` }, inputs: { [`${S}cccc0000000000000000000000000000-gcc-16.drv`]: ["lib"] } });
  assert.equal(four.get(`${S}dddd0000000000000000000000000000-src.tar.gz.drv`)!.fixed, true);
  const old = parseShow(JSON.stringify({
    [`${S}aaaa0000000000000000000000000000-x-1.drv`]: { name: "x-1", outputs: { out: { path: `${S}bbbb0000000000000000000000000000-x-1` } },
      inputDrvs: { [`${S}cccc0000000000000000000000000000-gcc-16.drv`]: ["lib"] } },
  }));
  assert.deepEqual([...old.values()][0].inputs, { [`${S}cccc0000000000000000000000000000-gcc-16.drv`]: ["lib"] });
  assert.equal(nameOf(`${S}cccc0000000000000000000000000000-gcc-16.drv`), "gcc-16");
});

test("walk: only the flake's own work is built when nixpkgs is cached; downloads are never looked up", async () => {
  const g = new Graph();
  const np = { hook: g.add("auto-patchelf-hook"), gcc: g.add("gcc-16", [], { lib: true }), gtk: g.add("gtk+3-3.24") };
  const top = flake(g, np);
  const ask = cache(new Set(outs(np.hook, np.gcc, np.gtk)));
  const w = await walk([top.path], g.show, ask);
  assert.deepEqual([...w.build.values()].sort(), ["tool-1.0", "tool-unwrapped-1.0", "vendor-1.0.tar.gz"]);
  assert.deepEqual([w.missing, w.unknown], [[], []]);
  assert.ok(!ask.asked.some((p) => p.includes("vendor")), "a download isn't looked up");
  assert.ok(!ask.asked.includes(np.gcc.outputs.out!), "only the output used (lib) is looked up");
});

/** Baseline and bumped graphs: nixpkgs derivations get new paths at the new
 * revision (same names), the flake's own get new paths too. */
function bump(change: (np: Record<string, Drv & { path: string }>, g: Graph) => void = () => {}) {
  const g = new Graph();
  const before = { hook: g.add("auto-patchelf-hook", [], { tag: "a" }), gcc: g.add("gcc-16", [], { lib: true, tag: "a" }), gtk: g.add("gtk+3-3.24", [], { tag: "a" }) };
  const after = { hook: g.add("auto-patchelf-hook", [], { tag: "b" }), gcc: g.add("gcc-16", [], { lib: true, tag: "b" }), gtk: g.add("gtk+3-3.24", [], { tag: "b" }) };
  change(after, g);
  return { g, base: flake(g, before), next: flake(g, after), before, after };
}

test("compare: nothing missing when the new revision is cached", async () => {
  const { g, base, next, before, after } = bump();
  const v = await compare({ x: [base.path] }, { x: [next.path] }, g.show, cache(new Set(outs(...Object.values(before), ...Object.values(after)))));
  assert.deepEqual(v, { missing: [], unknown: [] });
});

test("compare: a missing nested output (gcc's lib)", async () => {
  const { g, base, next, before, after } = bump();
  const held = new Set(outs(...Object.values(before), after.hook, after.gtk, after.gcc).filter((p) => p !== after.gcc.outputs.lib));
  const v = await compare({ x: [base.path] }, { x: [next.path] }, g.show, cache(held));
  assert.deepEqual(v.missing, ["x: gcc-16"]);
});

test("compare: a missing build hook", async () => {
  const { g, base, next, before, after } = bump();
  const v = await compare({ x: [base.path] }, { x: [next.path] }, g.show, cache(new Set(outs(...Object.values(before), after.gcc, after.gtk))));
  assert.deepEqual(v.missing, ["x: auto-patchelf-hook"]);
});

test("compare: a same-name rebuild (cached at the baseline, not at the new revision)", async () => {
  const { g, base, next, before, after } = bump();
  const v = await compare({ x: [base.path] }, { x: [next.path] }, g.show, cache(new Set(outs(...Object.values(before), after.hook, after.gcc))));
  assert.deepEqual(v.missing, ["x: gtk+3-3.24"], "same name as at the baseline, but it must be built");
});

test("compare: a missing library further down a cached path's closure", async () => {
  const { g, base, next, before, after } = bump();
  const pango = sp("pango-1.56");
  const refs = new Map<string, string[]>(outs(...Object.values(before), ...Object.values(after)).map((p) => [p, []]));
  refs.set(after.gtk.outputs.out!, [pango]); // gtk is cached, the library it needs isn't
  const v = await compare({ x: [base.path] }, { x: [next.path] }, g.show, cache(refs));
  assert.deepEqual(v.missing, ["x: pango-1.56 (needed by a cached path)"]);
});

test("compare: a failed lookup is unknown, never cached", async () => {
  const { g, base, next, before, after } = bump();
  const v = await compare({ x: [base.path] }, { x: [next.path] }, g.show,
    cache(new Set(outs(...Object.values(before), ...Object.values(after))), new Set([after.hook.outputs.out!])));
  assert.equal(v.unknown.length, 1);
  assert.match(v.unknown[0], /HTTP 503/);
});

test("compare: a failed lookup at the baseline is unknown too, so a same-name miss can't hide behind it", async () => {
  const { g, base, next, before, after } = bump();
  const v = await compare({ x: [base.path] }, { x: [next.path] }, g.show,
    cache(new Set(outs(...Object.values(before), after.hook, after.gcc)), new Set([before.gtk.outputs.out!])));
  assert.ok(v.unknown.some((u) => /HTTP 503/.test(u)), "the baseline's gtk couldn't be checked");
});

test("compare: an unreachable cache costs one round of lookups, then the rest aren't asked", async () => {
  const { g, base, next } = bump();
  let calls = 0;
  const down: FetchNarinfo = async () => { calls++; return { status: "unknown", error: "timeout" }; };
  const v = await compare({ x: [base.path], y: [base.path] }, { x: [next.path], y: [next.path] }, g.show, down);
  assert.equal(calls, 1, "stops at the first failed lookup, and the second system isn't walked");
  assert.deepEqual(v, { missing: [], unknown: ["timeout"] });
});

test("compare: past the deadline nothing more is asked", async () => {
  const { g, base, next } = bump();
  let calls = 0, clock = 0;
  // The flake's own outputs miss (as on the real cache), so the walk goes on.
  const slow: FetchNarinfo = async (p) => { calls++; clock += 60_000; return /-tool-/.test(p) ? { status: "missing" } : { status: "cached", references: [] }; };
  const v = await compare({ x: [base.path] }, { x: [next.path] }, g.show, slow, new Budget(90_000, () => clock));
  assert.ok(v.unknown.some((u) => /ran out of time/.test(u)));
  assert.ok(calls <= 4, `${calls} lookups`);
});

test("walk: after a failed lookup no more derivations are read", async () => {
  const { g, base } = bump();
  let reads = 0;
  const show = (paths: string[]) => { reads++; return g.show(paths); };
  const w = await walk([base.path], show, async (p) => (/-tool-/.test(p) ? { status: "missing" } : { status: "unknown", error: "timeout" }));
  assert.equal(w.unknown.length > 0, true);
  assert.ok(reads <= 2, `${reads} reads`);
});

test("Budget: a step's timeout is its own limit or what's left, and none once it's spent", () => {
  let clock = 0;
  const b = new Budget(10_000, () => clock);
  assert.equal(b.left(3_000), 3_000);
  clock = 8_000;
  assert.equal(b.left(3_000), 2_000);
  clock = 10_001;
  assert.equal(b.over, true);
  assert.throws(() => b.left(3_000), /ran out of time/);
});

test("closure: shared references are asked once", async () => {
  const a = sp("a"), b = sp("b"), c = sp("c");
  const ask = cache(new Map([[a, [c]], [b, [c]], [c, []]]));
  assert.deepEqual(await closure(new Set([a, b]), ask), { missing: [], unknown: [] });
  assert.equal(ask.asked.filter((p) => p === c).length, 1);
});

const realFetch = globalThis.fetch;
const realSleep = timing.sleep;
afterEach(() => { globalThis.fetch = realFetch; timing.sleep = realSleep; });

test("fetchNarinfo: 404 is missing, 200 gives references, 5xx is retried then unknown", async () => {
  timing.sleep = async () => {};
  const replies: Record<string, () => Response> = {
    gone: () => new Response("", { status: 404 }),
    here: () => new Response("StorePath: /nix/store/x\nReferences: aaaa0000000000000000000000000000-glibc bbbb0000000000000000000000000000-zlib\n", { status: 200 }),
    down: () => new Response("", { status: 503 }),
  };
  let calls = 0;
  globalThis.fetch = (async (url: string) => {
    calls++;
    const key = Object.keys(replies).find((k) => url.includes(k.padEnd(32, "0")))!;
    return replies[key]();
  }) as any;
  assert.deepEqual(await fetchNarinfo(`${S}${"gone".padEnd(32, "0")}-x`), { status: "missing" });
  assert.deepEqual(await fetchNarinfo(`${S}${"here".padEnd(32, "0")}-x`),
    { status: "cached", references: [`${S}aaaa0000000000000000000000000000-glibc`, `${S}bbbb0000000000000000000000000000-zlib`] });
  calls = 0;
  const down = await fetchNarinfo(`${S}${"down".padEnd(32, "0")}-x`);
  assert.equal(down.status, "unknown");
  assert.equal(calls, 3);
});

test("compare (snapshot move): new versions and new packages are the flake's own work by their pinned downloads; nixpkgs misses still count", async () => {
  const g = new Graph();
  const hook = g.add("auto-patchelf-hook"), gcc = g.add("gcc-16", [], { lib: true }), gtk = g.add("gtk+3-3.24");
  const pins = new Set<string>();
  /** A package of the flake: a pinned download, an unwrapped build on it, a
   * trivial (local) script, and a wrapper; extra nixpkgs inputs optional. */
  const mk = (name: string, v: string, extra: (Drv & { path: string })[] = []) => {
    const hash = `sha256-${name}${v}`;
    pins.add(hash);
    const src = g.add(`${name}-${v}.tar.gz`, [], { fixed: true, hash });
    const pkg = g.add(`${name}-unwrapped-${v}`, [[src, ["out"]], [hook, ["out"]], [gcc, ["lib"]], ...extra.map((e) => [e, ["out"]] as [Drv & { path: string }, string[]])]);
    const script = g.add(`${name}-launcher`, [], { local: true });
    return g.add(`${name}-${v}`, [[pkg, ["out"]], [script, ["out"]], [gtk, ["out"]]]);
  };
  const base = mk("tool", "1.0");
  const nixpkgs = new Set(outs(hook, gcc, gtk));
  const run = (next: (Drv & { path: string })[], held = nixpkgs) =>
    compare({ x: [base.path] }, { x: next.map((d) => d.path) }, g.show, cache(held), undefined, pins);
  // A new version, and a package added since the snapshot: nothing missing.
  assert.deepEqual(await run([mk("tool", "1.1"), mk("other", "3.0")]), { missing: [], unknown: [] });
  // The nixpkgs bump's rule (exact baseline names) would take them for nixpkgs builds.
  assert.deepEqual((await compare({ x: [base.path] }, { x: [mk("tool", "1.2").path] }, g.show, cache(nixpkgs))).missing, ["x: tool-1.2"]);
  // A nixpkgs dependency only the new version has, missing from the cache.
  const libnew = g.add("libnew-2.0", [[g.add("libnew-2.0.tar.gz", [], { fixed: true, hash: "sha256-upstream" }), ["out"]]]);
  assert.deepEqual((await run([mk("tool", "1.3", [libnew])])).missing, ["x: libnew-2.0"]);
  // A nixpkgs derivation sharing a pname with the flake's own (tool-9.0, not
  // built on a pinned download) is still a miss.
  const imposter = g.add("tool-9.0", [[g.add("tool-9.0.tar.gz", [], { fixed: true, hash: "sha256-nixpkgs-tool" }), ["out"]]]);
  assert.deepEqual((await run([mk("tool", "1.4", [imposter])])).missing, ["x: tool-9.0"]);
});

test("parseShow: a fixed output's hash as SRI from either layout, and never-substituted derivations", () => {
  const hex = "aa".repeat(32);
  const m = parseShow(JSON.stringify({
    "/nix/store/00000000000000000000000000000000-a.drv": { name: "a", outputs: { out: { path: "/nix/store/x-a", hashAlgo: "r:sha256", hash: hex } }, inputDrvs: {} },
    "/nix/store/11111111111111111111111111111111-b.drv": { name: "b", outputs: { out: { hash: "sha256-qqqq", method: "flat" } }, inputs: { drvs: {} } },
    "/nix/store/22222222222222222222222222222222-c.drv": { name: "c", outputs: { out: { path: "/nix/store/y-c" } }, inputs: { drvs: {} }, env: { allowSubstitutes: "" } },
    "/nix/store/33333333333333333333333333333333-d.drv": { name: "d", outputs: { out: { path: "/nix/store/y-d" } }, inputs: { drvs: {} }, structuredAttrs: { allowSubstitutes: false } },
    "/nix/store/44444444444444444444444444444444-e.drv": { name: "e", outputs: { out: { path: "/nix/store/y-e" } }, inputs: { drvs: {} }, env: { allowSubstitutes: "1" } },
  }));
  const get = (k: string) => [...m.values()].find((d) => d.name === k)!;
  assert.equal(get("a").hash, `sha256-${Buffer.from(hex, "hex").toString("base64")}`);
  assert.equal(get("b").hash, "sha256-qqqq");
  assert.deepEqual(["c", "d", "e"].map((k) => !!get(k).local), [true, true, false]);
});
