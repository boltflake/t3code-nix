# What the NixOS module (nixos/module.nix, programs.t3code) and the Home
# Manager module (home-manager/module.nix, programs.t3code-nix) share: the
# options they both have, the package selection, the CLI and doctor, and
# the server's unit as one plain description each module writes in its own
# form. A fix here reaches both.
#
#   packages:     this flake's own packages, by system
#   stable:       the NixOS-stable set (legacyPackages.<system>.stable), by system
#   serverBackup: by system, { unstable, stable }: version -> the database
#                 copy script (lib/server-backup.nix), from the flake's own
#                 package set, so both modules' ExecStartPre is one store path
{
  packages,
  stable ? { },
  serverBackup,
}:
let
  # Text that differs between the two modules, by kind.
  pick =
    kind: nixos: homeManager:
    if kind == "nixos" then nixos else homeManager;
in
{
  # The options both modules have, for options.programs.<ns>. `ours` is the
  # package set the defaults come from (it follows `nixpkgs` and `channel`).
  options =
    {
      lib,
      kind,
      ours,
      nightly,
    }:
    let
      text = pick kind;
      # systemd expands `%` specifiers in the unit's values (Environment=,
      # EnvironmentFile=, ConditionUser=). A path takes `%` only as `%h`, the
      # one the doctor expands too, and no control characters
      # (EnvironmentFile= is written unquoted: a newline would start another
      # directive).
      pathWithHome =
        description: pattern:
        lib.types.addCheck lib.types.str (p: builtins.match pattern p != null) // { inherit description; };
    in
    {
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
          releases) or `"nightly"` (upstream's nightly builds only). Picks the
          default `package` and the CLI that `cli.enable` installs. Only the
          latest channel is in the binary cache.
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
          server get the same list. ${text "Binary agents need `runtimeCompat` instead." "Binary agents run on this system's own loader (on NixOS, the NixOS module's `runtimeCompat`)."} See the README, "ACP registry agents".
        '';
      };

      telemetry.enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        example = false;
        description = ''
          Whether T3 Code sends its usage data: product usage events and
          T3 Connect relay connection traces, from the desktop app and the
          server (upstream's docs/user/telemetry.md). `false` starts the app,
          the CLI and the server with `T3CODE_TELEMETRY_ENABLED=false` unless
          the environment already sets it to something; `true` keeps the
          package's own setting (on, unless overridden with
          `telemetry = false`). It doesn't touch OpenTelemetry export to
          endpoints you configure. Applies as an override of `package`, and the
          CLI and server get the same. Running programs keep their setting
          until they restart. See the README, "Usage data".
        '';
      };

      updateCheck.enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        example = false;
        description = ''
          Whether the desktop app checks t3code-nix for a newer T3 Code and
          newer versions of the providers it bundles: then its sidebar's update
          icon shows, and clicking it lists them and says how to get them
          (update t3code-nix and rebuild your system). It fetches one small
          file from t3code-nix's site (boltflake.github.io) at start and every
          4 hours, with no ID or version sent. `false` starts the app with
          `T3CODE_NIX_UPDATE_URL` and `T3CODE_NIX_PROVIDERS` set blank, over
          any value it inherits: no check, and the icon only for updates
          upstream offers itself (a self-updating server, a provider installed
          outside Nix). Desktop
          app only; the CLI and the server don't check. Applies as an
          override of `package`. See the README, "Update notices".
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

      providersOnPath = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Whether the providers T3 Code bundles also go on `PATH`, at low
          priority, so your own package of the same command wins.
        '';
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
          only runs with ${text "`runtimeCompat`" "the NixOS module's `runtimeCompat`"}. For using upstream's own service on purpose; `server` is the
          Nix-managed one, and `t3 connect link` gives it T3 Connect. It
          applies to the module's own `t3` (`cli.enable`, the server), not to
          the one inside an app with `withCli`; for that, override the app
          with `allowUpstreamService = true`.
        '';
      };

      server = {
        enable = lib.mkEnableOption (
          text
            ''
              a T3 Code server as a systemd user service, `t3code-server`, running
              this flake's `t3 serve` with the same channel and providers as
              the app. It starts with each user's session (see `users`), or at
              boot for users with `users.users.<name>.linger`. Also installs that
              `t3`, for `t3 pair` and the like. Independent of `enable`, so a
              machine can run the server without the app''
            ''
              a T3 Code server as your systemd user service, `t3code-server`,
              running this flake's `t3 serve` with the same channel and
              providers as the app. It starts with your user manager (your first
              session), or at boot with lingering (`loginctl enable-linger`, or
              `users.users.<name>.linger` on NixOS). A new version starts at the
              next start, not at a switch. Also installs that `t3`, for `t3 pair`
              and the like. Independent of `enable`, so you can run the server
              without the app''
        );

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

        tailscaleServe = {
          enable = lib.mkEnableOption (
            text
              ''
                serving the server on this machine's tailnet through Tailscale
                Serve (`T3CODE_TAILSCALE_SERVE`). Needs `services.tailscale` and
                the user as its operator (`tailscale set --operator=<user>`)''
              ''
                serving the server on this machine's tailnet through Tailscale
                Serve (`T3CODE_TAILSCALE_SERVE`). Needs the tailscale daemon
                and you as its operator (`tailscale set --operator=$USER`).
                Supported with Home Manager as a NixOS module and
                `services.tailscale` there; elsewhere `t3` looks for
                `tailscale` on the `PATH` it reads, untested''
          );
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
          # leading `-` makes it optional. Not ending in `\`, which would join
          # the next line of the unit (EnvironmentFile= is written unquoted).
          type = lib.types.nullOr (
            pathWithHome "absolute path, or one under `%h/` (`%` only as `%h`, no control characters, not ending in `\\`)" "-?(/|%h/)(([^%[:cntrl:]]|%h)*([^\\%[:cntrl:]]|%h))?"
          );
          default = null;
          example = "/run/secrets/t3code-server.env";
          description = ''
            A file of `NAME=value` lines for the server's environment, read
            when it starts and never copied to the Nix store: for secrets, or
            other `T3CODE_*` settings. An absolute path, or one under `%h/`
            (the user's home folder); `-` first makes it optional. ${text "" "It must be readable by you: a user unit reads it as you. "}Values in it win over the options. Set
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
          `pkgs.t3code` through the flake's overlay, which builds on ${text "this system's nixpkgs" "your Home Manager's nixpkgs"} and follows its `allowUnfree`. The overlay's
          `pkgs.t3code` has its own `t3` (`withCli`); with `cli.enable` or the
          server, the module's `t3` is installed at high priority over it. For
          nightly, set `channel` instead, which also picks the CLI.${text "" " With Home Manager's nixGL set up (`targets.genericLinux.nixGL`), a desktop app is run through it."}
        '';
      };
    };

  # What the selection gives: the packages, the checks on it and the server's
  # unit, from the module's evaluated options (`cfg`). `ns` names the options
  # in messages ("programs.t3code" or "programs.t3code-nix").
  derive =
    {
      lib,
      pkgs,
      cfg,
      ns,
      kind,
      # The tailscale package for the unit's PATH, when tailscaleServe can
      # find one (null: none added).
      tailscale ? null,
      # programs.t3code.server.users, NixOS only (for the doctor).
      serverUsers ? [ ],
      # The desktop app's port, pinned (T3CODE_PORT) for a port opened in the
      # firewall (the NixOS module's openFirewall); null: upstream's scan.
      appPort ? null,
      # What the app is installed as (Home Manager: through nixGL).
      wrapApp ? (p: p),
      # More for the doctor: which module installed it.
      doctorArgs ? { },
    }:
    let
      inherit (pkgs.stdenv.hostPlatform) system;
      onStable = cfg.nixpkgs == "stable";
      # NixOS stable has T3 Code's latest channel only (an assertion below says
      # so; until then the defaults resolve to it, so evaluation gets that far).
      nightly = cfg.channel == "nightly" && !onStable;

      # `providers`, `excludeProviders` and `acpRuntimes`, as an override of a
      # wrapped package (pkgs/t3code/wrap.nix): only what was set, so defaults
      # stay the package's.
      selection =
        lib.optionalAttrs (cfg.providers != null) { inherit (cfg) providers; }
        // lib.optionalAttrs (cfg.excludeProviders != [ ]) { inherit (cfg) excludeProviders; }
        // lib.optionalAttrs (cfg.acpRuntimes != null) { inherit (cfg) acpRuntimes; }
        // lib.optionalAttrs (cfg.electron != null) { inherit (cfg) electron; }
        // lib.optionalAttrs (!cfg.telemetry.enable) { telemetry = false; }
        // lib.optionalAttrs (!cfg.updateCheck.enable) { updateCheck = false; }
        // lib.optionalAttrs (appPort != null) { port = appPort; };
      canSelect = p: p ? override && p ? passthru.providers;
      # acpRuntimes needs a wrapper that has it (a t3code-nix from before it
      # doesn't); without, it's left out here and the assertion below says so.
      canRuntimes = p: canSelect p && p ? passthru.acpRuntimes;
      # electron needs this flake's desktop app (its wrapper passes it on).
      canElectron = p: canSelect p && (p.passthru.electron or null) != null;
      # telemetry needs a wrapper that has it (a t3code-nix from before it
      # doesn't); without, it's left out here and the assertion below says so.
      canTelemetry = p: canSelect p && p ? passthru.telemetry;
      # port needs this flake's desktop app from a t3code-nix that has it.
      canPort = p: canElectron p && p ? passthru.port;
      # updateCheck too, and a desktop app with the update notice.
      canUpdateCheck =
        p: canElectron p && p ? passthru.updateCheck && (p.passthru.updateUrl or null) != null;

      srv = cfg.server;
      # systemd expands `%` specifiers in Environment=: a value meant as it is
      # gets `%` doubled.
      literal = lib.replaceStrings [ "%" ] [ "%%" ];
      # A server that finds its state directory owned by another exits with
      # this (upstream's SERVER_EXIT_CODE_STATE_DIR_OWNED): not worth
      # restarting.
      stateDirOwned = 78;
    in
    rec {
      inherit
        onStable
        nightly
        canSelect
        canPort
        ;
      # The set the defaults come from: the flake's, or the NixOS-stable one.
      ours =
        (if onStable then stable else packages).${system}
          or (throw "${ns}: t3code-nix supports Linux only (x86_64 and aarch64), not ${system}");

      app =
        if selection != { } && canSelect cfg.package then
          cfg.package.override (
            removeAttrs selection (
              lib.optional (!canRuntimes cfg.package) "acpRuntimes"
              ++ lib.optional (!canElectron cfg.package) "electron"
              ++ lib.optional (!canTelemetry cfg.package) "telemetry"
              ++ lib.optional (!canPort cfg.package) "port"
              ++ lib.optional (!canUpdateCheck cfg.package) "updateCheck"
            )
          )
        else
          cfg.package;
      # Wrapped (Home Manager: nixGL) only when the app is installed: the
      # doctor reads it on a server-only host too.
      installedApp = if cfg.enable then wrapApp app else app;
      # The CLI bundles what the app bundles: its providers, its ACP runtimes
      # and, if it has one, its preview browser; and it has the app's usage
      # data setting (off when telemetry.enable is, as for a server without
      # the app). With a package of another kind, the full CLI, with
      # telemetry.enable's.
      cli =
        let
          base = ours.${if nightly then "t3-nightly" else "t3"};
        in
        if canSelect app then
          base.override {
            inherit (app) providers;
            acpRuntimes = app.passthru.acpRuntimes or [ ];
            withPreviewBrowser = app.passthru.previewBrowser or null != null;
            telemetry = cfg.telemetry.enable && (app.passthru.telemetry or true);
            inherit (cfg.cli) allowUpstreamService;
          }
        else
          base.override {
            telemetry = cfg.telemetry.enable;
            inherit (cfg.cli) allowUpstreamService;
          };
      # The providers bundled by what the module installs: the app, or the CLI
      # (the server's, or cli.enable's), which is the full t3 when the app is a
      # package of another kind.
      bundled = lib.unique (
        lib.optionals cfg.enable (app.providers or [ ])
        ++ lib.optionals (srv.enable || cfg.cli.enable) (cli.providers or [ ])
      );
      claudeBundled = builtins.any (p: lib.getName p == "claude-code") bundled;
      # Whether the machine settings apply (the NixOS module's rules): the
      # Claude Code policy when the app or the server bundles claude-code, the
      # binary cache for the app, the server or an agent tool.
      wantsPolicy = (cfg.enable || srv.enable) && claudeBundled;
      wantsCache =
        cfg.enable || srv.enable || cfg.agentTools.boat.enable || cfg.agentTools.agent-browser.enable;

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
      agentTools =
        lib.optional cfg.agentTools.boat.enable ours.boat
        ++ lib.optional cfg.agentTools.agent-browser.enable agentBrowser;

      # `t3code-nix doctor`, knowing this configuration (a server-only host
      # too).
      doctor = ours.doctor.override (
        {
          t3code = installedApp;
          t3 = cli;
          inherit (cfg) channel;
          server = if srv.enable then "on" else "off";
          # Whether this configuration installs `cli` (else a `t3` from the app
          # itself, withCli, is the expected one).
          cliInstalled = cfg.cli.enable || srv.enable;
          serverHome = srv.home;
          inherit serverUsers;
          module = kind;
          # From the app before nixGL wraps it; none without the app.
          appTelemetry = if cfg.enable then app.passthru.telemetry or null else "none";
          appInstalled = cfg.enable;
          # (A store path given as a string has no outPath: compared as one.)
          appInner = if toString installedApp == toString app then null else app;
          cliTelemetry = cli.passthru.telemetry or null;
        }
        // doctorArgs
      );

      # Checks on any configuration.
      assertions = [
        {
          assertion = !(cfg.agentTools.agent-browser.enable && abAsked && !abOurs);
          message = "${ns}: agentTools.agent-browser.browser and .browserChannel work only with t3code-nix's agent-browser (its packages or its overlay's); unset them, or set agentTools.agent-browser.package to it.";
        }
        {
          assertion = !(onStable && cfg.channel == "nightly");
          message = "${ns}: NixOS stable (nixpkgs = \"stable\") has T3 Code's latest channel only; set channel = \"latest\", or nixpkgs = \"unstable\" for nightly.";
        }
      ];
      # Checks when the app or the server is used.
      selectionAssertions = [
        {
          assertion =
            removeAttrs selection [
              "telemetry"
              "port"
              "updateCheck"
            ] == { }
            || canSelect cfg.package;
          message = "${ns}: providers, excludeProviders and acpRuntimes need a package from this flake with providers (t3code, t3code-nightly, t3code-free, t3 …), not ${
            cfg.package.name or "this package"
          }; or leave them unset and set them with .override.";
        }
        {
          assertion = cfg.electron == null || canElectron cfg.package;
          message = "${ns}: electron needs this flake's desktop app (t3code, t3code-nightly, t3code-free or an .override of one), not ${
            cfg.package.name or "this package"
          }; or leave it unset and use .override { electron = …; }.";
        }
        {
          assertion = cfg.acpRuntimes == null || !canSelect cfg.package || canRuntimes cfg.package;
          message = "${ns}: acpRuntimes needs a package from a t3code-nix that has it; ${
            cfg.package.name or "this package"
          } doesn't.";
        }
        {
          # The app's only: the CLI and the server take it either way.
          assertion = cfg.telemetry.enable || !cfg.enable || canTelemetry cfg.package;
          message = "${ns}: telemetry.enable = false needs a package from a t3code-nix that has it (t3code, t3code-nightly, t3code-free, t3 … or an .override of one), not ${
            cfg.package.name or "this package"
          }; or set T3CODE_TELEMETRY_ENABLED=false in its environment yourself.";
        }
        {
          assertion = cfg.updateCheck.enable || !cfg.enable || canUpdateCheck cfg.package;
          message = "${ns}: updateCheck.enable = false needs this flake's desktop app from a t3code-nix that has it (t3code, t3code-nightly, t3code-free … or an .override of one), not ${
            cfg.package.name or "this package"
          }.";
        }
      ];
      serverAssertions = [
        {
          assertion = srv.host == null || !srv.lan;
          message = "${ns}: set server.host or server.lan, not both (a host always wins over lan).";
        }
        # Whatever pins the app's port (the NixOS module's openFirewall, or
        # the package's own `port`), the server can't share it. The app is
        # read only when it's installed.
        {
          assertion = !(cfg.enable && (app.passthru.port or null) == srv.port);
          message = "${ns}: the desktop app's port and server.port are both ${toString srv.port}, and only one of the app and the server can listen on it; ${
            if appPort != null then "set ${ns}.port" else "set the package's port"
          } to another one.";
        }
      ];
      # cli.enable installs the CLI alongside the app; on its own it would do
      # nothing, so say so.
      warnings = lib.optional (cfg.cli.enable && !cfg.enable && !srv.enable) ''
        ${ns}.cli.enable installs the t3 CLI alongside the app, so on
        its own it does nothing: set ${ns}.enable as well, or
        ${ns}.server.enable (which installs t3 for ${pick kind "its users" "you"}).'';

      # The server's unit, which each module writes in its own form.
      # Upstream's unit settings (apps/server/src/cloud/bootService.ts),
      # without its launcher. Not t3code.service: that is upstream's, in
      # ~/.config/systemd/user, which would shadow a unit of the same name.
      unit = {
        # The doctor's, which knows this flake's units by it.
        description = ours.doctor.unitDescription;
        wantedBy = [ "default.target" ];
        path = lib.optional (srv.tailscaleServe.enable && tailscale != null) tailscale;
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
          StartLimitIntervalSec = 300;
          StartLimitBurst = 5;
        };
        serviceConfig = {
          Type = "simple";
          WorkingDirectory = "%h";
          # Before a new version first starts, a copy of the database it may
          # migrate, so an older generation can be rolled back to with its
          # data.
          ExecStartPre = serverBackup.${system}.${if onStable then "stable" else "unstable"} (
            lib.getVersion cli
          );
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
        }
        // lib.optionalAttrs (srv.environmentFile != null) { EnvironmentFile = srv.environmentFile; };
      };
    };
}
