# programs.t3code for NixOS (the flake's nixosModules.default).
#
#   packages: this flake's own packages, by system
#   stable:   the NixOS-stable set (legacyPackages.<system>.stable), by system
#   cache:    lib/cache.nix
{
  packages,
  stable ? { },
  cache,
}:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.t3code;
  inherit (pkgs.stdenv.hostPlatform) system;
  onStable = cfg.nixpkgs == "stable";
  # The set the defaults come from: the flake's, or the NixOS-stable one.
  ours =
    (if onStable then stable else packages).${system}
      or (throw "programs.t3code: t3code-nix supports Linux only (x86_64 and aarch64), not ${system}");
  # NixOS stable has T3 Code's latest channel only (an assertion below says so;
  # until then the defaults resolve to it, so evaluation gets that far).
  nightly = cfg.channel == "nightly" && !onStable;

  # `providers`, `excludeProviders` and `acpRuntimes`, as an override of a
  # wrapped package (pkgs/t3code/wrap.nix): only what was set, so defaults
  # stay the package's.
  selection =
    lib.optionalAttrs (cfg.providers != null) { inherit (cfg) providers; }
    // lib.optionalAttrs (cfg.excludeProviders != [ ]) { inherit (cfg) excludeProviders; }
    // lib.optionalAttrs (cfg.acpRuntimes != null) { inherit (cfg) acpRuntimes; }
    // lib.optionalAttrs (cfg.electron != null) { inherit (cfg) electron; };
  canSelect = p: p ? override && p ? passthru.providers;
  # acpRuntimes needs a wrapper that has it (a t3code-nix from before it
  # doesn't); without, it's left out here and the assertion below says so.
  canRuntimes = p: canSelect p && p ? passthru.acpRuntimes;
  # electron needs this flake's desktop app (its wrapper passes it on).
  canElectron = p: canSelect p && (p.passthru.electron or null) != null;
  app =
    if selection != { } && canSelect cfg.package then
      cfg.package.override (
        removeAttrs selection (
          lib.optional (!canRuntimes cfg.package) "acpRuntimes"
          ++ lib.optional (!canElectron cfg.package) "electron"
        )
      )
    else
      cfg.package;
  # The CLI bundles what the app bundles: its providers, its ACP runtimes
  # and, if it has one, its preview browser. With a package of another kind,
  # the full CLI.
  cli =
    let
      base = ours.${if nightly then "t3-nightly" else "t3"};
    in
    if canSelect app then
      base.override {
        providers = app.providers;
        acpRuntimes = app.passthru.acpRuntimes or [ ];
        withPreviewBrowser = app.passthru.previewBrowser or null != null;
        inherit (cfg.cli) allowUpstreamService;
      }
    else
      base.override { inherit (cfg.cli) allowUpstreamService; };

  # Whether anything the module installs bundles claude-code: the app, or
  # the CLI (the server's, or cli.enable's), which is the full t3 when the
  # app is a package of another kind.
  claudeBundled = builtins.any (p: lib.getName p == "claude-code") (
    lib.optionals cfg.enable (app.providers or [ ])
    ++ lib.optionals (srv.enable || cfg.cli.enable) (cli.providers or [ ])
  );

  # agent-browser with the module's browser and browserChannel, where set. A
  # package whose `browser` is a package keeps it (the package decides), and
  # only this flake's packages (which record `browserChoice`) are overridden:
  # another agent-browser with either option set is an assertion failure.
  abCfg = cfg.agentTools.agent-browser;
  abAsked = abCfg.browser != null || abCfg.browserChannel != null;
  abOurs = abCfg.package ? browserChoice && abCfg.package ? override;
  agentBrowser =
    if !abAsked || !abOurs || abCfg.package.browserChoice == "package" then
      abCfg.package
    else
      abCfg.package.override (
        lib.optionalAttrs (abCfg.browser != null) { inherit (abCfg) browser; }
        // lib.optionalAttrs (abCfg.browserChannel != null) { inherit (abCfg) browserChannel; }
      );

  srv = cfg.server;
  # systemd expands `%` specifiers in the unit's values (Environment=,
  # EnvironmentFile=, ConditionUser=). A value meant as it is gets `%`
  # doubled; a path takes `%` only as `%h`, the one the doctor expands too,
  # and no control characters (EnvironmentFile= is written unquoted: a
  # newline would start another directive).
  literal = lib.replaceStrings [ "%" ] [ "%%" ];
  pathWithHome =
    description: pattern:
    lib.types.addCheck lib.types.str (p: builtins.match pattern p != null) // { inherit description; };
  # Before a new version first starts, a copy of the database it may
  # migrate, so an older generation can be rolled back to with its data.
  backupDatabase = pkgs.writeShellScript "t3code-server-backup" ''
    set -eu
    # As t3 resolves it (resolveBaseDir): trimmed, blank is ~/.t3, `~/` (or
    # `~\`) is the home folder, and a relative path is under the unit's working
    # directory, %h.
    home=$(printf '%s' "''${T3CODE_HOME-}" | ${pkgs.gnused}/bin/sed -z -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -n "$home" ] || home=$HOME/.t3
    case $home in "~") home=$HOME ;; "~/"* | '~\'*) home=$HOME/''${home:2} ;; esac
    home=$(${pkgs.coreutils}/bin/realpath -m -- "$home")
    db=$home/userdata/statev2.sqlite
    dir=$home/t3code-nix-backups
    version=${lib.escapeShellArg (lib.getVersion cli)}
    last=$(${pkgs.coreutils}/bin/cat "$dir/last-version" 2>/dev/null || true)
    [ "$last" != "$version" ] || exit 0
    ${pkgs.coreutils}/bin/mkdir -p -m 700 "$dir"
    # A copy cut short by a stop or a shutdown.
    ${pkgs.coreutils}/bin/rm -f -- "$dir"/*.part
    if [ -f "$db" ]; then
      name=statev2-''${last:-unknown}-$(${pkgs.coreutils}/bin/date -u +%Y%m%dT%H%M%SZ).sqlite
      # SQLite's online backup: a consistent copy, WAL included.
      (cd "$dir" && ${pkgs.sqlite}/bin/sqlite3 -init /dev/null "$db" ".backup $name.part")
      ${pkgs.coreutils}/bin/mv "$dir/$name.part" "$dir/$name"
      echo "t3code-server: copied the database used by ''${last:-an earlier version} to $dir/$name"
      # The newest ${toString keepBackups} only.
      ${pkgs.coreutils}/bin/ls -1t "$dir"/statev2-*.sqlite | ${pkgs.coreutils}/bin/tail -n +${toString (keepBackups + 1)} \
        | while read -r old; do ${pkgs.coreutils}/bin/rm -f -- "$old"; done
    fi
    echo "$version" > "$dir/last-version"
  '';
  keepBackups = 3;
  # A server that finds its state directory owned by another exits with this
  # (upstream's SERVER_EXIT_CODE_STATE_DIR_OWNED): not worth restarting.
  stateDirOwned = 78;
in
{
  _file = ./module.nix;

  options.programs.t3code = {
    enable = lib.mkEnableOption "T3 Code with the providers it supports";

    nixpkgs = lib.mkOption {
      type = lib.types.enum [
        "unstable"
        "stable"
      ];
      default = "unstable";
      description = ''
        Which libraries T3 Code is built on: `"unstable"` (this flake's
        nixos-unstable, the default, in the binary cache) or `"stable"`
        (NixOS stable: the newest NixOS release this flake tests, built on
        your machine, T3 Code's latest channel only). The same T3 Code and
        providers either way, normally at the same versions; NixOS stable can
        be a set behind when a release fails only there. Picks where the
        defaults of `package`, the CLI, the server's `t3`, the doctor and the
        agent tools come from; an explicitly set `package` wins, and then the
        providers follow it. See the README, "NixOS stable".
      '';
    };

    channel = lib.mkOption {
      type = lib.types.enum [
        "latest"
        "nightly"
      ];
      default = "latest";
      description = ''
        T3 Code's release channel: `"latest"` (upstream's non-nightly
        releases) or `"nightly"` (the newer of the newest nightly and the
        latest channel's release). Picks the default `package` and the CLI
        that `cli.enable` installs. Only the latest channel is in the binary
        cache.
      '';
    };

    providers = lib.mkOption {
      type = lib.types.nullOr (lib.types.listOf lib.types.str);
      default = null;
      example = [
        "codex"
        "claude"
      ];
      description = ''
        The providers to bundle, by t3code's driver name (`codex`,
        `claudeAgent` or `claude`, `cursor`, `fx`, `grok`, `kiro`, `muse`,
        `opencode`, `antigravity`, `pi`) or this flake's package name
        (`claude-code`, `cursor-agent`, `kiro-cli`). `null` keeps the
        package's own set: all ten for `t3code`, the four free ones for
        `t3code-free`. A misspelt name fails the build with the nearest
        match. Applies as an override of `package` (and of the CLI), so
        `package` must be one of this flake's `t3code*` or `t3*` packages
        with providers.
      '';
    };

    excludeProviders = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "grok" ];
      description = ''
        Providers to leave out, named as for `providers`. Applies the same
        way, after `providers`.
      '';
    };

    electron = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.either (lib.types.enum [
          "auto"
          "bundled"
          "nixpkgs"
        ]) lib.types.package
      );
      default = null;
      example = "bundled";
      description = ''
        Which Electron the desktop app runs on: `"auto"` (nixpkgs' newer
        patch of the Electron major T3 Code bundles, when it's usable and at
        least as new; otherwise upstream's bundled one), `"bundled"`,
        `"nixpkgs"` (an evaluation error when it can't), or an Electron
        package of the same major, from the nixpkgs the app is built on.
        `null` keeps the package's own (`"auto"` for this flake's). Applies
        as an override of `package`, which must be this flake's desktop app.
        See the README, "The desktop app's Electron".
      '';
    };

    acpRuntimes = lib.mkOption {
      type = lib.types.nullOr (lib.types.listOf lib.types.str);
      default = null;
      example = [ "nodejs" ];
      description = ''
        Runtimes for agents T3 Code installs from the ACP registry: `nodejs`
        (Node and npm, for npm agents) and `uv` (uv and Python, for uv
        agents). They go at the end of T3 Code's `PATH`, so your own Node or
        uv wins. `null` keeps the package's own list (none by default); `[ ]`
        clears it. Applies as an override of `package`, and the CLI and
        server get the same list. Binary agents need `runtimeCompat` instead.
        See the README, "ACP registry agents".
      '';
    };

    agentTools.boat.enable = lib.mkEnableOption ''
      boat, boat.dev's sandbox CLI, an agent tool: a command-line tool the
      agents use themselves. Works without `enable`; it's never part of T3
      Code'';

    agentTools.agent-browser = {
      enable = lib.mkEnableOption ''
        agent-browser, Vercel's headless browser CLI for agents, an agent
        tool. Works without `enable`; it's never part of T3 Code'';
      package = lib.mkOption {
        type = lib.types.package;
        default = ours.agent-browser;
        defaultText = lib.literalExpression "t3code-nix.packages.\${system}.agent-browser";
        description = ''
          The agent-browser to install: this flake's, an `.override { … }`
          of it, or `pkgs.agent-browser` from the overlay.
        '';
      };
      browserChannel = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "unstable"
            "stable"
          ]
        );
        default = null;
        description = ''
          Which of this flake's browser pins agent-browser's browser comes
          from: `"unstable"` (nixos-unstable's) or `"stable"` (the newest
          NixOS release's). `null` keeps the package's own choice. A package
          whose `browser` is a package keeps that browser either way.
        '';
      };
      browser = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "ungoogled-chromium"
            "chromium"
            "google-chrome"
          ]
        );
        default = null;
        description = ''
          Which browser agent-browser drives: `"ungoogled-chromium"` (the
          package's default), `"chromium"`, or `"google-chrome"` (unfree:
          allowed with this flake's packages; with the overlay's package,
          your nixpkgs' `allowUnfree` decides). `null` keeps the package's
          own choice. A package whose `browser` is a package keeps that
          browser either way.
        '';
      };
    };

    cli.enable = lib.mkEnableOption ''
      the headless `t3` CLI and server too (`t3-nightly` on the nightly
      channel), bundling what the installed app bundles: its providers and
      its preview browser, if it has one'';

    cli.allowUpstreamService = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Whether this flake's `t3` may run `t3 update`, `t3 service install`,
        `t3 up` and plain `t3 connect`, which it refuses by default. They set
        up T3 Code's own download (in ~/.t3/runtime) instead of this flake's
        build: no bundled providers, updated outside Nix, and on NixOS it
        only runs with `runtimeCompat`. For using upstream's own service on
        purpose; `server` is the Nix-managed one, and `t3 connect link` gives
        it T3 Connect.
      '';
    };

    server = {
      enable = lib.mkEnableOption ''
        a T3 Code server as a systemd user service, `t3code-server`, running
        this flake's `t3 serve` with the same channel and providers as
        the app. It starts with each user's session (see `users`), or at
        boot for users with `users.users.<name>.linger`. Also installs that
        `t3`, for `t3 pair` and the like. Independent of `enable`, so a
        machine can run the server without the app'';

      users = lib.mkOption {
        # User names (any NixOS allows), not what else systemd's
        # ConditionUser takes (a UID, @system, `!` to turn it around) or
        # nothing, which the doctor can't compare.
        type = lib.types.listOf (
          lib.types.addCheck lib.types.str (u: builtins.match "[0-9]*|[@!|].*|.*[%[:space:]].*" u == null)
          // {
            description = "user name (not empty, a UID, starting with @, ! or |, or with % or spaces)";
          }
        );
        default = [ ];
        example = [ "amber" ];
        description = ''
          The users whose session runs the server. Empty: every user that
          isn't a system user; named users may be system users. Each server
          listens on `port`, so on a machine with several users, name one.
        '';
      };

      home = lib.mkOption {
        # `%` only as `%h`: systemd expands every specifier here (`%u`,
        # `%%`, …), and the doctor, which checks this home, expands `%h`.
        type = lib.types.nullOr (
          pathWithHome "path (`%` only as `%h`, no control characters)" "([^%[:cntrl:]]|%h)*"
        );
        default = null;
        example = "%h/.t3-server";
        description = ''
          The server's T3 home (`T3CODE_HOME`; `%h` or `~/` is the user's
          home folder, and a relative path is under it; no other `%`
          specifier). `null` is `~/.t3`,
          which the `t3` CLI uses too. The desktop app also uses `~/.t3`, and
          a home can have one server at a time: on a machine that runs both,
          start the app with another `T3CODE_HOME`, or give the server one
          here and pass `--base-dir` to the `t3` commands meant for it.
        '';
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 3773;
        description = "The port the server listens on (`T3CODE_PORT`).";
      };

      host = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "0.0.0.0";
        description = ''
          The address to listen on (`T3CODE_HOST`), accepting any client
          that reaches it. `null`: 127.0.0.1, or with `lan`, every
          interface for private-network clients only.
        '';
      };

      lan = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Whether to accept connections from the local network and tailnet
          (private addresses only), not only from this machine
          (`T3CODE_LAN`). Off, as for a new upstream service. Can't be
          combined with `host`.
        '';
      };

      openFirewall = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Whether to open `port` in the firewall, for `lan` or `host`.";
      };

      tailscaleServe = {
        enable = lib.mkEnableOption ''
          serving the server on this machine's tailnet through Tailscale
          Serve (`T3CODE_TAILSCALE_SERVE`). Needs `services.tailscale` and
          the user as its operator (`tailscale set --operator=<user>`)'';
        port = lib.mkOption {
          type = lib.types.port;
          default = 443;
          description = "The HTTPS port Tailscale Serve uses (`T3CODE_TAILSCALE_SERVE_PORT`).";
        };
      };

      logLevel = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "All"
            "Trace"
            "Debug"
            "Info"
            "Warn"
            "Error"
            "Fatal"
            "None"
          ]
        );
        default = null;
        description = "The server's log level (`T3CODE_LOG_LEVEL`); `null` is upstream's, Info.";
      };

      environmentFile = lib.mkOption {
        # Absolute, or under `%h/` (systemd ignores a relative one); a
        # leading `-` makes it optional.
        type = lib.types.nullOr (
          pathWithHome "absolute path, or one under `%h/` (`%` only as `%h`, no control characters)" "-?(/|%h/)([^%[:cntrl:]]|%h)*"
        );
        default = null;
        example = "/run/secrets/t3code-server.env";
        description = ''
          A file of `NAME=value` lines for the server's environment, read
          when it starts and never copied to the Nix store: for secrets, or
          other `T3CODE_*` settings. An absolute path, or one under `%h/`
          (the user's home folder); `-` first makes it optional. Values in
          it win over the options. Set
          the server's home with `home` rather than `T3CODE_HOME` here:
          `t3code-nix doctor` only knows `home`.
        '';
      };
    };

    package = lib.mkOption {
      type = lib.types.package;
      default = ours.${if nightly then "t3code-nightly" else "t3code"};
      defaultText = lib.literalExpression "t3code-nix.packages.\${system}.t3code (t3code-nightly on the nightly channel)";
      example = lib.literalExpression ''t3code-nix.packages.''${system}.t3code.override { providers = [ "codex" "claude" ]; }'';
      description = ''
        The T3 Code package to install; `providers` and `excludeProviders`
        apply to it as an override. The default is the t3code-nix
        flake's own `t3code`: built on the flake's pinned nixpkgs, with
        exactly its bundled unfree packages allowed, and the build whose
        free parts the binary cache holds. Other choices: the flake's
        `t3code-free` or `t3`, an `.override { … }` of one of them, or
        `pkgs.t3code` through the flake's overlay, which builds on this
        system's nixpkgs and follows its `allowUnfree`. For nightly, set
        `channel` instead, which also picks the CLI.
      '';
    };

    binaryCache = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Whether to add the t3code-nix binary cache and its key to
        `nix.settings`. It holds this flake's free packages only, built on
        its pinned nixpkgs. It takes effect from the rebuild after the one
        that turns it on.
      '';
    };

    claudeCodePolicy = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Whether to write a Claude Code machine policy drop-in,
        `/etc/claude-code/managed-settings.d/10-t3code-nix.json`, with its
        update switches (`DISABLE_UPDATES`, `DISABLE_AUTOUPDATER`,
        `DISABLE_INSTALLATION_CHECKS`), when the app, the server or the CLI
        bundles claude-code. The wrapper sets the same switches, but a
        settings file (a repository's `.claude/settings.json`, or
        `~/.claude/settings.json`) can turn them back off, and claude would
        then install a copy of itself outside Nix; only a machine policy
        ranks above those files. It applies to every claude on the machine,
        and sits beside a `managed-settings.json` of your own.
        `t3code-nix doctor` warns when no policy sets them.
      '';
    };

    runtimeCompat = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Whether to turn on `programs.nix-ld` with the libraries needed by
        the T3 Code server that T3 Code downloads itself, which this flake
        therefore can't patch: the one another machine's T3 Code installs
        and starts here when it connects over SSH (and upstream's own
        service, with `cli.allowUpstreamService`). Works on its own, without
        `enable` or `server.enable`. For a server on this machine, use
        `server`. Off by default because nix-ld changes how
        every unpatched program on the system starts. Best effort: what
        upstream downloads isn't pinned here.
      '';
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = !(cfg.agentTools.agent-browser.enable && abAsked && !abOurs);
          message = "programs.t3code: agentTools.agent-browser.browser and .browserChannel work only with t3code-nix's agent-browser (its packages or its overlay's); unset them, or set agentTools.agent-browser.package to it.";
        }
        {
          assertion = !(onStable && cfg.channel == "nightly");
          message = "programs.t3code: NixOS stable (nixpkgs = \"stable\") has T3 Code's latest channel only; set channel = \"latest\", or nixpkgs = \"unstable\" for nightly.";
        }
      ];
    }
    (lib.mkIf srv.enable {
      assertions = [
        {
          assertion = srv.host == null || !srv.lan;
          message = "programs.t3code: set server.host or server.lan, not both (a host always wins over lan).";
        }
        {
          assertion = !srv.tailscaleServe.enable || config.services.tailscale.enable;
          message = "programs.t3code: server.tailscaleServe needs services.tailscale.enable.";
        }
      ];
      networking.firewall.allowedTCPPorts = lib.mkIf srv.openFirewall [ srv.port ];
      # The CLI the server runs, for `t3 pair` and the like.
      environment.systemPackages = [ cli ];

      # Not t3code.service: that is upstream's, in ~/.config/systemd/user,
      # which would shadow a unit of the same name here.
      systemd.user.services.t3code-server = {
        description = "T3 Code server (t3code-nix)";
        wantedBy = [ "default.target" ];
        # A restart would end running agent turns unasked, as upstream never
        # does: a rebuild's new version starts at the next login, boot or
        # `systemctl --user restart t3code-server`.
        restartIfChanged = false;
        path = lib.optional srv.tailscaleServe.enable config.services.tailscale.package;
        environment = {
          T3CODE_PORT = toString srv.port;
          T3CODE_LAN = lib.boolToString srv.lan;
          T3CODE_TAILSCALE_SERVE = lib.boolToString srv.tailscaleServe.enable;
          T3CODE_TAILSCALE_SERVE_PORT = toString srv.tailscaleServe.port;
        }
        // lib.optionalAttrs (srv.home != null) { T3CODE_HOME = srv.home; }
        // lib.optionalAttrs (srv.host != null) { T3CODE_HOST = literal srv.host; }
        // lib.optionalAttrs (srv.logLevel != null) { T3CODE_LOG_LEVEL = srv.logLevel; };
        unitConfig = {
          # The users named, or else not the display manager's or other
          # system users' sessions.
          ConditionUser = if srv.users == [ ] then [ "!@system" ] else map (u: "|${u}") srv.users;
          StartLimitIntervalSec = 300;
          StartLimitBurst = 5;
        };
        # Upstream's unit settings (apps/server/src/cloud/bootService.ts),
        # without its launcher.
        serviceConfig = {
          Type = "simple";
          WorkingDirectory = "%h";
          ExecStartPre = backupDatabase;
          ExecStart = "${lib.getExe cli} serve";
          # t3 serve's exit on SIGTERM: a clean stop, not a failure.
          SuccessExitStatus = 130;
          # Set by desktop sessions in the user manager, these make the login
          # shell t3 reads its PATH from skip NixOS's environment, leaving
          # only the unit's few packages after a restart.
          UnsetEnvironment = [
            "__NIXOS_SET_ENVIRONMENT_DONE"
            "__ETC_PROFILE_DONE"
            # Home Manager's, which would leave out home.sessionPath.
            "__HM_SESS_VARS_SOURCED"
          ];
          # The start is the database copy (t3 serve is Type=simple), which
          # takes as long as a database of several GB takes to read.
          TimeoutStartSec = "infinity";
          EnvironmentFile = lib.mkIf (srv.environmentFile != null) srv.environmentFile;
          Restart = "always";
          RestartSec = 5;
          RestartPreventExitStatus = stateDirOwned;
          KillMode = "mixed";
          OOMPolicy = "continue";
          CPUWeight = 1000;
          IOWeight = 1000;
          MemoryLow = "1536M";
          OOMScoreAdjust = 100;
          ManagedOOMPreference = "avoid";
        };
      };
    })

    {
      environment.systemPackages =
        lib.optionals cfg.enable ([ app ] ++ lib.optional cfg.cli.enable cli)
        # `t3code-nix doctor`, knowing this configuration (a server-only
        # host too).
        ++ lib.optional (cfg.enable || srv.enable) (
          ours.doctor.override {
            t3code = app;
            t3 = cli;
            inherit (cfg) channel;
            server = if srv.enable then "on" else "off";
            serverHome = srv.home;
            serverUsers = srv.users;
          }
        );
    }

    # cli.enable installs the CLI alongside the app; on its own it would do
    # nothing, so say so.
    {
      warnings = lib.optional (cfg.cli.enable && !cfg.enable && !srv.enable) ''
        programs.t3code.cli.enable installs the t3 CLI alongside the app, so on
        its own it does nothing: set programs.t3code.enable as well, or
        programs.t3code.server.enable (which installs t3 for its users).'';
    }

    # Whatever the app or the server use: the same selection, cache and runtimes.
    (lib.mkIf (cfg.enable || srv.enable) (
      lib.mkMerge [
        {
          assertions = [
            {
              assertion = selection == { } || canSelect cfg.package;
              message = "programs.t3code: providers, excludeProviders and acpRuntimes need a package from this flake with providers (t3code, t3code-nightly, t3code-free, t3 …), not ${
                cfg.package.name or "this package"
              }; or leave them unset and set them with .override.";
            }
            {
              assertion = cfg.electron == null || canElectron cfg.package;
              message = "programs.t3code: electron needs this flake's desktop app (t3code, t3code-nightly, t3code-free or an .override of one), not ${
                cfg.package.name or "this package"
              }; or leave it unset and use .override { electron = …; }.";
            }
            {
              assertion = cfg.acpRuntimes == null || !canSelect cfg.package || canRuntimes cfg.package;
              message = "programs.t3code: acpRuntimes needs a package from a t3code-nix that has it; ${
                cfg.package.name or "this package"
              } doesn't.";
            }
          ];
        }

        (lib.mkIf (cfg.claudeCodePolicy && claudeBundled) {
          # A drop-in, so an owner's own managed-settings.json keeps working
          # beside it; copied (`mode`), as claude's doctor flags a policy
          # reached through a link out of /etc/claude-code.
          environment.etc."claude-code/managed-settings.d/10-t3code-nix.json" = {
            mode = "0444";
            text = builtins.toJSON {
              env = {
                DISABLE_UPDATES = "1";
                DISABLE_AUTOUPDATER = "1";
                DISABLE_INSTALLATION_CHECKS = "1";
              };
            };
          };
        })
      ]
    ))

    # On its own too: a machine that only another machine's T3 Code connects
    # to over SSH installs nothing else of ours.
    (lib.mkIf cfg.runtimeCompat {
      programs.nix-ld = {
        enable = true;
        # What t3-unwrapped links against (pkgs/t3code/cli.nix), from this
        # system's nixpkgs; the module-eval check compares the two.
        libraries = with pkgs; [
          stdenv.cc.cc.lib
          openssl
          libsecret
          glib
          vulkan-loader
        ];
      };
    })

    # Agent tools, each on its own: no app or server needed.
    (lib.mkIf cfg.agentTools.boat.enable { environment.systemPackages = [ ours.boat ]; })
    (lib.mkIf cfg.agentTools.agent-browser.enable { environment.systemPackages = [ agentBrowser ]; })

    # The binary cache, for the app, the server and the agent tools alike. No
    # key means no cache (lib/cache.nix).
    (lib.mkIf
      (
        (cfg.enable || srv.enable || cfg.agentTools.boat.enable || cfg.agentTools.agent-browser.enable)
        && cfg.binaryCache
        && cache.publicKey != null
      )
      {
        nix.settings = {
          substituters = [ cache.url ];
          trusted-public-keys = [ cache.publicKey ];
        };
      }
    )
  ];
}
