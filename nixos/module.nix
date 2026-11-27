# programs.t3code for NixOS (the flake's nixosModules.default), with
# programs.t3code-nix as another name for it. What it shares with the Home
# Manager module (home-manager/module.nix) is in lib/module-core.nix.
#
#   core:  lib/module-core.nix, applied to the flake's packages
#   cache: lib/cache.nix
{
  core,
  cache,
}:
{
  config,
  options,
  lib,
  pkgs,
  ...
}:
let
  ns = "programs.t3code";
  cfg = config.programs.t3code;
  srv = cfg.server;
  d = core.derive {
    inherit
      lib
      pkgs
      cfg
      ns
      ;
    kind = "nixos";
    tailscale = config.services.tailscale.package;
    serverUsers = srv.users;
    appPort = if cfg.enable && cfg.openFirewall then cfg.port else null;
  };
  inherit (d) app cli;
  shared = core.options {
    inherit lib;
    kind = "nixos";
    inherit (d) ours nightly;
  };

  # Home Manager as a NixOS module: what each user's programs.t3code-nix
  # needs from the machine (home-manager/module.nix, `machine`). Users
  # without it, or with a t3code-nix from before it, count as not using it.
  # Read only when Home Manager is imported.
  hmUsers =
    if options ? home-manager.users then
      builtins.filter (u: u.programs ? t3code-nix.machine) (builtins.attrValues config.home-manager.users)
    else
      [ ];
  hmNeeds = what: builtins.any (u: u.programs.t3code-nix.machine.${what}) hmUsers;
