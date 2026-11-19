# OpenCode, the open source coding agent: upstream's prebuilt Linux release
# (a Bun single-file executable). For NixOS the executable is made to load
# nixpkgs' glibc with wrap-buddy (./wrap-buddy.nix; patchelf's rewrite
# breaks it on aarch64), which also loads nixpkgs' libstdc++ at start (the
# embedded @parcel/watcher add-on needs it and can't be patched itself), and
# wrapped with its auto-update off, its own `upgrade`/`update` refused, and
# nixpkgs' fzf and ripgrep on PATH (it would otherwise download its own).
{
  lib,
  stdenv,
  fetchurl,
  versions,
  guard,
  wrapBuddy,
  makeWrapper,
  installShellFiles,
  fzf,
  ripgrep,
}:
let
  pin = versions.load "opencode";
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "opencode";
    inherit (pin) version;

    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);

    # The archive holds a lone `opencode` file, unpacked into a directory of
    # its own.
    unpackPhase = ''
      runHook preUnpack
      mkdir source
      tar -xzf "$src" -C source
      runHook postUnpack
    '';
    sourceRoot = "source";

    nativeBuildInputs = [
      wrapBuddy
      makeWrapper
      installShellFiles
    ];
    buildInputs = [ stdenv.cc.cc.lib ];
    wrapBuddyExtraNeeded = [ "libstdc++.so.6" ];

    dontConfigure = true;
    dontBuild = true;
    # Stripping would remove the embedded JavaScript bundle; patchelf
    # doesn't touch it either, only wrap-buddy does.
    dontStrip = true;
    dontPatchELF = true;
    # Patched in postFixup instead (below), where its completions need it.
    dontWrapBuddy = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 opencode $out/libexec/opencode/opencode
      makeWrapper $out/libexec/opencode/opencode $out/bin/opencode \
        ${guard.refuse { name = "opencode"; }} \
        --set OPENCODE_DISABLE_AUTOUPDATE true \
        --prefix PATH : ${
          lib.makeBinPath [
            fzf
            ripgrep
          ]
        }
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    # wrap-buddy's own run comes after postFixup (postFixupHooks run after
    # it), too late for generating the completions with opencode itself:
    # patch it here, as that run would, then run it.
    postFixup = ''
      wrapBuddy -- $out
    ''
    + lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
      export HOME=$(mktemp -d)
      # --cmd would name the bash file opencode.bash.
      installShellCompletion --bash --name opencode <($out/bin/opencode --completions bash)
      installShellCompletion --cmd opencode \
        --fish <($out/bin/opencode --completions fish) \
        --zsh <($out/bin/opencode --completions zsh)
    '';

    meta = {
      description = "Open source coding agent";
      homepage = "https://github.com/anomalyco/opencode";
      license = lib.licenses.mit;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "opencode";
    };
  }
)
