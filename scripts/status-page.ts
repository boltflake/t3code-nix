// The status page's HTML (scripts/status.ts builds the data). One static
// file: inline CSS, inline SVG and one inline script, nothing loaded from
// another site (its Content-Security-Policy says so: the script is allowed
// by its hash, and it may fetch only the site's own live.json). The output
// depends only on its inputs, so it stays deterministic: dates are written
// out in UTC, and the script turns the relative ones into "2 hours ago" and
// the exact ones into the reader's own time zone in the browser, says when
// the data is out of date, reloads when the site has newer data, and
// strikes each version changed since the reader's last visit with a bolt
// (see SCRIPT).
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
/** A time shown exactly; the script rewrites it once, in the reader's
 * time zone. */
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

/** "Codex", or "T3 Code desktop app nightly": a name that stands alone. */
const titleOf = (n: string) => {
  const x = nameOf(n);
  // "Desktop app" -> "desktop app"; "CLI and server" keeps its capitals.
  const product = x.product?.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
  return product ? `T3 Code ${product}${x.channel === "Nightly" ? " nightly" : ""}` : x.title;
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
 * whose "Out of date" the script shows. */
function statusLine(checked: string | null): string {
  const time = checked ? `<span class="checked-text">Checked against upstream <time class="rel" id="checked" datetime="${escape(checked)}" title="${escape(utc(checked))}">${escape(utc(checked))}</time></span>` : "";
  return `<p class="status-line">${time}<span class="live-status" role="status"><span class="stale-note" hidden>Out of date</span></span></p>`;
}

/** The latest change shown here: the packages whose versions arrived in
 * the newest commit that changed one of them, with their versions (a
 * browser pin by name only: its browsers are in its row), when, and the
 * commit. */
export function latestLine(list: Row[], repo: string): string {
  const newest = list.filter((r) => r.published).sort((a, b) => (a.published!.at < b.published!.at ? 1 : a.published!.at > b.published!.at ? -1 : 0))[0]?.published;
  if (!newest) return "";
  const order = new Map(pageOrder(list).map((n, i) => [n, i]));
  const names = list.filter((r) => r.published?.commit === newest.commit).sort((a, b) => order.get(a.name)! - order.get(b.name)!)
    .map((r) => `<strong>${escape(titleOf(r.name))}</strong>${r.browsers ? "" : ` ${version(r.version)}`}`);
  const said = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `<p class="latest">Latest update: ${said} · ${rel(newest.at)} · <a class="hit" href="https://github.com/${escape(repo)}/commit/${escape(newest.commit)}">commit ${escape(newest.commit.slice(0, 7))}<span class="sr">, the latest update</span></a></p>\n`;
}

function hero(list: Row[], by: Map<string, Row>, live: Live | null, delivery: DeliveryFigure | null, repo: string): string {
  if (!live) {
    const latest = by.get("t3code")?.version, nightly = by.get("t3code-nightly")?.version;
    const parts = latest ? [`T3 Code ${escape(latest)}${nightly ? ` (Nightly ${escape(nightly)})` : ""}`] : [];
    return `<section class="hero plain" aria-labelledby="headline">
<div class="hero-main"><div class="hero-text">
<h2 id="headline">${list.length} packages</h2>
${parts.length ? `<p class="counts">${parts.join(" · ")}</p>\n` : ""}${latestLine(list, repo)}<p class="note">Upstream status isn't available; these are the versions on <code>main</code>.</p>
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
${counts.length ? `<p class="counts">${counts.join(`<span class="dot" aria-hidden="true"> · </span>`)}</p>\n` : ""}${latestLine(list, repo)}${statusLine(live.checked)}
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

/** "8 min"; "~3 h, approximate: upload time"; "not known". */
function deliveryWords(d: { gap: number | null; released: Released | null }): string {
  if (d.gap === null || !d.released) return "not known";
  if (KIND[d.released.kind].why) return `~${roughly(d.gap)}, approximate: ${KIND[d.released.kind].label}`;
  return duration(d.gap);
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
  return `<svg class="strip" viewBox="0 0 ${n * 9 - 3} 16" width="${n * 9 - 3}" height="16" role="img" aria-label="${escape(label)}">${oldestFirst.map((d, i) => tipped(d, i * 9)).join("")}</svg>`;
}

/** A strip bar, with its delivery for the script's card: the version,
 * the time it took and its band, and when it was published. A clear rect
 * over the bar's slot, gap included, makes short bars easy to hit. Hidden
 * from screen readers: the strip is one image with its summary as its
 * name, and the details list has each delivery. */
function tipped(d: Delivery, x: number): string {
  const known = d.gap !== null && d.released;
  const approx = known && KIND[d.released!.kind].why;
  const [band, took, note] = !known ? ["none", "Not known", "delivery time"]
    : approx ? ["approx", `~${roughly(d.gap!)}`, `approximate: ${KIND[d.released!.kind].label}`]
    : [tone(d.gap!), duration(d.gap!), "to deliver"];
  return `<g aria-hidden="true" data-v="${escape(d.shown)}" data-d="${escape(took)}" data-note="${escape(note)}" data-band="${band}" data-at="${escape(d.published.at)}"><rect class="hit" x="${x - 1.5}" width="9" height="16"/>${bar(d, x)}</g>`;
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
  return `<li class="pkg" id="pkg-${escape(r.name)}" data-v="${escape(r.browsers ? r.browsers.map((b) => `${b.name} ${b.version}`).join(", ") : r.version)}">
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

const COLS = (live: boolean) => `<div class="cols${live ? "" : " no-state"}" aria-hidden="true"><span>Package</span>${live ? "<span>State</span>" : ""}<span class="col-ver">On <code>main</code></span><span>Delivery</span><span>Recent deliveries</span><span></span></div>`;

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
<style>${minifyCss(STYLE)}</style>
</head>
<body>
<svg class="defs" aria-hidden="true" focusable="false"><defs><pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="3" height="3"/><rect class="hatch-line" width="1.2" height="3"/></pattern></defs></svg>
<div class="page">
<header class="top">
<div class="title"><a class="brand" href="${repoUrl}">${MARK}<span>t3code-nix</span></a><div class="crumb"><span class="slash" aria-hidden="true">/</span><h1>Package status</h1></div></div>
<nav aria-label="Project"><a href="${repoUrl}#quick-start">Install</a><a href="${repoUrl}/releases">Releases</a><a href="${repoUrl}">Repository</a></nav>
</header>
<main>
${hero(list, by, live, delivery, repo)}
${activity(list, live)}${sections}
</main>
<footer>
<h2 class="sr">About this page</h2>
<ul class="legend" aria-label="Delivery bands">${legend}</ul>
<p>Delivery is the time from upstream's release to the commit on <code>main</code>, for each version. The page is rebuilt every hour and on every update run; its data counts as out of date 2 hours after the last check.${live ? ` Last checked against upstream: <time id="checked-exact" datetime="${escape(live.checked)}">${escape(utc(live.checked))}</time>.` : ""}</p>
<p><a class="hit" href="${repoUrl}">t3code-nix on GitHub</a></p>
</footer>
</div>
<div class="tip" id="tip" aria-hidden="true"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ---- Style -------------------------------------------------------------

/** Our own CSS, smaller on the wire: no comments, and no whitespace a rule
 * doesn't need (around { } ; , > and after :). Never a space before a ":",
 * which can be a descendant combinator. Only for STYLE, whose strings are
 * font names and empty contents (tests check). */
export function minifyCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{};,>])\s*/g, "$1").replace(/:\s+/g, ":")
    .replace(/;}/g, "}").trim();
}

