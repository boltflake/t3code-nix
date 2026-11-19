# Reads a package's pin from versions/<name>.json. The updater is the only
# writer of those files. Each pin holds the version and, per system, the
# versioned download URL, its SRI hash, and the upstream asset identity.
# pinsDir: where the pins are read from: versions/ for the flake's own
# outputs, versions/stable/ (the snapshot) for the NixOS-stable set.
{
  lib,
  fetchurl,
  versionCheckHook,
  pinsDir ? ../versions,
  # The calling pkgs' unfree settings, for the browser pins' nixpkgs.
  unfreeConfig ? { },
}:
let
  load = name: lib.importJSON (pinsDir + "/${name}.json");
  # The start of every package's postInstallCheck (installCheck), which the
  # provider-wrappers check looks for.
  installCheckScript = ''
    checkEnv() { env --chdir=/ --ignore-environment HOME="$HOME" TMPDIR="$TMPDIR" "$@"; }
    reportsVersion() {
      local status=0 output
      output=$(checkEnv "$out/bin/$1" --version 2>&1) || status=$?
      if [ "$status" -ne 0 ]; then
        echo "$1 --version exited with status $status: $output" >&2
        exit 1
      fi
      if [[ "$output" != *"$version"* ]]; then
        echo "$1 --version doesn't report $version: $output" >&2
        exit 1
      fi
      echo "$1 --version exited with status 0 and reports $version"
    }
    reportsVersion "$NIX_MAIN_PROGRAM"
  '';
in
{
  inherit load installCheckScript;
  # The unfree settings the browser pins' nixpkgs gets (checked, without
  # evaluating a browser, by the overlay check).
  inherit unfreeConfig;
  # Whether this pins folder has the pin (a package without its pins isn't
  # in the set built from it).
  has = name: builtins.pathExists (pinsDir + "/${name}.json");

  # The fetchurl arguments for one system, or a clear error if the vendor
  # ships nothing for it.
  asset =
    pin: system:
    let
      a =
        pin.assets.${system}
          or (throw "${pin.name} ${pin.version} has no release for ${system} (see docs/acceptance-matrix.md)");
    in
    {
      inherit (a) url hash;
    };

  # agent-browser's browsers from a browser pin (versions/browser-<channel>.json,
  # scripts/lib/browserpins.ts): that nixpkgs revision's ungoogled-chromium,
  # chromium and google-chrome. fetchTarball with the revision and its hash
  # works without the flakes feature, in pure evaluation, and nothing is
  # fetched unless it's used. The import takes the unfree settings of the pkgs
  # that asked (`unfreeConfig`), so the flake's own sets allow google-chrome
  # and the overlay leaves it to the user's allowUnfree.
  browsers =
    channel: system:
    let
      pin = load "browser-${channel}";
      src = builtins.fetchTarball {
        url = "https://github.com/NixOS/nixpkgs/archive/${pin.rev}.tar.gz";
        sha256 = pin.narHash;
      };
      p = import src {
        inherit system;
        config = unfreeConfig;
        overlays = [ ];
      };
    in
    {
      inherit (p) ungoogled-chromium chromium google-chrome;
    };

  # T3 Code's release channel, checked: `name` ("latest" or "nightly") and
  # `suffix` ("" or "-nightly", for pin, package and command names);
  # anything else fails to evaluate, naming `what`.
  channel =
    what: channel:
    if
      builtins.elem channel [
        "latest"
        "nightly"
      ]
    then
      {
        name = channel;
        suffix = lib.optionalString (channel == "nightly") "-nightly";
      }
    else
      throw ''${what}: channel is "latest" or "nightly", not ${builtins.toJSON channel}'';

  # The systems a pin has assets for, for meta.platforms.
  platforms = pin: builtins.attrNames pin.assets;

  # The install check every package with one uses (spread into its mkDerivation
  # arguments): nixpkgs' versionCheckHook runs exactly `<mainProgram>
  # --version` (with no argument it would also accept a version found in
  # --help), with only a fresh HOME and TMPDIR. As the hook accepts a
  # command that fails after printing the version, each command then must
  # also exit 0 and report the version in that same environment: the main
  # program, then `also` (more commands in bin/). `extra`: shell lines run
  # after these; `checkEnv COMMAND...` runs a command in that environment,
  # from / and with no PATH (so COMMAND is an absolute path).
  installCheck =
    {
      also ? [ ],
      extra ? "",
    }:
    {
      doInstallCheck = true;
      nativeInstallCheckInputs = [ versionCheckHook ];
      versionCheckProgramArg = "--version";
      versionCheckKeepEnvironment = [
        "HOME"
        "TMPDIR"
      ];
      preInstallCheck = ''
        export HOME=$(mktemp -d) TMPDIR=$(mktemp -d)
      '';
      postInstallCheck =
        installCheckScript
        + lib.concatMapStrings (b: "reportsVersion ${lib.escapeShellArg b}\n") also
        + extra;
    };

  # Shell lines removing the musl builds of native add-ons under DIR: they
  # are never loaded on glibc, and nixpkgs has no musl libc to link them
  # against. (A musl file left elsewhere is ignored by autoPatchelf through
  # autoPatchelfIgnoreMissingDeps = [ "libc.musl-*.so.1" ].)
  dropMusl = dir: ''
    find ${dir} -type d \( -name '*-musl*' -o -name 'musl_*' \) -prune -exec rm -rf {} +
  '';

  # Shell lines installing the vendor's license files, pinned from the same
  # release, into $out/share/licenses/<name>/.
  installLicenses =
    pin:
    lib.concatStrings (
      lib.mapAttrsToList (
        path: l:
        let
          file = fetchurl {
            inherit (l) url hash;
            name = "${pin.name}-${pin.version}-${baseNameOf path}";
          };
        in
        "install -Dm644 ${file} $out/share/licenses/${pin.name}/${baseNameOf path}\n"
      ) (pin.licenses or { })
    );
}
