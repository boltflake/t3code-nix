# Claude Code, Anthropic's agentic coding tool for the terminal: the vendor's
# prebuilt Linux executable (Bun single-file). For NixOS it is patched to
# nixpkgs' glibc and wrapped: invoked as `claude`, its auto-updater and
# installation warnings off, its own update and install commands disabled,
# the system's CA certificates trusted unless the user chooses otherwise,
# nixpkgs' bubblewrap and socat on PATH for its sandbox, and
# `install`/`update`/`upgrade` (a copy outside Nix) refused.
{
  lib,
  stdenv,
  fetchurl,
  versions,
  guard,
  autoPatchelfHook,
  makeWrapper,
  bubblewrap,
  socat,
}:
let
  pin = versions.load "claude-code";
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "claude-code";
    inherit (pin) version;

    # The bare executable, no archive.
    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);
    dontUnpack = true;

    nativeBuildInputs = [
      autoPatchelfHook
      makeWrapper
    ];

    dontConfigure = true;
    dontBuild = true;
    # Stripping would remove the embedded JavaScript bundle.
    dontStrip = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 $src $out/libexec/claude-code/claude
      makeWrapper $out/libexec/claude-code/claude $out/bin/claude \
        ${guard.refuse { name = "claude-code"; }} \
        --argv0 claude \
        --set DISABLE_AUTOUPDATER 1 \
        --set DISABLE_INSTALLATION_CHECKS 1 \
        --set DISABLE_UPDATES 1 \
        --set-default CLAUDE_CODE_CERT_STORE system \
        --prefix PATH : ${
          lib.makeBinPath [
            bubblewrap
            socat
          ]
        }
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    meta = {
      description = "Agentic coding tool that lives in your terminal, understands your codebase and helps you code faster";
      homepage = "https://claude.com/product/claude-code";
      license = lib.licenses.unfree;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "claude";
    };
  }
)
