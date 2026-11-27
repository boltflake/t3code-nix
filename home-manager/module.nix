# programs.t3code-nix for Home Manager (the flake's homeModules.default):
# the NixOS module's options that make sense for one user, installed into
# this user's profile, and the server as this user's systemd unit. What it
# shares with the NixOS module is in lib/module-core.nix. Home Manager's own
# programs.t3code (settings, keybindings, themes) stays usable beside it.
#
#   core: lib/module-core.nix, applied to the flake's packages
{ core }:
{
  config,
  options,
  lib,
  pkgs,
  ...
}@args:
let
  ns = "programs.t3code-nix";
  cfg = config.programs.t3code-nix;
  srv = cfg.server;
  # Home Manager as a NixOS module passes the system's config; standalone
  # Home Manager doesn't.
  osConfig = args.osConfig or null;
  onNixos = osConfig != null;
  # This flake's NixOS module, imported there too (it has the machine-wide
  # options).
  ourNixos = onNixos && osConfig ? programs.t3code.claudeCodePolicy;
  osTailscale = onNixos && osConfig.services.tailscale.enable or false;

  # A desktop app runs through Home Manager's nixGL when that's set up
  # (identity otherwise, and on a Home Manager without it). Not this flake's
  # CLI (providers, no Electron); a package of another kind may be a desktop
  # app, so it is.
  # Only a package nixGL can wrap (one with overrideAttrs): a store path given
  # as a string or path, or a bare derivation, is installed as it is.
  isCli = p: p ? passthru.providers && (p.passthru.electron or null) == null;
  wrapApp =
    p: if config.lib ? nixGL.wrap && p ? overrideAttrs && !isCli p then config.lib.nixGL.wrap p else p;

  d = core.derive {
    inherit
      lib
      pkgs
      cfg
      ns
      wrapApp
      ;
    kind = "home-manager";
    tailscale = if osTailscale then osConfig.services.tailscale.package else null;
    doctorArgs = {
      nixosModule = ourNixos;
      asNixosModule = onNixos;
      userUnits = "${config.xdg.configHome}/systemd/user";
    };
  };
  inherit (d) cli;
  shared = core.options {
    inherit lib;
    kind = "home-manager";
    inherit (d) ours nightly;
  };

  # The NixOS module's machine-wide options: here only to say where they
  # live, if a NixOS config is copied over.
  nixosOnly =
    what:
    lib.mkOption {
      type = lib.types.unspecified;
      visible = false;
      description = "NixOS only: ${what}.";
    };
  machineWide = {
    binaryCache = "the machine's nix.settings";
    claudeCodePolicy = "a machine policy in /etc/claude-code";
    runtimeCompat = "nix-ld, a system setting";
    "server.users" = "this unit is yours alone";
    "server.openFirewall" = "the system's firewall";
    openFirewall = "the system's firewall";
    port = "the desktop app's port, opened in the system's firewall";
  };
  # The NixOS module's desktop-app port: it pins the app that module
  # installs, never this one.
  appPortOptions = {
    openFirewall = null;
    port = null;
  };
  setMachineWide = builtins.filter (
    n: (lib.attrByPath (lib.splitString "." n) { } options.programs.t3code-nix).isDefined or false
  ) (builtins.attrNames machineWide);

  # Home Manager's own programs.t3code (release-26.05 and later).
  theirs = config.programs.t3code;
  hasTheirs = options.programs ? t3code.package;
  # Its server, where it has one.
  theirServer = options.programs ? t3code.server.enable && theirs.server.enable;

  # The unit's PATH, as NixOS writes it for a user service: its `path` plus
  # systemd.defaultPath (the system's, with Home Manager as a NixOS module;
  # NixOS's default otherwise), so the two units run with the same one.
  unitPath =
    d.unit.path
    ++ (
      # (NixOS 26.05 has no systemd.defaultPath: its fixed list then, from
      # the system's package set.)
      if onNixos then
        osConfig.systemd.defaultPath or (with osConfig._module.args.pkgs or pkgs; [
          coreutils
          findutils
          gnugrep
          gnused
          osConfig.systemd.package
        ])
      else
        with pkgs;
        [
          coreutils
          findutils
          gnugrep
          gnused
          systemd
        ]
    );
  environment = d.unit.environment // {
    PATH = "${lib.makeBinPath unitPath}:${lib.makeSearchPathOutput "bin" "sbin" unitPath}";
  };
