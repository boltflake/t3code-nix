# `t3code-nix doctor`: why isn't T3 Code working? Read-only (doctor.sh).
#
# What it compares against is this build's: the app's channel and bundled
# providers, its CLI, whether the module enabled the server, and the binary
# cache. Store paths are written as plain strings (their context dropped),
# so the doctor doesn't depend on the app: `nix run .#doctor` fetches a
# shell script, not T3 Code. The module builds it from its own selection.
{
  lib,
  writeShellApplication,
  writeText,
  runtimeShell,
  coreutils,
  gnugrep,
  gnused,
  gawk,
  procps,
  versions,
  t3code,
  t3,
  cache,
  # Every provider by t3code driver name (pkgs/t3code/providers.nix).
  availableProviders,
  # T3 Code's release channel: "latest" or "nightly".
  channel ? "latest",
  # Which nixpkgs the set is built on: "unstable" (the default packages) or
  # "stable" (NixOS stable, which the binary cache doesn't hold).
  nixpkgs ? "unstable",
  # "on" or "off" from the module; "unknown" for the flake's package.
  server ? "unknown",
  # programs.t3code.server.home (null: ~/.t3).
  serverHome ? null,
  # programs.t3code.server.users (empty: every user that isn't a system one).
  serverUsers ? [ ],
}:
let
  checked = (versions.channel "t3code-nix doctor" channel).name;
  # The command T3 Code looks for on PATH, by driver: upstream's binaryPath
  # defaults, and for antigravity the name the wrapper's shim provides.
  # Cursor runs in T3 Code through its SDK (`-`: nothing is looked up).
  commands = {
    codex = "codex";
    claudeAgent = "claude";
    cursor = "-";
    grok = "grok";
    fx = "fx";
    opencode = "opencode";
    antigravity = "agy_acp_server.par";
    kiro = "kiro-cli";
    muse = "muse";
    pi = "pi";
  };
  plain = p: builtins.unsafeDiscardStringContext (toString p);
  # The bundled packages by name: a provider bundled from another build
  # (`providers = [ pkgs.codex … ]`) is described as that build. One bundled
  # under another name (say a `claude-code-bin`) isn't matched to its driver
  # and shows as not bundled.
  bundled = lib.listToAttrs (
    map (p: lib.nameValuePair (lib.getName p) p) (t3code.passthru.providers or [ ])
  );
  # Only bundled providers carry a store path: an unbundled one's isn't
  # evaluated (it may be unfree and not allowed here).
  providers = lib.concatStrings (
    lib.mapAttrsToList (
      driver: available:
      let
        name = lib.getName available;
        p = bundled.${name} or null;
      in
      if p == null then
        "${driver} ${name} - - ${commands.${driver}}\n"
      else
        "${driver} ${lib.getName p} ${lib.getVersion p} ${plain p} ${commands.${driver}}\n"
    ) availableProviders
  );
  # The desktop app's Electron (lib/electron.nix): which, and why.
  e = t3code.passthru.electron or null;
  electronLine =
    if e == null then
      ""
    else if e.choice == "bundled" then
      "Electron ${e.bundled}, bundled (${e.reason})"
    else
      "Electron ${e.version} from ${
        if e.choice == "nixpkgs" then "nixpkgs" else e.name
      } (bundled: ${e.bundled}; ${e.reason})";
  data = writeText "t3code-nix-doctor-data" ''
    CHANNEL=${lib.escapeShellArg checked}
    NIXPKGS=${lib.escapeShellArg nixpkgs}
    ELECTRON=${lib.escapeShellArg electronLine}
    VERSION=${lib.escapeShellArg (lib.getVersion t3code)}
    CLI=${lib.escapeShellArg (plain t3)}
    SERVER=${lib.escapeShellArg server}
    SERVER_HOME=${lib.escapeShellArg (if serverHome == null then "" else serverHome)}
    SERVER_USERS=${lib.escapeShellArg (lib.concatStringsSep " " serverUsers)}
    CACHE_URL=${lib.escapeShellArg cache.url}
    CACHE_KEY=${lib.escapeShellArg (if cache.publicKey == null then "" else cache.publicKey)}
    PROVIDERS=${lib.escapeShellArg providers}
  '';
  doctor = writeShellApplication {
    name = "t3code-nix-doctor";
    runtimeInputs = [
      coreutils
      gnugrep
      gnused
      gawk
      # ps, to check a codex daemon record from before 0.156 as codex does
      procps
    ];
    # systemctl and nix are the user's own (whatever this system runs).
    inheritPath = true;
    text = builtins.replaceStrings [ ". @data@" ] [ ". ${data}" ] (builtins.readFile ./doctor.sh);
    # No `set -e`: a check that can't run says so and the rest go on.
    bashOptions = [
      "nounset"
      "pipefail"
    ];
  };
in
doctor.overrideAttrs (old: {
  # `t3code-nix doctor` too.
  buildCommand = old.buildCommand + ''
    cat > $out/bin/t3code-nix <<SH
    #!${runtimeShell}
    case "\''${1:-}" in
      doctor) shift; exec $out/bin/t3code-nix-doctor "\$@" ;;
      *) echo "usage: t3code-nix doctor" >&2; exit 2 ;;
    esac
    SH
    chmod +x $out/bin/t3code-nix
  '';
  passthru = (old.passthru or { }) // {
    # The app it was built for (module-eval checks which set it came from).
    inherit commands t3code;
  };
  meta = (old.meta or { }) // {
    description = "Tells you why T3 Code (t3code-nix) isn't working; read-only";
    mainProgram = "t3code-nix-doctor";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
})
