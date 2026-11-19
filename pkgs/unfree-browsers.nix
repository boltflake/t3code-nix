# Unfree browsers the flake's own outputs allow besides its unfree packages
# (pkgs/unfree.nix): agent-browser's `browser = "google-chrome"`, from
# nixpkgs (the browser pins' or the flake's). They aren't packages of this
# flake, so they're kept apart from pkgs/unfree.nix, whose every name the
# cache job checks is a package. Used only when chosen.
[
  "google-chrome"
]