in
{
  _file = ./module.nix;

  options.programs.t3code-nix = shared // {
    server = shared.server // {
      users = nixosOnly machineWide."server.users";
      openFirewall = nixosOnly machineWide."server.openFirewall";
    };
    binaryCache = nixosOnly machineWide.binaryCache;
    claudeCodePolicy = nixosOnly machineWide.claudeCodePolicy;
    runtimeCompat = nixosOnly machineWide.runtimeCompat;
    openFirewall = nixosOnly machineWide.openFirewall;
    port = nixosOnly machineWide.port;

    # What this user needs from the machine, for this flake's NixOS module
    # with Home Manager as a NixOS module (nixos/module.nix reads it). Two
    # options, so reading one never evaluates the other: the cache rule must
    # not read the providers, which may read the machine's nix.settings.
    machine =
      lib.genAttrs
        [
          "policy"
          "cache"
        ]
        (
          what:
          lib.mkOption {
            internal = true;
            readOnly = true;
            type = lib.types.bool;
            description =
              {
                policy = "Whether the app, the server or its CLI bundles claude-code (the NixOS module's claudeCodePolicy).";
                cache = "Whether the app, the server or an agent tool is used (the NixOS module's binaryCache).";
              }
              .${what};
          }
        );
  };

  config = lib.mkMerge [
    {
      programs.t3code-nix.machine = {
        policy = d.wantsPolicy;
        cache = d.wantsCache;
      };
      assertions =
        d.assertions
        ++ map (n: {
          assertion = false;
          message =
            if appPortOptions ? ${n} then
              "${ns}.${n} is a NixOS option (${machineWide.${n}}), for the app the NixOS module installs, so it can't pin this one: open the app's port in your system's firewall, and pin the app to it with ${ns}.package = ….t3code.override { port = …; }; see the README, \"What Home Manager can't do\"."
            else
              "${ns}.${n} is a NixOS option (${machineWide.${n}}), which Home Manager can't set: on NixOS, set programs.t3code.${n} in this flake's NixOS module; elsewhere see the README, \"What Home Manager can't do\".";
        }) setMachineWide;
      inherit (d) warnings;
    }

    (lib.mkIf (cfg.enable || srv.enable) { assertions = d.selectionAssertions; })

    {
      home.packages =
        lib.optionals cfg.enable ([ d.installedApp ] ++ lib.optional cfg.cli.enable (lib.hiPrio cli))
        # The CLI the server runs, for `t3 pair` and the like. At high
        # priority: Home Manager's profile fails on two `t3` at the same
        # priority (an app with withCli has one), and this is the one the
        # server runs and the doctor checks.
        ++ lib.optional srv.enable (lib.hiPrio cli)
        ++ lib.optional (cfg.enable || srv.enable) d.doctor
        # The bundled providers, for the terminal.
        ++ lib.optionals ((cfg.enable || srv.enable) && cfg.providersOnPath) (map lib.lowPrio d.bundled)
        # Agent tools, each on its own: no app or server needed.
        ++ d.agentTools;
    }

    (lib.mkIf srv.enable {
      assertions = d.serverAssertions ++ [
        {
          assertion = config.systemd.user.enable or true;
          message = "${ns}: server.enable needs Home Manager's systemd.user.enable, which writes the unit.";
        }
        {
          assertion = !srv.tailscaleServe.enable || !onNixos || osTailscale;
          message = "${ns}: server.tailscaleServe needs services.tailscale.enable in the NixOS config.";
        }
      ];

      systemd.user.services.t3code-server = {
        Unit = d.unit.unitConfig // {
          Description = d.unit.description;
          # A switch doesn't restart it (sd-switch honours this): a restart
          # would end running agent turns unasked, as upstream never does.
          # A new version starts at the unit's next start.
          X-SwitchMethod = "keep-old";
        };
        Service = d.unit.serviceConfig // {
          # Quoted as NixOS quotes them, so values with spaces stay whole.
          Environment = lib.mapAttrsToList (n: v: builtins.toJSON "${n}=${v}") environment;
        };
        Install.WantedBy = d.unit.wantedBy;
      };
    })

    # With Home Manager as a NixOS module and this flake's NixOS module too.
    {
      warnings =
        lib.optional (ourNixos && srv.enable && osConfig.programs.t3code.server.enable) ''
          ${ns}.server and the NixOS module's programs.t3code.server are both on:
          your t3code-server unit shadows the system one for you, and other users
          may still run the system one on the same port. Turn one of them off.''
        ++ lib.optional (ourNixos && cfg.enable && osConfig.programs.t3code.enable) ''
          ${ns}.enable and the NixOS module's programs.t3code.enable both install
          T3 Code, in your profile and the system's; which one a menu or a shell
          finds isn't defined. Turn one of them off.'';
    }

    # Home Manager's own programs.t3code. Its rules apply only when its
    # `enable` is on; on a Home Manager without it, none of this exists.
    (lib.optionalAttrs hasTheirs (
      lib.mkMerge [
        # Our app is the app: theirs installs none. Below mkDefault, so a
        # user's own mkDefault wins (and then the assertion below says so)
        # rather than tying.
        (lib.mkIf (cfg.enable && theirs.enable) { programs.t3code.package = lib.mkOverride 1200 null; })
        (lib.mkIf theirs.enable {
          assertions = [
            {
              assertion = !(cfg.enable && theirs.package != null);
              message = "${ns}.enable and Home Manager's programs.t3code.package (${
                theirs.package.name or "a package"
              }) both install T3 Code: set programs.t3code.package = null, or turn ${ns}.enable off.";
            }
            {
              assertion = !(srv.enable && theirServer);
              message = "${ns}.server and Home Manager's programs.t3code.server are both on: two servers would contend for port 3773 and ~/.t3. Turn one of them off.";
            }
            {
              assertion = !(cfg.enable && !srv.enable && theirServer);
              message = "Home Manager's programs.t3code.server needs its own package, which ${ns}.enable replaces with this flake's app: use ${ns}.server.enable instead, and turn programs.t3code.server off.";
            }
          ];
        })
      ]
    ))
  ];
}
