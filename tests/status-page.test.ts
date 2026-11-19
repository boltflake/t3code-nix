// The status page's HTML, styles and script (scripts/status-page.ts), from
// hand-made rows; the script runs in node:vm against a small stub DOM.
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { escape, html, SCRIPT, SCRIPT_HASH, STYLE } from "../scripts/status-page.ts";
import type { Delivery, Row, StableView } from "../scripts/status.ts";
import type { Live, PinState } from "../scripts/status-live.ts";

const pub = (at: string) => ({ at, commit: "c".repeat(40) });
const exactAt = (at: string) => ({ at, kind: "published" as const });
const d = (gap: number | null, kind: "published" | "seen" | "uploaded" | null = "published", shown = "1"): Delivery =>
  ({ version: shown, shown, published: pub("2026-11-10T00:00:00.000Z"), released: kind ? { at: "2026-11-09T23:00:00.000Z", kind } : null, gap });
/** A row: delivered 8 minutes after an exact release, with a short history. */
function row(name: string, extra: Partial<Row> = {}): Row {
  return { name, version: "1.0", released: exactAt("2026-11-13T11:52:00.000Z"), published: pub("2026-11-13T12:00:00.000Z"), gap: 480, notes: null,
    counted: true, history: [d(480), d(3 * 3600), d(9 * 3600)], ...extra };
}
const live = (states: Record<string, PinState>, checked = "2026-11-13T11:50:00.000Z"): Live => ({ checked, states });
const text = (h: string) => h.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
/** The markup of one package's row. */
const rowOf = (page: string, name: string) => page.slice(page.indexOf(`id="pkg-${name}"`), page.indexOf("</li>\n", page.indexOf(`id="pkg-${name}"`)));

