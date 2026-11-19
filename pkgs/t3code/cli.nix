# T3 Code's headless CLI and server (`t3`) from upstream's release archive,
# without providers. For NixOS: its ELF files are pointed at nixpkgs' glibc
# and libraries, its musl add-on folders dropped.
{
  lib,
  stdenv,
  fetchurl,
  versions,
  autoPatchelfHook,
  makeWrapper,
  openssl,
  libsecret,
  glib,
  vulkan-loader,
  # T3 Code's release channel: "latest" or "nightly".
  channel ? "latest",
}:
let
  ch = versions.channel "t3-unwrapped" channel;
  pin = versions.load "t3${ch.suffix}";
  dir = "$out/libexec/t3";
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "t3-unwrapped${ch.suffix}";
    inherit (pin) version;

    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);

    # autoPatchelf also finds the release's own lib/libatomic.so.1 for the
    # main executable.
    nativeBuildInputs = [
      autoPatchelfHook
      makeWrapper
    ];
    buildInputs = [
      stdenv.cc.cc.lib
      openssl
      libsecret
      glib
      vulkan-loader
    ];

    dontConfigure = true;
    dontBuild = true;
    # Stripping would remove the application embedded in the main executable.
    dontStrip = true;
    # A musl build left in place (outside the folders removed below) is never
    # loaded on glibc.
    autoPatchelfIgnoreMissingDeps = [ "libc.musl-*.so.1" ];

    installPhase = ''
      runHook preInstall
      mkdir -p $out/libexec $out/bin
      cp -r . ${dir}
      ${versions.dropMusl "${dir}/node_modules"}
      makeWrapper ${dir}/t3 $out/bin/t3
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    meta = {
      description = "The best way to control Claude Code, Codex and more from any computer or phone (headless CLI and server), without providers";
      homepage = "https://github.com/pingdotgg/t3code";
      license = lib.licenses.mit;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "t3";
    };
  }
)
