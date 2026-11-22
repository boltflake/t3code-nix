# Which of this flake's packages the overlay puts at the top level of pkgs
# (each the package under pkgs.t3code-nix of that name, except t3code: that
# app with its CLI, withCli; see flake.nix).
# Every package is under pkgs.t3code-nix.<name>; only these names are also
# added at the top level, and each only if the user's nixpkgs has no package
# of that name, or has the same program under it (`sameAsNixpkgs`). So
# nixpkgs' fx (a JSON viewer), muse (a MIDI sequencer), t3 (a tee) and
# antigravity (a deprecated alias of the Antigravity IDE, antigravity-ide)
# stay as they are, and a nixpkgs that later gains a different program
# under one of these names keeps it too.
#
# The names are written out, not derived from the packages, so the
# overlay's attribute names never depend on evaluating a package.
{
  # The app, and the providers.
  candidates = [
    "t3code"
    "t3code-nightly"
    "t3code-free"
    "t3code-unwrapped"
    "t3code-unwrapped-nightly"
    "antigravity"
    "claude-code"
    "codex"
    "cursor-agent"
    "fx"
    "grok"
    "kiro-cli"
    "muse"
    "opencode"
    "pi"
    # Agent tools.
    "boat"
    "agent-browser"
  ];
  # Checked by hand against nixpkgs (description, homepage, source): the
  # same program, at the same or a newer version, so ours may replace it.
  sameAsNixpkgs = [
    "t3code"
    "claude-code"
    "codex"
    "kiro-cli"
    # vercel-labs/agent-browser, built from source there; nothing in
    # nixpkgs builds on it (checked 2026-11-14).
    "agent-browser"
  ];
  # Not opencode: nixpkgs' opencode-desktop builds from nixpkgs' opencode
  # (its source and node_modules), which ours, a release binary, hasn't.

  # Never at the top level, only under pkgs.t3code-nix. Every package is in
  # `candidates` or here (the overlay check), so a new one has to be placed.
  notTopLevel = [
    # The CLI (nixpkgs' t3 is a tee).
    "t3"
    "t3-nightly"
    "t3-free"
    "t3-unwrapped"
    "t3-unwrapped-nightly"
    "doctor"
    "init"
    "chrome-headless-shell"
    "chrome-headless-shell-nightly"
  ];
}