test("page: nothing loaded from anywhere, the policy, the title and the mark", () => {
  const page = html([row("codex", { notes: "https://github.com/openai/codex/releases/tag/v1.0" })], "o/r", live({ codex: { state: "up-to-date" } }), "id1");
  const urls = [...page.matchAll(/(?:https?:)?\/\/[^\s"'<>)]+/g)].map((m) => m.index!);
  assert.ok(urls.length > 0);
  for (const at of urls) assert.match(page.slice(Math.max(0, at - 6), at), /href="$/, `a URL outside an href: ${page.slice(at, at + 60)}`);
  assert.ok(!/\bsrc=|url\((?!#(?:hatch|mark-blur)\))|@import|<link\b|<img\b|<iframe\b/i.test(page), "nothing loaded");
  assert.ok(page.includes(`content="default-src 'none'; style-src 'unsafe-inline'; script-src '${SCRIPT_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'"`));
  assert.equal(SCRIPT_HASH, `sha256-${createHash("sha256").update(page.match(/<script>([\s\S]*?)<\/script>/)![1]).digest("base64")}`);
  assert.equal(SCRIPT.split("fetch(").length, 2, "one fetch, of the site's own live.json");
  assert.ok(SCRIPT.includes(`fetch("live.json?t=" + Date.now()`));
  assert.ok(page.includes("<title>Package status · t3code-nix</title>"));
  assert.match(page, /<header class="top">\n<div class="title"><a class="brand" href="https:\/\/github\.com\/o\/r"><svg class="mark"[^]*?<span>t3code-nix<\/span><\/a><div class="crumb"><span class="slash" aria-hidden="true">\/<\/span><h1>Package status<\/h1><\/div><\/div>/, "the title is in the header, after the name");
  assert.ok(!page.includes("packaged for Nix: the versions on"), "no intro line");
  assert.match(page, /<svg class="mark" viewBox="0 0 100 100" aria-hidden="true">/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\) \{\n  \.mark \.strike, \.mark \.glow, \.mark \.spin, \.mark \.pop, \.mark \.energy \{ animation: none; \}/, "the mark stands still when motion is reduced");
  assert.equal(page.split('id="mark-blur"').length, 2, "the glow's filter, once");
  const forced = page.match(/@media \(forced-colors: active\) \{\n([\s\S]*?)\n\}\n/)![1];
  assert.ok(forced.includes(".mark .strike, .mark .glow, .mark .energy { display: none; }"), "forced colours hide the strike, glow and energy");
  assert.equal(page.split(".mark .strike, .mark .glow, .mark .energy { display: none; }").length, 2, "and only there");
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(text(page)), "no raw ISO times in the text");
  assert.ok(page.includes('data-id="id1"'));
  for (const href of ["https://github.com/o/r#quick-start", "https://github.com/o/r/releases", "https://github.com/o/r"]) assert.ok(page.includes(`href="${href}"`), href);
  assert.ok(page.includes('<nav aria-label="Project">'));
  // The footer's exact time of the last check.
  assert.ok(page.includes('Last checked against upstream: <time id="checked-exact" datetime="2026-11-13T11:50:00.000Z">13 Nov 2026, 11:50 UTC</time>.'));
  // A version link names its package after the visible version.
  assert.ok(page.includes('<a class="hit" href="https://github.com/openai/codex/releases/tag/v1.0">1.<wbr>0<span class="sr">, release notes for Codex</span></a>'));
});

test("page: every title's text is also on the page", () => {
  const page = html([row("codex"), row("grok", { released: { at: "2026-11-13T09:00:00.000Z", kind: "uploaded" }, gap: 3 * 3600 })], "o/r",
    live({ codex: { state: "testing", version: "1.1", since: "2026-11-13T11:56:00.000Z", link: "https://github.com/o/r/actions/runs/9" }, grok: { state: "up-to-date" } }), "x", null,
    { median: 412, count: 9, since: "2026-10-14T12:00:00.000Z", until: "2026-11-13T12:00:00.000Z" });
  // What a sighted reader sees: no screen-reader-only text, nothing hidden,
  // no SVG (its labels are for screen readers), no titles.
  // A relative time's own text becomes "2 hours ago" in the browser, so it
  // doesn't count as the exact time being visible.
  const body = page.slice(page.indexOf("<body>"), page.indexOf("<script>")).replace(/(<time class="rel"[^>]*>)[^<]*(<\/time>)/g, "$1$2");
  const visible = text(body.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<span class="sr">[^<]*<\/span>/g, " ").replace(/<(\w+)[^>]* hidden>[\s\S]*?<\/\1>/g, " "));
  const titles = [...body.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(titles.length >= 2, String(titles.length));
  for (const t of titles) assert.ok(visible.includes(t), `only in a title: ${t}`);
  assert.ok(!body.includes("<title>"), "no SVG tooltips: their labels are aria-labels");
});

test("page: groups, headings, names and the header row", () => {
  const list = ["t3code", "t3code-nightly", "t3", "t3-nightly", "codex", "claude-code", "newcomer", "boat", "agent-browser", "browser-unstable", "nixpkgs-stable"].map((n) => row(n));
  const page = html(list, "o/r", live({}), "x");
  assert.match(page, /<h2 id="t3code">T3 Code <span class="count">4<\/span><\/h2>/);
  // T3 Code by channel, each with its products under it.
  assert.match(page, /<div class="parent">\n<div class="parent-head"><h3 class="parent-title">Latest<\/h3>/);
  assert.match(rowOf(page, "t3code-nightly"), /<h4 class="pkg-name">Desktop app<span class="sr">, Nightly<\/span><\/h4> <code class="attr">t3code-nightly<\/code><p class="desc">T3 Code&#39;s desktop app<\/p>/);
  const order = ["t3code", "t3", "t3code-nightly", "t3-nightly"].map((n) => page.indexOf(`id="pkg-${n}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "Latest's desktop app and CLI, then Nightly's");
  assert.ok(page.indexOf('<h3 class="parent-title">Nightly</h3>') > order[1] && page.indexOf('<h3 class="parent-title">Nightly</h3>') < order[2]);
  assert.match(rowOf(page, "codex"), /<h3 class="pkg-name">Codex<\/h3> <code class="attr">codex<\/code><p class="desc">OpenAI&#39;s coding agent<\/p>/);
  assert.ok(rowOf(page, "claude-code").includes('<code class="attr">claude-code</code> <span class="tag">unfree</span>'));
  assert.ok(page.indexOf('id="pkg-claude-code"') < page.indexOf('id="pkg-newcomer"'), "unknown packages after the known providers");
  assert.ok(page.indexOf('id="pkg-agent-browser"') < page.indexOf('id="pkg-browser-unstable"'), "the browser pins after agent-browser");
  assert.ok(page.indexOf('id="agent-tools"') < page.indexOf('id="pkg-boat"') && page.indexOf('id="pkg-boat"') < page.indexOf('id="nixos-stable"'));
  assert.ok(page.indexOf('id="nixos-stable"') < page.indexOf('id="pkg-nixpkgs-stable"'));
  // "Recent deliveries" one level under the package's heading.
  assert.ok(rowOf(page, "codex").includes('<h4 class="hist-title">Recent deliveries</h4>'));
  assert.ok(rowOf(page, "t3code").includes('<h5 class="hist-title">Recent deliveries</h5>'));
  // The header row: outside the list, hidden from screen readers, in the
  // markup's order.
  assert.ok(page.includes('<div class="cols" aria-hidden="true"><span>Package</span><span>State</span><span>On <code>main</code></span><span>Delivery</span><span>Recent deliveries</span><span></span></div>\n<ul class="pkgs"'));
  const r = rowOf(page, "codex");
  const cells = ['class="cell who"', 'class="cell state', 'class="cell ver"', 'class="cell dlv"', 'class="cell recent"', '<details class="more">'].map((c) => r.indexOf(c));
  assert.deepEqual([...cells].sort((a, b) => a - b), cells, "markup order matches the columns");
  assert.ok(cells.every((i) => i >= 0));
  // Without the live view: no state column, no state icon in any row.
  const plain = html(list, "o/r", null, "x");
  assert.ok(plain.includes('<div class="cols no-state" aria-hidden="true"><span>Package</span><span>On <code>main</code></span>'));
  assert.ok(!plain.includes('class="cell state'));
});

test("page: the headline card, with and without the live view", () => {
  const list = ["codex", "grok", "fx", "pi"].map((n) => row(n));
  const lead = (p: string) => p.match(/<span class="lead"><svg class="st (\w+)" viewBox="0 0 16 16" role="img" aria-label="([^"]+)">/)!.slice(1);
  const page = (states: Record<string, PinState>) => html(list, "o/r", live(states), "x");
  const ok = { state: "up-to-date" as const };
  assert.deepEqual(lead(page({ codex: { state: "held", version: "2", reason: "tests failed" }, grok: { state: "testing", version: "2" }, fx: ok, pi: ok })), ["held", "Updates held"]);
  assert.deepEqual(lead(page({ codex: ok, grok: { state: "testing", version: "2" }, fx: { state: "found", version: "2" }, pi: ok })), ["testing", "Updates underway"]);
  assert.deepEqual(lead(page({ codex: ok, grok: ok, fx: { state: "found", version: "2" } })), ["found", "Updates underway"]);
  assert.deepEqual(lead(page({ codex: ok, grok: ok, fx: ok })), ["none", "Not checked"], "pi has no state: not checked");
  const all = page({ codex: ok, grok: ok, fx: ok, pi: ok });
  assert.deepEqual(lead(all), ["ok", "All up to date"]);
  assert.match(all, /<h2 id="headline">All 4 packages up to date<span class="at-last" hidden> at the last check<\/span><\/h2>/);
  assert.ok(!all.includes('class="counts"'), "no counts line when all are up to date");
  assert.ok(all.includes('<span class="lead stale-icon" hidden>'));
  const mixed = page({ codex: { state: "held", version: "2", reason: "x" }, grok: { state: "found", version: "2" }, fx: ok });
  assert.match(mixed, /<h2 id="headline">1 of 4 packages up to date/);
  assert.deepEqual([...text(mixed.match(/<p class="counts">[\s\S]*?<\/p>/)![0]).matchAll(/\d [a-z ]+?(?= ·|$| $)/g)].map((m) => m[0].trim()),
    ["1 held", "1 new version found", "1 not checked"], "held first, only states that aren't up to date");
  // The status line: the checked time and the region, the
  // controls hidden until the script shows them.
  assert.ok(all.includes('Checked against upstream <time class="rel" id="checked" datetime="2026-11-13T11:50:00.000Z"'));
  assert.ok(all.includes('<span class="live-status" role="status"><span class="stale-note" hidden>Out of date</span><span class="newer" hidden>Newer data · <a href="" class="reload hit">Reload</a></span></span></p>'));
  assert.ok(!/pause|aria-pressed/i.test(all.replace(/pause bars/g, "")), "no pause control");
  // The figure, only when given.
  assert.ok(!all.includes('class="figure"'));
  const fig = html(list, "o/r", live({}), "x", null, { median: 412, count: 42, since: "2026-10-14T12:00:00.000Z", until: "2026-11-13T12:00:00.000Z" });
  assert.ok(fig.includes('<p class="figure-value">7 min</p>\n<p class="figure-label">Median delivery, last 30 days</p>\n</div>'));
  // Without the live view: the versions, the note, no icons, no checked time.
  const t3 = [row("t3code", { version: "0.1.9" }), row("t3code-nightly", { version: "0.2.0-n.1", published: pub("2026-11-13T13:00:00.000Z") })];
  const plain = html(t3, "o/r", null, "x");
  assert.match(plain, /<h2 id="headline">2 packages<\/h2>\n<p class="counts">T3 Code 0\.1\.9 \(Nightly 0\.2\.0-n\.1\) · last update <time class="rel" datetime="2026-11-13T13:00:00\.000Z"/);
  assert.ok(plain.includes("Upstream status isn&#39;t available; these are the versions on <code>main</code>.") || plain.includes("Upstream status isn't available; these are the versions on <code>main</code>."));
  assert.ok(!/<svg class="st /.test(plain.slice(plain.indexOf("<main>"), plain.indexOf("<footer>"))), "no state icons anywhere");
  assert.ok(!plain.includes('id="checked"') && plain.includes('class="live-status"'), "the status line without a checked time");
});

test("page: needs attention and updates underway", () => {
  const list = ["t3code-nightly", "codex", "grok", "cursor-agent", "fx"].map((n) => row(n));
  const page = html(list, "o/r", live({
    "t3code-nightly": { state: "found", version: "0.2.0-n.2", since: "2026-11-13T11:59:00.000Z", link: "https://github.com/x/y/releases/tag/n2" },
    codex: { state: "testing", version: "1.1", since: "2026-11-13T11:56:00.000Z", link: "https://github.com/o/r/actions/runs/9" },
    grok: { state: "held", version: "1.0.78", reason: "tests failed", since: "2026-11-13T10:00:00.000Z", link: "https://github.com/o/r/issues/5" },
    "cursor-agent": { state: "held", reason: "couldn't read upstream" },
    fx: { state: "held", version: "3", reason: "no matching release", since: "2026-11-13T08:00:00.000Z" },
  }), "x");
  const attention = page.slice(page.indexOf('id="attention"'), page.indexOf("</section>", page.indexOf('id="attention"')));
  // Oldest first, then those without a time; a link only where there is one.
  assert.deepEqual([...attention.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]), ["fx", "Grok Build", "Cursor Agent"]);
  assert.ok(attention.includes('<strong>Grok Build</strong>: 1.<wbr>0.<wbr>78: tests failed · found <time class="rel" datetime="2026-11-13T10:00:00.000Z"'));
  assert.ok(attention.includes('<a class="hit" href="https://github.com/o/r/issues/5">View issue<span class="sr"> for Grok Build</span></a>'));
  assert.ok(!/fx<\/strong>[^\n]*<a /.test(attention), "no link without one");
  assert.ok(attention.includes("<strong>Cursor Agent</strong>: couldn&#39;t read upstream</span>"), "no version, no time: just the reason");
  assert.ok(!/Cursor Agent<\/strong>[^\n]*found/.test(attention));
  const underway = page.slice(page.indexOf('id="underway"'), page.indexOf("</section>", page.indexOf('id="underway"')));
  assert.deepEqual([...underway.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]), ["Desktop app, Nightly", "Codex"], "in the page's order, all listed");
  assert.ok(underway.includes('<a class="hit" href="https://github.com/o/r/actions/runs/9">View run<span class="sr"> for Codex</span></a>'));
  assert.ok(underway.includes('Release notes<span class="sr"> for Desktop app, Nightly</span>'));
  // None of either: no cards.
  const calm = html(list, "o/r", live({}), "x");
  assert.ok(!calm.includes('id="attention"') && !calm.includes('id="underway"'));
});

test("page: each state's words, time and link in its row", () => {
  const list = ["codex", "grok", "fx", "pi", "boat"].map((n) => row(n));
  const page = html(list, "o/r", live({
    codex: { state: "testing", version: "1.1", since: "2026-11-13T11:56:00.000Z", link: "https://github.com/o/r/actions/runs/9" },
    grok: { state: "held", version: "1.0.78", reason: "tests failed", since: "2026-11-13T10:00:00.000Z" },
    fx: { state: "found", version: "3.1" },
    boat: { state: "up-to-date" },
  }), "x");
  assert.match(rowOf(page, "codex"), /<span class="state-words"><svg class="st testing" viewBox="0 0 16 16" aria-hidden="true">[^]*?<\/svg><span><a class="hit" href="https:\/\/github\.com\/o\/r\/actions\/runs\/9">Testing 1\.<wbr>1<span class="sr"> for Codex<\/span><\/a><\/span><\/span><span class="sub">since <time class="rel"/);
  assert.match(rowOf(page, "grok"), /<span class="state-words"><svg class="st held" viewBox="0 0 16 16" aria-hidden="true">[^]*?<\/svg><span>Held: tests failed <span class="v">1\.<wbr>0\.<wbr>78<\/span><\/span><\/span><span class="sub">found <time class="rel"/);
  assert.match(rowOf(page, "fx"), /<span class="state-words"><svg class="st found" viewBox="0 0 16 16" aria-hidden="true">[^]*?<\/svg><span>New version 3\.<wbr>1<\/span><\/span><\/span><\/div>/, "no link, no time");
  assert.match(rowOf(page, "pi"), /<div class="cell state none"><span class="lbl">State <\/span><span><span class="state-words"><svg class="st none" viewBox="0 0 16 16" aria-hidden="true">[^]*?<\/svg><span>Not checked<\/span><\/span><\/span><\/div>/);
  assert.match(rowOf(page, "boat"), /<div class="cell state ok"><span class="lbl">State <\/span><span><span class="state-words"><svg class="st ok" viewBox="0 0 16 16" aria-hidden="true">[^]*?<\/svg><span>Up to date<\/span><\/span><\/span><\/div>/);
  // The details carry the state's exact time.
  assert.ok(rowOf(page, "codex").includes("<dt>State</dt><dd>Testing 1.1, since <time datetime=\"2026-11-13T11:56:00.000Z\">13 Nov 2026, 11:56 UTC</time></dd>"));
});

test("page: the delivery column, the strip and the details", () => {
  const list = [
    row("codex"), // exact, 8 min
    row("grok", { released: { at: "2026-11-13T09:00:00.000Z", kind: "uploaded" }, gap: 3 * 3600 }),
    row("fx", { released: null, gap: null }),
    row("pi", { counted: "added", history: [] }),
    row("kiro-cli", { counted: "returned" }),
    row("muse", { counted: "older" }),
    row("opencode", { counted: "re-added" }),
    row("antigravity", { history: [d(60, "seen"), d(null, null)] }),
    row("opencode-x", { history: [d(60, "seen"), d(3600, "uploaded")] }),
    row("grok-x", { history: [d(null, null)] }),
    row("boat", { counted: "returned", history: [] }),
  ];
  const page = html(list, "o/r");
  const cell = (n: string) => rowOf(page, n).match(/<div class="cell dlv">([\s\S]*?)<\/div>/)![1];
  assert.equal(cell("codex"), '<span class="lbl">Delivery </span><svg class="band-mark" viewBox="0 0 6 16" aria-hidden="true"><rect class="b-good" x="0" y="11" width="6" height="5" rx="1"/></svg>8 min');
  assert.equal(cell("grok"), '<span class="lbl">Delivery </span>~3 h<span class="sr"> (approximately)</span>', "approximate: no band mark");
  assert.equal(cell("fx"), '<span class="lbl">Delivery </span><span class="none-text" aria-hidden="true">—</span><span class="sr">not known</span>');
  for (const [n, w] of [["pi", "Added"], ["kiro-cli", "Returned"], ["muse", "Older"], ["opencode", "Re-added"]]) {
    assert.equal(cell(n), `<span class="lbl">Delivery </span><span class="reason">${w}</span>`, n);
  }
  // The strip: one bar per delivery, oldest on the left, heights by band.
  const strip = rowOf(page, "codex").match(/<svg class="strip"[^>]*>[\s\S]*?<\/svg>/)![0];
  assert.match(strip, /aria-label="Last 3 deliveries: median 3 h, slowest 9 h; exact times only"/);
  assert.deepEqual([...strip.matchAll(/class="b-(\w+)"[^>]*height="(\d+)"/g)].map((m) => [m[1], m[2]]), [["slow", "16"], ["fair", "10"], ["good", "5"]]);
  const odd = rowOf(page, "antigravity").match(/<svg class="strip"[^>]*>[\s\S]*?<\/svg>/)![0];
  assert.match(odd, /aria-label="Last 2 deliveries; no exact delivery times"/);
  assert.ok(odd.includes('class="b-none"') && odd.includes('class="b-approx"'));
  for (const n of ["opencode-x", "grok-x"]) assert.match(rowOf(page, n), /aria-label="Last \d deliver(y|ies); no exact delivery times"/, n);
  assert.ok(!rowOf(page, "opencode-x").includes("b-none") && !rowOf(page, "grok-x").includes("b-approx"));
  assert.ok(rowOf(page, "pi").includes('<span class="muted">No deliveries yet</span>'));
  assert.ok(rowOf(page, "boat").includes('<span class="muted">No deliveries yet</span>') && rowOf(page, "boat").includes("is back on <code>main</code>"), "no deliveries after a return");
  assert.ok(rowOf(page, "pi").includes('<p class="muted">No deliveries yet.</p>'));
  // The details: release, publish (linked to the commit), why the version
  // shown isn't a delivery, and each delivery in words.
  const det = rowOf(page, "grok");
  assert.ok(det.includes('<summary>Details<span class="sr"> for Grok Build</span></summary>'));
  assert.ok(det.includes("<dt>Released upstream</dt><dd><time datetime=\"2026-11-13T09:00:00.000Z\">13 Nov 2026, 09:00 UTC</time> (file uploaded). Upstream gives only the file"));
  assert.ok(det.includes(`<a href="https://github.com/o/r/commit/${"c".repeat(40)}">commit ccccccc<span class="sr"> for Grok Build</span></a>`));
  assert.ok(det.includes("<span>8 min, under 1 h</span>") && det.includes("<span>3 h, under 6 h</span>") && det.includes("<span>9 h, 6 h or more</span>"));
  assert.ok(rowOf(page, "antigravity").includes("<span>~1 min, approximate: first seen</span>") && rowOf(page, "antigravity").includes("<span>not known</span>"));
  assert.ok(rowOf(page, "pi").includes("1.0 was on <code>main</code> when the package was added."));
  assert.ok(rowOf(page, "kiro-cli").includes("1.0 is back on <code>main</code>: it was there before."));
  assert.ok(rowOf(page, "muse").includes("is older than the version before it."));
  assert.ok(!rowOf(page, "codex").includes("when the package was added"));
});

test("page: the Electron line in each Desktop app row, between On main and Details", () => {
  const page = html([row("t3code", { electron: "Electron: bundled 44.10.1" }), row("t3code-nightly", { electron: "Electron: bundled 45.0.2" }), row("t3")], "o/r");
  for (const [n, e] of [["t3code", "44.10.1"], ["t3code-nightly", "45.0.2"]]) {
    const r = rowOf(page, n);
    const at = r.indexOf(`<p class="electron">Electron: bundled ${e}</p>`);
    assert.ok(at > r.indexOf('class="cell ver"') && at < r.indexOf('<details class="more">'), n);
  }
  assert.ok(!rowOf(page, "t3").includes('class="electron"'), "only rows that have one");
  assert.ok(!page.includes("product-note"), "no longer under the heading");
});

test("page: providers and agent tools in alphabetical order of their names", () => {
  const names = ["codex", "pi", "claude-code", "zz-new", "antigravity", "fx", "aa-new", "boat", "agent-browser", "browser-stable", "browser-unstable"];
  const page = html(names.map((n) => row(n)), "o/r");
  const order = (ids: string[]) => ids.map((n) => page.indexOf(`id="pkg-${n}"`));
  const sorted = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] < x);
  // Antigravity, Claude Code, Codex, fx, pi, then unknown ones by package name.
  assert.ok(sorted(order(["antigravity", "claude-code", "codex", "fx", "pi", "aa-new", "zz-new"])));
  // Every provider, from input in reverse order: the case of a title
  // doesn't matter ("fx" sits between "Cursor Agent" and "Grok Build").
  const all = html(["pi", "opencode", "muse", "kiro-cli", "grok", "fx", "cursor-agent", "codex", "claude-code", "antigravity"].map((n) => row(n)), "o/r");
  const at = (n: string) => all.indexOf(`id="pkg-${n}"`);
  const expected = ["antigravity", "claude-code", "codex", "cursor-agent", "fx", "grok", "kiro-cli", "muse", "opencode", "pi"];
  assert.ok(expected.every((n, i) => i === 0 || at(expected[i - 1]) < at(n)), expected.map((n) => `${n}@${at(n)}`).join(" "));
  // The activity cards follow it: held ones without a time, and the
  // underway ones, in the same alphabetical order.
  const busy = html(expected.map((n) => row(n)), "o/r", live({ pi: { state: "held", reason: "x" }, codex: { state: "held", reason: "x" }, opencode: { state: "testing", version: "2" }, fx: { state: "found", version: "2" } }), "x");
  const card = (id: string) => { const c = busy.slice(busy.indexOf(`id="${id}"`), busy.indexOf("</section>", busy.indexOf(`id="${id}"`))); return [...c.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]); };
  assert.deepEqual(card("attention"), ["Codex", "pi"]);
  assert.deepEqual(card("underway"), ["fx", "OpenCode"]);
  // agent-browser (with its browser pins after it), then boat.
  assert.ok(sorted(order(["agent-browser", "browser-unstable", "browser-stable", "boat"])) || sorted(order(["agent-browser", "browser-stable", "browser-unstable", "boat"])));
});

test("page: NixOS stable, current or behind, and escaped links", () => {
  const list = [row("t3code"), row("codex", { version: "1.3" }), row("nixpkgs-stable", { version: "nixos-26.05 ffffffffffff" })];
  const current: StableView = { current: true, differing: [], issue: null };
  assert.match(html(list, "o/r", null, "", current), /<p class="card-note">NixOS stable has the same versions as main\.<\/p>/);
  const behind: StableView = { current: false, differing: [{ name: "codex", stable: "1.2", main: "1.3" }, { name: "grok", stable: null, main: "1" }, { name: "t3code", stable: "0.1.9", main: "0.1.10" }, { name: "t3code-nightly", stable: "1", main: "2" }], issue: 7 };
  assert.match(html(list, "o/r", null, "", behind), /NixOS stable is on an earlier set: Codex 1\.2, main 1\.3; Grok Build not yet, main 1; T3 Code desktop app 0\.1\.9, main 0\.1\.10; T3 Code desktop app nightly 1, main 2\. <a href="https:\/\/github\.com\/o\/r\/issues\/7">Why \(#7\)<\/a>/);
  assert.match(html(list, "o/r", null, "", { current: false, differing: [{ name: "codex", stable: "1.3", main: "1.3" }], issue: null }), /Codex 1\.3, main a newer build of it\./);
  const linked = html([row("codex")], "o/r", live({ codex: { state: "held", version: "1.1", reason: "x", link: 'https://github.com/o/r/issues/5?a=1&b="2"' } }), "x");
  assert.ok(linked.includes('href="https://github.com/o/r/issues/5?a=1&amp;b=&quot;2&quot;">'));
  assert.ok(!linked.includes('b="2"'));
  assert.equal(escape(`"'&<>`), "&quot;&#39;&amp;&lt;&gt;");
  const evil = html([row("<b>x</b>", { version: "<i>2</i>" })], "o/r");
  assert.ok(!evil.includes("<b>x</b>") && !evil.includes("<i>2</i>"));
});

test("styles: tabular figures survive the font shorthand", () => {
  const body = STYLE.match(/\nbody \{[^}]*\}/)![0];
  assert.ok(body.indexOf("font-variant-numeric: tabular-nums") > body.indexOf("font: "), "after `font:`, which would reset it");
});

test("styles: each state's pill in its own colours, and versions on main in text colour", () => {
  // The declarations of the one rule whose selector list names sel.
  const rule = (sel: string) => {
    const hits = [...STYLE.matchAll(/\n([^\n{]+) \{([^}]*)\}/g)].filter((m) => m[1].split(", ").includes(sel));
    assert.equal(hits.length, 1, sel);
    return hits[0][2].trim();
  };
  for (const [cls, c, bg] of [["ok", "ok", "ok-bg"], ["found", "move", "move-bg"], ["testing", "move", "move-bg"], ["held", "held", "held-bg"], ["none", "muted", "none-bg"]]) {
    for (const sel of [`.state.${cls} .state-words`, `.parent-state.${cls}`]) assert.equal(rule(sel), `color: var(--${c}); background: var(--${bg});`, sel);
  }
  // The grey colours are the delivery chip's too, and the chip may wrap.
  assert.ok(STYLE.includes("\n.state.none .state-words, .parent-state.none, .reason { color: var(--muted); background: var(--none-bg); }"), "the chip");
  assert.equal(rule(".dlv .reason"), "white-space: normal;");
  assert.match(STYLE, /\n\.state-words, \.parent-state, \.reason \{ display: inline-flex;[^}]*border: 1px solid color-mix\(in srgb, currentColor 25%, transparent\);/, "one pill shape, with an edge");
  assert.match(STYLE, /\n\.ver a \{ color: var\(--text\); text-decoration-color: var\(--muted\); \}/);
  assert.match(STYLE, /\n\.state-words a \{ text-decoration-color: currentColor; \}/);
  // Both still answer a hover, as every other link does.
  assert.equal(rule(".ver a:hover"), "text-decoration-color: currentColor;");
  assert.equal(rule(".state-words a:hover"), "text-decoration-thickness: 2px;");
});

test("styles: contrast of every text pair, icon and bar, in both schemes", () => {
  const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+): (#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
  const light = tokens(STYLE.slice(0, STYLE.indexOf("@media (prefers-color-scheme: dark)")));
  const dark = { ...light, ...tokens(STYLE.slice(STYLE.indexOf("@media (prefers-color-scheme: dark)"), STYLE.indexOf("* { box-sizing"))) };
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const text = [["text", "surface"], ["text", "hover"], ["text", "page"], ["muted", "surface"], ["muted", "hover"], ["muted", "page"], ["muted", "none-bg"],
    ["link", "surface"], ["link", "hover"], ["link", "page"], ["ok", "ok-bg"], ["move", "move-bg"], ["held", "held-bg"], ["none", "none-bg"],
    ["ok", "surface"], ["move", "surface"], ["held", "surface"], ["move", "hover"], ["held", "hover"]];
  const graphic = [["ok", "surface"], ["held", "surface"], ["slow", "surface"], ["move", "surface"], ["none", "surface"], ["approx", "surface"], ["focus", "surface"], ["focus", "page"],
    // The focus ring on a hovered row and over a pill's tint.
    ["focus", "hover"], ["focus", "ok-bg"], ["focus", "move-bg"], ["focus", "held-bg"], ["focus", "none-bg"],
    // The underlines: versions on main, in --muted; a state's link, in its pill's colour.
    ["muted", "surface"], ["muted", "hover"], ["ok", "ok-bg"], ["move", "move-bg"], ["held", "held-bg"]];
  for (const [name, t] of [["light", light], ["dark", dark]] as const) {
    for (const [a, b] of text) assert.ok(ratio(t[a], t[b]) >= 4.5, `${name} ${a} on ${b}: ${ratio(t[a], t[b]).toFixed(2)}`);
    for (const [a, b] of graphic) assert.ok(ratio(t[a], t[b]) >= 3, `${name} ${a} on ${b}: ${ratio(t[a], t[b]).toFixed(2)}`);
  }
});

// ---- The script --------------------------------------------------------

interface Opts {
  now?: number; replies?: (string | Error | "hang")[]; checked?: string | null; hidden?: boolean; focused?: boolean;
  storage?: "ok" | "throws" | "read-throws" | "malformed" | "fails-later" | "fails-first"; store?: Map<string, string>; dateHeader?: string | null;
}
/** Runs SCRIPT against a stub DOM. Replies are "A" (id A) or "A@<iso>" (id A
 * checked then), an Error (the fetch fails) or "hang" (never answers). */
function run(o: Opts = {}) {
  let now = o.now ?? Date.parse("2026-11-13T12:00:00Z");
  const el = (extra: Record<string, any> = {}): any => ({
    _hidden: extra.hidden ?? true, changes: 0, get hidden() { return this._hidden; }, set hidden(v: boolean) { if (v !== this._hidden) this.changes++; this._hidden = v; },
    classList: { set: new Set<string>(), toggle(c: string, on: boolean) { on ? this.set.add(c) : this.set.delete(c); } },
    listeners: [] as any[], addEventListener(_: string, fn: any) { this.listeners.push(fn); }, ...extra,
  });
  /** A <time>: counts how often its text changes. */
  const time = (cls: string, dateTime: string, title: string) => ({ cls, dateTime, title, _t: title, writes: 0, get textContent() { return this._t; }, set textContent(v: string) { this.writes++; this._t = v; } });
  const checkedEl = o.checked === null ? null : time("rel", o.checked ?? "2026-11-13T11:50:00.000Z", "13 Nov 2026, 11:50 UTC");
  const rels = [time("rel", "2026-11-13T11:59:30.000Z", "13 Nov 2026, 11:59 UTC"), time("rel", "2026-11-13T09:00:00.000Z", "13 Nov 2026, 09:00 UTC")];
  if (checkedEl) rels.push(checkedEl);
  const exactTime = time("", "2026-11-13T09:00:00.000Z", "13 Nov 2026, 09:00 UTC");
  const times = [...rels, exactTime];
  const foot = { dateTime: checkedEl?.dateTime ?? "", textContent: checkedEl?.title ?? "" };
  const els: Record<string, any> = { ".stale-note": el(), ".at-last": el(), ".stale-icon": el(), ".newer": el(), ".status-line": el(), ".reload": el(), "#checked-exact": foot };
  const leads = [el({ hidden: false })];
  const state = { details: false, selection: "", hidden: o.hidden ?? false, focused: o.focused ?? true, reloads: 0, fetches: 0, aborted: 0, urls: [] as string[] };
  const store = o.store ?? new Map<string, string>();
  let writes = 0;
  const storage = {
    getItem: (k: string) => { if (o.storage === "throws" || o.storage === "read-throws") throw new Error("blocked"); if (o.storage === "malformed") return "{not json"; return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { writes++; if (o.storage === "throws" || (o.storage === "fails-later" && writes > 1) || (o.storage === "fails-first" && writes === 1)) throw new Error("full"); store.set(k, v); },
  };
  const intervals: [() => unknown, number][] = [], timeouts: (() => void)[] = [], delays: number[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const replies = [...(o.replies ?? [])];
  const hung: { resolve: (v: any) => void; signal: unknown }[] = [];
  const reply = (r: string) => {
    const [id, checked] = r.split("@");
    return { headers: { get: (h: string) => (h === "date" ? o.dateHeader ?? null : null) }, json: async () => ({ id, checked: checked ?? null }) };
  };
  class FixedDate extends Date { static now() { return now; } }
  const document = {
    documentElement: { dataset: { id: "A" } },
    get hidden() { return state.hidden; },
    hasFocus: () => state.focused,
    querySelector: (q: string) => (q === "#checked" ? checkedEl : q === "details[open]" ? (state.details ? {} : null) : els[q] ?? null),
    querySelectorAll: (q: string) => (q === "time" ? times : q === "time.rel" ? times.filter((t) => t.cls === "rel") : q === ".lead:not(.stale-icon)" ? leads : []),
    addEventListener: (t: string, fn: () => void) => { (listeners[t] ??= []).push(fn); },
  };
  vm.runInNewContext(SCRIPT, {
    document, sessionStorage: storage, location: { reload: () => { state.reloads++; } }, Intl, Date: FixedDate, Math, Number, JSON, String, Array,
    getSelection: () => state.selection,
    addEventListener: (t: string, fn: () => void) => { (listeners[t] ??= []).push(fn); },
    setInterval: (fn: () => unknown, ms: number) => { intervals.push([fn, ms]); },
    setTimeout: (fn: () => void, ms: number) => { timeouts.push(fn); delays.push(ms); return timeouts.length; }, clearTimeout: () => {},
    AbortController: class { signal = { aborted: false }; abort() {
      state.aborted++;
      this.signal.aborted = true;
      // Only a fetch given this controller's signal is aborted.
      for (const h of hung.filter((f) => f.signal === this.signal)) h.resolve(Promise.reject(new Error("aborted")));
    } },
    fetch: (url: string, init?: { signal?: unknown }) => {
      state.fetches++;
      state.urls.push(url);
      const next = replies.length ? replies.shift()! : "A";
      if (next === "hang") return new Promise((resolve) => hung.push({ resolve, signal: init?.signal }));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(reply(next));
    },
  });
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    state, els, leads, rels, checkedEl, exactTime, foot, store, intervals, timeouts, delays, flush,
    /** Answers the oldest hanging check. */
    answer: async (r: string) => {
      const h = hung.shift();
      assert.ok(h, "answer(): no check is hanging");
      h.resolve(reply(r));
      await flush();
    },
    /** One minute passes: the interval runs. */
    minute: async () => { now += 60e3; intervals[0][0](); await flush(); },
    advance: (ms: number) => { now += ms; },
    fire: (t: string) => { for (const fn of listeners[t] ?? []) fn(); },
    blur: () => { state.focused = false; for (const fn of listeners.blur ?? []) fn(); },
    focus: () => { state.focused = true; for (const fn of listeners.focus ?? []) fn(); },
    hide: () => { state.hidden = true; for (const fn of listeners.visibilitychange ?? []) fn(); },
    show: async () => { state.hidden = false; for (const fn of listeners.visibilitychange ?? []) fn(); await flush(); },
  };
}

test("script: wording, one interval, checks on start, every minute visible, every 5 minutes hidden, and on return", async () => {
  const p = run();
  await p.flush();
  assert.deepEqual(p.intervals.map(([, ms]) => ms), [60e3], "one interval");
  assert.equal(p.state.fetches, 1, "a check on start");
  assert.match(p.state.urls[0], /^live\.json\?t=\d+$/, "the tiny file, past any cache");
  assert.deepEqual(p.rels.map((t) => t.textContent), ["just now", "3 hours ago", "10 minutes ago"], "drawn once on start; under a minute is just now");
  assert.equal(p.exactTime.textContent, "13 Nov 2026, 09:00 UTC", "an exact time is never touched");
  await p.minute();
  assert.equal(p.state.fetches, 2, "visible: every minute");
  p.hide();
  for (let i = 0; i < 4; i++) await p.minute();
  assert.equal(p.state.fetches, 2, "hidden: not before 5 minutes");
  await p.minute();
  assert.equal(p.state.fetches, 3, "hidden: every 5 minutes");
  await p.show();
  assert.equal(p.state.fetches, 4, "straight away on becoming visible");
});

test("script: times stand still while someone reads, move while nobody's there, and catch up on return", async () => {
  const p = run();
  await p.flush();
  const writes = () => p.rels.map((t) => t.writes).reduce((a, b) => a + b);
  const before = writes();
  for (let i = 0; i < 5; i++) await p.minute();
  assert.equal(writes(), before, "reading: no time changes");
  assert.equal(p.rels[0].textContent, "just now");
  // A short blur (the find bar): nothing, neither during it nor on return.
  p.blur();
  await p.minute();
  p.focus();
  assert.equal(writes(), before);
  // A real absence: unfocused for 2 minutes, then times move each minute.
  p.blur();
  await p.minute();
  await p.minute();
  assert.equal(p.rels[0].textContent, "8 minutes ago", "away (12:08): redrawn");
  await p.minute();
  assert.equal(p.rels[0].textContent, "9 minutes ago");
  // Back: one redraw; a second return in a row changes nothing.
  p.advance(30e3);
  p.focus();
  assert.equal(p.rels[0].textContent, "10 minutes ago", "redrawn on return");
  const after = writes();
  await p.show();
  p.focus();
  assert.equal(writes(), after, "two returns in a row: nothing the second time");
  // Hidden counts as away at once.
  p.hide();
  await p.minute();
  assert.equal(p.rels[0].textContent, "11 minutes ago");
});

test("script: a newer check time waits for a redraw; an older one is ignored", async () => {
  // (The first check is part of loading the page: it draws everything.)
  const p = run({ replies: ["A", "A@2026-11-13T11:55:00.000Z", "A@2026-11-13T11:40:00.000Z"] });
  await p.flush();
  await p.minute();
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:50:00.000Z", "reading: not shown yet");
  assert.equal(p.foot.textContent, "13 Nov 2026, 11:50 UTC");
  p.hide();
  await p.minute();
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:55:00.000Z", "away: shown at the redraw");
  assert.equal(p.checkedEl!.title, "13 Nov 2026, 11:55 UTC");
  assert.deepEqual([p.foot.dateTime, p.foot.textContent], ["2026-11-13T11:55:00.000Z", "13 Nov 2026, 11:55 UTC"], "the footer follows");
  assert.equal(p.els[".newer"].hidden, true, "no link: nothing newer");
  p.advance(5 * 60e3);
  await p.minute();
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:55:00.000Z", "an older time is ignored");
  assert.equal(p.state.reloads, 0);
});

test("script: out of date while reading: on once, with the checked words; off only at a redraw", async () => {
  // Data 1 h 55 min old; ten minutes later it's over 2 hours.
  const p = run({ checked: "2026-11-13T10:05:00.000Z", replies: [...Array(11).fill("A"), "A@2026-11-13T12:10:00.000Z"] });
  await p.flush();
  assert.equal(p.els[".stale-note"].hidden, true);
  assert.equal(p.checkedEl!.textContent, "1 hour ago");
  for (let i = 0; i < 10; i++) await p.minute();
  assert.equal(p.els[".stale-note"].hidden, false, "on, while reading");
  assert.equal(p.checkedEl!.textContent, "2 hours ago", "with the checked line's own words");
  for (const q of [".at-last", ".stale-icon"]) assert.equal(p.els[q].hidden, false, q);
  assert.equal(p.leads[0].hidden, true);
  // A fresh check time arrives while reading: it stays on until a redraw.
  for (let i = 0; i < 3; i++) await p.minute();
  assert.equal(p.els[".stale-note"].hidden, false, "never off while reading");
  assert.equal(p.els[".stale-note"].changes, 1, "one change");
  p.hide();
  await p.minute();
  assert.equal(p.els[".stale-note"].hidden, true, "off at the redraw");
});

test("script: a stale newer time and a failed check still turn out of date on", async () => {
  // A newer time that is itself over 2 hours old.
  const p = run({ checked: "2026-11-13T09:00:00.000Z", now: Date.parse("2026-11-13T10:30:00Z"), replies: ["A", "A@2026-11-13T09:10:00.000Z"] });
  await p.flush();
  assert.equal(p.els[".stale-note"].hidden, true);
  p.advance(60 * 60e3);
  await p.minute();
  assert.equal(p.els[".stale-note"].hidden, false, "11:31, checked 09:10: out of date");
  // Checks failing while someone reads.
  const q = run({ checked: "2026-11-13T10:01:00.000Z", replies: ["A", new Error("offline")] });
  await q.flush();
  q.advance(60e3);
  await q.minute();
  assert.equal(q.els[".stale-note"].hidden, false, "a failed check counts");
  // The visitor's clock 3 hours fast: corrected by the site's Date.
  const fast = run({ now: Date.parse("2026-11-13T15:00:00Z"), dateHeader: new Date("2026-11-13T12:00:00Z").toUTCString() });
  await fast.flush();
  assert.equal(fast.els[".stale-note"].hidden, true);
});

test("script: a newer id reloads only when nobody is in the window", async () => {
  // Someone reading: the link, never a reload.
  const reading = run({ replies: ["B", "B"] });
  await reading.flush();
  assert.equal(reading.els[".newer"].hidden, false);
  await reading.minute();
  assert.equal(reading.state.reloads, 0);
  // Then the tab goes to the background: it reloads.
  reading.hide();
  assert.equal(reading.state.reloads, 1);
  // Hidden from the start: at once.
  const hidden = run({ replies: ["B"], hidden: true });
  await hidden.flush();
  assert.equal(hidden.state.reloads, 1);
  // Unfocused: only after 2 minutes; a short blur doesn't count.
  const blurred = run({ replies: ["A", "B", "B", "B"] });
  await blurred.flush();
  blurred.blur();
  await blurred.minute();
  assert.equal(blurred.state.reloads, 0);
  await blurred.minute();
  assert.equal(blurred.state.reloads, 1);
  // Unfocused from the start: 2 minutes from then.
  const start = run({ replies: ["B", "B", "B"], focused: false });
  await start.flush();
  await start.minute();
  assert.equal(start.state.reloads, 0);
  await start.minute();
  assert.equal(start.state.reloads, 1);
  // A section open or text selected: it waits, hidden or not.
  const open = run({ replies: ["B"], hidden: true });
  open.state.details = true;
  await open.flush();
  assert.equal(open.state.reloads, 0);
  open.state.details = false;
  open.state.selection = "codex";
  await open.minute();
  assert.equal(open.state.reloads, 0);
  open.state.selection = "";
  await open.minute();
  assert.equal(open.state.reloads, 1);
  // "Reload": a real reload.
  const link = run({ replies: ["B"] });
  await link.flush();
  let prevented = 0;
  for (const fn of link.els[".reload"].listeners) fn({ preventDefault: () => { prevented++; } });
  assert.deepEqual([prevented, link.state.reloads], [1, 1]);
});

test("script: ids remembered, seeded with the page's own; no loop on stale copies", async () => {
  const store = new Map<string, string>();
  const p = run({ replies: ["A", "B", "A", "B"], hidden: true, store });
  await p.flush();
  assert.deepEqual(JSON.parse(store.get("t3code-nix-reloaded")!), ["A"], "seeded with its own id");
  for (let i = 0; i < 3; i++) { p.advance(5 * 60e3); await p.minute(); }
  assert.equal(p.state.reloads, 1);
  assert.deepEqual(JSON.parse(store.get("t3code-nix-reloaded")!), ["A", "B"]);
  // After that reload a cache still serves page A while live.json says B:
  // a fresh run shows the link and doesn't loop.
  const again = run({ replies: ["B", "B"], hidden: true, store });
  await again.flush();
  again.advance(5 * 60e3);
  await again.minute();
  assert.equal(again.state.reloads, 0);
  assert.equal(again.els[".newer"].hidden, false, "the link still shows");
  assert.equal(again.els[".newer"].changes, 1, "announced once");
  // Only the last 20 are kept.
  const many = new Map([["t3code-nix-reloaded", JSON.stringify(Array.from({ length: 25 }, (_, i) => `x${i}`))]]);
  await run({ store: many }).flush();
  assert.equal(JSON.parse(many.get("t3code-nix-reloaded")!).length, 20);
});

test("script: one check at a time, a hung one aborted after 15 seconds, and no extra timers", async () => {
  const p = run({ replies: ["hang", "A@2026-11-13T11:57:00.000Z"] });
  await p.flush();
  assert.equal(p.state.fetches, 1);
  await p.minute();
  assert.equal(p.state.fetches, 1, "no second check while one is out");
  p.hide();
  await p.show();
  assert.equal(p.state.fetches, 1, "becoming visible during a check: nothing more");
  assert.equal(p.intervals.length, 1, "events add no timers");
  assert.equal(p.delays.at(-1), 15e3);
  p.timeouts.at(-1)!();
  await p.flush();
  assert.equal(p.state.aborted, 1);
  await p.minute();
  assert.equal(p.state.fetches, 2, "the next check starts");
  p.hide();
  await p.minute();
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:57:00.000Z", "and it works");
});

test("script: storage that can't be trusted never reloads by itself", async () => {
  for (const storage of ["throws", "read-throws", "malformed", "fails-later", "fails-first"] as const) {
    const p = run({ replies: ["B", "B", "B"], hidden: true, storage, checked: "2026-11-13T09:00:00.000Z" });
    await p.flush();
    p.advance(5 * 60e3);
    await p.minute();
    assert.equal(p.state.reloads, 0, `${storage}: no automatic reload`);
    assert.equal(p.rels[0].textContent, "6 minutes ago", `${storage}: times work`);
    assert.equal(p.els[".stale-note"].hidden, false, `${storage}: the switch works`);
    assert.equal(p.els[".newer"].hidden, false, `${storage}: the link shows`);
  }
  // A malformed entry in otherwise working storage counts as empty: replaced,
  // and the reload happens once.
  const junk = new Map([["t3code-nix-reloaded", "{not json"]]);
  const healed = run({ replies: ["B", "B"], hidden: true, store: junk });
  await healed.flush();
  assert.equal(healed.state.reloads, 1);
  assert.deepEqual(JSON.parse(junk.get("t3code-nix-reloaded")!), ["A", "B"]);
  // Storage that worked for the first run and can't be read in the next.
  const store = new Map<string, string>();
  const first = run({ replies: ["B"], hidden: true, store });
  await first.flush();
  assert.equal(first.state.reloads, 1);
  const next = run({ replies: ["C", "C"], hidden: true, store, storage: "read-throws" });
  await next.flush();
  assert.equal(next.state.reloads, 0, "after a successful reload, reads failing: no loop");
});

test("script: no pause control", () => {
  assert.ok(!/paus|aria-pressed/i.test(SCRIPT));
});

test("page: agent-browser without its browser pins still draws", () => {
  const page = html([row("agent-browser")], "o/r");
  assert.ok(page.includes('<code class="attr">agent-browser</code>'));
});

test("script: the first check draws everything with the corrected clock", async () => {
  // Opened on a clock 3 hours fast: out of date at first sight, put right
  // by the first check's Date header.
  const p = run({ now: Date.parse("2026-11-13T15:00:00Z"), dateHeader: new Date("2026-11-13T12:00:00Z").toUTCString(), replies: ["A@2026-11-13T11:58:00.000Z"] });
  await p.flush();
  assert.equal(p.els[".stale-note"].hidden, true);
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T11:58:00.000Z");
  assert.equal(p.checkedEl!.textContent, "2 minutes ago");
});

test("script: a fresh newer time keeps out of date off while reading", async () => {
  // Data 1 h 55 min old; a newer time arrives while someone reads; ten
  // minutes later the switch is still off and the checked line unchanged.
  const p = run({ checked: "2026-11-13T10:05:00.000Z", replies: ["A", "A@2026-11-13T11:59:00.000Z"] });
  await p.flush();
  for (let i = 0; i < 10; i++) await p.minute();
  assert.equal(p.els[".stale-note"].hidden, true);
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T10:05:00.000Z");
});

test("script: coming back to the tab redraws at once, and its check is drawn in full", async () => {
  const p = run();
  await p.flush();
  p.hide();
  await p.minute();
  assert.equal(p.rels[0].textContent, "1 minute ago", "the minute's redraw (12:01)");
  p.advance(30e3);
  await p.show();
  assert.equal(p.rels[0].textContent, "2 minutes ago", "redrawn on becoming visible, between minutes (12:01:30)");
  // A tab frozen for hours comes back: its old check time makes it out of
  // date, but the check on return brings a fresh time, drawn in full.
  const q = run({ replies: ["A", "A@2026-11-13T16:58:00.000Z"] });
  await q.flush();
  q.state.hidden = true;
  q.advance(5 * 3600e3);
  await q.show();
  assert.equal(q.els[".stale-note"].hidden, true, "not out of date after the return check");
  assert.equal(q.checkedEl!.dateTime, "2026-11-13T16:58:00.000Z");
  // The same after a sleep in a visible, focused tab: the minute's check
  // settles, not the timer before it.
  const r = run({ replies: ["A", "A@2026-11-13T16:58:00.000Z"] });
  await r.flush();
  r.advance(5 * 3600e3);
  await r.minute();
  assert.equal(r.els[".stale-note"].hidden, true);
});

test("script: a missed focus event doesn't leave a reader counted as away", async () => {
  const p = run({ replies: ["A", "B", "B", "B"] });
  await p.flush();
  p.blur();
  p.state.focused = true; // focus came back, but no event arrived
  await p.minute();
  await p.minute();
  await p.minute();
  assert.equal(p.state.reloads, 0, "hasFocus() says someone is there");
  assert.equal(p.rels[0].textContent, "just now", "and the times stand still");
});

test("script: coming back redraws before the return check answers", async () => {
  const p = run({ replies: ["A", "hang"] });
  await p.flush();
  p.hide();
  p.advance(150e3);
  await p.show();
  assert.equal(p.state.fetches, 2, "the return check is out");
  assert.equal(p.rels[0].textContent, "3 minutes ago", "times already redrawn");
});

test("script: a check still out when the tab comes back is drawn in full", async () => {
  // The hidden tab's 5-minute check is out when the reader returns after
  // hours; its fresh answer must not leave "Out of date" showing.
  const p = run({ replies: ["A", "hang"], hidden: true });
  await p.flush();
  p.advance(5 * 3600e3);
  await p.minute();
  assert.equal(p.state.fetches, 2, "the hidden check is out");
  await p.show();
  assert.equal(p.state.fetches, 2, "no second check");
  assert.equal(p.els[".stale-note"].hidden, false, "old data, for now");
  await p.answer("A@2026-11-13T16:59:00.000Z");
  assert.equal(p.els[".stale-note"].hidden, true, "the outstanding check's answer is drawn in full");
  assert.equal(p.checkedEl!.dateTime, "2026-11-13T16:59:00.000Z");
});

test("page: a found version says what it waits for, in its row, the activity list and its details", () => {
  const page = html([row("codex", { version: "1.0" })], "o/r", live({ codex: { state: "found", version: "1.1", wait: "waiting for the <update> run", since: "2026-11-13T11:50:00.000Z" } }), "x");
  const time = '<time class="rel" datetime="2026-11-13T11:50:00.000Z" title="13 Nov 2026, 11:50 UTC">13 Nov 2026, 11:50 UTC</time>';
  assert.ok(page.includes(`<strong>Codex</strong>: 1.<wbr>1 found · ${time} · waiting for the &lt;update&gt; run</span></li>`), "the activity list");
  assert.ok(page.includes(`<span class="sub">found ${time} · waiting for the &lt;update&gt; run</span>`), "the row");
  assert.ok(page.includes('<dt>State</dt><dd>New version 1.1, found <time datetime="2026-11-13T11:50:00.000Z">13 Nov 2026, 11:50 UTC</time>; waiting for the &lt;update&gt; run</dd>'), "the details");
  // Only a found state shows it.
  const held = html([row("codex", { version: "1.0" })], "o/r", live({ codex: { state: "held", version: "1.1", reason: "x", wait: "nope" } as any }), "x");
  assert.ok(!held.includes("nope"));
});

test("page: a T3 Code channel's line sums up its products", () => {
  const t3 = [row("t3code", { version: "0.1.9" }), row("t3", { version: "0.1.9" }), row("t3code-nightly", { version: "0.2.0-n.1" }), row("t3-nightly", { version: "0.2.0-n.2" })];
  const head = (page: string, label: string) => page.match(new RegExp(`<div class="parent-head"><h3 class="parent-title">${label}</h3>.*?</div>`))![0];
  const ok = { state: "up-to-date" } as const;
  const page = html(t3, "o/r", live({ t3code: ok, t3: ok, "t3code-nightly": { state: "testing", version: "0.2.0-n.3" }, "t3-nightly": { state: "held", version: "0.2.0-n.3", reason: "x" } }), "x");
  // The same version on every product: shown; different ones: left to the rows.
  assert.match(head(page, "Latest"), /<span class="parent-ver">0\.<wbr>1\.<wbr>9<\/span> <span class="parent-state ok"><svg[^]*?<\/svg>Up to date<\/span>/);
  assert.ok(!head(page, "Nightly").includes("parent-ver"));
  // The most urgent state (held before testing), with the products in it.
  assert.match(head(page, "Nightly"), /<span class="parent-state held"><svg[^]*?<\/svg>Held \(CLI and server\)<\/span>/);
  const found = html(t3, "o/r", live({ t3code: { state: "found", version: "0.2" }, t3: { state: "found", version: "0.2" } }), "x");
  assert.match(head(found, "Latest"), /<\/svg>New version found<\/span>/, "both: the words alone");
  // A channel with one product: its version and its state alone.
  const one = html([row("t3code-nightly", { version: "0.2.0-n.1" })], "o/r", live({ "t3code-nightly": { state: "testing", version: "0.2.0-n.2" } }), "x");
  assert.match(head(one, "Nightly"), /<span class="parent-ver">0\.<wbr>2\.<wbr>0-<wbr>n\.<wbr>1<\/span> <span class="parent-state testing"><svg[^]*?<\/svg>Testing<\/span>/);
  assert.ok(!one.includes('parent-title">Latest'), "no line for an empty channel");
  // Without the live view: no state.
  assert.ok(!head(html(t3, "o/r", null, "x"), "Latest").includes("parent-state"));
  // Each step of the order: testing before found, found before not checked,
  // and a product without a state counts as not checked.
  const top = (a: PinState | undefined, b: PinState | undefined) => head(html(t3.slice(0, 2), "o/r", live({ ...(a ? { t3code: a } : {}), ...(b ? { t3: b } : {}) }), "x"), "Latest");
  assert.match(top({ state: "testing", version: "2" }, { state: "found", version: "2" }), /parent-state testing">.*Testing \(Desktop app\)</);
  assert.match(top({ state: "found", version: "2" }, { state: "not-checked" }), /parent-state found">.*New version found \(Desktop app\)</);
  assert.match(top(ok, undefined), /parent-state none">.*Not checked \(CLI and server\)</);
  // The underway list follows the page's order: Latest's products, then Nightly's.
  const busy = html(t3, "o/r", live({ t3code: { state: "found", version: "a" }, t3: { state: "found", version: "a" }, "t3code-nightly": { state: "found", version: "a" }, "t3-nightly": { state: "found", version: "a" } }), "x");
  const underway = busy.slice(busy.indexOf('id="underway"'), busy.indexOf("</section>", busy.indexOf('id="underway"')));
  assert.deepEqual([...underway.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]), ["Desktop app, Latest", "CLI and server, Latest", "Desktop app, Nightly", "CLI and server, Nightly"]);
});

test("page: a browser pin lists its browsers, the default first, with what's missing", () => {
  const browsers = [{ name: "ungoogled-chromium", version: "157.0.1", unavailable: [] }, { name: "chromium", version: null, unavailable: [] },
    { name: "google-chrome", version: "158.0.2", unavailable: ["aarch64-linux"] }];
  const page = html([row("agent-browser"), row("browser-unstable", { browsers, channel: "nixos-unstable", version: "157.0.1 (nixos-unstable)" } as any)], "o/r", live({}), "x");
  const r = rowOf(page, "browser-unstable");
  assert.ok(r.includes('<ul class="kids browsers" role="list" aria-label="Browsers from nixos-unstable">'
    + '<li><code class="kid-name">ungoogled-chromium</code> <span class="kid-info"><span class="kid-ver">157.<wbr>0.<wbr>1</span> <span class="kid-note">default</span></span></li>'
    + '<li><code class="kid-name">chromium</code> <span class="kid-info"><span class="kid-ver"><span class="muted">version not recorded</span></span></span></li>'
    + '<li><code class="kid-name">google-chrome</code> <span class="kid-info"><span class="kid-ver">158.<wbr>0.<wbr>2</span> <span class="kid-note">not available on aarch64</span></span></li></ul>'), r);
  // Missing on both systems: both named.
  const both = html([row("agent-browser"), row("browser-unstable", { browsers: [browsers[0], { name: "google-chrome", version: null, unavailable: ["aarch64-linux", "x86_64-linux"] }], channel: "nixos-unstable" } as any)], "o/r", live({}), "x");
  assert.ok(rowOf(both, "browser-unstable").includes('<span class="kid-note">not available on aarch64 and x86_64</span>'));
  // Inside the pin's row, after its values and before its details; other rows have none.
  assert.ok(r.indexOf('class="cell recent"') < r.indexOf('class="kids browsers"') && r.indexOf('class="kids browsers"') < r.indexOf('<details class="more">'));
  assert.ok(!rowOf(page, "agent-browser").includes("kids"));
  // The pin's own version is its channel: the browsers' versions are under it.
  assert.ok(r.includes('<div class="cell ver"><span class="lbl">On main </span>nixos-<wbr>unstable</div>'), r);
});
