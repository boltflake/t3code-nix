# Google Antigravity CLI (`agy`): the vendor's prebuilt Linux executable.
# For NixOS it is patched to nixpkgs' glibc and wrapped as `agy` (a regular
# file, so a link to it resolves to that name), run with `agy` as its argv[0]
# (it names itself after it), with its background updater off and
# `agy update` and `agy install` refused.
{
  lib,
  stdenv,
  fetchurl,
  versions,
  guard,
  autoPatchelfHook,
  makeWrapper,
}:
let
  pin = versions.load "antigravity";
in
stdenv.mkDerivation (
  versions.installCheck {
    extra = ''
      # The ACP server T3 Code starts: checkEnv's environment, but from a
      # writable throwaway directory (checkEnv runs from /).
      env --chdir="$(mktemp -d)" --ignore-environment HOME="$HOME" TMPDIR="$TMPDIR" \
        $out/bin/agy acp --help
    '';
  }
  // {
    pname = "antigravity";
    inherit (pin) version;

    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);

    # The archive holds a lone `antigravity` file, unpacked into a directory
    # of its own.
    unpackPhase = ''
      runHook preUnpack
      mkdir source
      tar -xzf "$src" -C source
      runHook postUnpack
    '';
    sourceRoot = "source";

    nativeBuildInputs = [
      autoPatchelfHook
      makeWrapper
    ];

    dontConfigure = true;
    dontBuild = true;
    # The vendor ships it stripped: strip would remove nothing, only rewrite it.
    dontStrip = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 antigravity $out/libexec/antigravity/antigravity
      makeWrapper $out/libexec/antigravity/antigravity $out/bin/agy \
        ${guard.refuse { name = "antigravity"; }} \
        --argv0 agy \
        --set AGY_CLI_DISABLE_AUTO_UPDATE true
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    meta = {
      description = "Google Antigravity CLI, the terminal-first surface to interact with Antigravity agents";
      homepage = "https://antigravity.google";
      license = lib.licenses.unfree;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "agy";
    };
  }
)
