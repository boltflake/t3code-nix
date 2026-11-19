# `t3code-nix init` (`nix run github:swsammy/t3code-nix#init`): writes
# /etc/nixos/flake.nix from the flake template for a NixOS system that
# isn't a flake yet, with its nixpkgs branch and host name filled in
# (init.sh). It doesn't depend on T3 Code: `nix run …#init` doesn't build
# or fetch it.
{
  lib,
  writeShellApplication,
  coreutils,
  findutils,
  gnugrep,
  gnused,
  gawk,
}:
writeShellApplication {
  name = "t3code-nix-init";
  runtimeInputs = [
    coreutils
    findutils
    gnugrep
    gnused
    gawk
  ];
  # nix, nix-channel, nixos-version and git are the system's own.
  inheritPath = true;
  text =
    builtins.replaceStrings
      [ "template=@template@" ]
      [
        "template=${../../templates/default/flake.nix}"
      ]
      (builtins.readFile ./init.sh);
  meta = {
    description = "Makes a NixOS system that isn't a flake yet into one with T3 Code (t3code-nix)";
    mainProgram = "t3code-nix-init";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
