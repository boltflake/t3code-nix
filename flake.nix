{
  description = "T3 Code and every provider it supports, updated minutes after each upstream release";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  # The binary cache, offered to `nix run` and friends. Nix asks first (or
  # takes --accept-flake-config) and uses it only for trusted users or a
  # cache the machine trusts already, so the README also gives the lines to
  # add by hand.
  # The binary cache (lib/cache.nix), written out because Nix reads
  # `nixConfig` without evaluating it. The cache-settings check compares
  # these with lib/cache.nix.
  nixConfig = {
    extra-substituters = [ "https://t3code-nix.cachix.org" ];
    extra-trusted-public-keys = [
      "t3code-nix.cachix.org-1:FwZvqgRcnUjCSEUmdosysof1pTedbm/TTmlk8IeDsJA="
    ];
  };

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = lib.genAttrs systems;
      # Not supported: `nix run` there says so (lib/unsupported.nix).
      otherSystems = [
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      cache = import ./lib/cache.nix;
      # What the NixOS and Home Manager modules share (lib/module-core.nix).
      core = import ./lib/module-core.nix {
        inherit (self) packages;
        # nixpkgs = "stable": only evaluated when chosen.
        stable = lib.mapAttrs (_: l: l.stable) self.legacyPackages;
        # The server's database copy, from the flake's own package set.
        serverBackup = forAllSystems (system: {
          unstable = import ./lib/server-backup.nix { pkgs = pkgsFor system; };
          stable = import ./lib/server-backup.nix { pkgs = stablePkgsFor system; };
        });
      };

      # Running this flake's own outputs is the opt-in to the unfree
      # packages it bundles, and to those only (see README, "Unfree
      # packages").
      # The overlay leaves the decision to the user's own nixpkgs config.
      # Plus agent-browser's Chrome, used only when chosen (pkgs/unfree-browsers.nix).
      unfreePackages = import ./pkgs/unfree.nix ++ import ./pkgs/unfree-browsers.nix;

      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) unfreePackages;
          # Nothing from the user's nixpkgs config (default.nix is impure).
          overlays = [ ];
        };

      # NixOS stable (the stable toggle): the nixos-NN.MM revision
      # versions/nixpkgs-stable.json pins, fetched only when used.
      stablePin = lib.importJSON ./versions/nixpkgs-stable.json;
      stableSrc = builtins.fetchTarball {
        url = "https://github.com/NixOS/nixpkgs/archive/${stablePin.rev}.tar.gz";
        sha256 = stablePin.narHash;
      };
      # Home Manager master, for the hm-* checks (lib/hm-checks.nix) and
      # vmTests.homeManager: fetched only when one of them is evaluated.
      homeManagerPin = lib.importJSON ./ci/home-manager.json;
      homeManagerSrc = builtins.fetchTarball {
        url = "https://github.com/nix-community/home-manager/archive/${homeManagerPin.rev}.tar.gz";
        sha256 = homeManagerPin.narHash;
      };
      stablePkgsFor =
        system:
        import stableSrc {
          inherit system;
          config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) unfreePackages;
          overlays = [ ];
        };
      # NixOS stable without unfree packages allowed (free-variant's twin).
      stableFreePkgsFor =
        system:
        import stableSrc {
          inherit system;
          overlays = [ ];
        };
      # The stable set users get: the snapshot's pins (versions/stable/).
      stableFor =
        system:
        import ./pkgs {
          pkgs = stablePkgsFor system;
          pinsDir = ./versions/stable;
          browserChannel = "stable";
          nixpkgs = "stable";
        };
      # What a snapshot move would give (the stable-next checks): the current
      # pins, on NixOS stable, without the nightly packages.
      stableNextFor =
        system:
        lib.filterAttrs (n: _: !lib.hasSuffix "-nightly" n) (
          import ./pkgs {
            pkgs = stablePkgsFor system;
            browserChannel = "stable";
            nixpkgs = "stable";
          }
        );
      # A NixOS-stable set's agent-browser with chromium and google-chrome
      # (its own browser-stable pin), by browser name.
      optionalVariants =
        set:
        lib.genAttrs [ "chromium" "google-chrome" ] (
          browser: set.agent-browser.override { inherit browser; }
        );
      # lib/checks.nix with a package set, its pins and the harness's pkgs: the
      # default checks, and the same recipe for the NixOS-stable suites.
      checksWith =
        {
          pkgs,
          packages,
          pinsDir,
          system,
          freeSet ? null,
          noFallback ? packages,
        }:
        pkgs.callPackage ./lib/checks.nix {
          inherit
            self
            cache
            packages
            pinsDir
            freeSet
            noFallback
            ;
          homeManager = homeManagerSrc;
          # nixpkgs as an overlay user without allowUnfree has it.
          overlayPkgs = import nixpkgs {
            inherit system;
            overlays = [ self.overlays.default ];
          };
          # The same, with the unfree packages the flake's outputs allow,
          # so its derivations can be compared with theirs.
          overlayAllowed = (pkgsFor system).appendOverlays [ self.overlays.default ];
        };
      defaultChecks =
        system:
        checksWith {
          inherit system;
          pkgs = pkgsFor system;
          packages = self.packages.${system};
          pinsDir = ./versions;
          noFallback = import ./pkgs {
            pkgs = pkgsFor system;
            electronFallback = false;
          };
        };
      # A NixOS-stable suite (lib/stable-suite.nix), each check named
      # <prefix><check>: the stable set and the snapshot (prefix "stable-"),
      # or the stable-next set and versions/ ("stable-next-"). Built by one
      # recipe, so a pair has the same derivations when the pins are equal.
      suiteFor =
        system: prefix: packages: pinsDir:
        let
          suite = import ./lib/stable-suite.nix;
          checks = checksWith {
            inherit system packages pinsDir;
            pkgs = stablePkgsFor system;
            # The same set without unfree packages allowed (free-variant).
            freeSet = import ./pkgs {
              pkgs = stableFreePkgsFor system;
              inherit pinsDir;
              browserChannel = "stable";
              nixpkgs = "stable";
            };
          };
          present = builtins.filter (n: packages ? ${n});
        in
        lib.mapAttrs' (n: v: lib.nameValuePair "${prefix}${n}" v) (
          lib.genAttrs (present suite.twinnedPackages) (n: packages.${n})
          // lib.genAttrs suite.twinnedChecks (n: checks.${n})
          # The module with nixpkgs = "stable", on this set (no default original).
          // {
            module-eval = (stablePkgsFor system).callPackage ./lib/stable-module-eval.nix {
              inherit self cache pinsDir;
              set = packages;
            };
            # Every package of the set evaluates (init too, which isn't built).
            eval = (stablePkgsFor system).runCommand "eval" { } (
              builtins.deepSeq (map (p: p.drvPath) (builtins.attrValues packages)) "touch $out"
            );
          }
        );
    in
    {
      # Every package under pkgs.t3code-nix; the app and the providers also at
      # the top level, but never over a different nixpkgs program of the
      # same name (lib/overlay.nix). `default` is a flake-output convention,
      # not a package name.
      overlays.default =
        final: prev:
        let
          # agent-browser on the user's own ungoogled-chromium.
          # The fallback file is about the flake's pinned nixpkgs, not yours.
          ours = removeAttrs (import ./pkgs {
            pkgs = final;
            browserChannel = null;
            electronFallback = false;
          }) [ "default" ];
          names = import ./lib/overlay.nix;
          topLevel = builtins.filter (
            name: !(prev ? ${name}) || builtins.elem name names.sameAsNixpkgs
          ) names.candidates;
          # The top-level t3code replaces nixpkgs' (sameAsNixpkgs), which has
          # the CLI too (`t3`, and `t3code-desktop`); modules written for it,
          # Home Manager's programs.t3code among them, run that `t3`.
          top = ours // {
            t3code = ours.t3code.override { withCli = true; };
          };
        in
        {
          t3code-nix = ours;
        }
        // lib.getAttrs topLevel top;

      packages =
        forAllSystems (system: import ./pkgs { pkgs = pkgsFor system; })
        // lib.genAttrs otherSystems (system: {
          default = import ./lib/unsupported.nix system;
        });

      nixosModules = rec {
        t3code = import ./nixos/module.nix { inherit core cache; };
        default = t3code;
      };

      # programs.t3code-nix for Home Manager (home-manager/module.nix).
      homeModules = rec {
        t3code-nix = import ./home-manager/module.nix { inherit core; };
        default = t3code-nix;
      };
      # The same, under the name older guides use.
      homeManagerModules = self.homeModules;

      # Every package builds and passes its version probe, plus the smoke tests.
      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          own =
            # `default` is t3code again: checked once.
            removeAttrs self.packages.${system} [ "default" ]
            # callPackage adds override helpers; keep only the checks themselves.
            // lib.filterAttrs (_: lib.isDerivation) (defaultChecks system);
          suite = import ./lib/stable-suite.nix;
          listed = with suite; twinnedPackages ++ twinnedChecks ++ nightly ++ guards ++ flakeLevel;
          names = builtins.attrNames own ++ [ "stable-names" ];
          unlisted = builtins.filter (n: !builtins.elem n listed) names;
          gone = builtins.filter (n: !builtins.elem n names) listed;
          # The stable set's package names come from the snapshot's pin files
          # alone (pkgs/default.nix filters with builtins), so listing them
          # never imports nixpkgs-stable and can't fail on it.
          stableNames = builtins.attrNames self.legacyPackages.${system}.stable;
          snapshotNightly =
            builtins.filter (lib.hasSuffix "-nightly.json") (
              builtins.attrNames (builtins.readDir ./versions/stable)
            )
            ++ builtins.filter (lib.hasSuffix "-nightly") stableNames;
        in
        own
        // {
          # Every check is in the NixOS-stable suite's lists, and the snapshot
          # has no nightly pins.
          stable-names = pkgs.runCommand "stable-names" { } (
            if
              unlisted == [ ] && gone == [ ] && snapshotNightly == [ ] && builtins.elem "t3code" stableNames
            then
              "touch $out"
            else
              "echo ${lib.escapeShellArg "not in lib/stable-suite.nix: ${toString unlisted}; listed but gone: ${toString gone}; nightly in the stable set: ${toString snapshotNightly}; stable set: ${toString stableNames}"}; exit 1"
          );
        }
      );

      # `nix flake init -t github:boltflake/t3code-nix`: a NixOS flake with
      # the module (templates/default; checked by `template`).
      templates.default = {
        path = ./templates/default;
        description = "A NixOS system with T3 Code from t3code-nix";
        welcomeText = ''
          Wrote flake.nix: a NixOS system with T3 Code. It imports your
          ./configuration.nix. Check its nixpkgs line (see the comment
          there), then run:

          ```
          sudo nixos-rebuild switch --flake /etc/nixos#nixos
          ```
        '';
      };

      # `nix flake init -t github:boltflake/t3code-nix#home-manager`: a
      # standalone Home Manager flake with the module (templates/home-manager;
      # checked by `hm-template`).
      templates.home-manager = {
        path = ./templates/home-manager;
        description = "Home Manager with T3 Code from t3code-nix, on NixOS or another Linux";
        welcomeText = ''
          Wrote flake.nix: Home Manager with T3 Code. Set your user name,
          home folder and system in it (the lines marked), then run this,
          with YOUR_USERNAME replaced by that user name:

          ```
          nix run github:nix-community/home-manager/master -- switch --flake '.#YOUR_USERNAME'
          ```
        '';
      };

      # Too heavy for `checks` (they need KVM); see lib/vm-test.nix.
      legacyPackages = forAllSystems (system: {
        vmTests.server = import ./lib/vm-test.nix {
          inherit self;
          pkgs = pkgsFor system;
        };
        vmTests.homeManager = import ./lib/vm-test-home-manager.nix {
          inherit self;
          pkgs = pkgsFor system;
          homeManager = homeManagerSrc;
        };
        # NixOS stable (programs.t3code.nixpkgs = "stable"). Not evaluated by
        # `nix flake show` or `nix flake check`, so nothing fetches the stable
        # nixpkgs unless it's used.
        stable = removeAttrs (stableFor system) [ "default" ];
        # Internal: the stable-next set, for the stable-next checks.
        stableNext = removeAttrs (stableNextFor system) [ "default" ];
        # The NixOS-stable suites, evaluated and built apart from `checks` (by
        # scripts/ci/stable.ts), so nothing about NixOS stable can fail or delay
        # the default checks.
        stableChecks = suiteFor system "stable-" (stableFor system) ./versions/stable;
        stableNextChecks = suiteFor system "stable-next-" (stableNextFor system) ./versions;
        # agent-browser with its optional browsers (chromium, google-chrome),
        # for the report-only smokes (scripts/ci/variants.ts): never in
        # `checks` (Chrome would be downloaded on every run) or the cache.
        # Per browser pin, "<pin>-<browser>"; the stable set's from its own
        # (the snapshot's) browser-stable pin.
        agentBrowserVariants =
          let
            ab = self.packages.${system}.agent-browser;
          in
          lib.listToAttrs (
            lib.concatMap
              (
                channel:
                map
                  (browser: {
                    name = "browser-${channel}-${browser}";
                    value = ab.override {
                      inherit browser;
                      browserChannel = channel;
                    };
                  })
                  [
                    "chromium"
                    "google-chrome"
                  ]
              )
              [
                "unstable"
                "stable"
              ]
          );
        stableAgentBrowserVariants = optionalVariants (stableFor system);
        # The stable runner smokes' tools (scripts/ci/stable.ts), from the
        # nixpkgs-stable pin like the rest of the stable harness.
        stableSmokeTools = {
          inherit (stablePkgsFor system)
            xvfb-run
            dbus
            xdotool
            util-linux
            ;
        };
      });

      # `nix fmt` formats every .nix file (the nix-format check's nixfmt).
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);
    };
}