/** Our own script, smaller on the wire: each line trimmed, comment lines
 * and blank lines dropped. Line breaks stay, so no statement runs into the
 * next. Only for SOURCE, which has no multi-line strings and no "//" in a
 * string (tests check). */
export function minifyJs(js: string): string {
  return js.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).join("\n");
}

export const STYLE = `
:root { color-scheme: light dark;
  --page: #F6F8FA; --surface: #FFFFFF; --hover: #F1F4F8; --text: #17202A; --muted: #526071; --link: #2457C5; --focus: #2457C5; --line: #DCE2E9;
  --ok: #17663F; --ok-bg: #EAF5EE; --move: #2457A7; --move-bg: #EDF3FF; --held: #815600; --held-bg: #FFF4D6; --none: #526071; --none-bg: #EEF1F5;
  --slow: #A52B32; --approx: #7B8796; --flake: #4A78CF; --bolt: #FFD23F; --bolt-edge: #B87A00; }
@media (prefers-color-scheme: dark) { :root {
  --page: #10151D; --surface: #151B24; --hover: #1D2632; --text: #E8EDF4; --muted: #AAB6C7; --link: #9BBDFF; --focus: #9BBDFF; --line: #303B49;
  --ok: #88D9A6; --ok-bg: #172E23; --move: #A5C5FF; --move-bg: #1C2B43; --held: #F1CC75; --held-bg: #352B16; --none: #B7C2D1; --none-bg: #252E3A;
  --slow: #FFADB4; --approx: #69788D; --flake: #8FB2EE; --bolt-edge: #7A5200; } }
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
.latest { margin-top: .5rem; font-size: .875rem; line-height: 1.25rem; color: var(--muted); overflow-wrap: anywhere; }
.latest strong { color: var(--text); font-weight: 500; }
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
/* The bolt (the end of SCRIPT): lightning drawn over the On main column,
   clipped to it, onto each version changed since the reader last saw it; the
   version flashes and keeps a small bolt for as long as the page is open. */
.zap { position: absolute; pointer-events: none; overflow: visible; z-index: 20; }
.zap path, .zap line { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.zap .edge { stroke: var(--bolt-edge); stroke-width: 5; }
.zap .glow { stroke: var(--bolt); stroke-width: 11; filter: url(#mark-blur); opacity: .75; }
.zap .main { stroke: var(--bolt); stroke-width: 3; }
.zap .core { stroke: #FFFFFF; stroke-width: 1.2; }
.zap .spark { stroke: var(--bolt); stroke-width: 2; }
.zap .halo { fill: var(--bolt); filter: url(#mark-blur); }
.zapped .ver { animation: zap-text 1.4s cubic-bezier(.2, .8, .3, 1); }
@keyframes zap-text {
  0% { text-shadow: 0 0 2px #FFFFFF, 0 0 10px var(--bolt), 0 0 22px var(--bolt); transform: translateX(0); }
  4% { transform: translateX(-2px); } 8% { transform: translateX(2px); } 12% { transform: translateX(-1px); } 16% { transform: translateX(0); }
  100% { text-shadow: 0 0 0 transparent; } }
.zap-tag { display: inline-flex; vertical-align: -2px; margin-left: .375rem; width: .875rem; height: .875rem; }
.zap-tag svg { width: 100%; height: 100%; overflow: visible; }
.zap-tag path { fill: var(--bolt); stroke: var(--bolt-edge); stroke-width: 6; stroke-linejoin: round; paint-order: stroke; }
.zap-tag.pop { animation: zap-pop .55s cubic-bezier(.3, 1.8, .5, 1) both; }
@keyframes zap-pop { 0% { transform: scale(0) rotate(-25deg); opacity: 0; } 100% { transform: scale(1) rotate(0); opacity: 1; } }
.dlv { display: flex; align-items: center; gap: .375rem; white-space: nowrap; }
/* A chip may wrap rather than spill into the next column. */
.dlv .reason { white-space: normal; }
.none-text { color: var(--muted); }
.band-mark { width: 6px; height: 16px; flex: none; }
.strip { display: block; overflow: visible; }
.strip .hit { fill: transparent; }
/* The bar under the pointer grows, springing up from its base. */
.strip g > :not(.hit) { transform-box: fill-box; transform-origin: 50% 100%; transition: transform .2s cubic-bezier(.3, 1.8, .5, 1), filter .2s; }
.strip g.on > :not(.hit) { transform: scale(1.5, 1.35); filter: drop-shadow(0 1px 2px rgb(0 0 0 / .35)); }
.tip { position: fixed; left: 0; top: 0; z-index: 10; pointer-events: none; min-width: 13rem; max-width: min(21rem, calc(100vw - 1rem)); padding: .625rem .75rem;
  background: var(--surface); color: var(--text); border: 1px solid var(--line); border-radius: .625rem; box-shadow: 0 10px 28px rgb(0 0 0 / .22), 0 2px 6px rgb(0 0 0 / .1);
  font-size: .8125rem; line-height: 1.4; visibility: hidden; opacity: 0; transform: translateY(6px) scale(.94); transform-origin: var(--ax, 50%) 100%;
  transition: opacity .14s, transform .22s cubic-bezier(.3, 1.6, .5, 1), visibility 0s .14s; }
.tip.below { transform: translateY(-6px) scale(.94); transform-origin: var(--ax, 50%) 0; }
.tip.show { visibility: visible; opacity: 1; transform: none; transition: opacity .14s, transform .22s cubic-bezier(.3, 1.6, .5, 1), visibility 0s; }
.tip.show.glide { transition: opacity .14s, transform .22s cubic-bezier(.3, 1.6, .5, 1), visibility 0s, left .14s ease-out, top .14s ease-out; }
.tip::after { content: ""; position: absolute; left: var(--ax, 50%); bottom: -6px; width: 10px; height: 10px; margin-left: -5px; background: var(--surface);
  border: solid var(--line); border-width: 0 1px 1px 0; transform: rotate(45deg); }
.tip.below::after { bottom: auto; top: -6px; border-width: 1px 0 0 1px; }
.tip-head { display: flex; align-items: center; gap: .5rem; }
.tip-v { font: 600 .8125rem/1.3 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; overflow-wrap: anywhere; }
.tip-tag { margin-left: auto; flex: none; padding: 0 .4rem; border-radius: 999px; background: var(--move-bg); color: var(--move); font-size: .6875rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; }
.tip-d { display: flex; align-items: baseline; gap: .375rem; margin-top: .375rem; }
.tip-d strong { font-size: 1.0625rem; }
.tip-note, .tip-t { color: var(--muted); }
.tip-dot { width: .625rem; height: .625rem; flex: none; align-self: center; border-radius: 2px; }
.tip-dot.good { background: var(--ok); } .tip-dot.fair { background: var(--held); } .tip-dot.slow { background: var(--slow); }
.tip-dot.approx { background: repeating-linear-gradient(45deg, var(--approx) 0 1px, transparent 1px 3px); border: 1px solid var(--approx); } .tip-dot.none { border: 1.5px solid var(--approx); border-radius: 50%; }
.tip-t { margin-top: .125rem; font-size: .75rem; }

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
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } .zapped .ver, .zap-tag.pop { animation: none; } }
@media (forced-colors: active) {
  .st { color: CanvasText; }
  .b-good, .b-fair, .b-slow { fill: CanvasText; }
  .b-approx { stroke: CanvasText; } .hatch-line { fill: CanvasText; } .hatch-bg { fill: Canvas; }
  .b-none { stroke: CanvasText; }
  .mark .flake path { stroke: CanvasText; } .mark .bolt { fill: CanvasText; stroke: Canvas; } .mark .strike, .mark .glow, .mark .energy { display: none; }
  .zap { display: none; } .zap-tag path { fill: CanvasText; stroke: Canvas; }
}
`;

