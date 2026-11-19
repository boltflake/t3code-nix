// The status page's HTML (scripts/status.ts builds the data). One static
// file: inline CSS, inline SVG and one inline script, nothing loaded from
// another site (its Content-Security-Policy says so: the script is allowed
// by its hash, and it may fetch only the site's own live.json). The output
// depends only on its inputs, so it stays deterministic: dates are written
// out in UTC, and the script turns the relative ones into "2 hours ago" in
// the browser, says when the data is out of date, and offers or makes a
// reload when the site has newer data (see SCRIPT).
import { createHash } from "node:crypto";
import { AGENT_TOOLS, BROWSER_PINS, NIXPKGS_PINS, PROVIDERS, T3, UNFREE } from "./lib/packages.ts";
import type { Browser, Delivery, Row, StableView } from "./status.ts";
import type { Live, PinState, StateName } from "./status-live.ts";
import type { Released } from "./lib/util.ts";

/** Each kind of upstream release time: a short label, and why the delay
 * from it is only approximate (null: exact). */
export const KIND: Record<Released["kind"], { label: string; why: string | null }> = {
  published: { label: "release", why: null },
  uploaded: {
    label: "file uploaded",
    why: "Upstream gives only the file's upload time, often hours before the release, so the real delay is shorter.",
  },
  built: {
    label: "build time",
    why: "Upstream's manifest gives the build time, which comes before the release, so the real delay is shorter.",
  },
  seen: {
    label: "first seen",
    why: "Upstream gives no release time; this is when t3code-nix's update run saw the version, so the real delay may be longer.",
  },
};

