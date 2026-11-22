# t3code-nix without flakes: `nix-env -f`, `nix-shell`, `nix-build`,
# `import (fetchTarball …)` and channel-based NixOS configurations.
#
#   nix-env -f https://github.com/boltflake/t3code-nix/archive/main.tar.gz -iA t3code
#   t3code-nix = import (fetchTarball "https://github.com/boltflake/t3code-nix/archive/main.tar.gz") { };
#     t3code-nix.t3code               this system's packages, at the top level
#     t3code-nix.nixosModules.default the NixOS module
#     t3code-nix.overlays.default     the overlay
#     t3code-nix.flake                every flake output, by system
#
# The flake's own outputs, evaluated without flakes: nixpkgs is fetched at
# the revision flake.lock pins, checked against its narHash, so this follows
# the flake exactly and needs no flake-compat (the nixpkgs bump updates it
# with flake.lock).
{
  system ? builtins.currentSystem,
}:
let
  lock = (builtins.fromJSON (builtins.readFile ./flake.lock)).nodes.nixpkgs.locked;
  src = fetchTarball {
    url = "https://github.com/${lock.owner}/${lock.repo}/archive/${lock.rev}.tar.gz";
    sha256 = lock.narHash;
  };
  # What the flake's outputs read from their nixpkgs input. No user config
  # or overlays: this evaluation is impure, and they would change the
  # builds (and miss the binary cache).
  nixpkgs = {
    outPath = src;
    lib = import (src + "/lib");
    legacyPackages = builtins.mapAttrs (
      system: _:
      import src {
        inherit system;
        config = { };
        overlays = [ ];
      }
    ) flake.packages;
  };
  flake = (import ./flake.nix).outputs {
    self = flake // {
      outPath = ./.;
    };
    inherit nixpkgs;
  };
  packages = flake.packages.${system} or { };
in
# `default` is the app again; nix-env would list it under that name only.
# A system without packages keeps its stub (lib/unsupported.nix).
(if packages ? t3code then removeAttrs packages [ "default" ] else packages)
// {
  inherit (flake) nixosModules overlays;
  inherit flake;
  # NixOS stable (the stable toggle) for this system; fetched only when used.
  stable = flake.legacyPackages.${system}.stable or { };
}