// ---- Script ------------------------------------------------------------

// Nothing changes by itself while someone is in the window, except the
// out-of-date switch turning on, a reload for newer data and the bolt (at
// the end of the script, with its own comment). "Nobody in the
// window": the tab hidden, or the window unfocused for 2 minutes (a moment
// in the find bar doesn't count). Then, once a minute, the relative times
// are redrawn with the newest check time, and once more when someone comes
// back. Checks of the site's tiny live.json, only while the tab is
// visible: on start, on becoming visible, and once a minute (not within
// 30 s of the last); one at a time, aborted after 15 s. The same id: only
// the check time is taken. Another id: a reload at once (an answer that
// arrives while the tab is hidden waits for the check on becoming
// visible). Each id gets at most 3 reloads in an hour, 10 minutes apart: a
// cache that still serves the old page gets another chance, and data that
// comes back to an earlier id later is reloaded for again. Times are
// compared either way round, so a clock set back can't stop checks or
// tries. The tab remembers its tries, and its own id as
// one; if storage can't be trusted, it never reloads by itself.
const SOURCE = `// Told whether the page is current (see the bolt, below): true after a
// check of live.json that started since the tab last came back and didn't
// reload, false when it reloads.
let pageState = () => {};
(() => {
  const d = document, id = d.documentElement.dataset.id;
  const $ = (q) => d.querySelector(q), all = (q) => d.querySelectorAll(q);
  const IDS = "t3code-nix-reloaded";
  // Storage that can't be read or written, or doesn't keep what it was
  // given, turns the automatic reload off for this tab.
  let broken = false;
  const get = () => { try { return sessionStorage.getItem(IDS); } catch { broken = true; return null; } };
  const remembered = () => { try { const a = JSON.parse(get() || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
  // Tries are "<id>@<ms>"; a bare "<id>" (an older page's) is a try long
  // ago, so aged out.
  const tries = (x) => remembered().filter((e) => typeof e === "string" && (e === x || e.startsWith(x + "@")))
    .map((e) => Number(e.slice(x.length + 1)) || 0);
  const remember = (x) => {
    const e = x + "@" + Date.now();
    try { sessionStorage.setItem(IDS, JSON.stringify([...remembered(), e].slice(-20))); } catch { broken = true; }
    if (!remembered().includes(e)) broken = true;
  };
  const f = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  const units = [["year", 31536e3], ["month", 2592e3], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  // returns: how often the tab has come back, so a check that started
  // before can't say the page is current; leaving: a reload has started,
  // and no check after that says the page is current.
  let skew = 0, busy = false, lastCheck = 0, stale = false, first = true, returns = 0, leaving = false;
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
  const utc = (iso) => {
    const t = new Date(iso), two = (n) => String(n).padStart(2, "0");
    const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return t.getUTCDate() + " " + M[t.getUTCMonth()] + " " + t.getUTCFullYear() + ", " + two(t.getUTCHours()) + ":" + two(t.getUTCMinutes()) + " UTC";
  };
  // Exact times in the reader's own time zone, in the page's English: the
  // date as the page writes it, the clock as the reader's English locale
  // writes it, or else British English with the reader's 12- or 24-hour
  // clock ("13 Nov 2026, 3:50 PM EST", "13 Nov 2026, 17:50 CET"). Without
  // Intl, UTC as the page was built.
  const local = (() => {
    try {
      const own = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions();
      const english = /^en(-|$)/i.test(own.locale);
      const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "numeric", year: "numeric" });
      const clock = new Intl.DateTimeFormat(english ? own.locale : "en-GB",
        { hour: "numeric", minute: "2-digit", timeZoneName: "short", ...(english || !own.hourCycle ? {} : { hourCycle: own.hourCycle }) });
      const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const f = (iso) => {
        const t = new Date(iso), p = {};
        for (const x of date.formatToParts(t)) p[x.type] = x.value;
        return Number(p.day) + " " + M[Number(p.month) - 1] + " " + p.year + ", " + clock.format(t);
      };
      f(new Date(0).toISOString());
      return f;
    } catch { return null; }
  })();
  const exact = local || utc;
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
  const since = (t) => Math.abs(Date.now() - t);
  const reload = (x) => {
    const t = tries(x).filter((at) => since(at) < 3600e3);
    if (broken || t.length >= 3 || t.some((at) => since(at) < 10 * 60e3)) return;
    remember(x);
    if (broken) return;
    leaving = true;
    pageState(false);
    location.reload();
  };
  const check = async () => {
    if (busy) return;
    busy = true;
    lastCheck = Date.now();
    const back = returns;
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
      } else if (!d.hidden) reload(data.id);
    } catch {} finally {
      if (timer) clearTimeout(timer);
      busy = false;
      // The first check, part of loading the page, and the check on coming
      // back to the tab (it may have been frozen for hours) draw everything,
      // with the clock the Date header corrected.
      if (first) { first = false; redraw(); } else settle();
      // Not reloading: as current as it can be, for now. Unless the tab came
      // back while this was out, which skipped the return's own check: that
      // check runs now, and draws everything as a return's check does.
      if (!leaving && !d.hidden) { if (back === returns) pageState(true); else { first = true; check(); } }
    }
  };
  // Once, on start: every exact time, and the exact time each relative one
  // shows on hover, in the reader's zone.
  if (local) {
    for (const t of all("time:not(.rel)")) setText(t, exact(t.dateTime));
    for (const t of all("time.rel")) t.title = exact(t.dateTime);
  }
  // The strip's card: the bar under the pointer (or tapped) grows, and a
  // card over it shows that delivery; moving along the strip slides the
  // card from bar to bar. A tap elsewhere, a scroll, a resize or Escape
  // closes it. The details list has the same, for keyboards and screen
  // readers.
  const tip = $("#tip");
  if (tip) {
    let on = null;
    const add = (tag, cls, parent, text) => {
      const e = d.createElement(tag);
      e.className = cls;
      if (text) e.textContent = text;
      parent.appendChild(e);
      return e;
    };
    const barOf = (t) => (t && t.closest ? t.closest(".strip g[data-at]") : null);
    const hide = () => {
      if (on) on.classList.remove("on");
      on = null;
      tip.classList.remove("show");
    };
    const show = (g) => {
      if (g === on) return;
      if (on) on.classList.remove("on");
      on = g;
      g.classList.add("on");
      const at = g.getAttribute("data-at");
      tip.textContent = "";
      const head = add("div", "tip-head", tip);
      add("span", "tip-v", head, g.getAttribute("data-v"));
      if (g === g.parentNode.lastElementChild) add("span", "tip-tag", head, "Latest");
      const took = add("div", "tip-d", tip);
      add("span", "tip-dot " + g.getAttribute("data-band"), took);
      add("strong", "", took, g.getAttribute("data-d"));
      add("span", "tip-note", took, g.getAttribute("data-note"));
      add("div", "tip-t", tip, "Published " + ago(at) + " \u00b7 " + exact(at));
      // Over the bar, or under it when there's no room; inside the window.
      // It glides only from another bar, never in from where it last was.
      tip.classList.toggle("glide", tip.classList.contains("show"));
      const b = g.querySelector(".hit").getBoundingClientRect();
      const w = tip.offsetWidth, h = tip.offsetHeight, vw = d.documentElement.clientWidth;
      const cx = b.left + b.width / 2, left = Math.min(Math.max(8, cx - w / 2), vw - w - 8);
      const below = b.top - h - 12 < 8;
      tip.classList.toggle("below", below);
      tip.style.left = left + "px";
      tip.style.top = (below ? b.bottom + 12 : b.top - h - 12) + "px";
      tip.style.setProperty("--ax", cx - left + "px");
      tip.classList.add("show");
    };
    d.addEventListener("pointerover", (e) => { const g = barOf(e.target); if (g) show(g); });
    // A mouse leaving the bar closes the card, unless it went to another
    // bar; a touch keeps it open until the next tap.
    d.addEventListener("pointerout", (e) => {
      if (on && e.pointerType !== "touch" && barOf(e.target) === on && !barOf(e.relatedTarget)) hide();
    });
    d.addEventListener("pointerdown", (e) => { if (!barOf(e.target)) hide(); });
    d.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
    addEventListener("scroll", hide, { passive: true });
    addEventListener("resize", hide);
  }
  // This page's own id counts as a try.
  if (id && !tries(id).length) remember(id);
  addEventListener("blur", () => { blurredAt = Date.now(); });
  addEventListener("focus", () => {
    const back = blurredAt !== null && Date.now() - blurredAt >= 120e3;
    blurredAt = null;
    if (back) redraw();
  });
  d.addEventListener("visibilitychange", () => {
    if (d.hidden) return;
    returns++;
    redraw();
    first = true;
    check();
  });
  redraw();
  if (!d.hidden) check();
  setInterval(() => {
    // A check settles when it ends; without one (or with one still out),
    // settle now. (After a sleep, settling before the check would show
    // "Out of date" for data the check is about to refresh.)
    if (!busy && !d.hidden && since(lastCheck) >= 30e3) check(); else settle();
  }, 60e3);
})();
// The bolt: versions changed since this reader last saw them. Each row
// carries its version (data-v). The tab keeps the versions it has shown
// in sessionStorage, the browser the newest any tab has shown in
// localStorage; a page compares with the tab's own, else the browser's.
// A row that didn't change (or is new to the page) is remembered at once;
// a changed one gets the small bolt at once, and is remembered only when
// it has been seen (fully in view, the tab visible and the page current),
// and then gets its strike. So a reload before the reader scrolls to it, or
// a tab that loads hidden, loses nothing, and a tab never strikes the same
// version twice. The strike: from the On main heading onto the first
// version in view, then chain lightning down the column to the others in
// view in the same card, clipped to the column (on narrow screens, where
// the layout hides the heading, sparks on each version alone). No bolt at all on a
// first visit or when storage can't be read. Reduced motion, forced
// colours or no Web Animations: the small bolt, no strike. No
// IntersectionObserver: the small bolt, remembered at once.
(() => {
  const d = document, KEY = "t3code-nix-seen";
  const rows = Array.from(d.querySelectorAll(".pkg[data-v]"));
  if (!rows.length) return;
  const name = (r) => r.id.slice(4);
  let stores;
  try { stores = [sessionStorage, localStorage]; } catch { return; }
  const read = (s) => { try { const m = JSON.parse(s.getItem(KEY) || "null"); return m && typeof m === "object" && !Array.isArray(m) ? m : null; } catch { return null; } };
  const base = read(stores[0]) || read(stores[1]);
  const remember = (list) => {
    for (const s of stores) {
      try {
        const m = read(s) || Object.assign({}, base);
        for (const r of list) m[name(r)] = r.dataset.v;
        s.setItem(KEY, JSON.stringify(m));
      } catch {}
    }
  };
  const fresh = base ? rows.filter((r) => typeof base[name(r)] === "string" && base[name(r)] !== r.dataset.v) : [];
  remember(rows.filter((r) => !fresh.includes(r)));
  if (!fresh.length) return;
  // The SVG namespace, from the mark: SOURCE has no "//" in a string (see
  // minifyJs), and the namespace's URL would be one.
  const NS = d.querySelector(".mark").namespaceURI;
  const el = (n, a, p) => { const e = d.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  const cell = (r) => r.querySelector(".cell.ver");
  const media = (q) => typeof matchMedia === "function" && matchMedia(q).matches;
  const still = () => media("(prefers-reduced-motion: reduce)") || media("(forced-colors: active)") || typeof d.body.animate !== "function";
  // The small bolt, said as "changed since your last visit".
  for (const r of fresh) {
    const tag = d.createElement("span");
    tag.className = "zap-tag";
    tag.title = "Changed since your last visit";
    el("path", { d: "M62 6 35 53H50L40 94 68 44H53Z" }, el("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" }, tag));
    const sr = tag.appendChild(d.createElement("span"));
    sr.className = "sr";
    sr.textContent = ", changed since your last visit";
    cell(r).appendChild(tag);
  }
  if (typeof IntersectionObserver !== "function") return remember(fresh);
  // A jagged line from a to b (midpoint displacement), kept between x0 and x1.
  const jag = (a, b, rough, x0, x1) => {
    let pts = [a, b], w = rough;
    for (let i = 0; i < 5; i++, w *= .55) {
      const out = [pts[0]];
      for (let j = 1; j < pts.length; j++) {
        const p = pts[j - 1], q = pts[j], dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1, o = (Math.random() - .5) * w;
        out.push([(p[0] + q[0]) / 2 - dy / len * o, (p[1] + q[1]) / 2 + dx / len * o], q);
      }
      pts = out;
    }
    return pts.map((p) => [Math.min(x1 - 4, Math.max(x0 + 4, p[0])), p[1]]);
  };
  const path = (pts) => "M" + pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L");
  const play = (e, k, o) => e.animate(k, Object.assign({ fill: "forwards" }, o));
  // One bolt in layer g, drawn in and flickering out; returns when it lands.
  const bolt = (g, a, b, box, o) => {
    const sub = el("g", { opacity: o.alpha }, g), dd = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const pts = jag(a, b, Math.min(o.rough * dd, (box.r - box.l) * .55), box.l, box.r), lines = [];
    const draw = (pp, thin) => ["edge", "glow", "main", "core"].map((c) => {
      const p = el("path", { class: c, d: path(pp) }, sub);
      if (thin) p.style.strokeWidth = "calc(" + getComputedStyle(p).strokeWidth + " * .55)";
      return p;
    });
    lines.push(...draw(pts, false));
    for (let i = 0; i < o.branches; i++) {
      const at = pts[Math.floor(pts.length * (.3 + Math.random() * .4))];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + (Math.random() < .5 ? -1 : 1) * (.45 + Math.random() * .5);
      const len = dd * (.18 + Math.random() * .22);
      lines.push(...draw(jag(at, [at[0] + Math.cos(ang) * len, at[1] + Math.sin(ang) * len], len * .5, box.l, box.r), true));
    }
    for (const p of lines) {
      const L = p.getTotalLength();
      p.style.strokeDasharray = L;
      p.style.strokeDashoffset = L;
      play(p, [{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: 90, delay: o.delay, easing: "ease-in" });
    }
    play(sub, [{ opacity: o.alpha }, { opacity: o.alpha, offset: .2 }, { opacity: .2, offset: .3 }, { opacity: o.alpha, offset: .4 }, { opacity: .5, offset: .65 }, { opacity: 0 }], { duration: 520, delay: o.delay + 90 });
    return o.delay + 90;
  };
  // Where a bolt lands: on top of the version, a little way in.
  const spot = (r) => {
    const c = cell(r), lbl = c.querySelector(".lbl"), range = d.createRange();
    range.setStart(c, lbl ? Array.prototype.indexOf.call(c.childNodes, lbl) + 1 : 0);
    range.setEnd(c, c.childNodes.length);
    const b = range.getClientRects()[0] || c.getBoundingClientRect();
    return [b.left + Math.min(b.width * .4, 22), b.top + 3];
  };
  // Where a strike lands: sparks and a halo, the version flashing and its
  // small bolt popping.
  const land = (r, g, p) => {
    const halo = el("circle", { class: "halo", cx: p[0], cy: p[1], r: 4 }, g);
    play(halo, [{ r: 4, opacity: .95 }, { r: 26, opacity: 0 }], { duration: 420, easing: "ease-out" });
    for (let i = 0; i < 8; i++) {
      const a = Math.PI * i / 4 + Math.random() * .5, far = 12 + Math.random() * 14;
      const s = el("line", { class: "spark", x1: p[0] + Math.cos(a) * 4, y1: p[1] + Math.sin(a) * 4, x2: p[0] + Math.cos(a) * 9, y2: p[1] + Math.sin(a) * 9 }, g);
      play(s, [{ transform: "translate(0,0)", opacity: 1 }, { transform: "translate(" + Math.cos(a) * far + "px," + (Math.sin(a) * far + 6) + "px)", opacity: 0 }], { duration: 380 + Math.random() * 200, easing: "cubic-bezier(.1,.7,.3,1)" });
    }
    r.classList.add("zapped");
    cell(r).querySelector(".zap-tag").classList.add("pop");
  };
  // One layer per strike over the window as it is, scrolling with the page,
  // clipped to the column (or the version). clientWidth leaves out
  // a scrollbar, so the layer never widens the page.
  const layer = (box) => {
    const w = d.documentElement.clientWidth, h = d.documentElement.clientHeight;
    const g = el("svg", { class: "zap", "aria-hidden": "true", viewBox: "0 0 " + w + " " + h }, d.body);
    const px = (n) => Math.max(0, n) + "px";
    Object.assign(g.style, { left: scrollX + "px", top: scrollY + "px", width: w + "px", height: h + "px",
      clipPath: "inset(" + px(box.t) + " " + px(w - box.r) + " " + px(h - box.b) + " " + px(box.l) + ")" });
    return g;
  };
  // The rows of one card that came into view together, top to bottom: a
  // chain down the column from its heading, or on narrow screens (where
  // the layout hides the heading) the landing alone on each version, one
  // after another.
  const strike = (group) => {
    const card = group[0].closest(".card"), head = card.querySelector(".col-ver");
    const hop = group.length > 5 ? 110 : 170;
    if (!head || !head.getClientRects().length) {
      group.forEach((r, i) => {
        setTimeout(() => {
          const vb = cell(r).getBoundingClientRect(), g = layer({ l: vb.left - 8, r: vb.right, t: vb.top - 8, b: vb.bottom + 8 });
          land(r, g, spot(r));
          setTimeout(() => g.remove(), 1200);
        }, i * hop);
      });
      return;
    }
    const hb = head.getBoundingClientRect(), box = { l: hb.left - 8, r: hb.right, t: hb.bottom + 2, b: card.getBoundingClientRect().bottom };
    const g = layer(box);
    let t = 0, last = null;
    group.forEach((r, i) => {
      const p = spot(r);
      const from = last || [(box.l + box.r) / 2 + (Math.random() - .5) * (box.r - box.l) * .3, box.t];
      t = bolt(g, from, p, box, { rough: last ? .5 : .35, alpha: last ? .85 : 1, delay: i ? t + hop - 90 : 0, branches: last ? 1 : 3 });
      setTimeout(() => land(r, g, p), t);
      last = p;
    });
    setTimeout(() => g.remove(), t + 1200);
  };
  // Each changed version once it is fully in view, with the tab visible
  // and the page current (pageState): the gate opens with the first check
  // of live.json that says so, and again with the first after the tab
  // comes back, and each time it opens it looks afresh at those it hasn't
  // struck. Hidden, or once a reload has started, it waits. So a page that
  // is reloading for newer data starts no strike and remembers nothing.
  const waiting = new Set(fresh);
  let current = false;
  d.addEventListener("visibilitychange", () => { if (d.hidden) current = false; });
  const io = new IntersectionObserver((es) => {
    if (d.hidden || !current) return;
    const full = new Map();
    for (const e of es) full.set(e.target, e.isIntersecting && e.intersectionRatio >= .99);
    const now = fresh.filter((r) => waiting.has(r) && full.get(cell(r)));
    const cards = new Map();
    for (const r of now) {
      waiting.delete(r);
      io.unobserve(cell(r));
      const c = r.closest(".card");
      cards.set(c, (cards.get(c) || []).concat(r));
    }
    if (!now.length) return;
    // Seen now, so remembered now; the strike that follows only shows it.
    remember(now);
    if (!still()) cards.forEach(strike);
  }, { threshold: [0, .99] });
  pageState = (on) => {
    if (on === current) return;
    current = on;
    if (!on) return;
    // Opening: reports queued while it was shut may be out of date, so
    // they're dropped, and a fresh one asked for.
    io.takeRecords();
    for (const r of waiting) { io.unobserve(cell(r)); io.observe(cell(r)); }
  };
})();`;
/** The script as the page carries it (minifyJs). */
export const SCRIPT = minifyJs(SOURCE);
/** The script's hash, for the Content-Security-Policy. */
export const SCRIPT_HASH = `sha256-${createHash("sha256").update(SCRIPT).digest("base64")}`;
