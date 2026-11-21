# A NixOS system with T3 Code, from t3code-nix. It imports your
# configuration.nix. Build it with
#   sudo nixos-rebuild switch --flake /etc/nixos#nixos
# which works whatever your host name is. Optional: rename `nixos` below to
# your host name (`hostname`), and a plain `sudo nixos-rebuild switch` works.
{
  inputs = {
    # Check this line. It says nixos-unstable. If `sudo nix-channel --list`
    # shows a stable release, for example nixos-26.05, change it to
    # nixos-26.05, so your system stays on the release it's on now. If it
    # shows no `nixos` channel, find out which release your system follows
    # before you rebuild, because left as it is this line moves it to
    # unstable. `nix-instantiate --find-file nixpkgs` shows where
    # <nixpkgs> comes from now; trace that to its channel or revision, and
    # use that branch.
    # (This flake's packages bring their own nixpkgs either way.)
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Don't make it follow your nixpkgs: the binary cache holds builds made
    # on t3code-nix's own pinned nixpkgs.
    t3code-nix.url = "github:swsammy/t3code-nix";
  };

  # The binary cache, for the first build (the module adds it for later
  # ones).
  nixConfig = {
    extra-substituters = [ "https://t3code-nix.cachix.org" ];
    extra-trusted-public-keys = [
      "t3code-nix.cachix.org-1:FwZvqgRcnUjCSEUmdosysof1pTedbm/TTmlk8IeDsJA="
    ];
  };

  outputs =
    { nixpkgs, t3code-nix, ... }:
    {
      # `nixos` is NixOS's default host name: `--flake /etc/nixos#nixos`
      # builds it whatever yours is.
      nixosConfigurations.nixos = nixpkgs.lib.nixosSystem {
        modules = [
          ./configuration.nix
          t3code-nix.nixosModules.default
          {
            programs.t3code = {
              enable = true; # the desktop app, its providers on PATH and `t3code-nix doctor`

              # Optional: uncomment what you need. All the options are
              # under "The NixOS module" in t3code-nix's README.
              # providers = [ "codex" "claude" ];       # bundle only these (default: all ten)
              # excludeProviders = [ "grok" ];          # or leave some out
              # channel = "nightly";                    # T3 Code nightly (built on your machine)
              # nixpkgs = "stable";                     # NixOS stable's libraries, not with nightly (built locally)
              # cli.enable = true;                      # the headless `t3` CLI too
              # server.enable = true;                   # keep T3 Code running in the background for your phone, laptop or browser
              # server.lan = true;                      # reachable on your local network and tailnet
              # server.openFirewall = true;             # open its port (3773) in the firewall
              # agentTools.agent-browser.enable = true; # lets agents open, click and screenshot web pages
              # agentTools.boat.enable = true;          # boat.dev's sandbox CLI for agents
            };
          }
        ];
      };
    };
}
