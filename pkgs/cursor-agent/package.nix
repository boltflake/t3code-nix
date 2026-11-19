# Cursor's agent CLI (`cursor-agent`, also `agent`): the vendor's prebuilt
# Linux package, kept together as shipped. For NixOS its dynamically linked
# ELF programs and native add-ons are patched to nixpkgs' glibc, libstdc++,
# libgcc_s and zlib (the statically linked helpers are left as they are), the
# launcher runs on nixpkgs' bash, and both commands are wrapped with its
# auto-update off, its update check pointed at a closed loopback port (so
# every update fails, the interactive menu's `/update` too), nixpkgs'
# coreutils on PATH, and `update`, `upgrade`, `install` and `set-channel`
# refused.
{
  lib,
  stdenv,
  fetchurl,
  versions,
  guard,
  autoPatchelfHook,
  makeWrapper,
  bashNonInteractive,
  coreutils,
  zlib,
}:
let
  pin = versions.load "cursor-agent";
  dir = "${placeholder "out"}/libexec/cursor-agent";
  # Cursor fetches its update information from this URL when it is set; a
  # closed port on the loopback address makes every update fail ("Failed to
  # fetch update info") and install nothing, including the interactive
  # menu's `/update`, which no command-line guard sees.
  updateCheckUrl = "http://127.0.0.1:9/cursor-agent-is-installed-by-nix";
  # Without its opt-out marker, cursor's interactive update can switch the
  # user to a "Grok agent host" it downloads. The wrapper writes it, when
  # missing, into every config folder cursor could use: $CURSOR_CONFIG_DIR,
  # $XDG_CONFIG_HOME/cursor and $HOME/.cursor. It never stops cursor starting.
  optOut = ''
    (
      # $1: the config folder.
      mark() {
        local marker=$1/grok-switch-opt-out.json now
        [[ -e $marker ]] && return 0
        ${coreutils}/bin/mkdir -p -- "$1" &&
          now=$(${coreutils}/bin/date -u +%Y-%m-%dT%H:%M:%S.%3NZ) &&
          (set -C && printf '{"schema":1,"optedOutAt":"%s"}' "$now" > "$marker")
      }
      # Each on its own: one that fails doesn't skip the others.
      if [[ -n ''${CURSOR_CONFIG_DIR-} ]]; then
        mark "$CURSOR_CONFIG_DIR" || true
      fi
      if [[ -n ''${XDG_CONFIG_HOME-} ]]; then
        mark "$XDG_CONFIG_HOME/cursor" || true
      fi
      if [[ -v HOME ]]; then
        mark "''${HOME:+$HOME/}.cursor" || true
      fi
    ) 2>/dev/null || true
  '';
  wrap = command: ''
    makeWrapper ${dir}/${command} $out/bin/${command} \
      ${guard.refuse { name = "cursor-agent"; }} \
      --run ${lib.escapeShellArg optOut} \
      --set AGENT_CLI_UPDATE_CHECK_URL ${lib.escapeShellArg updateCheckUrl} \
      --prefix PATH : ${lib.makeBinPath [ coreutils ]} \
      --add-flags --disable-auto-update
  '';
in
stdenv.mkDerivation (
  versions.installCheck {
    also = [ "agent" ];
  }
  // {
    pname = "cursor-agent";
    inherit (pin) version;

    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);
    sourceRoot = "dist-package";

    nativeBuildInputs = [
      autoPatchelfHook
      makeWrapper
    ];
    # nixpkgs' bash: the fixup phase rewrites the launcher's
    # `#!/usr/bin/env bash` to it.
    buildInputs = [
      bashNonInteractive
      stdenv.cc.cc.lib
      zlib
    ];

    dontConfigure = true;
    dontBuild = true;
    # The SEA programs carry their application after the ELF sections.
    dontStrip = true;

    installPhase = ''
      runHook preInstall
      mkdir -p $out/libexec
      cp -r . ${dir}
      # The launcher tells the program which name it was run as from its own
      # file name (`agent` or `cursor-agent`), after resolving links for its
      # directory, so `agent` gets a link of that name beside it.
      ln -s cursor-agent ${dir}/agent
      ${wrap "cursor-agent"}
      ${wrap "agent"}
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    # The statically linked helpers (rg and crepectl on both systems,
    # cursorsandbox on x86_64) are left untouched: autoPatchelfHook skips files
    # without an interpreter or dynamic section. On aarch64 cursorsandbox is
    # dynamically linked against glibc and is patched like the other dynamic
    # files.

    meta = {
      description = "Cursor CLI: run Cursor's agents in the terminal";
      homepage = "https://cursor.com/cli";
      license = lib.licenses.unfree;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "cursor-agent";
    };
  }
)
