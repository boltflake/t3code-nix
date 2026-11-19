# OpenAI's Codex CLI, from the vendor's prebuilt Linux release archive (a
# statically linked musl package root, kept whole in $out/libexec/codex).
# Changes for NixOS: the wrapper turns off codex's startup update check and
# its daemon's automatic start (which would copy codex into ~/.codex and update
# it there) and refuses the commands that would install or update codex
# outside Nix; nixpkgs' bubblewrap comes first on PATH; the bundled ripgrep
# is replaced by nixpkgs'; and only the dynamically linked voice runtime is
# patched to run against nixpkgs' glibc and its own bundled libraries. The
# static binaries are otherwise left exactly as shipped.
{
  lib,
  stdenv,
  fetchurl,
  versions,
  guard,
  zstd,
  makeWrapper,
  autoPatchelfHook,
  installShellFiles,
  bubblewrap,
  ripgrep,
}:
let
  pin = versions.load "codex";
  root = "$out/libexec/codex";
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "codex";
    inherit (pin) version;

    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);

    # The archive has no leading directory: unpack it into one of its own.
    unpackPhase = ''
      runHook preUnpack
      mkdir source
      tar --zstd -xf "$src" -C source
      runHook postUnpack
    '';
    sourceRoot = "source";

    nativeBuildInputs = [
      zstd
      makeWrapper
      autoPatchelfHook
      installShellFiles
    ];

    dontConfigure = true;
    dontBuild = true;
    # The static binaries stay byte for byte as shipped: no stripping, no
    # patchelf, and autoPatchelf only on the voice runtime (postFixup).
    dontStrip = true;
    dontPatchELF = true;
    dontAutoPatchelf = true;

    installPhase = ''
      runHook preInstall

      # codex finds its package root from bin/ and the manifest beside it.
      mkdir -p ${root}
      cp -a . ${root}/
      ln -sf ${lib.getExe ripgrep} ${root}/codex-path/rg

      makeWrapper ${root}/bin/codex $out/bin/codex \
        ${guard.refuseCodex} \
        --prefix PATH : ${lib.makeBinPath [ bubblewrap ]} \
        --add-flags "-c features.daemon_auto_start=false" \
        --add-flags "-c check_for_update_on_startup=false"
      # codex's own error message tells users to install codex-code-mode-host.
      ln -s ../libexec/codex/bin/codex-code-mode-host $out/bin/codex-code-mode-host

      ${versions.installLicenses pin}

      runHook postInstall
    '';

    postInstall = lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
      export HOME=$(mktemp -d)
      # --cmd would name the bash file codex.bash.
      installShellCompletion --bash --name codex <($out/bin/codex completion bash)
      installShellCompletion --cmd codex \
        --fish <($out/bin/codex completion fish) \
        --zsh <($out/bin/codex completion zsh)
    '';

    # The voice runtime needs only glibc (which autoPatchelf finds on its own)
    # and the libraries bundled in its lib/, which autoPatchelf finds because
    # they are among the files it patches. No buildInputs and no ignored
    # dependencies: anything else a future release needs fails the build.
    postFixup = ''
      autoPatchelf ${root}/codex-resources/voice
    '';

    meta = {
      description = "Lightweight coding agent that runs in your terminal";
      homepage = "https://github.com/openai/codex";
      license = lib.licenses.asl20;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "codex";
    };
  }
)
