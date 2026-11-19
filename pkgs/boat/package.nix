# boat: boat.dev's cloud sandboxes from the command line (`boat run`,
# `boat new`, `boat exec`), an agent tool: something the agents T3 Code
# runs use themselves. Never part of t3code or t3. Its release asset is a
# static-pie executable, installed as it is.
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
  pin = versions.load "boat";
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "boat";
    inherit (pin) version;

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

    # - BOAT_NO_UPDATE: boat otherwise asks boat.dev for a newer version
    #   whenever its check interval has passed, signed in or not, and its
    #   install can't write the store. `--set`, so a user's 0 can't turn the
    #   check back on.
    # - `boat self-update` is refused with a message that says what to do.
    installPhase = ''
      runHook preInstall
      install -Dm755 $src $out/libexec/boat/boat
      makeWrapper $out/libexec/boat/boat $out/bin/boat \
        ${
          guard.refuse {
            name = "boat";
            simple = true;
            commands = [ "self-update" ];
          }
        } \
        --set BOAT_NO_UPDATE 1
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    # Its zsh script is meant for eval (it ends in `compdef`); as a file in
    # site-functions it needs the #compdef tag and to run its function, so
    # it is written out first, where a failure or a renamed function stops
    # the build.
    postInstall = lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
      export HOME=$(mktemp -d)
      # --cmd would name the bash file boat.bash.
      installShellCompletion --bash --name boat <($out/bin/boat completions bash)
      $out/bin/boat completions zsh > $HOME/zsh
      grep -q '^_boat_complete()' $HOME/zsh
      installShellCompletion --cmd boat \
        --fish <($out/bin/boat completions fish) \
        --zsh <(echo '#compdef boat'; cat $HOME/zsh; echo '_boat_complete "$@"')
    '';

    meta = {
      description = "boat.dev's cloud sandboxes from the command line";
      homepage = "https://boat.dev";
      license = lib.licenses.mit;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "boat";
    };
  }
)