export const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Escaped, with `code` spans as in the README. */
const text = (s: string) => escape(s).replace(/`([^`]+)`/g, "<code>$1</code>");

export function duration(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  // Under an hour stays in minutes (3570 s isn't "1 h").
  if (s < 3600) return `${Math.min(m, 59)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

/** The same, rounded to its largest unit: for times only known roughly. */
export function roughly(s: number): string {
  // Each unit stays below the next one's threshold, as in duration().
  if (s < 3600) return `${Math.min(59, Math.max(1, Math.round(s / 60)))} min`;
  if (s < 48 * 3600) return `${Math.min(47, Math.round(s / 3600))} h`;
  return `${Math.round(s / 86400)} d`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 Nov 2026, 10:17 UTC". */
export function utc(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** A time the script shows as "2 hours ago" (the exact time stays in
 * the title, and in the details or the footer). */
const rel = (iso: string) => `<time class="rel" datetime="${escape(iso)}" title="${escape(utc(iso))}">${escape(utc(iso))}</time>`;
/** A time shown exactly, never rewritten. */
const exact = (iso: string) => `<time datetime="${escape(iso)}">${escape(utc(iso))}</time>`;

/** A version, allowed to wrap after a "-" or "." (long nightly versions). */
const version = (v: string) => escape(v).replace(/([-.])/g, "$1<wbr>");

/** Under an hour, under six, six or more: the badges' colours too. */
export function tone(gap: number): "good" | "fair" | "slow" {
  return gap < 3600 ? "good" : gap < 6 * 3600 ? "fair" : "slow";
}
const BAND = { good: "under 1 h", fair: "under 6 h", slow: "6 h or more" } as const;

// The state icons: each its own shape as well as its own colour, 16px,
// drawn with currentColor. Next to a word they're hidden from screen
// readers; alone (the headline's) they carry a label.
type Icon = "ok" | "found" | "testing" | "held" | "none" | "stale";
const CLASS: Record<StateName, Icon> = { "up-to-date": "ok", found: "found", testing: "testing", held: "held", "not-checked": "none" };
const SHAPE: Record<Icon, string> = {
  ok: `<circle cx="8" cy="8" r="6.6"/><path d="M5.1 8.3l2 2 3.9-4.1"/>`,
  found: `<circle cx="8" cy="8" r="6.6"/><path d="M8 11.2V5.1M5.4 7.6 8 5l2.6 2.6"/>`,
  testing: `<path d="M6.2 1.9h3.6M6.8 1.9v3.9L3.4 11.9a1.3 1.3 0 0 0 1.1 2h7a1.3 1.3 0 0 0 1.1-2L9.2 5.8V1.9M4.7 9.9h6.6"/>`,
  held: `<path d="M5.6 1.6h4.8l4 4v4.8l-4 4H5.6l-4-4V5.6Z"/><path d="M6.6 5.9v4.2M9.4 5.9v4.2"/>`,
  none: `<circle cx="8" cy="8" r="6.6" stroke-dasharray="2.6 2.6"/><path d="M5.6 8h4.8"/>`,
  stale: `<circle cx="8" cy="8" r="6.6"/><path d="M8 4.6V8l2.3 1.5"/>`,
};
const LABEL: Record<Icon, string> = { ok: "All up to date", found: "Updates underway", testing: "Updates underway", held: "Updates held", none: "Not checked", stale: "Out of date" };
const icon = (kind: Icon, label?: string, extra = "") =>
  `<svg class="st ${kind}${extra}" viewBox="0 0 16 16" ${label ? `role="img" aria-label="${escape(label)}"` : `aria-hidden="true"`}>${SHAPE[kind]}</svg>`;

/** The project's mark: the flake and bolt of docs/header.svg, with its
 * 10-second loop (a strike, the flake turning, the bolt popping in), redrawn
 * in the flake's own 100-unit space. Still when motion is reduced. */
const rot = (r: number) => (r ? ` transform="rotate(${r} 50 50)"` : "");
const STRIKE = "M78.8-44.4 58-9.2 69.2-6 46.8 26 58 29.2 50 46.8";
const MARK = `<svg class="mark" viewBox="0 0 100 100" aria-hidden="true"><defs><filter id="mark-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter></defs>`
  + `<path class="glow" d="${STRIKE}" pathLength="153"/><path class="strike" d="${STRIKE}" pathLength="153"/>`
  + `<g class="spin"><g class="flake">${[0, 60, 120, 180, 240, 300].map((r) => `<path d="M50 43V12M43.5 19 50 25.5 56.5 19"${rot(r)}/>`).join("")}</g>`
  + `<g class="energy">${[0, 60, 120, 180, 240, 300].map((r) => `<path d="M50 43V12" pathLength="100"${rot(r)}/>`).join("")}</g></g>`
  + `<g class="pop"><path class="bolt" d="M62 6 35 53H50L40 94 68 44H53Z" transform="translate(51 50) scale(.78) translate(-51 -50)"/></g></svg>`;

/** A package's name as the page shows it, and with its T3 Code product and
 * channel (a T3 Code package is listed under its channel, by product). */
function nameOf(n: string): { title: string; product?: string; channel?: string; description?: string } {
  const p = PROVIDERS[n] ?? AGENT_TOOLS[n] ?? BROWSER_PINS[n] ?? NIXPKGS_PINS[n];
  if (p) return { title: p.title, description: p.description };
  for (const prod of T3) {
    const c = prod.channels.find(([, name]) => name === n);
    if (c) return { title: prod.title, product: prod.title, channel: c[0], description: prod.description };
  }
  return { title: n };
}
/** "Codex", or "Desktop app, Nightly". */
const fullName = (n: string) => {
  const x = nameOf(n);
  return x.product ? `${x.product}, ${x.channel}` : x.title;
};

/** What a state says: "Testing 0.168.0", "Held: tests failed",
 * "New version 1.4.16". */
function says(s: PinState): string {
  switch (s.state) {
    case "testing": return `Testing ${s.version}`;
    case "held": return `Held: ${s.reason}`;
    case "found": return `New version ${s.version}`;
    case "not-checked": return "Not checked";
    default: return "Up to date";
  }
}
/** Where a state's link goes, in words. */
const LINK_WORDS: Partial<Record<StateName, string>> = { testing: "View run", held: "View issue", found: "Release notes" };
/** A state's own time, in words: since when it's been tested, or when the
 * version was first seen. */
const since = (s: PinState) => (s.since && s.state !== "up-to-date" && s.state !== "not-checked"
  ? `${s.state === "testing" ? "since" : "found"} ${rel(s.since)}` : "");

/** A link whose accessible name adds the package after the visible words. */
const more = (href: string, words: string, who: string) => `<a class="hit" href="${escape(href)}">${escape(words)}<span class="sr"> for ${escape(who)}</span></a>`;

// ---- The headline card -----------------------------------------------

export interface DeliveryFigure { median: number; count: number; since: string; until: string }

function figure(d: DeliveryFigure | null): string {
  if (!d) return "";
  return `<div class="figure">
<p class="figure-value">${escape(duration(d.median))}</p>
<p class="figure-label">Median delivery, last 30 days</p>
</div>`;
}

/** The status line: the checked time (live view) and the status region,
 * whose texts the script shows. */
function statusLine(checked: string | null): string {
  const time = checked ? `<span class="checked-text">Checked against upstream <time class="rel" id="checked" datetime="${escape(checked)}" title="${escape(utc(checked))}">${escape(utc(checked))}</time></span>` : "";
  return `<p class="status-line">${time}<span class="live-status" role="status"><span class="stale-note" hidden>Out of date</span><span class="newer" hidden>Newer data · <a href="" class="reload hit">Reload</a></span></span></p>`;
}

function hero(list: Row[], by: Map<string, Row>, live: Live | null, delivery: DeliveryFigure | null): string {
  if (!live) {
    const newest = list.map((r) => r.published?.at).filter((a): a is string => !!a).sort().at(-1);
    const latest = by.get("t3code")?.version, nightly = by.get("t3code-nightly")?.version;
    const parts = [
      ...(latest ? [`T3 Code ${escape(latest)}${nightly ? ` (Nightly ${escape(nightly)})` : ""}`] : []),
      ...(newest ? [`last update ${rel(newest)}`] : []),
    ];
    return `<section class="hero plain" aria-labelledby="headline">
<div class="hero-main"><div class="hero-text">
<h2 id="headline">${list.length} packages</h2>
${parts.length ? `<p class="counts">${parts.join(" · ")}</p>\n` : ""}<p class="note">Upstream status isn't available; these are the versions on <code>main</code>.</p>
${statusLine(null)}
</div></div>
${figure(delivery)}
</section>`;
  }
  const state = (n: string): StateName => live.states[n]?.state ?? "not-checked";
  const count = (s: StateName) => list.filter((r) => state(r.name) === s).length;
  const ok = count("up-to-date");
  const lead: Icon = count("held") ? "held" : count("testing") ? "testing" : count("found") ? "found" : count("not-checked") ? "none" : "ok";
  const title = ok === list.length ? `All ${list.length} packages up to date` : `${ok} of ${list.length} packages up to date`;
  const counts = ([["held", "held"], ["testing", "testing"], ["found", "new version found"], ["not-checked", "not checked"]] as const)
    .filter(([s]) => count(s) > 0).map(([s, w]) => `<span class="count-item ${CLASS[s]}">${icon(CLASS[s])}${count(s)} ${count(s) > 1 && s === "found" ? "new versions found" : w}</span>`);
  return `<section class="hero" aria-labelledby="headline">
<div class="hero-main"><span class="lead">${icon(lead, LABEL[lead])}</span><span class="lead stale-icon" hidden>${icon("stale", LABEL.stale)}</span><div class="hero-text">
<h2 id="headline">${escape(title)}<span class="at-last" hidden> at the last check</span></h2>
${counts.length ? `<p class="counts">${counts.join(`<span class="dot" aria-hidden="true"> · </span>`)}</p>\n` : ""}${statusLine(live.checked)}
</div></div>
${figure(delivery)}
</section>`;
}

/** Held pins, always open; then the found and testing ones. */
function activity(list: Row[], live: Live | null): string {
  if (!live) return "";
  const order = new Map(pageOrder(list).map((n, i) => [n, i]));
  const line = (n: string) => {
    const s = live.states[n];
    const who = fullName(n);
    const what = s.state === "held" ? `${s.version ? `${version(s.version)}: ` : ""}${escape(s.reason ?? "")}` : s.state === "testing" ? `testing ${version(s.version ?? "")}` : `${version(s.version ?? "")} found`;
    const when = (s.since ? ` · ${s.state === "held" ? "found " : ""}${rel(s.since)}` : "") + (s.state === "found" && s.wait ? ` · ${escape(s.wait)}` : "");
    const link = s.link && LINK_WORDS[s.state] ? ` · ${more(s.link, LINK_WORDS[s.state]!, who)}` : "";
    return `<li>${icon(CLASS[s.state])}<span><strong>${escape(who)}</strong>: ${what}${when}${link}</span></li>`;
  };
  const held = list.map((r) => r.name).filter((n) => live.states[n]?.state === "held").sort((a, b) => {
    const ta = live.states[a].since, tb = live.states[b].since;
    if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
    if (!!ta !== !!tb) return ta ? -1 : 1;
    return order.get(a)! - order.get(b)!;
  });
  const moving = list.map((r) => r.name).filter((n) => ["found", "testing"].includes(live.states[n]?.state ?? ""))
    .sort((a, b) => order.get(a)! - order.get(b)!);
  return (held.length ? `<section class="notice attention" aria-labelledby="attention">
<h2 id="attention">Needs attention</h2>
<ul>
${held.map(line).join("\n")}
</ul>
</section>
` : "") + (moving.length ? `<section class="notice underway" aria-labelledby="underway">
<h2 id="underway">Updates underway</h2>
<ul>
${moving.map(line).join("\n")}
</ul>
</section>
` : "");
}

// ---- Package rows ------------------------------------------------------

const REASON: Record<Exclude<Row["counted"], true>, string> = { added: "Added", "re-added": "Re-added", returned: "Returned", older: "Older" };

/** A bar for one delivery: its band in colour and height, or neutral and
 * hatched when approximate, or a small outlined dot when not known. */
function bar(d: { gap: number | null; released: Released | null }, x: number): string {
  if (d.gap === null || !d.released) return `<circle class="b-none" cx="${x + 3}" cy="13.5" r="2"/>`;
  if (KIND[d.released.kind].why) return `<rect class="b-approx" x="${x}" y="6" width="6" height="10" rx="1"/>`;
  const t = tone(d.gap);
  const h = { good: 5, fair: 10, slow: 16 }[t];
  return `<rect class="b-${t}" x="${x}" y="${16 - h}" width="6" height="${h}" rx="1"/>`;
}

function deliveryCell(r: Row): string {
  if (r.counted !== true) return `<span class="reason">${REASON[r.counted]}</span>`;
  if (r.gap === null || !r.released) return `<span class="none-text" aria-hidden="true">—</span><span class="sr">not known</span>`;
  if (KIND[r.released.kind].why) return `~${escape(roughly(r.gap))}<span class="sr"> (approximately)</span>`;
  return `<svg class="band-mark" viewBox="0 0 6 16" aria-hidden="true">${bar(r, 0)}</svg>${escape(duration(r.gap))}`;
}

/** "8 min, under 1 h"; "~3 h, approximate: upload time"; "not known". */
function deliveryWords(d: { gap: number | null; released: Released | null }): string {
  if (d.gap === null || !d.released) return "not known";
  if (KIND[d.released.kind].why) return `~${roughly(d.gap)}, approximate: ${KIND[d.released.kind].label}`;
  return `${duration(d.gap)}, ${BAND[tone(d.gap)]}`;
}

/** The median of some numbers (the mean of the middle two for an even
 * count), rounded. */
export function median(xs: number[]): number {
  const a = [...xs].sort((p, q) => p - q), mid = a.length >> 1;
  return Math.round(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2);
}

function strip(h: Delivery[]): string {
  if (!h.length) return `<span class="muted">No deliveries yet</span>`;
  const oldestFirst = [...h].reverse();
  const exactGaps = h.filter((d) => d.gap !== null && d.released && !KIND[d.released.kind].why).map((d) => d.gap!).sort((a, b) => a - b);
  const n = h.length;
  let label = `Last ${n} ${n === 1 ? "delivery" : "deliveries"}`;
  if (exactGaps.length) {
    label += `: median ${duration(median(exactGaps))}, slowest ${duration(exactGaps.at(-1)!)}; exact times only`;
  } else label += "; no exact delivery times";
  return `<svg class="strip" viewBox="0 0 ${n * 9 - 3} 16" width="${n * 9 - 3}" height="16" role="img" aria-label="${escape(label)}">${oldestFirst.map((d, i) => bar(d, i * 9)).join("")}</svg>`;
}

/** Why the version shown isn't a delivery, in a sentence. */
function notCounted(r: Row): string {
  const v = escape(r.version);
  switch (r.counted) {
    case "added": return `${v} was on <code>main</code> when the package was added.`;
    case "re-added": return `${v} came with the package being added again.`;
    case "returned": return `${v} is back on <code>main</code>: it was there before.`;
    case "older": return `${v} is older than the version before it.`;
    default: return "";
  }
}

function details(r: Row, repo: string, s: PinState | undefined, level: 4 | 5): string {
  const who = fullName(r.name);
  const items: string[] = [];
  if (s && s.state !== "up-to-date") items.push(`<dt>State</dt><dd>${escape(says(s))}${s.since ? `, ${s.state === "testing" ? "since" : "found"} ${exact(s.since)}` : ""}${s.state === "found" && s.wait ? `; ${escape(s.wait)}` : ""}</dd>`);
  items.push(`<dt>Released upstream</dt><dd>${r.released ? `${exact(r.released.at)} (${escape(KIND[r.released.kind].label)})${KIND[r.released.kind].why ? `. ${escape(KIND[r.released.kind].why!)}` : ""}` : "Not known"}</dd>`);
  items.push(`<dt>Published on <code>main</code></dt><dd>${r.published ? `${exact(r.published.at)}, <a href="https://github.com/${escape(repo)}/commit/${escape(r.published.commit)}">commit ${escape(r.published.commit.slice(0, 7))}<span class="sr"> for ${escape(who)}</span></a>` : "Not known"}</dd>`);
  const why = r.counted === true ? "" : `<p>${notCounted(r)}</p>`;
  const hist = r.history.length
    ? `<ol class="hist">${r.history.map((d) => `<li><span class="v">${version(d.shown)}</span> <span>${escape(deliveryWords(d))}</span> <span class="muted">${exact(d.published.at)}</span></li>`).join("")}</ol>`
    : `<p class="muted">No deliveries yet.</p>`;
  return `<details class="more"><summary>Details<span class="sr"> for ${escape(who)}</span></summary><div class="more-body">
<dl>${items.join("")}</dl>${why}
<h${level} class="hist-title">Recent deliveries</h${level}>${hist}
</div></details>`;
}

function row(r: Row, repo: string, live: Live | null, level: 3 | 4): string {
  const n = nameOf(r.name);
  const s = live ? live.states[r.name] ?? { state: "not-checked" as const } : undefined;
  const unfree = UNFREE.has(r.name) ? ` <span class="tag">unfree</span>` : "";
  const desc = n.description;
  const heading = `<h${level} class="pkg-name">${escape(n.title)}${n.channel ? `<span class="sr">, ${escape(n.channel)}</span>` : ""}</h${level}>`;
  const who = fullName(r.name);
  const ver = r.browsers && r.channel ? version(r.channel) : r.notes ? `<a class="hit" href="${escape(r.notes)}">${version(r.version)}<span class="sr">, release notes for ${escape(who)}</span></a>` : version(r.version);
  let stateCell = "";
  if (s) {
    const words = version(says(s));
    const linked = s.link && LINK_WORDS[s.state] ? `<a class="hit" href="${escape(s.link)}">${words}<span class="sr"> for ${escape(who)}</span></a>` : words;
    const extra = s.state === "held" && s.version ? ` <span class="v">${version(s.version)}</span>` : "";
    const when = [since(s), s.state === "found" && s.wait ? escape(s.wait) : ""].filter(Boolean).join(" · ");
    stateCell = `<div class="cell state ${CLASS[s.state]}"><span class="lbl">State </span><span><span class="state-words">${icon(CLASS[s.state])}<span>${linked}${extra}</span></span>${when ? `<span class="sub">${when}</span>` : ""}</span></div>`;
  }
  return `<li class="pkg" id="pkg-${escape(r.name)}">
<div class="cell who">${heading} <code class="attr">${escape(r.name)}</code>${unfree}${desc ? `<p class="desc">${text(desc)}</p>` : ""}</div>
${stateCell}<div class="meta"><div class="cell ver"><span class="lbl">On main </span>${ver}</div>
<div class="cell dlv"><span class="lbl">Delivery </span>${deliveryCell(r)}</div>
<div class="cell recent"><span class="lbl">Recent deliveries </span>${strip(r.history)}</div></div>
${r.browsers?.length ? `${browserList(r.browsers, r.channel ?? who)}\n` : ""}${r.electron ? `<p class="electron">${escape(r.electron)}</p>\n` : ""}${details(r, repo, s, level === 3 ? 4 : 5)}
</li>`;
}

/** A browser pin's browsers, each with its version, inside the pin's row:
 * they move together (one nixpkgs revision), so the pin keeps the one state,
 * delivery and details. */
function browserList(list: Browser[], from: string): string {
  const note = (b: Browser) => [
    ...(b.name === "ungoogled-chromium" ? ["default"] : []),
    ...(b.unavailable.length ? [`not available on ${b.unavailable.map((sys) => sys.replace(/-linux$/, "")).join(" and ")}`] : []),
  ];
  return `<ul class="kids browsers" role="list" aria-label="Browsers from ${escape(from)}">${list.map((b) => {
    const notes = note(b);
    return `<li><code class="kid-name">${escape(b.name)}</code> <span class="kid-info"><span class="kid-ver">${b.version === null ? `<span class="muted">version not recorded</span>` : version(b.version)}</span>${notes.length ? ` <span class="kid-note">${escape(notes.join(" · "))}</span>` : ""}</span></li>`;
  }).join("")}</ul>`;
}

const COLS = (live: boolean) => `<div class="cols${live ? "" : " no-state"}" aria-hidden="true"><span>Package</span>${live ? "<span>State</span>" : ""}<span>On <code>main</code></span><span>Delivery</span><span>Recent deliveries</span><span></span></div>`;

/** Alphabetical by title, whatever the case; then by package name. */
const byTitle = (titles: Record<string, { title: string }>) => (a: string, b: string) =>
  titles[a].title.localeCompare(titles[b].title, "en", { sensitivity: "base" }) || a.localeCompare(b, "en");
/** The page's order of packages: T3 Code's; the providers alphabetically by
 * title, then any the page doesn't know, by package name; the agent tools
 * alphabetically by title, with the browser pins right after agent-browser;
 * then nixpkgs-stable. */
function groups(list: Row[]) {
  const has = new Set(list.map((r) => r.name));
  const t3Names = new Set(T3.flatMap((p) => p.channels.map(([, n]) => n)));
  const providers = [...Object.keys(PROVIDERS).filter((n) => has.has(n)).sort(byTitle(PROVIDERS)),
    ...list.map((r) => r.name).filter((n) => !t3Names.has(n) && !Object.hasOwn(PROVIDERS, n) && !Object.hasOwn(AGENT_TOOLS, n) && !Object.hasOwn(BROWSER_PINS, n)
      && !Object.hasOwn(NIXPKGS_PINS, n)).sort()];
  const tools = Object.keys(AGENT_TOOLS).filter((n) => has.has(n)).sort(byTitle(AGENT_TOOLS))
    .flatMap((n) => (n === "agent-browser" ? [n, ...Object.keys(BROWSER_PINS).filter((b) => has.has(b))] : [n]));
  const nixpkgs = Object.keys(NIXPKGS_PINS).filter((n) => has.has(n));
  // By channel (Latest, Nightly), each with its products in T3's order.
  const t3 = (T3[0]?.channels ?? []).map(([label], i) => ({ label, names: T3.map((p) => p.channels[i]?.[1]).filter((n): n is string => !!n && has.has(n)) }));
  return { t3, providers, tools, nixpkgs };
}
const pageOrder = (list: Row[]) => {
  const g = groups(list);
  return [...g.t3.flatMap((p) => p.names), ...g.providers, ...g.tools, ...g.nixpkgs];
};

/** The NixOS stable line: current, or behind with what differs. */
function stableLine(v: StableView, repo: string): string {
  const titleOf = (n: string) => {
    const x = nameOf(n);
    return x.product ? `T3 Code ${x.product.toLowerCase()}${x.channel === "Nightly" ? " nightly" : ""}` : x.title;
  };
  if (v.current) return `<p class="card-note">NixOS stable has the same versions as main.</p>`;
  const each = v.differing.map((d) =>
    // The same shown version on both sides: main has a newer build of it
    // (a browser pin's newer channel revision, or new details).
    d.stable !== null && d.stable === d.main
      ? `${escape(titleOf(d.name))} ${escape(d.stable)}, main a newer build of it`
      : `${escape(titleOf(d.name))} ${d.stable === null ? "not yet" : escape(d.stable)}, main ${d.main === null ? "none" : escape(d.main)}`);
  const issue = v.issue === null ? "" : ` <a href="https://github.com/${escape(repo)}/issues/${v.issue}">Why (#${v.issue})</a>`;
  return `<p class="card-note">NixOS stable is on an earlier set: ${each.join("; ")}.${issue}</p>`;
}

/** A T3 Code channel's line above its products: its name, the version when
 * every product has the same one, and (live) the most urgent of their states. */
function parentHead(label: string, rows: Row[], live: Live | null): string {
  const versions = new Set(rows.map((r) => r.version));
  const ver = versions.size === 1 ? ` <span class="parent-ver">${version(rows[0].version)}</span>` : "";
  let state = "";
  if (live) {
    const order: StateName[] = ["held", "testing", "found", "not-checked", "up-to-date"];
    const all = rows.map((r) => live.states[r.name]?.state ?? "not-checked");
    const top = order.find((o) => all.includes(o))!;
    const words: Record<StateName, string> = { held: "Held", testing: "Testing", found: "New version found", "not-checked": "Not checked", "up-to-date": "Up to date" };
    // Every product in that state: the words alone; otherwise which ones.
    const which = rows.filter((_, i) => all[i] === top).map((r) => nameOf(r.name).title);
    const said = which.length === rows.length ? words[top] : `${words[top]} (${which.join(", ")})`;
    state = ` <span class="parent-state ${CLASS[top]}">${icon(CLASS[top])}${escape(said)}</span>`;
  }
  return `<div class="parent-head"><h3 class="parent-title">${escape(label)}</h3>${ver}${state}</div>`;
}

function section(id: string, title: string, count: number | null, body: string, live: boolean, before = ""): string {
  return `<section class="group" aria-labelledby="${id}">
<h2 id="${id}">${escape(title)}${count === null ? "" : ` <span class="count">${count}</span>`}</h2>
<div class="card">${before}${body ? `${COLS(live)}\n${body}` : ""}</div>
</section>`;
}

export function html(list: Row[], repo: string, live: Live | null = null, id = "", stable: StableView | null = null, delivery: DeliveryFigure | null = null): string {
  const by = new Map(list.map((r) => [r.name, r]));
  const repoUrl = `https://github.com/${escape(repo)}`;
  const g = groups(list);
  const ul = (names: string[], level: 3 | 4) => `<ul class="pkgs" role="list">\n${names.map((n) => row(by.get(n)!, repo, live, level)).join("\n")}\n</ul>`;
  const t3Count = g.t3.reduce((a, p) => a + p.names.length, 0);
  const t3Body = g.t3.filter((c) => c.names.length).map((c) => `<div class="parent">
${parentHead(c.label, c.names.map((n) => by.get(n)!), live)}
${ul(c.names, 4).replace('<ul class="pkgs"', '<ul class="pkgs kids"')}
</div>`).join("\n");
  const sections = [
    t3Count ? section("t3code", "T3 Code", t3Count, t3Body, !!live) : "",
    section("providers", "Agent Providers", g.providers.length, ul(g.providers, 3), !!live),
    g.tools.length ? section("agent-tools", "Agent Tools", g.tools.length, ul(g.tools, 3), !!live) : "",
    g.nixpkgs.length || stable ? section("nixos-stable", "NixOS stable", null, g.nixpkgs.length ? ul(g.nixpkgs, 3) : "", !!live, stable ? stableLine(stable, repo) : "") : "",
  ].filter(Boolean).join("\n");
  const legend = (["good", "fair", "slow"] as const).map((t) => `<li><svg class="band-mark" viewBox="0 0 6 16" aria-hidden="true">${bar({ gap: { good: 60, fair: 3600, slow: 6 * 3600 }[t], released: { at: "", kind: "published" } }, 0)}</svg>${BAND[t]}</li>`).join("")
    + `<li><svg class="band-mark" viewBox="0 0 6 16" aria-hidden="true">${bar({ gap: 60, released: { at: "", kind: "seen" } }, 0)}</svg>approximate</li>`
    + `<li><svg class="band-mark" viewBox="0 0 6 16" aria-hidden="true">${bar({ gap: null, released: null }, 0)}</svg>not known</li>`;

  return `<!doctype html>
<html lang="en" data-id="${escape(id)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src '${SCRIPT_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark">
<title>Package status · t3code-nix</title>
<style>${STYLE}</style>
</head>
<body>
<svg class="defs" aria-hidden="true" focusable="false"><defs><pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="3" height="3"/><rect class="hatch-line" width="1.2" height="3"/></pattern></defs></svg>
<div class="page">
<header class="top">
<div class="title"><a class="brand" href="${repoUrl}">${MARK}<span>t3code-nix</span></a><div class="crumb"><span class="slash" aria-hidden="true">/</span><h1>Package status</h1></div></div>
<nav aria-label="Project"><a href="${repoUrl}#quick-start">Install</a><a href="${repoUrl}/releases">Releases</a><a href="${repoUrl}">Repository</a></nav>
</header>
<main>
${hero(list, by, live, delivery)}
${activity(list, live)}${sections}
</main>
<footer>
<h2 class="sr">About this page</h2>
<ul class="legend" aria-label="Delivery bands">${legend}</ul>
<p>Delivery is the time from upstream's release to the commit on <code>main</code>, for each version. The page is rebuilt every hour and on every update run; its data counts as out of date 2 hours after the last check.${live ? ` Last checked against upstream: <time id="checked-exact" datetime="${escape(live.checked)}">${escape(utc(live.checked))}</time>.` : ""}</p>
<p><a class="hit" href="${repoUrl}">t3code-nix on GitHub</a></p>
</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ---- Style -------------------------------------------------------------

export const STYLE = `
:root { color-scheme: light dark;
  --page: #F6F8FA; --surface: #FFFFFF; --hover: #F1F4F8; --text: #17202A; --muted: #526071; --link: #2457C5; --focus: #2457C5; --line: #DCE2E9;
  --ok: #17663F; --ok-bg: #EAF5EE; --move: #2457A7; --move-bg: #EDF3FF; --held: #815600; --held-bg: #FFF4D6; --none: #526071; --none-bg: #EEF1F5;
  --slow: #A52B32; --approx: #7B8796; --flake: #4A78CF; --bolt: #FFD23F; }
@media (prefers-color-scheme: dark) { :root {
  --page: #10151D; --surface: #151B24; --hover: #1D2632; --text: #E8EDF4; --muted: #AAB6C7; --link: #9BBDFF; --focus: #9BBDFF; --line: #303B49;
  --ok: #88D9A6; --ok-bg: #172E23; --move: #A5C5FF; --move-bg: #1C2B43; --held: #F1CC75; --held-bg: #352B16; --none: #B7C2D1; --none-bg: #252E3A;
  --slow: #FFADB4; --approx: #69788D; --flake: #8FB2EE; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--page); color: var(--text); font: 400 1rem/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
.defs { position: absolute; width: 0; height: 0; }
.page { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1.5rem 4rem; }
a { color: var(--link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); }
a:hover { text-decoration-color: currentColor; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
strong { font-weight: 600; }
code { font: .875em/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
h1, h2, h3, h4, h5, p { margin: 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.muted { color: var(--muted); }
[hidden] { display: none !important; }

.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem 1.5rem; margin-bottom: 1.5rem; }
.title { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .75rem; min-width: 0; }
.brand { display: inline-flex; align-items: center; gap: .625rem; color: var(--text); text-decoration: none; font-weight: 600; font-size: 1.25rem; line-height: 1.75rem; min-height: 2.75rem; }
/* The slash wraps with the heading, never left at the end of a line. */
.crumb { display: flex; align-items: center; gap: .75rem; }
.slash { color: var(--line); font-size: 1.5rem; font-weight: 300; }
.mark { width: 2.75rem; height: 2.75rem; flex: none; overflow: visible; }
.mark .flake path { fill: none; stroke: var(--flake); stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; }
.mark .energy path { fill: none; stroke: #FFFFFF; stroke-width: 7; stroke-linecap: round; stroke-dasharray: 24 76; }
.mark .bolt { fill: var(--bolt); stroke: var(--page); stroke-width: 9; stroke-linejoin: round; paint-order: stroke; }
/* A dash of 200 then a gap of 210, starting 201 in: nothing drawn at the
   start (a zero-length dash would still draw its round cap). */
.mark .strike, .mark .glow { fill: none; stroke: var(--bolt); stroke-linecap: round; stroke-linejoin: round; opacity: 0; stroke-dasharray: 200 210; }
.mark .strike { stroke-width: 4; animation: mark-in 10s linear infinite; }
.mark .glow { stroke-width: 8.8; filter: url(#mark-blur); animation: mark-glow 10s linear infinite; }
.mark .spin, .mark .pop { transform-box: view-box; transform-origin: 50px 50px; }
.mark .spin { animation: mark-spin 10s cubic-bezier(.2, .9, .25, 1) infinite; }
.mark .pop { animation: mark-pop 10s cubic-bezier(.3, 1.6, .5, 1) infinite; }
.mark .energy { opacity: 0; animation: mark-energy 10s ease-out infinite; }
@keyframes mark-in { 0% { opacity: 1; stroke-dashoffset: 201; } 2.5% { opacity: 1; stroke-dashoffset: 0; } 4%, 100% { opacity: 0; stroke-dashoffset: 0; } }
@keyframes mark-glow { 0% { opacity: .9; stroke-dashoffset: 201; } 2.5% { opacity: .9; stroke-dashoffset: 0; } 4.5%, 100% { opacity: 0; stroke-dashoffset: 0; } }
@keyframes mark-pop { 0%, 2.6% { transform: scale(0); opacity: 0; } 2.8% { opacity: 1; } 4.5% { transform: scale(1.12); } 6%, 96% { transform: scale(1); opacity: 1; } 99.5%, 100% { transform: scale(0); opacity: 0; } }
@keyframes mark-spin { 0%, 2.5% { transform: rotate(0) scale(1); } 3% { transform: rotate(-6deg) scale(.92); } 6% { transform: rotate(60deg) scale(1.04); } 7.5%, 100% { transform: rotate(60deg) scale(1); } }
@keyframes mark-energy { 0%, 2.6% { opacity: 0; stroke-dashoffset: 24; } 2.8% { opacity: 1; } 6.5% { opacity: 1; stroke-dashoffset: -100; } 7%, 100% { opacity: 0; stroke-dashoffset: -100; } }
@media (prefers-reduced-motion: reduce) {
  .mark .strike, .mark .glow, .mark .spin, .mark .pop, .mark .energy { animation: none; }
}
nav { display: flex; flex-wrap: wrap; gap: .25rem; }
nav a { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0 .75rem; border-radius: 6px; color: var(--text); text-decoration: none; font-weight: 500; font-size: 1rem; }
nav a:hover { background: var(--hover); }

h1 { font-size: 1.25rem; line-height: 1.75rem; font-weight: 500; color: var(--muted); }

.hero, .notice, .card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
.hero { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1.5rem 3rem; padding: 1.5rem; margin-bottom: 1rem; }
.hero-main { display: flex; gap: 1rem; align-items: flex-start; min-width: 0; flex: 1 1 24rem; }
.hero .lead { display: inline-flex; margin-top: .125rem; }
.hero .lead .st { width: 2rem; height: 2rem; stroke-width: 1.4; }
.hero-text { min-width: 0; }
#headline { font-size: 1.75rem; line-height: 2.25rem; font-weight: 600; letter-spacing: -.02em; }
.counts { display: flex; flex-wrap: wrap; align-items: center; column-gap: .375rem; row-gap: .25rem; margin-top: .5rem; color: var(--muted); font-size: .875rem; line-height: 1.25rem; }
.count-item { display: inline-flex; align-items: center; gap: .375rem; color: var(--text); font-weight: 500; }
.note { margin-top: .5rem; color: var(--muted); font-size: .875rem; line-height: 1.25rem; }
.status-line { display: flex; flex-wrap: wrap; align-items: center; row-gap: .25rem; margin-top: .75rem; color: var(--muted); font-size: .875rem; line-height: 1.25rem; }
.status-line.is-stale .checked-text { color: var(--held); }
/* Each part spaces itself, so a hidden one leaves no gap. */
.checked-text, .live-status > span { margin-right: .75rem; }
.live-status { display: inline-flex; flex-wrap: wrap; }
.stale-note { display: inline-flex; color: var(--held); background: var(--held-bg); font-weight: 600; border-radius: 4px; padding: 0 .375rem; }
.figure { flex: 0 1 16rem; display: flex; flex-direction: column; justify-content: center; border-left: 1px solid var(--line); padding-left: 1.5rem; }
.figure-value { font-size: 1.75rem; line-height: 2.25rem; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.figure-label { font-size: .875rem; line-height: 1.25rem; font-weight: 500; }

.notice { padding: 1rem 1.5rem; margin-bottom: 1rem; }
.notice h2 { font-size: .875rem; line-height: 1.25rem; font-weight: 600; }
.notice ul { list-style: none; margin: .5rem 0 0; padding: 0; display: grid; gap: .5rem; }
.notice li { display: flex; gap: .5rem; align-items: flex-start; line-height: 1.5rem; }
.notice li .st { margin-top: .25rem; }
.attention { border-color: color-mix(in srgb, var(--held) 45%, var(--line)); background: color-mix(in srgb, var(--held-bg) 55%, var(--surface)); }
.attention h2 { color: var(--held); }

.group { margin-top: 2rem; }
.group > h2 { display: flex; align-items: center; gap: .5rem; font-size: 1.125rem; line-height: 1.5rem; font-weight: 600; margin-bottom: .75rem; }
.count { font-size: .75rem; line-height: 1rem; font-weight: 600; color: var(--muted); background: var(--none-bg); border-radius: 999px; padding: .125rem .5rem; font-variant-numeric: tabular-nums; }
.card { overflow: hidden; }
.card-note { padding: 1rem; color: var(--muted); font-size: .875rem; line-height: 1.25rem; border-bottom: 1px solid var(--line); }
.card-note:last-child { border-bottom: 0; }
.parent + .parent { border-top: 1px solid var(--line); }
.parent-head { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .75rem; padding: .75rem 1rem 0; }
.parent-title { font-size: 1rem; line-height: 1.5rem; font-weight: 600; }
.parent-ver { font-size: .875rem; line-height: 1.25rem; color: var(--muted); overflow-wrap: anywhere; }
.parent-state { font-size: .875rem; line-height: 1.25rem; }
/* Children: a line down the left joins them to their parent. It sits in the
   rows' own padding, with their content indented past it: the whole row on
   narrow screens, and on wide ones the name and the details only, so the
   columns stay under the header row's. */
.kids > .pkg { border-top: 0; }
.kids > .pkg::after { content: ""; position: absolute; top: 0; bottom: 0; left: 1rem; border-left: 2px solid var(--line); }
.kids > .pkg + .pkg::before { content: ""; position: absolute; top: 0; left: 1rem; right: 0; border-top: 1px solid var(--line); }
.browsers { list-style: none; margin: .5rem 0 0; padding: 0 0 0 .875rem; border-left: 2px solid var(--line); display: grid; gap: .375rem; font-size: .875rem; line-height: 1.25rem; }
/* Each browser: its name, then its version and note in a column of their
   own, so what wraps stays beside its name. The name's column takes at most
   45%, so large text on a small screen still leaves room for the version. */
.browsers li { display: grid; grid-template-columns: minmax(0, min(9.5rem, 45%)) minmax(0, 1fr); align-items: baseline; column-gap: .75rem; min-width: 0; }
.kid-name { font-size: .8125rem; color: var(--text); overflow-wrap: anywhere; }
.kid-info { display: flex; flex-wrap: wrap; column-gap: .75rem; min-width: 0; }
.kid-ver { overflow-wrap: anywhere; }
.kid-note { color: var(--muted); }
.electron { color: var(--muted); font-size: .8125rem; line-height: 1.25rem; min-width: 0; }
.parent .pkgs { margin-top: .5rem; }

.pkgs { list-style: none; margin: 0; padding: 0; }
.pkg { position: relative; padding: 1rem; border-top: 1px solid var(--line); transition: background-color .12s; }
.cols + .pkgs > .pkg:first-child { border-top: 0; }
.pkg:hover, .pkg:focus-within { background: var(--hover); }
.cols { display: none; }
.cell { min-width: 0; font-size: .875rem; line-height: 1.25rem; }
.who { font-size: 1rem; line-height: 1.5rem; }
.pkg-name { display: inline; font-size: 1rem; line-height: 1.5rem; font-weight: 600; }
.attr { color: var(--muted); font-size: .8125rem; margin-left: .25rem; overflow-wrap: anywhere; }
.tag { display: inline-block; margin-left: .375rem; font-size: .75rem; line-height: 1rem; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 .375rem; vertical-align: 1px; }
.desc { color: var(--muted); font-size: .875rem; line-height: 1.25rem; }
.state { display: flex; align-items: flex-start; }
.state > span, .state-words > span, .notice li > span, .more-body dd { min-width: 0; overflow-wrap: anywhere; }
/* Links in rows and cards: a target at least 24px tall, 4px taller than its
   line, without moving the text. They don't overlap the next line's only
   because rows, the meta line and the notice lists keep at least 8px
   between lines (WCAG 2.5.8): keep that gap wherever two of them can sit on
   adjacent lines. */
a.hit { display: inline-block; padding-block: .125rem; margin-block: -.125rem; }
/* The state as a tinted pill, its icon inside, in the state's own colour;
   the versions on main no longer share it. The edge, a faint mix of the
   pill's colour, keeps the pill's shape on a hovered row (whose background
   is as light as the tints) and becomes an outline in forced colours. */
.state-words, .parent-state, .reason { display: inline-flex; align-items: flex-start; gap: .375rem; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: .75rem; padding: 0 .5rem; font-weight: 500; }
.state-words .st, .parent-state .st { margin-top: .125rem; }
.state.ok .state-words, .parent-state.ok { color: var(--ok); background: var(--ok-bg); }
.state.found .state-words, .state.testing .state-words, .parent-state.found, .parent-state.testing { color: var(--move); background: var(--move-bg); }
.state.held .state-words, .parent-state.held { color: var(--held); background: var(--held-bg); }
.state.none .state-words, .parent-state.none, .reason { color: var(--muted); background: var(--none-bg); }
.reason { font-size: .8125rem; }
.state a { color: inherit; }
.sub { display: block; color: var(--muted); font-size: .8125rem; }
.v { font-variant-numeric: tabular-nums; }
/* Versions on main read as text, not as a state: their link shows by a
   full-strength underline in --muted (3:1 on the row in both schemes). A
   state's link, in its pill, underlines in the pill's own colour. */
.ver a { color: var(--text); text-decoration-color: var(--muted); }
.ver a:hover { text-decoration-color: currentColor; }
.state-words a { text-decoration-color: currentColor; }
.state-words a:hover { text-decoration-thickness: 2px; }
.ver, .dlv { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.dlv { display: flex; align-items: center; gap: .375rem; white-space: nowrap; }
/* A chip may wrap rather than spill into the next column. */
.dlv .reason { white-space: normal; }
.none-text { color: var(--muted); }
.band-mark { width: 6px; height: 16px; flex: none; }
.strip { display: block; overflow: visible; }

.st { width: 1rem; height: 1rem; flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.st.ok { color: var(--ok); } .st.found, .st.testing { color: var(--move); } .st.held, .st.stale { color: var(--held); } .st.none { color: var(--none); }
.b-good { fill: var(--ok); } .b-fair { fill: var(--held); } .b-slow { fill: var(--slow); }
.b-approx { fill: url(#hatch); stroke: var(--approx); stroke-width: 1; }
.hatch-bg { fill: var(--surface); } .hatch-line { fill: var(--approx); }
.b-none { fill: none; stroke: var(--approx); stroke-width: 1.2; }

.more { margin-top: .5rem; }
.more > summary { display: inline-flex; align-items: center; gap: .25rem; min-height: 2.75rem; cursor: pointer; color: var(--link); font-size: .875rem; font-weight: 500; list-style: none; }
.more > summary::-webkit-details-marker { display: none; }
.more > summary::after { content: ""; width: .375rem; height: .375rem; border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: translateY(-2px) rotate(45deg); transition: transform .12s; }
.more[open] > summary::after { transform: translateY(1px) rotate(-135deg); }
.more-body { padding: .5rem 0 .25rem; font-size: .875rem; line-height: 1.25rem; display: grid; gap: .75rem; }
.more-body dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; }
.more-body dt { color: var(--muted); }
.more-body dd { margin: 0; }
.hist-title { font-size: .875rem; line-height: 1.25rem; font-weight: 600; }
.hist { list-style: none; margin: 0; padding: 0; display: grid; gap: .25rem; }
.hist li { display: flex; flex-wrap: wrap; gap: 0 .75rem; font-variant-numeric: tabular-nums; }
.hist .v { min-width: 6rem; font-weight: 500; overflow-wrap: anywhere; }

footer { margin-top: 3rem; color: var(--muted); font-size: .875rem; line-height: 1.25rem; display: grid; gap: .75rem; }
.legend { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; list-style: none; margin: 0; padding: 0; }
.legend li { display: inline-flex; align-items: center; gap: .375rem; }

/* Wide screens: the rows line up in columns, the details' summary in the
   last one and its panel across the row under it. */
@media (min-width: 60rem) {
  .meta { display: contents; }
  /* The Electron line under the row's values, between the name and Details. */
  .electron { grid-column: 2 / -2; }
  .browsers { grid-column: 1 / -2; }
  .electron { margin-top: .25rem; }
  .kids .who, .kids .more-body { padding-left: .875rem; }
  .cols, .pkg { display: grid; grid-template-columns: minmax(0, 2.4fr) minmax(0, 1.6fr) minmax(0, 1.2fr) minmax(0, .9fr) 7.5rem 5.5rem; column-gap: 1rem; align-items: start; }
  .cols.no-state, .no-state ~ .pkgs .pkg, .no-state ~ .parent .pkg { grid-template-columns: minmax(0, 2.6fr) minmax(0, 1.4fr) minmax(0, 1fr) 7.5rem 5.5rem; }
  .cols { padding: .625rem 1rem; border-bottom: 1px solid var(--line); color: var(--muted); font-size: .875rem; line-height: 1.25rem; font-weight: 600; }
  .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .recent { padding-top: .125rem; }
  .more { grid-column: 1 / -1; margin: 0; }
  .more > summary { position: absolute; top: .375rem; right: 1rem; }
  .more[open] > .more-body { margin-top: .75rem; padding-top: .75rem; border-top: 1px dashed var(--line); }
}
/* Narrow screens: each row stacks, with its labels shown. */
@media (max-width: 59.99rem) {
  .page { padding: 1rem 1rem 3rem; }
  #headline, .figure-value { font-size: 1.5rem; line-height: 2rem; }
  .figure { border-left: 0; padding-left: 0; border-top: 1px solid var(--line); padding-top: 1rem; flex-basis: 100%; }
  /* The same lines in every row: the name (with its description), the
     state, then On main, Delivery and the strip (the strip on a line of its
     own when they don't fit), then Details. */
  .pkg { display: grid; grid-template-columns: minmax(0, 1fr); row-gap: .5rem; padding: .75rem 1rem .25rem; }
  .kids > .pkg { padding-left: 1.875rem; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; }
  .lbl { color: var(--muted); }
  .state .lbl, .recent .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .more { margin: 0; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
@media (forced-colors: active) {
  .st { color: CanvasText; }
  .b-good, .b-fair, .b-slow { fill: CanvasText; }
  .b-approx { stroke: CanvasText; } .hatch-line { fill: CanvasText; } .hatch-bg { fill: Canvas; }
  .b-none { stroke: CanvasText; }
  .mark .flake path { stroke: CanvasText; } .mark .bolt { fill: CanvasText; stroke: Canvas; } .mark .strike, .mark .glow, .mark .energy { display: none; }
}
`;

// ---- Script ------------------------------------------------------------

// Nothing changes by itself while someone is in the window, except the
// out-of-date switch turning on and the "Newer data · Reload" link
// appearing. "Nobody in the window": the tab hidden, or the window unfocused
// for 2 minutes (a moment in the find bar doesn't count). Then, once a
// minute, the relative times are redrawn with the newest check time, and
// once more when someone comes back. Checks of the site's tiny live.json:
// on start, once a minute while visible, every 5 minutes in the background,
// and on becoming visible; one at a time, aborted after 15 s. The same id:
// only the check time is taken. Another id: the link, and a reload when
// nobody is in the window, no section is open and nothing is selected, once
// per id (the tab remembers the ids it reloaded for, starting with its own,
// so stale copies can't make it loop; if storage can't be trusted, never).
export const SCRIPT = `(() => {
  const d = document, id = d.documentElement.dataset.id;
  const $ = (q) => d.querySelector(q), all = (q) => d.querySelectorAll(q);
  const IDS = "t3code-nix-reloaded";
  // Storage that can't be read or written, or doesn't keep what it was
  // given, turns the automatic reload off for this tab.
  let broken = false;
  const get = () => { try { return sessionStorage.getItem(IDS); } catch { broken = true; return null; } };
  const remembered = () => { try { const a = JSON.parse(get() || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
  const remember = (x) => {
    try { sessionStorage.setItem(IDS, JSON.stringify([...remembered(), x].slice(-20))); } catch { broken = true; }
    if (!remembered().includes(x)) broken = true;
  };
  const f = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  const units = [["year", 31536e3], ["month", 2592e3], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  let skew = 0, pending = null, busy = false, lastCheck = 0, stale = false, first = true;
  const now = () => Date.now() + skew;
  // hasFocus() too, so a missed focus event can't leave a reader "away".
  const hasFocus = () => typeof d.hasFocus !== "function" || d.hasFocus();
  let blurredAt = hasFocus() ? null : Date.now();
  const away = () => d.hidden || (!hasFocus() && blurredAt !== null && Date.now() - blurredAt >= 120e3);
  const ago = (iso) => {
    const s = (now() - Date.parse(iso)) / 1000;
    // Under a minute, or ahead of us, is "just now"; whole units, rounded down.
    if (!(s >= 60)) return "just now";
    const [unit, n] = units.find(([, n]) => s >= n);
    return f.format(-Math.floor(s / n), unit);
  };
  const exact = (iso) => {
    const t = new Date(iso), two = (n) => String(n).padStart(2, "0");
    const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return t.getUTCDate() + " " + M[t.getUTCMonth()] + " " + t.getUTCFullYear() + ", " + two(t.getUTCHours()) + ":" + two(t.getUTCMinutes()) + " UTC";
  };
  const checkedEl = $("#checked");
  // The newest check time this tab knows; the page shows it at redraws.
  let checked = checkedEl ? checkedEl.dateTime : null;
  const show = (el, on) => { if (el && el.hidden === on) el.hidden = !on; };
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const setStale = (on) => {
    stale = on;
    for (const q of [".stale-note", ".at-last", ".stale-icon"]) show($(q), on);
    for (const el of all(".lead:not(.stale-icon)")) show(el, !on);
    const line = $(".status-line");
    if (line) line.classList.toggle("is-stale", on);
  };
  const isStale = () => checked !== null && now() - Date.parse(checked) > 120 * 60e3;
  // Everything, as of now: the check time, every relative time, the switch.
  const redraw = () => {
    if (checkedEl && checked && checkedEl.dateTime !== checked) {
      checkedEl.dateTime = checked;
      checkedEl.title = exact(checked);
      const foot = $("#checked-exact");
      if (foot) { foot.dateTime = checked; setText(foot, exact(checked)); }
    }
    for (const t of all("time.rel")) setText(t, ago(t.dateTime));
    if (isStale() !== stale) setStale(!stale);
  };
  // While someone reads: the switch may only turn on, with the checked
  // line's own words, so it never says "1 hour ago" beside "Out of date".
  const settle = () => {
    if (away()) return redraw();
    if (!stale && isStale()) {
      if (checkedEl) setText(checkedEl, ago(checkedEl.dateTime));
      setStale(true);
    }
  };
  const safe = () => away() && !$("details[open]") && !String((typeof getSelection === "function" && getSelection()) || "");
  const tryReload = () => {
    if (broken || pending === null || remembered().includes(pending) || !safe()) return;
    remember(pending);
    if (!broken) location.reload();
  };
  const check = async () => {
    if (busy) return;
    busy = true;
    lastCheck = Date.now();
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15e3) : null;
    try {
      const res = await fetch("live.json?t=" + Date.now(), { cache: "no-store", ...(ctrl ? { signal: ctrl.signal } : {}) });
      const server = Date.parse(res.headers.get("date"));
      if (Number.isFinite(server)) skew = server - Date.now();
      const data = await res.json();
      if (typeof data.id !== "string") return;
      if (data.id === id) {
        const c = data.checked;
        if (checkedEl && typeof c === "string" && Number.isFinite(Date.parse(c)) && (checked === null || Date.parse(c) > Date.parse(checked))) checked = c;
      } else {
        pending = data.id;
        show($(".newer"), true);
        tryReload();
      }
    } catch {} finally {
      if (timer) clearTimeout(timer);
      busy = false;
      // The first check, part of loading the page, and the check on coming
      // back to the tab (it may have been frozen for hours) draw everything,
      // with the clock the Date header corrected.
      if (first) { first = false; redraw(); } else settle();
    }
  };
  const reloadLink = $(".reload");
  // "Reload": a real reload, not a navigation the cache could answer.
  if (reloadLink) reloadLink.addEventListener("click", (e) => { e.preventDefault(); location.reload(); });
  // This page's own id counts as reloaded for.
  if (id && !remembered().includes(id)) remember(id);
  addEventListener("blur", () => { blurredAt = Date.now(); });
  addEventListener("focus", () => {
    const back = blurredAt !== null && Date.now() - blurredAt >= 120e3;
    blurredAt = null;
    if (back) redraw();
  });
  d.addEventListener("visibilitychange", () => {
    if (d.hidden) return tryReload();
    redraw();
    first = true;
    check();
  });
  redraw();
  check();
  setInterval(() => {
    // A check settles when it ends; without one (or with one still out),
    // settle now. (After a sleep, settling before the check would show
    // "Out of date" for data the check is about to refresh.)
    if (!busy && (!d.hidden || Date.now() - lastCheck >= 5 * 60e3)) check(); else settle();
    tryReload();
  }, 60e3);
})();`;
/** The script's hash, for the Content-Security-Policy. */
export const SCRIPT_HASH = `sha256-${createHash("sha256").update(SCRIPT).digest("base64")}`;
