# The NixOS module with programs.t3code.nixpkgs = "stable", against the set
# it's given: the snapshot's (stable-module-eval) or the stable-next one
# (stable-next-module-eval). Its own file, so both twins are built by one
# recipe and have the same derivation when they pass.
{
  lib,
  runCommand,
  path,
  pkgs,
  self,
  cache,
  # The NixOS-stable set to check, and the pins it was built from.
  set,
  pinsDir,
}:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  module = import ../nixos/module.nix {
    core = import ./module-core.nix {
      inherit (self) packages;
      inherit cache;
      stable.${system} = set;
      serverBackup.${system}.stable = import ./server-backup.nix { inherit pkgs; };
    };
    inherit cache;
  };
  eval =
    settings:
    (import (path + "/nixos/lib/eval-config.nix") {
      system = null;
      modules = [
        module
        {
          nixpkgs.pkgs = pkgs;
          programs.t3code = settings;
        }
      ];
    }).config;
  installed = c: name: builtins.filter (p: lib.getName p == name) c.environment.systemPackages;
  drvs = map (p: p.drvPath);
  failedAssertion =
    c: builtins.any (a: !a.assertion && lib.hasPrefix "programs.t3code:" a.message) c.assertions;
  pinned = channel: (lib.importJSON (pinsDir + "/browser-${channel}.json")).outPaths.${system};
  browserOf = c: map (p: p.browser.outPath) (installed c "agent-browser");
  unstable = self.packages.${system};

  onStable = eval {
    enable = true;
    nixpkgs = "stable";
    cli.enable = true;
  };
  server = eval {
    nixpkgs = "stable";
    server.enable = true;
  };
  explicit = eval {
    enable = true;
    nixpkgs = "stable";
    package = unstable.t3code.override { providers = [ "codex" ]; };
    cli.enable = true;
  };
  browser = eval {
    nixpkgs = "stable";
    agentTools.agent-browser.enable = true;
  };
  browserUnstable = eval {
    nixpkgs = "stable";
    agentTools.agent-browser = {
      enable = true;
      browserChannel = "unstable";
    };
  };
  tools = eval {
    enable = true;
    nixpkgs = "stable";
    agentTools.boat.enable = true;
  };
  ownBrowser = eval {
    nixpkgs = "stable";
    agentTools.agent-browser = {
      enable = true;
      package = set.agent-browser.override { browser = pkgs.hello; };
    };
  };
  ownBrowserChannel = eval {
    nixpkgs = "stable";
    agentTools.agent-browser = {
      enable = true;
      package = set.agent-browser.override { browser = pkgs.hello; };
      browserChannel = "stable";
    };
  };
  compat = eval {
    nixpkgs = "stable";
    runtimeCompat = true;
  };
  telemetryOff = eval {
    enable = true;
    nixpkgs = "stable";
    cli.enable = true;
    telemetry.enable = false;
  };
  firewall = eval {
    enable = true;
    nixpkgs = "stable";
    cli.enable = true;
    openFirewall = true;
  };
  withNightly = eval {
    enable = true;
    nixpkgs = "stable";
    channel = "nightly";
  };
  tests = {
    "nixpkgs = stable installs the stable set's app and CLI" =
      drvs (installed onStable "t3code") == [ set.t3code.drvPath ]
      && drvs (installed onStable "t3") == [ set.t3.drvPath ]
      && !failedAssertion onStable;
    "the stable set's providers go on PATH" =
      let
        names = map lib.getName set.t3code.providers;
      in
      lib.sort lib.lessThan (
        drvs (builtins.filter (p: builtins.elem (lib.getName p) names) onStable.environment.systemPackages)
      ) == lib.sort lib.lessThan (drvs set.t3code.providers);
    "telemetry.enable = false gives the stable set's app and CLI, off" =
      drvs (installed telemetryOff "t3code") == [ (set.t3code.override { telemetry = false; }).drvPath ]
      && drvs (installed telemetryOff "t3") == [ (set.t3.override { telemetry = false; }).drvPath ]
      && !failedAssertion telemetryOff;
    "openFirewall pins the stable set's app and opens its port" =
      drvs (installed firewall "t3code") == [ (set.t3code.override { port = 3773; }).drvPath ]
      && drvs (installed firewall "t3") == [ set.t3.drvPath ]
      && firewall.networking.firewall.allowedTCPPorts == [ 3773 ]
      && !failedAssertion firewall;
    "the server runs the stable set's t3" =
      lib.hasPrefix "${set.t3}/bin/" server.systemd.user.services.t3code-server.serviceConfig.ExecStart;
    "an explicit package wins; the CLI stays stable, with the app's providers" =
      drvs (installed explicit "t3code") == [ explicit.programs.t3code.package.drvPath ]
      && map (p: p.passthru.unwrapped.drvPath) (installed explicit "t3") == [ set.t3-unwrapped.drvPath ]
      && map (p: map lib.getName p.providers) (installed explicit "t3") == [ [ "codex" ] ];
    "agent-browser follows the toggle, with the pins' Chromium" =
      browserOf browser == [ (pinned "stable") ] && browserOf browserUnstable == [ (pinned "unstable") ];
    "the doctor and boat come from the stable set" =
      drvs (installed tools "boat") == [ set.boat.drvPath ]
      &&
        map (p: p.passthru.t3code.drvPath) (installed tools "t3code-nix-doctor") == [ set.t3code.drvPath ];
    "an explicit agent-browser keeps its browser, unless browserChannel is set" =
      browserOf ownBrowser == [ pkgs.hello.outPath ]
      && browserOf ownBrowserChannel == [ pkgs.hello.outPath ];
    "runtimeCompat alone turns on nix-ld with every library the stable t3 links against, installing nothing else" =
      compat.programs.nix-ld.enable
      &&
        lib.subtractLists (map lib.getName compat.programs.nix-ld.libraries) (
          map lib.getName set.t3-unwrapped.buildInputs
        ) == [ ]
      && installed compat "t3code" == [ ]
      && installed compat "t3" == [ ]
      && installed compat "t3code-nix-doctor" == [ ];
    "stable with the nightly channel fails its assertion, which names the latest channel" =
      builtins.any
        (
          a:
          !a.assertion
          &&
            a.message
            == ''programs.t3code: NixOS stable (nixpkgs = "stable") has T3 Code's latest channel only; set channel = "latest", or nixpkgs = "unstable" for nightly.''
        )
        withNightly.assertions;
  };
  failed = builtins.attrNames (lib.filterAttrs (_: ok: !ok) tests);
in
runCommand "module-eval" { } (
  if failed == [ ] then
    "touch $out"
  else
    "echo ${lib.escapeShellArg "module-eval on NixOS stable: not true: ${lib.concatStringsSep "; " failed}"}; exit 1"
)
