# Puts the providers on PATH for an unwrapped t3code or t3. t3code finds its
# providers on PATH, so this is all the bundling it needs. At startup t3code
# puts the user's login-shell PATH ahead of this one, so providers the user
# installed themselves win and these fill the gaps (see the README).
#
# Which providers is the caller's choice, by t3code's driver names
# (providers.nix; "claude" and our package names work too) or as packages:
#
#   t3code.override { providers = [ "codex" "claude" ]; }
#   t3code.override { excludeProviders = [ "grok" "muse" ]; }
#   t3code.override { providers = [ pkgs.codex "opencode" ]; }
#
# A name that isn't a provider is an error that suggests the nearest one.
#
# Runtimes for agents t3code installs from the ACP registry, off by default:
#
#   t3code.override { acpRuntimes = [ "nodejs" ]; }   # npm agents
#   t3code.override { acpRuntimes = [ "uv" ]; }       # uv agents (uv, python3)
#
# They go at the end of PATH, after the providers: the user's own Node or uv
# (from the login shell's PATH, which t3code puts first) always wins.
#
# It also links the HTML-preview browser where t3code looks for it
# (preview-browser.sh); leave it out with
#
#   t3code.override { withPreviewBrowser = false; }
#
# which drops it from the closure; a link an earlier launch made stays.
#
# T3 Connect's relay client is nixpkgs' cloudflared, named by
# T3CODE_CLOUDFLARED_PATH (unless the user sets it to something; t3 takes an
# empty or blank one as unset, so the wrapper does too, for whitespace as
# the shell's locale reads [:space:]).
# t3 looks there before its own downloads in ~/.t3/tools/cloudflared and
# before PATH, so an older download (from upstream's install) is never used
# and none is made. It's on PATH too.
#
# T3 Code's usage data (product events and relay traces, upstream's
# docs/user/telemetry.md) is on unless turned off:
#
#   t3code.override { telemetry = false; }
#
# which starts every program here with T3CODE_TELEMETRY_ENABLED=false when
# the variable is unset, empty or only whitespace (as the shell's locale
# reads [:space:]; T3 Code takes an empty one as unset, so usage data would
# stay on). Any other value is the user's and stays as it is. DO_NOT_TRACK
# is never set: it would reach every agent T3 Code starts. With the
# default, the wrappers are as without this.
#
# The desktop app's own server takes the first free port from 3773 up. To
# pin it (for a port opened in the firewall, the NixOS module's
# openFirewall):
#
#   t3code.override { port = 3780; }
#
# which starts the app with T3CODE_PORT set to it when the variable is
# unset, empty or only whitespace (as for telemetry); any other value is the
# user's and stays. The app takes it from its own environment and leaves it
# out of its server's, so its terminals and agents don't get it. Desktop
# app only: the CLI inside it (withCli) isn't given it. With the default
# (null), the wrappers are as without this.
#
# The desktop app tells you when this flake has a newer T3 Code (its
# sidebar's update icon; desktop.nix, update-notice.cjs), checking one small
# file on this flake's site. To turn that check off:
#
#   t3code.override { updateCheck = false; }
#
# which starts the app with T3CODE_NIX_UPDATE_URL set blank, over any value
# it inherits. Desktop app only. With the default, the wrappers are as
# without this.
#
# The CLI refuses `t3 update`, `t3 service install`, `t3 up` and plain
# `t3 connect` (lib/guard.nix); for upstream's own service on purpose (with
# the module's runtimeCompat):
#
#   t3.override { allowUpstreamService = true; }
#
# The desktop app's Electron (desktop.nix, lib/electron.nix) is set here too
# and passed on; null keeps the unwrapped app's own choice ("auto"):
#
#   t3code.override { electron = "bundled"; }
#
# The desktop app can carry the CLI too, wrapped the same way (providers,
# PATH) but as the CLI (its guards, its preview-browser mode, its shell
# completions), plus `t3code-desktop` on the latest channel: the layout of
# nixpkgs' t3code, which the overlay's top-level t3code has.
#
#   t3code.override { withCli = true; }
#
# Arguments nixpkgs' t3code takes (enableClaude, …) fail with a message
# naming `providers`; any other unknown argument fails too.
let
  # nixpkgs' t3code takes enable<Tool> flags; this one takes providers.
  unknownArgMessage =
    name: unknown:
    let
      nixpkgsStyle = builtins.filter (a: builtins.match "enable[A-Z].*" a != null) unknown;
      list = builtins.concatStringsSep ", ";
    in
    "${name} (t3code-nix) was given arguments it doesn't take: ${list unknown}."
    + (
      if nixpkgsStyle != [ ] then
        " ${list nixpkgsStyle}: arguments of nixpkgs' t3code. This one bundles agent providers by name, providers = [ \"claude\" \"codex\" … ] (or excludeProviders), and puts no other tools (git, gh) on T3 Code's PATH; see the README, \"Agent providers\" (https://github.com/boltflake/t3code-nix#agent-providers)."
      else
        ""
    );
  wrapper =
    {
      lib,
      symlinkJoin,
      makeWrapper,
      installShellFiles,
      runCommand,
      writeText,
      replaceVars,
      coreutils,
      cloudflared,
      nodejs,
      uv,
      python3,
      unwrapped,
      # The desktop app's Electron, or null for the unwrapped app's own.
      electron ? null,
      # Every provider this t3code supports: driver name -> package.
      availableProviders,
      providers ? builtins.attrNames availableProviders,
      excludeProviders ? [ ],
      previewBrowser,
      withPreviewBrowser ? true,
      acpRuntimes ? [ ],
      guard,
      allowUpstreamService ? false,
      telemetry ? true,
      # The desktop app's port (T3CODE_PORT), or null for upstream's scan.
      port ? null,
      # The desktop app's update notice (update-notice.cjs): false turns its
      # check off.
      updateCheck ? true,
      # Put into the name: "-free" for t3code-free and t3-free.
      variant ? "",
      # The CLI inside the desktop app (withCli): the same channel's unwrapped
      # CLI and its own pin's preview browser.
      withCli ? false,
      cliUnwrapped ? null,
      cliPreviewBrowser ? null,
    }:
    let
      # The unwrapped app, with the Electron asked for (desktop only).
      app =
        if electron == null then
          unwrapped
        else if unwrapped ? passthru.electron then
          unwrapped.override { inherit electron; }
        else
          throw "t3code: electron applies to the desktop app only, not ${unwrapped.name}";
      helper = import ./select-providers.nix {
        inherit lib;
        available = availableProviders;
      };
      selected = helper.select { inherit providers excludeProviders; };
      # The update notice's bundled providers (desktop app): package name ->
      # version, for the ones bundled by name from this set.
      providerNames = builtins.fromJSON (builtins.readFile ./provider-names.json);
      bundledVersions = builtins.listToAttrs (
        map (
          d:
          lib.nameValuePair (providerNames.${d} or (lib.getName availableProviders.${d})
          ) availableProviders.${d}.version
        ) (helper.named { inherit providers excludeProviders; })
      );
      providersJson = writeText "providers.json" (builtins.toJSON bundledVersions);
      # The wrapper's flags for the notice's provider list, given the desktop
      # build's notice file and where the list goes (shell words): the list
      # only when the notice fitted.
      providerFlags = notice: target: ''
        providerFlags=()
        if [ "$(cat ${notice})" = on ]; then
          install -Dm444 ${providersJson} ${target}
          providerFlags=(--set-default T3CODE_NIX_PROVIDERS ${target})
        fi
      '';

      # The ACP registry's runners: npm (with node) for npm agents; uv with a
      # full python3 for uv agents (uv would otherwise download a Python that
      # can't start without nix-ld, and python3Minimal lacks ssl).
      runtimes = {
        nodejs = [ nodejs ];
        uv = [
          uv
          python3
        ];
      };
      runtimeNames = lib.unique (
        map (
          r:
          if !builtins.isString r then
            throw "t3code: acpRuntimes takes names (${lib.concatStringsSep ", " (builtins.attrNames runtimes)}), not packages"
          else if runtimes ? ${r} then
            r
          else
            throw (helper.unknownRuntime r (builtins.attrNames runtimes))
        ) acpRuntimes
      );
      runtimeFlags = lib.optionals (runtimeNames != [ ]) [
        "--suffix"
        "PATH"
        ":"
        (lib.makeBinPath (lib.concatMap (r: runtimes.${r}) runtimeNames))
      ];

      # t3code looks for Antigravity on PATH as `agy_acp_server.par` and treats
      # it as the newer CLI when the real file is named `agy`. This link lives
      # only on t3code's PATH, not in the antigravity package.
      shims = runCommand "t3code-provider-shims" { } (
        ''
          mkdir -p $out/bin
        ''
        + lib.concatMapStrings (
          p:
          lib.optionalString (lib.getName p == "antigravity") ''
            ln -s ${p}/bin/agy $out/bin/agy_acp_server.par
          ''
        ) selected
      );
      # The CLI takes --base-dir; the desktop app doesn't.
      cli = if lib.hasPrefix "t3-" app.name then "1" else "0";
      linkPreviewBrowser = replaceVars ./preview-browser.sh (
        lib.genAttrs [
          "mkdir"
          "ln"
          "mv"
          "rm"
        ] (c: "${coreutils}/bin/${c}")
      );
      guardFlags = lib.optional (cli == "1" && !allowUpstreamService) guard.refuseT3;
      browserFlagsFor =
        mode: browser:
        lib.optionals withPreviewBrowser [
          "--run"
          (lib.concatStringsSep " " [
            ". ${linkPreviewBrowser};"
            "t3codeLinkPreviewBrowser ${mode}"
            "${browser}/libexec/chrome-headless-shell"
            browser.platform
            browser.version
            ''"$@" || echo "warning: couldn't link T3 Code's preview browser" >&2''
          ])
        ];
      browserFlags = browserFlagsFor cli previewBrowser;
      pathFlag = lib.makeBinPath (
        selected
        ++ [
          shims
          cloudflared
        ]
      );
      cloudflaredRun = ''case "''${T3CODE_CLOUDFLARED_PATH-}" in *[![:space:]]*) ;; *) export T3CODE_CLOUDFLARED_PATH=${cloudflared}/bin/cloudflared ;; esac'';
      telemetryRun = ''case "''${T3CODE_TELEMETRY_ENABLED-}" in *[![:space:]]*) ;; *) export T3CODE_TELEMETRY_ENABLED=false ;; esac'';
      # After cloudflaredRun on the same line, so that with the default the
      # wrappers' build script (and so the derivation) is unchanged.
      telemetryFlags =
        if !builtins.isBool telemetry then
          throw "t3code: telemetry takes true or false, not ${builtins.typeOf telemetry}"
        else
          lib.optionalString (!telemetry) " --run ${lib.escapeShellArg telemetryRun}";
      # The desktop app's programs only, after telemetryFlags on the same line,
      # so that with the default the build script is unchanged.
      portRun =
        if port == null then
          null
        else if !builtins.isInt port || port < 1 || port > 65535 then
          throw "t3code: port takes a TCP port number (1 to 65535) or null, not ${
            if builtins.isInt port then toString port else builtins.typeOf port
          }"
        else if cli == "1" then
          throw "t3code: port applies to the desktop app only, not ${app.name} (the CLI takes T3CODE_PORT or --port itself)"
        else
          ''case "''${T3CODE_PORT-}" in *[![:space:]]*) ;; *) export T3CODE_PORT=${toString port} ;; esac'';
      portFlags = lib.optionalString (portRun != null) " --run ${lib.escapeShellArg portRun}";
      # Off: the variable set blank, a force (not a default), so an inherited
      # URL can't turn it back on. The desktop app only; with the default the
      # build script is unchanged.
      updateFlags =
        if !builtins.isBool updateCheck then
          throw "t3code: updateCheck takes true or false, not ${builtins.typeOf updateCheck}"
        else if updateCheck then
          ""
        else if cli == "1" then
          throw "t3code: updateCheck applies to the desktop app only, not ${app.name}"
        else if !(app ? passthru.updateUrl) then
          throw "t3code: updateCheck needs a desktop app that has the update notice, not ${app.name}"
        else
          " --set T3CODE_NIX_UPDATE_URL '' --set T3CODE_NIX_PROVIDERS ''";
      # The desktop app with its check on: the provider list, when the notice
      # fitted (the snippet sets providerFlags).
      withProviderList = cli == "0" && updateCheck == true && app ? passthru.updateUrl;

      # The CLI inside the desktop app.
      innerCli =
        if !withCli then
          null
        else if cli == "1" then
          throw "t3code: withCli applies to the desktop app only, not ${app.name}"
        else if cliUnwrapped == null || (withPreviewBrowser && cliPreviewBrowser == null) then
          throw "t3code: withCli needs cliUnwrapped, and cliPreviewBrowser unless withPreviewBrowser is false"
        else
          cliUnwrapped;
      completions = bin: ''
        export HOME=$(mktemp -d)
        export T3CODE_HOME=$HOME/.t3
        for shell in bash zsh fish; do
          ${bin} --completions $shell > $HOME/t3.$shell
        done
        installShellCompletion --bash --name t3 $HOME/t3.bash
        installShellCompletion --cmd t3 --zsh $HOME/t3.zsh --fish $HOME/t3.fish
      '';
    in
    symlinkJoin {
      name = lib.replaceStrings [ "-unwrapped" ] [ variant ] app.name;
      paths = [ app ] ++ lib.optional withCli innerCli;
      nativeBuildInputs = [
        makeWrapper
      ]
      ++ lib.optional (cli == "1" || withCli) installShellFiles;

      postBuild = ''
        for bin in ${app}/bin/*; do
          name=$(basename "$bin")
          rm "$out/bin/$name"
          ${
            if withProviderList then
              providerFlags "${app}/share/t3code-nix/$name/update-notice" "$out/share/t3code-nix/$name/providers.json"
            else
              "providerFlags=()"
          }
          makeWrapper "$bin" "$out/bin/$name" \
            ${lib.concatStringsSep " " guardFlags} \
            --prefix PATH : ${pathFlag} \
            ${lib.escapeShellArgs runtimeFlags} \
            --run ${lib.escapeShellArg cloudflaredRun}${telemetryFlags}${portFlags}${updateFlags} \
            "''${providerFlags[@]}" \
            ${lib.escapeShellArgs browserFlags}
        done
      ''
      # The CLI's shell completions, from the (already patched) binary itself,
      # with a throwaway home: they complete the command `t3`.
      + lib.optionalString (cli == "1") (completions "${app}/bin/t3")
      # The CLI inside the desktop app, wrapped as the CLI is.
      + lib.optionalString withCli (
        ''
          rm "$out/bin/t3"
          makeWrapper ${innerCli}/bin/t3 "$out/bin/t3" \
            ${lib.concatStringsSep " " (lib.optional (!allowUpstreamService) guard.refuseT3)} \
            --prefix PATH : ${pathFlag} \
            ${lib.escapeShellArgs runtimeFlags} \
            --run ${lib.escapeShellArg cloudflaredRun}${telemetryFlags} \
            ${lib.escapeShellArgs (browserFlagsFor "1" cliPreviewBrowser)}
        ''
        + completions "${innerCli}/bin/t3"
        # nixpkgs' name for the desktop app, on the channel nixpkgs has.
        + lib.optionalString (app.meta.mainProgram or null == "t3code") ''
          ln -s t3code $out/bin/t3code-desktop
        ''
      );

      passthru = {
        unwrapped = app;
        electron = app.passthru.electron or null;
        providers = selected;
        acpRuntimes = runtimeNames;
        previewBrowser = if withPreviewBrowser then previewBrowser else null;
        cliPreviewBrowser = if withCli && withPreviewBrowser then cliPreviewBrowser else null;
        inherit withCli unknownArgMessage;
        # Whether usage data is left on (false: turned off), and the line that
        # turns it off (for the telemetry-wrapper check).
        inherit telemetry telemetryRun;
        # The desktop app's pinned port (null: upstream's scan), and the line
        # that sets it (for the port-wrapper check).
        inherit port portRun;
        # Whether the update notice's check is left on (false: off), and the
        # URL the desktop app checks when it is (null for the CLI).
        inherit updateCheck;
        updateUrl = app.passthru.updateUrl or null;
        # The update notice's provider list (package name -> version) and,
        # for the update-notice check, the snippet that adds it.
        inherit bundledVersions providerFlags;
        # For the preview-browser-link check.
        inherit linkPreviewBrowser;
      };

      meta = app.meta // {
        description =
          lib.replaceStrings [ "without providers" ] [ "with its providers" ]
            app.meta.description;
      };
    };

  known = builtins.functionArgs wrapper;
in
# lib.setFunctionArgs, which needs no lib: callPackage fills `known`, and an
# override with an argument outside it gets the message, not Nix's own error.
{
  __functionArgs = known;
  __functor =
    _: args:
    let
      unknown = builtins.attrNames (removeAttrs args (builtins.attrNames known));
    in
    if unknown == [ ] then
      wrapper args
    else
      throw (
        unknownArgMessage (builtins.replaceStrings [ "-unwrapped" ] [ "" ]
          (builtins.parseDrvName (args.unwrapped.name or "t3code")).name
        ) unknown
      );
}
