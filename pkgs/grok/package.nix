# Grok Build, xAI's agentic coding CLI: the vendor's prebuilt, statically
# linked Linux executable, installed byte for byte. For NixOS it is wrapped
# so that it runs as `grok`, with its auto-updater off and `grok update`
# refused. It also answers to the command name `agent`, but that name belongs
# to cursor-agent here (a different program), so only `grok` is installed.
{
  lib,
  stdenv,
  fetchurl,
  versions,
  guard,
  makeWrapper,
  installShellFiles,
}:
let
  pin = versions.load "grok";
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "grok";
    inherit (pin) version;

    # The bare executable, no archive.
    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);
    dontUnpack = true;

    nativeBuildInputs = [
      makeWrapper
      installShellFiles
    ];

    dontConfigure = true;
    dontBuild = true;
    # Static: installed as shipped, with nothing for the usual fixup to
    # strip or patch.
    dontStrip = true;
    dontPatchELF = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 $src $out/libexec/grok/grok
      makeWrapper $out/libexec/grok/grok $out/bin/grok \
        ${guard.refuse { name = "grok"; }} \
        --argv0 grok \
        --set GROK_DISABLE_AUTOUPDATER 1
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    postInstall = lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
      export HOME=$(mktemp -d)
      # --cmd would name the bash file grok.bash.
      installShellCompletion --bash --name grok <($out/bin/grok completions bash)
      installShellCompletion --cmd grok \
        --fish <($out/bin/grok completions fish) \
        --zsh <($out/bin/grok completions zsh)
    '';

    meta = {
      description = "Grok Build, xAI's agentic coding CLI and TUI";
      homepage = "https://x.ai";
      license = lib.licenses.unfree;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "grok";
    };
  }
)