in
{
  _file = ./module.nix;

  # The Home Manager module's name, so the options it shares read the same
  # in both. One alias per option, not one for the whole set: an alias of a
  # set of options would wrap it in one property, so a `mkDefault` or `mkIf`
  # on one of them would never be taken apart. The option names, from the
  # declarations alone (no config: imports can't depend on it).
  imports =
    let
      declared =
        lib.recursiveUpdate
          (core.options {
            inherit lib;
            kind = "nixos";
            ours = { };
            nightly = false;
          })
          {
            server.users = null;
            server.openFirewall = null;
            openFirewall = null;
            port = null;
            binaryCache = null;
            claudeCodePolicy = null;
            runtimeCompat = null;
          };
      paths = lib.collect builtins.isList (
        lib.mapAttrsRecursiveCond (a: !(lib.isOption a)) (path: _: path) declared
      );
    in
    map (
      p:
      lib.mkAliasOptionModule
        (
          [
            "programs"
            "t3code-nix"
          ]
          ++ p
        )
        (
          [
            "programs"
            "t3code"
          ]
          ++ p
        )
    ) paths;

  options.programs.t3code = shared // {
    server = shared.server // {
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

      openFirewall = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Whether to open `port` in the firewall, for `lan` or `host`.";
      };
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Whether to open the desktop app's port, `port`, in the firewall, for
        the app's Network access (Settings → Sharing & access, which stays
        the app's setting), so devices on your network and tailnet reach
        the app's own server. It also starts the app with `T3CODE_PORT` set
        to `port`, so the app listens there rather than on the first free
        port from 3773 up; while something else holds that port, the app's
        server can't start (the app says so and keeps retrying). A
        non-blank `T3CODE_PORT` already in the app's environment wins, and
        the firewall still opens `port`. For the server (`server.enable`), use
        `server.openFirewall`. T3 Connect and Tailscale HTTPS (Tailscale
        Serve) need no open port. Applies as an override of `package`.
      '';
    };

    port = lib.mkOption {
      type = lib.types.ints.between 1 65535;
      default = 3773;
      description = ''
        The desktop app's port, with `openFirewall`: the app is started
        with it (`T3CODE_PORT`) and it's opened in the firewall. Not
        `server.port` while the server is on, since only one of them can
        listen on a port. Ports below 1024 normally need root, which the
        app doesn't have. Without `openFirewall` it does nothing (the rebuild
        warns); pin the package's `port` instead.
      '';
    };

    binaryCache = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Whether to add the t3code-nix binary cache and its key to
        `nix.settings`, when this module or a Home Manager user's
        `programs.t3code-nix` (Home Manager as a NixOS module) installs the
        app, the server or an agent tool. It holds this flake's free
        packages only, built on its pinned nixpkgs. It takes effect from the
        rebuild after the one that turns it on.
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
        bundles claude-code, here or in a Home Manager user's
        `programs.t3code-nix` (Home Manager as a NixOS module). The wrapper
        sets the same switches, but a settings file (a repository's
        `.claude/settings.json`, or `~/.claude/settings.json`) can turn them
        back off, and claude would then install a copy of itself outside
        Nix; only a machine policy ranks above those files. It applies to
        every claude on the machine, and sits beside a
        `managed-settings.json` of your own. `t3code-nix doctor` warns when
        no policy sets them.
      '';
    };

    runtimeCompat = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Whether to turn on `programs.nix-ld` with the libraries needed by
        the T3 Code server that T3 Code downloads itself, which this flake
        therefore can't patch: the one another machine's T3 Code installs
        and starts here when it connects over SSH and finds no `t3` of its
        own version here (and upstream's own service, with
        `cli.allowUpstreamService`). Works on its own, without
        `enable` or `server.enable`. For a server on this machine, use
        `server`. Off by default because nix-ld changes how
        every unpatched program on the system starts. Best effort: what
        upstream downloads isn't pinned here.
      '';
    };
  };

  config = lib.mkMerge [
    { inherit (d) assertions; }
    (lib.mkIf srv.enable {
      assertions = d.serverAssertions ++ [
        {
          assertion = !srv.tailscaleServe.enable || config.services.tailscale.enable;
          message = "${ns}: server.tailscaleServe needs services.tailscale.enable.";
        }
      ];
      networking.firewall.allowedTCPPorts = lib.mkIf srv.openFirewall [ srv.port ];
      # The CLI the server runs, for `t3 pair` and the like. At high
      # priority: the system profile ignores collisions, and another `t3` (an
      # app with withCli, the overlay's pkgs.t3code) must not win by list order.
      environment.systemPackages = [ (lib.hiPrio cli) ];

      systemd.user.services.t3code-server = {
        inherit (d.unit)
          description
          wantedBy
          path
          environment
          serviceConfig
          ;
        # A restart would end running agent turns unasked, as upstream never
        # does: a rebuild's new version starts at the next login, boot or
        # `systemctl --user restart t3code-server`.
        restartIfChanged = false;
        unitConfig = d.unit.unitConfig // {
          # The users named, or else not the display manager's or other
          # system users' sessions.
          ConditionUser = if srv.users == [ ] then [ "!@system" ] else map (u: "|${u}") srv.users;
        };
      };
    })

    {
      environment.systemPackages =
        lib.optionals cfg.enable ([ app ] ++ lib.optional cfg.cli.enable (lib.hiPrio cli))
        ++ lib.optional (cfg.enable || srv.enable) d.doctor
        # The bundled providers, for the terminal.
        ++ lib.optionals ((cfg.enable || srv.enable) && cfg.providersOnPath) (map lib.lowPrio d.bundled);
      inherit (d) warnings;
    }

    # Whatever the app or the server use: the same selection.
    (lib.mkIf (cfg.enable || srv.enable) { assertions = d.selectionAssertions; })

    # The desktop app's port (openFirewall), the app's only.
    {
      warnings =
        lib.optional (cfg.openFirewall && !cfg.enable) ''
          ${ns}.openFirewall opens the desktop app's port, so without
          ${ns}.enable it does nothing; for the server, use
          ${ns}.server.openFirewall.''
        # Set by the user: a priority above the default's (mkOptionDefault).
        ++ lib.optional (!cfg.openFirewall && options.programs.t3code.port.highestPrio < 1500) ''
          ${ns}.port applies with ${ns}.openFirewall only, so on its own
          it does nothing. To pin the app's port without opening it here
          (another firewall rule, or none), use
          package = ….t3code.override { port = …; } instead.''
        # A port pinned on the package, which openFirewall replaces.
        ++
          lib.optional
            (
              cfg.enable
              && cfg.openFirewall
              && (cfg.package.passthru.port or null) != null
              && cfg.package.passthru.port != cfg.port
            )
            ''
              ${ns}.openFirewall pins the app to ${ns}.port
              (${toString cfg.port}) and opens that one, in place of the port
              its package is pinned to (${toString cfg.package.passthru.port});
              to keep that one, set ${ns}.port = ${toString cfg.package.passthru.port}.'';
    }
    (lib.mkIf (cfg.enable && cfg.openFirewall) {
      assertions = [
        {
          assertion = d.canPort cfg.package;
          message = "${ns}: openFirewall needs this flake's desktop app from a t3code-nix that has `port` (t3code, t3code-nightly, t3code-free or an .override of one), not ${
            cfg.package.name or "this package"
          }; or open the app's port with networking.firewall.allowedTCPPorts yourself.";
        }
      ];
      networking.firewall.allowedTCPPorts = [ cfg.port ];
    })

    (lib.mkIf (cfg.claudeCodePolicy && (d.wantsPolicy || hmNeeds "policy")) {
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
    { environment.systemPackages = d.agentTools; }

    # The binary cache, for the app, the server and the agent tools alike,
    # here or for a Home Manager user. No key means no cache (lib/cache.nix).
    # (The options first: Home Manager users are read only when they apply.)
    (lib.mkIf (cfg.binaryCache && cache.publicKey != null && (d.wantsCache || hmNeeds "cache")) {
      nix.settings = {
        substituters = [ cache.url ];
        trusted-public-keys = [ cache.publicKey ];
      };
    })
  ];
}
