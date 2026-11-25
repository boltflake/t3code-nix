# Home Manager with T3 Code, from t3code-nix, for one user on NixOS or
# another Linux distro. Set the lines marked below, then switch to it:
#   nix run github:nix-community/home-manager/master -- switch --flake '.#you'
# (`you` is the user name you set; later switches can use `home-manager
# switch --flake '.#you'`.)
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Don't make it follow your nixpkgs: the binary cache holds builds made
    # on t3code-nix's own pinned nixpkgs.
    t3code-nix.url = "github:boltflake/t3code-nix";
  };

  # The binary cache, used when you're a trusted user of the Nix daemon (and
  # accept it). Home Manager can't add it for the system: see the README,
  # "The Home Manager module", for the lines that do.
  nixConfig = {
    extra-substituters = [ "https://t3code-nix.cachix.org" ];
    extra-trusted-public-keys = [
      "t3code-nix.cachix.org-1:FwZvqgRcnUjCSEUmdosysof1pTedbm/TTmlk8IeDsJA="
    ];
  };

  outputs =
    {
      nixpkgs,
      home-manager,
      t3code-nix,
      ...
    }:
    let
      # Set these: your user name (`id -un`), your home folder (`echo $HOME`)
      # and system (`x86_64-linux` or `aarch64-linux`).
      username = "you";
      homeDirectory = "/home/you";
      system = "x86_64-linux";
    in
    {
      homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
        pkgs = nixpkgs.legacyPackages.${system};
        modules = [
          t3code-nix.homeModules.default
          {
            home.username = username;
            home.homeDirectory = homeDirectory;
            # The Home Manager release you started with; leave it when you update.
            home.stateVersion = "26.05";
            programs.home-manager.enable = true;

            programs.t3code-nix = {
              enable = true; # the desktop app, its providers on PATH and `t3code-nix doctor`

              # Optional: uncomment what you need. All the options are
              # under "The Home Manager module" in t3code-nix's README.
              # providers = [ "codex" "claude" ];       # bundle only these (default: all ten)
              # excludeProviders = [ "grok" ];          # or leave some out
              # channel = "nightly";                    # T3 Code nightly (built on your machine)
              # cli.enable = true;                      # the headless `t3` CLI too
              # server.enable = true;                   # T3 Code in the background, as your systemd user service
              # server.home = "%h/.t3-server";          # its own T3 home, beside the app's ~/.t3
              # agentTools.agent-browser.enable = true; # lets agents open, click and screenshot web pages
              # agentTools.boat.enable = true;          # boat.dev's sandbox CLI for agents
            };

            # Not NixOS? T3 Code needs your system's GPU drivers: see the
            # README, "The Home Manager module", for targets.genericLinux.gpu.
          }
        ];
      };
    };
}
