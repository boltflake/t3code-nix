# Muse Code (`muse`), Meta's interactive terminal coding agent: the vendor's
# prebuilt, statically linked Linux executable, installed byte for byte as
# the command itself. Nothing changes for NixOS: it runs as shipped, and it
# has no self-update to turn off.
{
  lib,
  stdenv,
  fetchurl,
  versions,
}:
let
  pin = versions.load "muse";
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "muse";
    inherit (pin) version;

    # The bare executable, no archive. The URL ends in a query string, so the
    # download gets a name of its own.
    src = fetchurl (versions.asset pin stdenv.hostPlatform.system // { name = "muse-${pin.version}"; });
    dontUnpack = true;

    dontConfigure = true;
    dontBuild = true;
    # Static: installed as shipped, with nothing for the usual fixup to
    # strip or patch.
    dontStrip = true;
    dontPatchELF = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 $src $out/bin/muse
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    meta = {
      description = "Muse Code, Meta's interactive terminal coding agent";
      homepage = "https://ai.meta.com";
      license = lib.licenses.unfree;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "muse";
    };
  }
)
