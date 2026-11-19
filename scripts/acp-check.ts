// ACP registry runtimes, in the Nix sandbox (lib/checks.nix, acp-runtimes):
// does t3code find the runner an npm or uv agent needs on a wrapped t3's
// PATH?
//
//   node acp-check.ts T3 NPM UV
//
// Starts `t3 serve` in a throwaway home with a one-agent-each registry in
// t3code's registry cache (it reads the cache before fetching, so nothing is
// fetched) and two agents configured, one npm and one uv. NPM and UV are the
// runner each agent must use: a path, which the status must name (t3code
// tries to install the agent with it; offline that fails, and nothing is
// downloaded), or "-", for "not available on this environment's PATH". The
// server gets a PATH of coreutils only and no login shell, so the runners
// it finds come from the wrapper.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, stopGroup } from "./lib/proc.ts";

const DEADLINE_MS = 120_000;
export const AGENTS = {
  npm: { id: "t3code-nix-npm", distribution: { npx: { package: "t3code-nix-acp@1.0.0", args: ["--acp"] } } },
  uv: { id: "t3code-nix-uv", distribution: { uvx: { package: "t3code-nix-acp==1.0.0", args: [] } } },
};

/** Is the agent's status settled, and does it say what we expect? */
export function verdict(status: any, runner: string, want: string): "pending" | "ok" | string {
  const message: string = status?.message ?? "";
  if (!status?.status || /checking|not been checked/i.test(message)) return "pending";
  if (want === "-") {
    return message.includes(`ACP executable '${runner}' is not available on this environment's PATH.`) ? "ok" : `expected no ${runner}: ${message}`;
  }
  return message.includes(want) ? "ok" : `expected ${want}: ${message}`;
}

async function main(t3: string, npm: string, uv: string, coreutils: string): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "acp-check-"));
  const state = join(base, "state");
  try {
    mkdirSync(join(state, "userdata"), { recursive: true });
    mkdirSync(join(state, "caches", "acp-registry"), { recursive: true });
    const agents = Object.values(AGENTS).map((a) => ({ ...a, name: a.id, version: "1.0.0", description: "t3code-nix's check" }));
    writeFileSync(join(state, "caches", "acp-registry", "registry.json"), JSON.stringify({ version: "1.0.0", agents }));
    const instance = (agentId: string) => ({ driver: "acpRegistry", enabled: true, config: { agentId } });
    writeFileSync(join(state, "userdata", "settings.json"), JSON.stringify({
      providerInstances: { npmagent: instance(AGENTS.npm.id), uvagent: instance(AGENTS.uv.id) },
    }));
    // Offline, so the install attempt fails at once (naming the runner it
    // used) instead of retrying the network until t3code gives up.
    const env = { PATH: coreutils, HOME: base, TMPDIR: base, SHELL: "/nonexistent", XDG_CACHE_HOME: join(base, ".cache"),
      XDG_CONFIG_HOME: join(base, ".config"), npm_config_offline: "true", UV_OFFLINE: "1" };
    const port = await freePort();
    const log = openSync(join(base, "server.log"), "w+");
    const server = spawn(t3, ["serve", "--base-dir", state, "--host", "127.0.0.1", "--port", String(port)],
      { env, cwd: base, stdio: ["ignore", log, log], detached: true });
    const closed = new Promise<void>((resolve) => server.on("close", () => resolve()));
    const want = { npmagent: ["npm", npm], uvagent: ["uv", uv] } as const;
    const results: Record<string, string> = {};
    try {
      const deadline = Date.now() + DEADLINE_MS;
      while (Date.now() < deadline) {
        for (const [name, [runner, expect]] of Object.entries(want)) {
          const file = join(state, "caches", `${name}.json`);
          let status: any = null;
          try { status = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; } catch { /* being written */ }
          results[name] = verdict(status, runner, expect);
        }
        if (Object.values(results).every((r) => r !== "pending")) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      await stopGroup(server.pid);
      await closed;
      closeSync(log);
    }
    const failures = Object.entries(results).filter(([, r]) => r !== "ok").map(([n, r]) => `${n}: ${r === "pending" ? "never settled" : r}`);
    for (const [n, r] of Object.entries(results)) console.log(`${n}: ${r}`);
    if (failures.length) {
      process.stderr.write(readFileSync(join(base, "server.log"), "utf8").slice(-3000));
      throw new Error(failures.join("; "));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [t3, npm, uv, coreutils] = process.argv.slice(2);
  try {
    if (!t3 || !npm || !uv || !coreutils) throw new Error("usage: acp-check.ts T3 NPM|- UV|- COREUTILS_BIN");
    await main(t3, npm, uv, coreutils);
  } catch (e: any) {
    console.error(`acp-check: ${e.message}`);
    process.exit(1);
  }
}
