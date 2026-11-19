// Drive the packaged agent-browser against a page served on loopback, in a
// throwaway home: `open`, `snapshot` finds the button by its ref, `click`
// changes the page's title, `screenshot` writes a PNG, `close`. The browser
// is the wrapper's default (one of the browser pins).
//
//   node agent-browser-smoke.ts PACKAGE
//
// Runs on real machines and CI runners, not in the Nix sandbox (Chromium
// needs user namespaces there, and the wrapper never passes --no-sandbox).
// Google's release feed check is turned off for the run, so nothing but
// loopback is needed.
//
// With `expect` (agentBrowserProblems), it also checks the browser is the one
// asked for: its brands (`Google Chrome` for Chrome, only `Chromium` for
// both Chromiums), its full version, and Widevine where it's required.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE = `<!doctype html><title>before</title><button onclick="document.title='after'">Press me</button>`;

/** What the running browser must be: "chrome" or "chromium" by brand, its
 * full version (null: not checked), and whether Widevine must be there. */
export interface Expect { brand: "chrome" | "chromium"; version: string | null; widevine: boolean }

// Brands, the full version and Widevine, from the page (one eval, JSON).
const PROBE = `(async () => { let widevine = false; try { await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{ initDataTypes: ["cenc"],
  videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: "SW_SECURE_CRYPTO" }] }]); widevine = true; } catch {}
  const v = await navigator.userAgentData.getHighEntropyValues(["fullVersionList"]);
  return JSON.stringify({ brands: navigator.userAgentData.brands.map((b) => b.brand), full: v.fullVersionList, widevine }); })()`;

/** The problems an `eval` of PROBE shows against `expect`. */
export function probeProblems(out: string, expect: Expect): string[] {
  let doc: any;
  try {
    // agent-browser prints the result as a JSON string.
    doc = JSON.parse(JSON.parse(out.trim().split("\n").filter(Boolean).pop() ?? ""));
  } catch {
    return [`couldn't read the browser's brands: ${out.slice(-300)}`];
  }
  const problems: string[] = [];
  const brands: string[] = Array.isArray(doc?.brands) ? doc.brands : [];
  const chrome = brands.includes("Google Chrome");
  if (expect.brand === "chrome" && !chrome) problems.push(`not Google Chrome (brands: ${brands.join(", ")})`);
  if (expect.brand === "chromium" && (chrome || !brands.includes("Chromium"))) problems.push(`not Chromium (brands: ${brands.join(", ")})`);
  const name = expect.brand === "chrome" ? "Google Chrome" : "Chromium";
  const full = (Array.isArray(doc?.full) ? doc.full : []).find((b: any) => b?.brand === name)?.version;
  if (expect.version !== null && full !== expect.version) problems.push(`${name} ${full ?? "(no version)"}, not ${expect.version}`);
  if (expect.widevine && doc?.widevine !== true) problems.push("widevine: Widevine isn't available");
  return problems;
}

export async function agentBrowserSmoke(pkg: string): Promise<boolean> {
  return (await agentBrowserProblems(pkg)).length === 0;
}

/** The smoke's problems (none: it passed), with `expect` checked too. */
export async function agentBrowserProblems(pkg: string, expect: Expect | null = null): Promise<string[]> {
  return (await agentBrowserRun(pkg, expect)).problems;
}

/** The same, and whether a command ran out of time (then the problems
 * prove nothing about the browser). */
export async function agentBrowserRun(pkg: string, expect: Expect | null = null): Promise<{ problems: string[]; timedOut: boolean }> {
  let timedOut = false;
  const home = mkdtempSync(join(tmpdir(), "agent-browser-smoke-"));
  const server = createServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    AGENT_BROWSER_NO_VERSION_CHECK: "1" };
  // Asynchronous: the page is served from this process, so it must keep
  // answering while agent-browser runs.
  const ab = (...args: string[]) => new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(join(pkg, "bin", "agent-browser"), args, { env, cwd: home, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
        if ((error as any)?.killed) timedOut = true;
        resolve({ ok: !error, out: `${stdout ?? ""}${stderr ?? ""}` });
      }));
  const problems: string[] = [];
  try {
    const open = await ab("open", url);
    if (!open.ok) problems.push(`open: ${open.out.slice(-500)}`);
    const snap = await ab("snapshot");
    const ref = /button "Press me" \[ref=(e\d+)\]/.exec(snap.out)?.[1];
    if (!ref) problems.push(`snapshot: no ref for the button in ${snap.out.slice(-500)}`);
    else {
      const click = await ab("click", `@${ref}`);
      if (!click.ok) problems.push(`click: ${click.out.slice(-500)}`);
      const title = await ab("get", "title");
      if (!/\bafter\b/.test(title.out)) problems.push(`the click didn't change the title: ${title.out.slice(-200)}`);
    }
    if (expect) problems.push(...probeProblems((await ab("eval", PROBE)).out, expect));
    const shot = join(home, "shot.png");
    await ab("screenshot", shot);
    if (!existsSync(shot) || !readFileSync(shot).subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) problems.push("screenshot: no PNG written");
  } finally {
    // The whole sequence ends with close; a second try before giving up.
    if (!(await ab("close")).ok) {
      const again = await ab("close");
      if (!again.ok) problems.push(`close: ${again.out.slice(-500)}`);
    }
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
  for (const p of problems) console.error(`agent-browser-smoke (${pkg}): ${p}`);
  if (!problems.length) console.log(`agent-browser-smoke (${pkg}): open, snapshot, click, screenshot and close worked`);
  return { problems, timedOut };
}

if (import.meta.main) {
  const [pkg] = process.argv.slice(2);
  if (!pkg) {
    console.error("usage: agent-browser-smoke.ts PACKAGE");
    process.exit(2);
  }
  process.exit((await agentBrowserSmoke(pkg)) ? 0 : 1);
}
