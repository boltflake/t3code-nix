# The checks that use Home Manager (ci/home-manager.json, fetched only by
# these): every name starts with `hm-`, and no other check may force the
# fetch (home-manager-lazy, scripts/ci/test.ts, checks that). Home Manager
# master can break: each of its evaluations here goes through tryEval, so a
# thrown error, a removed option, a type error or a failed assertion is a
# false condition (a failed check that names it), not an evaluation error
# that fails CI's whole part. tryEval catches only throws, so what it
# couldn't (a missing file, attribute or function argument) is turned into
# one here: its files through `hmFile`, its functions through `hmCall`, and
# its attributes read with `or`. Left: an evaluator error inside Home
# Manager's own code, which only a broken master would have.
{
  lib,
  pkgs,
  path,
  runCommand,
  self,
  cache,
  packages,
  overlayAllowed,
  homeManager,
  conditions,
}:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  # Whether v evaluates (deeply: not a derivation, whose inputs deepSeq
  # would walk), and its value or a fallback.
  evaluates = v: (builtins.tryEval (builtins.deepSeq v v)).success;
  valueOr =
    fallback: v:
    let
      r = builtins.tryEval (builtins.deepSeq v v);
    in
    if r.success then r.value else fallback;
  # Each condition, false where it throws.
  safe = builtins.mapAttrs (_: valueOr false);

  user = {
    home.username = "alice";
    home.homeDirectory = "/home/alice";
    home.stateVersion = "26.05";
    # Not built in the profiles (no cache holds it).
    manual.manpages.enable = false;
  };
  # A standalone Home Manager configuration with our module, evaluated as
  # Home Manager's modules/default.nix does, without its last step (which
  # throws on a failed assertion, so its messages couldn't be read). On
  # exactly the pkgs given (as with useGlobalPkgs): its nixpkgs module would
  # import nixpkgs afresh, without this set's overlay.
  hmFile =
    rel:
    let
      p = homeManager + rel;
    in
    if builtins.pathExists p then p else throw "hm-checks: Home Manager has no ${rel}";
  # A Home Manager function called with only the arguments it takes, and a
  # throw (not an evaluator error) if it wants one this doesn't give.
  hmCall =
    f: args:
    let
      wanted = builtins.functionArgs f;
      missing = builtins.filter (n: !wanted.${n} && !(args ? ${n})) (builtins.attrNames wanted);
    in
    if !builtins.isFunction f then
      throw "hm-checks: a Home Manager entry point isn't a function"
    else if missing != [ ] then
      throw "hm-checks: a Home Manager entry point wants ${toString missing}"
    else
      f (builtins.intersectAttrs wanted args);
  # The first of a list, or a throw (builtins.head [ ] isn't one).
  first = l: if l == [ ] then throw "hm-checks: none found" else builtins.head l;
  homeWith =
    {
      pkgs ? overlayAllowed,
      module ? self.homeModules.default,
    }:
    modules:
    let
      hmLib = import (hmFile "/modules/lib/stdlib-extended.nix") pkgs.lib;
    in
    hmLib.evalModules {
      modules = [
        module
        user
      ]
      ++ modules
      ++ hmCall (import (hmFile "/modules/modules.nix")) {
        inherit pkgs;
        lib = hmLib;
        check = true;
        useNixpkgsModule = false;
      };
      class = "homeManager";
      specialArgs.modulesPath = toString (homeManager + "/modules");
    };
  home = homeWith { };
  ours = settings: home [ { programs.t3code-nix = settings; } ];
  # Home Manager's own programs.t3code too.
  both =
    settings: theirs:
    home [
      {
        programs.t3code-nix = settings;
        programs.t3code = theirs;
      }
    ];

  cfgOf = h: h.config;
  pkgsOf = h: h.config.home.packages;
  installed = h: name: builtins.filter (p: lib.getName p == name) (pkgsOf h);
  drvs = map (p: p.drvPath);
  has = h: p: builtins.elem p.drvPath (drvs (pkgsOf h));
  failed = h: map (a: a.message) (builtins.filter (a: !a.assertion) h.config.assertions);
  failsWith = h: text: builtins.any (lib.hasInfix text) (failed h);
  noneFailed = h: failed h == [ ];
  warnsWith = h: text: builtins.any (lib.hasInfix text) h.config.warnings;
  unitOf = h: h.config.systemd.user.services.t3code-server or (throw "no t3code-server user unit");
  providersOf = p: map lib.getName p.providers;

  # nixpkgs = "stable" routed to a stand-in set (as the stable suite's own
  # module-eval does with the real one): its t3code is t3code-free here.
  standInStable = removeAttrs packages [ "t3code" ] // {
    t3code = packages.t3code-free;
  };
  routed = import ../home-manager/module.nix {
    core = import ./module-core.nix {
      inherit (self) packages;
      inherit cache;
      stable.${system} = standInStable;
      serverBackup.${system} = {
        unstable = import ./server-backup.nix { inherit pkgs; };
        stable = import ./server-backup.nix { inherit pkgs; };
      };
    };
  };
  onStable = homeWith { module = routed; } [ { programs.t3code-nix.nixpkgs = "stable"; } ];
  onStableNightly = homeWith { module = routed; } [
    {
      programs.t3code-nix = {
        nixpkgs = "stable";
        channel = "nightly";
        enable = true;
      };
    }
  ];

  # A stand-in nixGL: its wrapper prints a marker and runs the program.
  fakeGL = {
    nixGLIntel = pkgs.writeShellScriptBin "nixGLIntel" ''exec "$@"'';
  };
  withGL =
    settings:
    home [
      {
        programs.t3code-nix = settings;
        targets.genericLinux.nixGL.packages = fakeGL;
      }
    ];

  app = home [ { programs.t3code-nix.enable = true; } ];
  appCli = ours {
    enable = true;
    cli.enable = true;
    package = overlayAllowed.t3code;
  };
  freeServer = ours {
    package = packages.t3-free;
    enable = true;
    server.enable = true;
  };
  serverOnly = ours { server.enable = true; };
  picked = ours {
    enable = true;
    providers = [
      "codex"
      "claude"
    ];
    excludeProviders = [ "claude" ];
  };
  nightly = ours {
    enable = true;
    channel = "nightly";
    cli.enable = true;
  };
  cliAlone = ours { cli.enable = true; };
  # Usage data off: the app with its CLI, and the server alone.
  telemetryOff = ours {
    enable = true;
    cli.enable = true;
    telemetry.enable = false;
  };
  telemetryServer = ours {
    server.enable = true;
    telemetry.enable = false;
  };
  telemetryOf = h: name: map (p: p.passthru.telemetry or null) (installed h name);
  toolsAlone = ours {
    agentTools.boat.enable = true;
    agentTools.agent-browser.enable = true;
  };
  nixosOnly =
    map
      (
        settings:
        ours (
          {
            enable = true;
          }
          // settings
        )
      )
      [
        { binaryCache = true; }
        { claudeCodePolicy = false; }
        { runtimeCompat = true; }
        { server.users = [ "alice" ]; }
        { server.openFirewall = true; }
      ];

  # With Home Manager's own module.
  theirsKept = both { server.enable = true; } { enable = true; };
  theirsNulled = both { enable = true; } {
    enable = true;
    userSettings.defaultTheme = "dark";
  };
  theirsMkDefault = both { enable = true; } {
    enable = true;
    package = lib.mkDefault packages.t3code-free;
  };
  bothServersApp =
    both
      {
        enable = true;
        server.enable = true;
      }
      {
        enable = true;
        server.enable = true;
      };
  bothServers = both { server.enable = true; } {
    enable = true;
    server.enable = true;
  };
  theirServerOurApp = both { enable = true; } {
    enable = true;
    server.enable = true;
  };
  theirsOff = both {
    enable = true;
    server.enable = true;
  } { server.enable = true; };
  theirsAlone = home [
    {
      programs.t3code = {
        enable = true;
        server.enable = true;
      };
    }
  ];
  withoutTheirs = home [
    {
      disabledModules = [ "programs/t3code.nix" ];
      programs.t3code-nix = {
        enable = true;
        server.enable = true;
      };
    }
  ];

  noSystemd = home [
    {
      programs.t3code-nix.server.enable = true;
      systemd.user.enable = false;
    }
  ];

  # Profiles, built (collisions show only when home.path builds).
  # From the flake's own app with its CLI (what the overlay's pkgs.t3code
  # is, but with the flake's Electron fallback, as CI's desktop part builds
  # it), so a nixpkgs Electron that breaks doesn't fail these.
  flakeAppWithCli = packages.t3code.override { withCli = true; };
  profiles = {
    # An app with its own t3, and the module's CLI.
    appWithCli = ours {
      enable = true;
      cli.enable = true;
      package = flakeAppWithCli;
    };
    # A CLI as the package, with the server: one t3, the server's.
    cliAsPackage = freeServer;
    # Our server beside Home Manager's own app (theirs keeps its package).
    theirApp = both { server.enable = true; } {
      enable = true;
      package = flakeAppWithCli;
    };
    # Our app and server, theirs with its package nulled.
    nulled = both {
      enable = true;
      server.enable = true;
    } { enable = true; };
  };
  # Home Manager as a NixOS module, with this flake's NixOS module and a
  # made-up cache (so the cache rule doesn't depend on lib/cache.nix): each
  # user a Home Manager module.
  example = {
    url = "https://example.cachix.org";
    publicKey = "example.cachix.org-1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  };
  nixosModule = import ../nixos/module.nix {
    core = import ./module-core.nix {
      inherit (self) packages;
      cache = example;
      serverBackup.${system}.unstable = import ./server-backup.nix { inherit pkgs; };
    };
    cache = example;
  };
  nixosWith =
    {
      useGlobalPkgs ? true,
      useUserPackages ? true,
      nixos ? { },
    }:
    users:
    (import (path + "/nixos/lib/eval-config.nix") {
      system = null;
      modules = [
        nixosModule
        (hmFile "/nixos")
        {
          nixpkgs.pkgs = pkgs;
          home-manager = {
            inherit useGlobalPkgs useUserPackages;
            users = builtins.mapAttrs (_: m: {
              imports = [ m ];
              home.stateVersion = "26.05";
            }) users;
          };
          users.users = builtins.mapAttrs (_: _: { isNormalUser = true; }) users;
        }
        nixos
      ];
    }).config;
  # A user with our Home Manager module.
  on = settings: {
    imports = [ self.homeModules.default ];
    programs.t3code-nix = settings;
  };
  policyOf = c: c.environment.etc ? "claude-code/managed-settings.d/10-t3code-nix.json";
  cacheOf = c: builtins.elem example.url (c.nix.settings.substituters or [ ]);
  # [policy, cache] for a NixOS config.
  machineOf = c: [
    (policyOf c)
    (cacheOf c)
  ];
  pkgModes = lib.cartesianProduct {
    useGlobalPkgs = [
      true
      false
    ];
    useUserPackages = [
      true
      false
    ];
  };
  # A NixOS config and a Home Manager user's server, with this unit's lines
  # that must match: ExecStart, ExecStartPre and Environment (PATH too).
  paired =
    {
      server,
      nixos ? { },
    }:
    let
      c = nixosWith { inherit nixos; } {
        alice = on { inherit server; };
      };
    in
    {
      nixosUnit = pkgs.writeText "nixos-t3code-server.service" (
        valueOr "" c.systemd.user.units."t3code-server.service".text
      );
      homeUnit =
        valueOr ""
          c.home-manager.users.alice.xdg.configFile."systemd/user/t3code-server.service".source
            or (throw "hm-checks: Home Manager writes no t3code-server unit");
    };
  parity = {
    defaults = paired {
      server.enable = true;
      nixos.programs.t3code.server.enable = true;
    };
    quoted = paired {
      server = {
        enable = true;
        host = "a b%c \"d\"";
        home = "%h/.t3 server";
        environmentFile = "-%h/t3 env";
        logLevel = "Debug";
      };
      nixos.programs.t3code.server = {
        enable = true;
        host = "a b%c \"d\"";
        home = "%h/.t3 server";
        environmentFile = "-%h/t3 env";
        logLevel = "Debug";
      };
    };
    tailscale = paired {
      server = {
        enable = true;
        tailscaleServe.enable = true;
      };
      nixos = {
        services.tailscale.enable = true;
        programs.t3code.server = {
          enable = true;
          tailscaleServe.enable = true;
        };
      };
    };
  };

  # A profile's store path, or null when it doesn't evaluate.
  profileOf = name: valueOr null profiles.${name}.config.home.path.outPath;
  # The module's t3: the one at high priority.
  t3Of =
    h: valueOr null (first (builtins.filter (p: p.meta.priority or 5 < 5) (installed h "t3"))).outPath;
in
{
  hm-module-eval =
    conditions "hm-module-eval"
      (safe {
        "the flake exports the module under homeModules and homeManagerModules" =
          builtins.all
            (m: has (homeWith { module = m; } [ { programs.t3code-nix.enable = true; } ]) packages.t3code)
            [
              self.homeModules.default
              self.homeModules.t3code-nix
              self.homeManagerModules.default
              self.homeManagerModules.t3code-nix
            ];
        "default.nix exports the same module" = has (homeWith {
          module = (import ../default.nix { inherit system; }).homeModules.default;
        } [ { programs.t3code-nix.enable = true; } ]) packages.t3code;
        "enable installs the flake's t3code, the doctor and the providers, and no t3" =
          has app packages.t3code
          && installed app "t3code-nix-doctor" != [ ]
          && has app packages.codex
          && installed app "t3" == [ ];
        "the bundled providers are at low priority" = builtins.all (p: p.meta.priority or 5 == 10) (
          installed app "codex"
        );
        "providers and excludeProviders apply to the app" =
          map providersOf (installed picked "t3code") == [ [ "codex" ] ];
        "the nightly channel installs t3code-nightly and t3-nightly" =
          !(packages ? t3code-nightly)
          || (has nightly packages.t3code-nightly && installed nightly "t3-nightly" != [ ]);
        "nixpkgs = \"stable\" takes the stable set's defaults" =
          (cfgOf onStable).programs.t3code-nix.package.drvPath == packages.t3code-free.drvPath;
        "NixOS stable with the nightly channel fails, naming the fix" =
          failsWith onStableNightly "programs.t3code-nix: NixOS stable (nixpkgs = \"stable\") has T3 Code's latest channel only";
        "another package is installed as it is" = has freeServer packages.t3-free && noneFailed freeServer;
        "cli.enable alone warns, naming programs.t3code-nix" =
          warnsWith cliAlone "programs.t3code-nix.cli.enable installs the t3 CLI alongside the app";
        "agent tools install without the app" =
          has toolsAlone packages.boat && installed toolsAlone "t3code" == [ ];
        "the server alone installs its t3 at high priority, and no app" =
          map (p: p.meta.priority or 5) (installed serverOnly "t3") == [ (-10) ]
          && installed serverOnly "t3code" == [ ];
        "the overlay's t3code: the app with its CLI, and the module's t3 at high priority" =
          has appCli overlayAllowed.t3code
          && map (p: p.meta.priority or 5) (installed appCli "t3") == [ (-10) ];
        "each machine-wide option fails, saying where it lives" = builtins.all (
          h: failsWith h "is a NixOS option" && failsWith h "What Home Manager can't do"
        ) nixosOnly;
        "no machine-wide option set: nothing fails" = noneFailed app && noneFailed serverOnly;
        "the server's unit: keep-old, wanted by default.target, the CLI's t3 serve" =
          let
            u = unitOf serverOnly;
          in
          u.Unit.X-SwitchMethod == "keep-old"
          && u.Install.WantedBy == [ "default.target" ]
          && u.Service.ExecStart == [ "${(first (installed serverOnly "t3")).outPath}/bin/t3 serve" ];
        "the server needs Home Manager's systemd integration" =
          failsWith noSystemd "server.enable needs Home Manager's systemd.user.enable";
        "the module tells the NixOS module what it needs" =
          (cfgOf app).programs.t3code-nix.machine == {
            policy = true;
            cache = true;
          }
          &&
            (cfgOf cliAlone).programs.t3code-nix.machine == {
              policy = false;
              cache = false;
            }
          && (cfgOf toolsAlone).programs.t3code-nix.machine.cache;

        # Home Manager's own programs.t3code.
        "with our app, theirs installs no package, and their settings still apply" =
          (cfgOf theirsNulled).programs.t3code.package == null
          && noneFailed theirsNulled
          && (cfgOf theirsNulled).home.activation ? t3codeSettingsActivation;
        "with only our server, theirs keeps its package" =
          (cfgOf theirsKept).programs.t3code.package.drvPath == overlayAllowed.t3code.drvPath
          && noneFailed theirsKept;
        "a user's mkDefault package wins over ours, and then fails as two apps" =
          (cfgOf theirsMkDefault).programs.t3code.package.drvPath == packages.t3code-free.drvPath
          && failsWith theirsMkDefault "both install T3 Code: set programs.t3code.package = null";
        "both servers fail with our message, with our app and without" =
          failsWith bothServersApp "programs.t3code-nix.server and Home Manager's programs.t3code.server are both on"
          && failsWith bothServers "programs.t3code-nix.server and Home Manager's programs.t3code.server are both on";
        "their server with our app fails with our fix" =
          failsWith theirServerOurApp "use programs.t3code-nix.server.enable instead";
        "none of it while their enable is off: nothing fails, and their package stays" =
          noneFailed theirsOff && (cfgOf theirsOff).programs.t3code.package != null;
        "a config Home Manager rejects is a false condition here, not an evaluation error" =
          valueOr "caught" (drvs (home [ { programs.no-such-option.enable = true; } ]).config.home.packages)
          == "caught";
        "their module with the overlay's app runs the t3 that app has" =
          (cfgOf theirsAlone).systemd.user.services.t3code.Service.ExecStart or null == [
            "${overlayAllowed.t3code}/bin/t3 serve"
          ];
        "without their module (an older Home Manager), the same config evaluates" =
          noneFailed withoutTheirs && has withoutTheirs packages.t3code;

        # nixGL.
        "without nixGL the app is installed as it is" = has app packages.t3code;
        "with nixGL the desktop app, and a package of another kind, run through it" =
          let
            gl = withGL { enable = true; };
            other = withGL {
              enable = true;
              package = pkgs.hello;
            };
          in
          !(has gl packages.t3code)
          && installed gl "t3code" != [ ]
          && map providersOf (installed gl "t3code") == [ (providersOf packages.t3code) ]
          && !(has other pkgs.hello);
        "with nixGL the doctor knows the app it runs" =
          let
            gl = withGL { enable = true; };
          in
          (first (installed gl "t3code-nix-doctor")).t3code.drvPath == (first (installed gl "t3code"))
          .drvPath;
        "the doctor looks for the unit where Home Manager writes it (xdg.configHome)" =
          (first (
            installed (home [
              {
                programs.t3code-nix.enable = true;
                xdg.configHome = "/home/alice/config";
              }
            ]) "t3code-nix-doctor"
          )).userUnits == "/home/alice/config/systemd/user";
        "telemetry.enable = false reaches the app, the CLI and the server's t3" =
          telemetryOf telemetryOff "t3code" == [ false ]
          && telemetryOf telemetryOff "t3" == [ false ]
          && telemetryOf telemetryServer "t3" == [ false ]
          &&
            (unitOf telemetryServer).Service.ExecStart == [
              "${(first (installed telemetryServer "t3")).outPath}/bin/t3 serve"
            ]
          && noneFailed telemetryOff
          && noneFailed telemetryServer;
        "with nixGL the doctor gets the app's usage data setting from before nixGL wraps it" =
          let
            gl = withGL {
              enable = true;
              telemetry.enable = false;
            };
            doctor = first (installed gl "t3code-nix-doctor");
          in
          doctor.appTelemetry == false
          && doctor.cliTelemetry == false
          # The app inside the nixGL wrapper, which a t3 on PATH may be.
          && doctor.appInner.drvPath == (first (installed telemetryOff "t3code")).drvPath
          && (first (installed telemetryOff "t3code-nix-doctor")).appInner == null;
        "the server-only doctor has no app setting" =
          (first (installed telemetryServer "t3code-nix-doctor")).appTelemetry == "none";
        "with nixGL a CLI package isn't wrapped" = has (withGL {
          enable = true;
          package = packages.t3-free;
        }) packages.t3-free;
      })
      ''
        # The profiles build (a collision fails home.path), and their t3 is
        # the one the module installs.
        check() { # name, profile, expected t3
          [ -n "$2" ] || { echo "$1: the profile didn't evaluate"; exit 1; }
          [ -x "$2/bin/t3" ] && [ -x "$3/bin/t3" ] || { echo "$1: a t3 isn't an executable"; exit 1; }
          [ "$(readlink -f $2/bin/t3)" = "$(readlink -f $3/bin/t3)" ] || { echo "$1: its t3 isn't $3's"; exit 1; }
          echo "$1: builds, t3 from $3"
        }
        check appWithCli ${toString (profileOf "appWithCli")} ${toString (t3Of profiles.appWithCli)}
        check cliAsPackage ${toString (profileOf "cliAsPackage")} ${toString (t3Of profiles.cliAsPackage)}
        check theirApp ${toString (profileOf "theirApp")} ${toString (t3Of profiles.theirApp)}
        check nulled ${toString (profileOf "nulled")} ${toString (t3Of profiles.nulled)}
        [ -e ${toString (profileOf "appWithCli")}/bin/t3code-desktop ] || { echo "appWithCli: no t3code-desktop"; exit 1; }
      '';

  # Home Manager as a NixOS module, with this flake's NixOS module: what the
  # users' programs.t3code-nix turn on for the machine.
  hm-nixos-eval =
    let
      claude = on { enable = true; };
      codex = on {
        enable = true;
        providers = [ "codex" ];
      };
      plain = { };
      mixed = nixosWith { } {
        alice = plain;
        bob = codex;
        carol = claude;
      };
      serverWarned = nixosWith { nixos.programs.t3code.server.enable = true; } {
        alice = on { server.enable = true; };
      };
      appsWarned = nixosWith { nixos.programs.t3code.enable = true; } {
        alice = on { enable = true; };
      };
      tailscaleOff = nixosWith { } {
        alice = on {
          server.enable = true;
          server.tailscaleServe.enable = true;
        };
      };
      tailscaleOn = nixosWith { nixos.services.tailscale.enable = true; } {
        alice = on {
          server.enable = true;
          server.tailscaleServe.enable = true;
        };
      };
      failedOf = c: map (a: a.message) (builtins.filter (a: !a.assertion) c.assertions);
      homeEnv =
        c: c.home-manager.users.alice.systemd.user.services.t3code-server.Service.Environment or [ ];
    in
    conditions "hm-nixos-eval" (safe {
      "a user bundling claude-code turns on the policy and the cache, and activates, in every pkgs mode" =
        builtins.all
          (
            m:
            let
              c = nixosWith m { alice = claude; };
            in
            machineOf c == [
              true
              true
            ]
            && lib.hasSuffix ".drv" c.home-manager.users.alice.home.activationPackage.drvPath
          )
          pkgModes;
      "a user without claude-code turns on only the cache, in every pkgs mode" = builtins.all (
        m:
        machineOf (nixosWith m { alice = codex; }) == [
          false
          true
        ]
      ) pkgModes;
      "a custom package's own providers count" =
        machineOf (
          nixosWith { } {
            alice = on {
              enable = true;
              package = packages.t3code.override { providers = [ "claude" ]; };
            };
          }
        ) == [
          true
          true
        ];
      "a package without provider metadata, with the server, counts the full CLI" =
        machineOf (
          nixosWith { } {
            alice = on {
              package = pkgs.hello;
              server.enable = true;
            };
          }
        ) == [
          true
          true
        ];
      "agent tools alone: the cache only" =
        machineOf (nixosWith { } { alice = on { agentTools.boat.enable = true; }; }) == [
          false
          true
        ];
      "cli.enable alone: neither" =
        machineOf (nixosWith { } { alice = on { cli.enable = true; }; }) == [
          false
          false
        ];
      "a user without our module: neither" =
        machineOf (nixosWith { } { alice = plain; }) == [
          false
          false
        ];
      "several users: any one needing a setting turns it on" =
        machineOf mixed == [
          true
          true
        ];
      "the NixOS module's own options still decide: claudeCodePolicy and binaryCache off" =
        machineOf (
          nixosWith {
            nixos.programs.t3code = {
              claudeCodePolicy = false;
              binaryCache = false;
            };
          } { alice = claude; }
        ) == [
          false
          false
        ];
      "a user whose providers read osConfig.nix.settings evaluates" =
        machineOf (
          nixosWith { } {
            alice =
              { osConfig, ... }:
              {
                imports = [ self.homeModules.default ];
                programs.t3code-nix = {
                  enable = true;
                  providers = [ "codex" ] ++ lib.optional (osConfig.nix.settings.substituters != [ ]) "claude";
                };
              };
          }
        ) == [
          true
          true
        ];
      "both servers on: the Home Manager module warns" =
        builtins.any (lib.hasInfix "programs.t3code-nix.server and the NixOS module's programs.t3code.server are both on") serverWarned.warnings;
      "both apps on: the Home Manager module warns" =
        builtins.any (lib.hasInfix "programs.t3code-nix.enable and the NixOS module's programs.t3code.enable both install") appsWarned.warnings;
      "tailscaleServe needs services.tailscale in the NixOS config" =
        builtins.any (lib.hasInfix "server.tailscaleServe needs services.tailscale.enable in the NixOS config") (
          failedOf tailscaleOff
        )
        && !(builtins.any (lib.hasInfix "tailscaleServe") (failedOf tailscaleOn))
        # Without context: hasInfix makes a regex of the store path.
        && builtins.any (lib.hasInfix (builtins.unsafeDiscardStringContext "${lib.getBin tailscaleOn.services.tailscale.package}/bin")) (
          map builtins.unsafeDiscardStringContext (homeEnv tailscaleOn)
        );
      "without Home Manager, nothing on: neither" =
        let
          c =
            (import (path + "/nixos/lib/eval-config.nix") {
              system = null;
              modules = [
                nixosModule
                { nixpkgs.pkgs = pkgs; }
              ];
            }).config;
        in
        machineOf c == [
          false
          false
        ];
    }) "";

  # `nix flake init -t github:boltflake/t3code-nix#home-manager`: a
  # standalone Home Manager flake with the module, evaluated (its activation
  # package's drvPath) with this Home Manager and nixpkgs, not built.
  hm-template =
    let
      dir = ../templates/home-manager;
      tpl = import (dir + "/flake.nix");
      outputs = tpl.outputs {
        self = outputs;
        nixpkgs.legacyPackages = lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (_: pkgs);
        home-manager.lib = hmCall (import (hmFile "/lib")) { inherit lib; };
        t3code-nix = self;
      };
      you = outputs.homeConfigurations.you;
    in
    conditions "hm-template" (safe {
      "the flake exports it, and it holds only flake.nix" =
        self.templates.home-manager.path == dir
        && builtins.attrNames (builtins.readDir dir) == [ "flake.nix" ];
      "its inputs: nixpkgs, Home Manager following it, and this flake following nothing" =
        tpl.inputs.t3code-nix.url == "github:boltflake/t3code-nix"
        && tpl.inputs.nixpkgs.url == "github:NixOS/nixpkgs/nixos-unstable"
        && tpl.inputs.home-manager.url == "github:nix-community/home-manager"
        && tpl.inputs.home-manager.inputs.nixpkgs.follows == "nixpkgs"
        && !(tpl.inputs.t3code-nix ? inputs);
      "it enables T3 Code for the user it names" =
        you.config.programs.t3code-nix.enable && you.config.home.username == "you";
      "the whole configuration evaluates" = lib.hasSuffix ".drv" you.activationPackage.drvPath;
    }) "";

  # Both modules write the server's unit from one description: the same
  # ExecStart, ExecStartPre and Environment lines (PATH included), with
  # quoting Home Manager needs written out, and Tailscale's PATH under Home
  # Manager as a NixOS module.
  hm-unit-parity = runCommand "hm-unit-parity" { } (
    lib.concatStrings (
      lib.mapAttrsToList (
        name: p:
        ''
          # Not the variables NixOS gives every unit (systemd.globalEnvironment).
          lines() { grep -E '^(ExecStart|ExecStartPre|Environment|EnvironmentFile)=' "$1" | grep -vE '^Environment="(LOCALE_ARCHIVE|TZDIR)=' | sort; }
          [ -s ${p.nixosUnit} ] && [ -n ${lib.escapeShellArg (toString p.homeUnit)} ] \
            || { echo "${name}: a unit didn't evaluate"; exit 1; }
          if ! diff <(lines ${p.nixosUnit}) <(lines ${p.homeUnit}); then
            echo "${name}: the units differ"; exit 1
          fi
          [ "$(lines ${p.nixosUnit} | wc -l)" -ge 6 ] || { echo "${name}: too few lines compared"; exit 1; }
        ''
        + lib.optionalString (name == "quoted") ''
          # Its environmentFile is in both, not left out of both.
          for u in ${p.nixosUnit} ${p.homeUnit}; do
            grep -q '^EnvironmentFile=' $u || { echo "${name}: $u has no EnvironmentFile line"; exit 1; }
          done
        ''
        + ''
          # Both carry the Description the doctor knows this flake's units by.
          for u in ${p.nixosUnit} ${p.homeUnit}; do
            grep -qxF ${lib.escapeShellArg "Description=${packages.doctor.unitDescription}"} $u \
              || { echo "${name}: $u lacks the doctor's Description line"; exit 1; }
          done
          echo "${name}: the same"
        ''
      ) parity
    )
    + "touch $out\n"
  );
}
