// What each pinned package is, for people: the status page's names and
// descriptions. Each provider's and agent tool's row in the README's
// Packages table starts with the same "Title: description" (the browser
// pins, not packages, are only named under it), and UNFREE
// matches the providers in pkgs/unfree.nix (tests/status.test.ts checks
// both).

/** T3 Code's own packages: the app and the CLI, each on the latest and the nightly channel. */
export const T3: { title: string; description: string; channels: [string, string][] }[] = [
  { title: "Desktop app", description: "T3 Code's desktop app", channels: [["Latest", "t3code"], ["Nightly", "t3code-nightly"]] },
  { title: "CLI and server", description: "T3 Code's headless CLI and server", channels: [["Latest", "t3"], ["Nightly", "t3-nightly"]] },
];

/** The providers, by package name (the page lists them alphabetically by title). */
export const PROVIDERS: Record<string, { title: string; description: string }> = {
  codex: { title: "Codex", description: "OpenAI's coding agent" },
  "claude-code": { title: "Claude Code", description: "Anthropic's coding agent" },
  "cursor-agent": { title: "Cursor Agent", description: "Cursor's coding agent" },
  grok: { title: "Grok Build", description: "xAI's coding agent" },
  fx: { title: "fx", description: "Vercel's native coding agent" },
  opencode: { title: "OpenCode", description: "an open-source coding agent built for the terminal" },
  antigravity: { title: "Antigravity", description: "Google Antigravity's CLI, `agy`" },
  "kiro-cli": { title: "Kiro CLI", description: "Kiro's coding agent for the terminal" },
  muse: { title: "Muse Code", description: "Meta's coding agent" },
  pi: { title: "pi", description: "a minimal terminal coding agent" },
};

/** The unfree providers (pkgs/unfree.nix, less the preview browser). */
export const UNFREE = new Set(["antigravity", "claude-code", "cursor-agent", "grok", "kiro-cli", "muse"]);

/** The agent tools (tools the agents use themselves; never part of T3
 * Code); the page lists them after the providers, alphabetically by title. */
export const AGENT_TOOLS: Record<string, { title: string; description: string }> = {
  boat: { title: "boat", description: "boat.dev's cloud sandboxes from the command line" },
  "agent-browser": { title: "agent-browser", description: "Vercel's headless browser CLI for agents" },
};

/** agent-browser's browser pins, listed under it (not packages of their
 * own: a nixpkgs revision each, shown by its three browsers' versions and
 * its channel). */
export const BROWSER_PINS: Record<string, { title: string; description: string }> = {
  "browser-unstable": { title: "Browsers (unstable)", description: "agent-browser's browsers, from nixos-unstable" },
  "browser-stable": { title: "Browsers (stable)", description: "the same, from the newest NixOS release" },
};

/** Pins that aren't packages: NixOS stable's nixpkgs (the stable toggle),
 * shown by channel and short revision. */
export const NIXPKGS_PINS: Record<string, { title: string; description: string }> = {
  "nixpkgs-stable": { title: "nixpkgs (stable)", description: "the NixOS release the stable toggle builds on" },
};
