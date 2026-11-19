# The flake's default package on a system it has nothing for. `nix run`
# there builds this and gets the message, instead of "flake does not
# provide attribute packages.<system>.default". It evaluates everywhere, so
# `nix flake check --all-systems` and `nix flake show --all-systems` keep
# working, and its name says what it is.
system:
derivation {
  name = "t3code-nix-supports-Linux-only";
  inherit system;
  builder = "/bin/sh";
  args = [
    "-c"
    "echo 't3code-nix supports Linux only; see README' >&2; exit 1"
  ];
}
