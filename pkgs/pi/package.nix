# pi, a minimal terminal coding agent: upstream's Bun-compiled Linux
# release, patched for NixOS with autoPatchelf and wrapped so that its
# self-update is refused.
{
  lib,
  stdenv,
  fetchurl,
  versions,
  guard,
  autoPatchelfHook,
  makeWrapper,
  libxcb,
}:
let
  pin = versions.load "pi";
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "pi";
    inherit (pin) version;

    # The release binary, not the npm build: no dependency hash to keep up to
    # date. It reads its themes, docs and native add-ons from the directory
    # it lives in, so the whole tree is kept together.
    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);
    sourceRoot = "pi";

    nativeBuildInputs = [
      autoPatchelfHook
      makeWrapper
    ];
    # libxcb: the X11 clipboard add-on (native/linux/prebuilds/*/linux-platform-x11.node).
    buildInputs = [
      stdenv.cc.cc.lib
      libxcb
    ];

    dontConfigure = true;
    dontBuild = true;
    # Stripping would remove the embedded JavaScript bundle.
    dontStrip = true;

    installPhase = ''
      runHook preInstall
      mkdir -p $out/libexec
      cp -r . $out/libexec/pi
      makeWrapper $out/libexec/pi/pi $out/bin/pi ${guard.refusePiSelfUpdate}
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    meta = {
      description = "Minimal terminal coding agent";
      homepage = "https://github.com/earendil-works/pi";
      license = lib.licenses.mit;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "pi";
    };
  }
)
