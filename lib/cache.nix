# The project's binary cache: the one place its name and key are defined.
# The NixOS module and the `cache-settings` check read it from here.
# flake.nix's `nixConfig`, templates/default/flake.nix's `nixConfig` and the
# README's "Binary cache" section repeat the two values (Nix reads
# `nixConfig` without evaluating it); `nix flake check` (cache-settings)
# fails unless all four agree. A `publicKey` of null means "no cache": the
# module adds nothing. Never put a made-up key here: a malformed key stops
# Nix's substitution with an error, and a wrong one makes Nix trust nothing
# from the cache.
rec {
  name = "t3code-nix";
  url = "https://${name}.cachix.org";
  publicKey = "t3code-nix.cachix.org-1:FwZvqgRcnUjCSEUmdosysof1pTedbm/TTmlk8IeDsJA=";
}
