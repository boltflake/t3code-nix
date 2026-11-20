# The NixOS-stable acceptance suite (README, "NixOS stable"): which of the
# flake's checks are run on the stable set too, and which aren't, and why. Every
# check the flake has must be in one of these lists: the stable-names check
# fails otherwise, so a check added later is put in one on purpose.
{
  # Packages built (patching and version probes) as stable-<name> and
  # stable-next-<name>.
  twinnedPackages = [
    "t3code"
    "t3code-free"
    "t3code-unwrapped"
    "t3"
    "t3-free"
    "t3-unwrapped"
    "chrome-headless-shell"
    "doctor"
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
    "boat"
    "agent-browser"
  ];
  # lib/checks.nix's checks, called with the stable set and its pins.
  twinnedChecks = [
    # agent-browser on the browser-stable pin (an override, not a package);
    # on the stable set, the same derivation as its own agent-browser.
    "agent-browser-stable-chromium"
    "t3-smoke"
    "t3-speech-worker"
    "t3-speech-smoke"
    "speech-libs"
    "speech-model-pin"
    "preview-browser-pin"
    "preview-browser-link"
    "acp-runtimes"
    "free-variant"
    "update-guards"
    "updater-switches"
    "codex-layout"
    "licences"
    "provider-wrappers"
    "as-shipped"
    "relay-client"
    "completions"
    "boat-self-update-off"
    "fx-upgrade-off"
    "agent-tools-separate"
    "agent-browser-browsers"
    # The desktop app on each Electron (lib/electron.nix), forced.
    "t3code-electron-bundled"
    "t3code-electron-nixpkgs"
    "electron-swap"
  ];
  # Not on NixOS stable.
  nightly = [
    "t3code-nightly"
    "t3code-unwrapped-nightly"
    "t3-nightly"
    "t3-unwrapped-nightly"
    "chrome-headless-shell-nightly"
    "t3-nightly-smoke"
    "t3-nightly-speech-worker"
    "t3-nightly-speech-smoke"
    "t3code-nightly-electron-bundled"
    "t3code-nightly-electron-nixpkgs"
  ];
  # They read a vendor's command line, which nixpkgs doesn't change; their
  # notes would open guard-review issues against main's versions.
  guards = [
    "t3-guard-flags"
    "codex-guard-flags"
    "provider-commands"
  ];
  # About the flake's code, not a package set.
  flakeLevel = [
    "typecheck"
    "unit"
    "nix-format"
    "cache-settings"
    "template"
    "overlay"
    "module-eval"
    "default-nix"
    "no-self-rev"
    "init"
    "init-scenarios"
    "server-unit"
    "doctor-scenarios"
    "provider-selection"
    "guard-environment"
    "preview-browser-optional"
    "unsupported-systems"
    "stable-names"
    "electron-choice"
    "electron-fallback"
    "electron-runtime"
  ];
}
