# Every package this flake ships, built on the given pkgs. Used for the
# flake's own outputs (pinned nixpkgs), by the overlay (the user's), and for
# the NixOS-stable set (the nixpkgs-stable pin, with the snapshot's pins).
# browserChannel: agent-browser's default Chromium, a browser pin
# ("unstable" or "stable"), or null for this pkgs' own (the overlay).
# pinsDir: where the pins are read from; a package whose pins aren't there
# isn't in the set (the snapshot has no nightly pins, so the stable set has
# no nightly packages, and a package added since the last move isn't in it).
# nixpkgs: which nixpkgs this set is, for the doctor to name ("stable" for
# the NixOS-stable sets).
{
  pkgs,
  browserChannel ? "unstable",
  pinsDir ? ../versions,
  nixpkgs ? "unstable",
  # Read ci/electron-fallback.json (lib/electron.nix): only this flake's
  # default packages on its pinned nixpkgs-unstable do; never the NixOS
  # stable sets, the overlay, or the comparisons with it.
  electronFallback ? nixpkgs == "unstable",
}:
let
  inherit (pkgs) lib;
  versions = import ../lib/versions.nix {
    inherit (pkgs) lib fetchurl versionCheckHook;
    inherit pinsDir;
    # The browser pins' nixpkgs allows what this pkgs allows (google-chrome).
    unfreeConfig = {
      allowUnfree = pkgs.config.allowUnfree or false;
      allowUnfreePredicate = pkgs.config.allowUnfreePredicate or (_: false);
    };
  };
  guard = import ../lib/guard.nix { inherit lib; };
  callPackage = lib.callPackageWith (pkgs // { inherit versions guard; });

  self = {
    codex = callPackage ./codex/package.nix { };
    fx = callPackage ./fx/package.nix { };
    opencode = callPackage ./opencode/package.nix {
      wrapBuddy = callPackage ./opencode/wrap-buddy.nix { };
    };
    pi = callPackage ./pi/package.nix { };

    # Unfree (see pkgs/unfree.nix)
    antigravity = callPackage ./antigravity/package.nix { };
    claude-code = callPackage ./claude-code/package.nix { };
    cursor-agent = callPackage ./cursor-agent/package.nix { };
    grok = callPackage ./grok/package.nix { };
    kiro-cli = callPackage ./kiro-cli/package.nix { };
    muse = callPackage ./muse/package.nix { };

    # Agent tools: what the agents use themselves; never in T3 Code's closure.
    boat = callPackage ./boat/package.nix { };
    agent-browser = callPackage ./agent-browser/package.nix { inherit browserChannel; };

    # T3 Code, without providers
    t3-unwrapped = callPackage ./t3code/cli.nix { channel = "latest"; };
    t3-unwrapped-nightly = callPackage ./t3code/cli.nix { channel = "nightly"; };
    # `electron` is passed: callPackage would otherwise fill it with
    # nixpkgs' own `electron` attribute.
    t3code-unwrapped = callPackage ./t3code/desktop.nix {
      channel = "latest";
      electron = "auto";
      inherit electronFallback;
    };
    t3code-unwrapped-nightly = callPackage ./t3code/desktop.nix {
      channel = "nightly";
      electron = "auto";
      inherit electronFallback;
    };

    # The HTML-preview browser each channel's release pins (unfree)
    chrome-headless-shell = previewBrowser "t3code";
    chrome-headless-shell-nightly = previewBrowser "t3code-nightly";

    # T3 Code with every provider it supports (see providers.nix) and its
    # preview browser
    t3 = wrap self.t3-unwrapped "t3";
    t3-nightly = wrap self.t3-unwrapped-nightly "t3-nightly";
    t3code = wrap self.t3code-unwrapped "t3code";
    t3code-nightly = wrap self.t3code-unwrapped-nightly "t3code-nightly";

    # The same with the free providers only and no preview browser: nothing
    # unfree in the closure, so the binary cache can hold all of it.
    t3-free = free self.t3;
    t3code-free = free self.t3code;

    # `t3code-nix doctor` for the default build (the module builds its own).
    doctor = callPackage ./doctor/package.nix {
      inherit (self) t3code t3;
      inherit nixpkgs;
      availableProviders = providers;
      cache = import ../lib/cache.nix;
    };

    # `t3code-nix init`: a NixOS system that isn't a flake yet, made into
    # one with T3 Code.
    init = callPackage ./init/package.nix { };

    default = self.t3code;
  };

  # The pins each package reads. A package is in the set only when its pins
  # folder has all of them.
  needs =
    let
      own = n: [ n ];
      browser = ch: [
        "agent-browser"
        "browser-${ch}"
      ];
    in
    {
      t3-unwrapped = own "t3";
      t3-unwrapped-nightly = own "t3-nightly";
      t3code-unwrapped = own "t3code";
      t3code-unwrapped-nightly = own "t3code-nightly";
      chrome-headless-shell = own "t3code";
      chrome-headless-shell-nightly = own "t3code-nightly";
      t3 = own "t3";
      t3-nightly = own "t3-nightly";
      t3code = own "t3code";
      t3code-nightly = own "t3code-nightly";
      t3-free = own "t3";
      t3code-free = own "t3code";
      doctor = [
        "t3code"
        "t3"
      ];
      init = [ ];
      default = own "t3code";
      agent-browser = if browserChannel == null then [ "agent-browser" ] else browser browserChannel;
    };
  pinned = n: builtins.all versions.has (needs.${n} or [ n ]);
  # Builtins only: the set's names never need this pkgs (so listing the
  # NixOS-stable set never fetches its nixpkgs).
  set = builtins.removeAttrs self (builtins.filter (n: !pinned n) (builtins.attrNames self));

  # From each package's own pin, so a candidate that changes one t3code pin
  # tests the browser that release uses; the channels' pins agree, so it is
  # one build.
  previewBrowser =
    pin: callPackage ./chrome-headless-shell/package.nix { inherit ((versions.load pin)) browser; };
  wrap =
    unwrapped: pin:
    callPackage ./t3code/wrap.nix {
      inherit unwrapped;
      # Passed, or callPackage would fill it with nixpkgs' `electron`.
      electron = null;
      availableProviders = providers;
      previewBrowser = previewBrowser pin;
    };
  providers = import ./t3code/providers.nix set;
  # The `-free` variants. The name stays on a later `.override { providers =
  # … }`, even one that adds an unfree provider: the name says where it
  # started, `passthru.providers` what it bundles.
  free =
    pkg:
    pkg.override {
      providers = builtins.filter (
        driver: !builtins.elem (lib.getName providers.${driver}) (import ./unfree.nix)
      ) (builtins.attrNames providers);
      withPreviewBrowser = false;
      variant = "-free";
    };
in
set
