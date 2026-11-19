# Kiro CLI, Kiro's agentic coding assistant for the terminal: the vendor's
# self-contained Linux executable, patched for NixOS with autoPatchelf and
# wrapped so that its auto-update is off and `kiro-cli update` is refused.
# (A signed-in session isn't tested here: it needs an account.)
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
  pin = versions.load "kiro-cli";
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "kiro-cli";
    inherit (pin) version;

    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);
    sourceRoot = "kirocli";

    nativeBuildInputs = [
      autoPatchelfHook
      makeWrapper
    ];
    buildInputs = [ stdenv.cc.cc.lib ];

    dontConfigure = true;
    dontBuild = true;
    # The vendor ships it stripped: strip would remove nothing, only rewrite it.
    dontStrip = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 bin/kiro-cli $out/libexec/kiro-cli/kiro-cli
      makeWrapper $out/libexec/kiro-cli/kiro-cli $out/bin/kiro-cli \
        ${guard.refuse { name = "kiro-cli"; }} \
        --set KIRO_NO_AUTO_UPDATE 1
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    meta = {
      description = "Kiro's agentic coding assistant for the terminal";
      homepage = "https://kiro.dev";
      license = lib.licenses.unfree;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "kiro-cli";
    };
  }
)
