# fx, Vercel's native coding agent: the vendor's static Linux executable,
# installed as shipped. For NixOS it is wrapped so that its background
# updater is off and `fx update` is refused.
{
  lib,
  stdenv,
  fetchurl,
  versions,
  guard,
  makeWrapper,
}:
let
  pin = versions.load "fx";
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "fx";
    inherit (pin) version;

    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);

    # The archive has no top directory.
    unpackPhase = ''
      runHook preUnpack
      mkdir source
      tar -xzf "$src" -C source
      runHook postUnpack
    '';
    sourceRoot = "source";

    nativeBuildInputs = [ makeWrapper ];

    dontConfigure = true;
    dontBuild = true;
    # Static: installed as shipped, with nothing for the usual fixup to
    # strip or patch.
    dontStrip = true;
    dontPatchELF = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 fx $out/libexec/fx/fx
      # fx downloads and installs updates in the background unless told not
      # to (fx.sh/docs/configure-fx/configuration: FX_AUTO_UPGRADE=0).
      makeWrapper $out/libexec/fx/fx $out/bin/fx \
        ${guard.refuse { name = "fx"; }} \
        --set FX_AUTO_UPGRADE 0
      install -Dm644 -t $out/share/licenses/fx THIRD_PARTY_NOTICES.md
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    meta = {
      description = "Tiny, open, embeddable, native coding agent";
      homepage = "https://github.com/vercel-labs/fx";
      license = lib.licenses.asl20;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "fx";
    };
  }
)
