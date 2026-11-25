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
  # Whether the module installs `t3` (cli.enable or the server); null for
  # the flake's package, which doesn't know.
  cliInstalled ? null,
  # programs.t3code.server.home (null: ~/.t3).
  serverHome ? null,
  # programs.t3code.server.users (empty: every user that isn't a system one).
  serverUsers ? [ ],
  # The module that installed it: "nixos", "home-manager", or null for the
  # flake's package.
  module ? null,
  # Home Manager only: whether it runs as a NixOS module (it then reads the
  # system's config), and whether this flake's NixOS module is in that
  # config too.
  asNixosModule ? false,
  nixosModule ? false,
  # Home Manager only: the folder it writes user units to (xdg.configHome's
  # systemd/user); null: the doctor's own config folder.
  userUnits ? null,
  # The Description= of this flake's t3code-server units: the modules write
  # their units with it (lib/module-core.nix), and the doctor knows a unit
  # as this flake's by it. One definition, here.
  unitDescription ? "T3 Code server (t3code-nix)",
  # Whether the app and the CLI leave usage data on (their wrappers'
  # `telemetry`): true, false, null (a package without the setting) or, for
  # the app, "none" (the module installs no app). The module passes the app's
  # from the package before nixGL wraps it.
  appTelemetry ? t3code.passthru.telemetry or null,
  # Whether the app is installed (false on a server-only host, whose app's
  # store path is then never read).
  appInstalled ? true,
  # The app inside Home Manager's nixGL wrapper (null: not wrapped).
  appInner ? null,
  cliTelemetry ? t3.passthru.telemetry or null,
  # The CLI's unwrapped package, which a running server of this build runs
  # (only its path is compared, so it's not part of the doctor's closure).
  cliUnwrapped ? t3.passthru.unwrapped or null,
}:
let
  cliUnwrappedPath =
    if cliUnwrapped == null then "" else builtins.unsafeDiscardStringContext (toString cliUnwrapped);
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
  onOff =
    v:
    if v == "none" then
      "none"
    else if v == null then
      "unknown"
    else if v then
      "on"
    else
      "off";
  data = writeText "t3code-nix-doctor-data" ''
    CHANNEL=${lib.escapeShellArg checked}
    NIXPKGS=${lib.escapeShellArg nixpkgs}
    ELECTRON=${lib.escapeShellArg electronLine}
    VERSION=${
      # A store path given as a string: parseDrvName takes it without context.
      lib.escapeShellArg (lib.getVersion (if builtins.isString t3code then plain t3code else t3code))
    }
    CLI=${lib.escapeShellArg (plain t3)}
    APP=${
      lib.escapeShellArg (
        if appInstalled && (t3code ? outPath || builtins.isString t3code) then plain t3code else ""
      )
    }
    APP_INNER=${
      lib.escapeShellArg (
        if appInstalled && (appInner ? outPath || builtins.isString appInner) then plain appInner else ""
      )
    }
    CLI_INSTALLED=${
      lib.escapeShellArg (
        if cliInstalled == null then
          "unknown"
        else if cliInstalled then
          "yes"
        else
          "no"
      )
    }
    SERVER=${lib.escapeShellArg server}
    SERVER_HOME=${lib.escapeShellArg (if serverHome == null then "" else serverHome)}
    SERVER_USERS=${lib.escapeShellArg (lib.concatStringsSep " " serverUsers)}
    MODULE=${lib.escapeShellArg (if module == null then "" else module)}
    NIXOS_MODULE=${lib.escapeShellArg (if nixosModule then "yes" else "no")}
    AS_NIXOS_MODULE=${lib.escapeShellArg (if asNixosModule then "yes" else "no")}
    USER_UNITS=${lib.escapeShellArg (if userUnits == null then "" else userUnits)}
    UNIT_DESCRIPTION=${lib.escapeShellArg unitDescription}
    CACHE_URL=${lib.escapeShellArg cache.url}
    CACHE_KEY=${lib.escapeShellArg (if cache.publicKey == null then "" else cache.publicKey)}
    PROVIDERS=${lib.escapeShellArg providers}
    TELEMETRY_APP=${lib.escapeShellArg (onOff appTelemetry)}
    TELEMETRY_CLI=${lib.escapeShellArg (onOff cliTelemetry)}
    CLI_UNWRAPPED=${lib.escapeShellArg cliUnwrappedPath}
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
    inherit
      commands
      t3code
      cliInstalled
      appTelemetry
      cliTelemetry
      appInner
      cliUnwrappedPath
      userUnits
      unitDescription
      ;
  };
  meta = (old.meta or { }) // {
    description = "Tells you why T3 Code (t3code-nix) isn't working; read-only";
    mainProgram = "t3code-nix-doctor";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
})
