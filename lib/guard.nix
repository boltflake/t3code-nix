# Providers installed by Nix must not update or reinstall themselves: an
# update writes a second, unpatched copy outside Nix (for example
# `claude update` puts a 327 MB claude in ~/.local/share/claude and links
# ~/.local/bin/claude to it), which can shadow the Nix one and won't run on
# NixOS. t3code's "update provider" button runs exactly these commands.
#
# `refuse` returns makeWrapper arguments that make the wrapper print a short
# message and exit 1 when the command line holds one of the given
# subcommands anywhere, unless `-h` or `--help` (or a provider's help or
# version form, providerHelp's `after`) comes right after it with no `--` before.
# The line runs as usual when its first argument is help, the version, or
# one of the provider's other commands from providerCommands (`claude
# plugin install x`, `opencode run update`): what follows is that command's
# business. This doesn't try to parse each provider's command line: their
# parsers have too many rules for that to stay right (hidden options, values
# that look like options, words that switch modes), and testing found a
# new one each time. The cost is refusing some ordinary use, with
# the message: a one-word prompt that is a refused name (`claude -p
# update`), an option's value equal to one (`--model update`), an option
# before another command (`claude --verbose plugin install x`). Providers
# without a list (agent-browser, boat) take the word after an option as its
# value and the next plain word as the command. Options in refusedOptions
# (opencode's `--wizard`) are refused wherever they come. t3 and codex have
# their own parsers (refuseT3, refuseCodex), compared with their help at
# every bump. Every guard runs in a subshell (`run`), so its variables
# never reach the program's environment.
{ lib }:
let
  message =
    name:
    "${name} is installed by Nix (t3code-nix), so it can't update itself. "
    + "Update the t3code-nix flake and rebuild to get the new version.";
  stopWith = text: "echo ${lib.escapeShellArg text} >&2; exit 1";
  # A wrapper's --run snippet, in a subshell: its variables never reach the
  # program's environment (a user's exported `n` or `prompt` stays theirs).
  run = body: "--run ${lib.escapeShellArg "(\n${body}\n) || exit 1"}";
  stop = name: stopWith (message name);
  # Upstream's own service, on purpose: `t3.override { allowUpstreamService
  # = true; }`, or programs.t3code.cli.allowUpstreamService.
  optOut = " To use T3 Code's own service anyway, override t3 with allowUpstreamService = true.";
  t3Update =
    message "t3"
    + " For a background server that Nix updates, use programs.t3code.server"
    + " in the NixOS module."
    + optOut;
  t3Service =
    "t3 is installed by Nix (t3code-nix): `t3 service install` would set up"
    + " a service running T3 Code's own download instead, without the bundled"
    + " providers. Use programs.t3code.server in the NixOS module."
    + optOut;
  t3Up =
    "t3 is installed by Nix (t3code-nix): `t3 up` (and plain `t3 connect`,"
    + " which is `t3 up --connect`) would install a service running T3 Code's"
    + " own download instead, without the bundled providers. For your other"
    + " devices, use programs.t3code.server in the NixOS module (lan, host or"
    + " tailscaleServe) and `t3 pair`; for T3 Connect, run `t3 connect link`,"
    + " then restart t3code-server."
    + optOut;

  # Every option that takes a separate value, of the `t3` root command (its
  # own and the global ones) and of `t3 connect` and `t3 service`, whose
  # subcommands the guard also reads. The guard skips each one's value
  # wherever it comes. Upstream (Effect's parser) takes only the global ones
  # (`--log-level`, `--completions`) before a subcommand and rejects a
  # parent's own (`t3 --base-dir X update` is an error), so the guard is
  # stricter than it needs to be, never looser. Checked against the help of
  # all three in the t3-guard-flags check, so a value option upstream adds,
  # of any type or with an alias, opens a guard-review issue instead of
  # passing unnoticed.
  # That check reads "takes a value" from the help's column; if upstream
  # ever prints a type for a boolean, the completion script's per-option
  # `takesValue` is the exact source. The guard also takes any `-h` as help;
  # a refused command with its own `-h` would need a look.
  t3ValueFlags = [
    "--base-dir"
    "--bootstrap-fd"
    "--completions"
    "--dev-url"
    "--host"
    "--log-level"
    "--mode"
    "--port"
    "--tailscale-serve-port"
  ];

  # A boolean option takes one of these as its value when it comes next
  # (`--lan true up`, `connect --headless true`), so they are never the
  # subcommand (none is named like one). Checked against the list in
  # `t3 --completions powershell` by t3-guard-flags.
  t3BooleanWords = [
    "true"
    "yes"
    "on"
    "1"
    "y"
    "false"
    "no"
    "off"
    "0"
    "n"
  ];
  # `connect` subcommands reviewed and refused (none yet): one that installs
  # upstream's service, as plain `connect` does, goes here.
  t3ConnectRefused = [ ];
  # `t3 connect`'s subcommands it lets through: T3 Connect's sign-in and link
  # only.
  t3ConnectSubcommands = [
    "login"
    "link"
    "publish"
    "status"
    "unlink"
    "logout"
  ];
  # Every command `t3` lists in its help, at any depth (`auth pairing create`),
  # reviewed. The t3-guard-flags check walks the help and notes one upstream
  # lists that isn't here (a guard-review issue), so a new listed command
  # that installs upstream's own t3 or service can't pass unnoticed (that's
  # how `t3 up` did). Commands upstream leaves out of the help (`service
  # update`, `start`, `__service-launcher` and others) aren't covered: read
  # the bundle for them. One that only one channel lists is fine here.
  # Before adding one, read what it does in the bundle; if it installs, refuse
  # it in refuseT3 too (a `connect` one: list it in t3ConnectRefused).
  # Refused: update, up, connect (plain), service install (and its hidden
  # alias `service update`). `install` refuses itself from the Nix store
  # (only a t3 under ~/.t3/runtime/versions installs itself); `browser
  # setup` only allows Chrome's sandbox and installs libraries with apt;
  # `uninstall` and `service uninstall` remove upstream's own copy;
  # `environment link` links another machine's T3 Code (see "T3 Code over
  # SSH"); `feedback` sends a report to the T3 team through the running
  # server (only with Agent feedback set to Automatic in Settings > Labs),
  # and `feedback list` reads the reports saved on this machine; `workflow`
  # starts and steers the running server's workflow runs, lists their hook
  # paths and changes what they keep (`workflow store`); the rest handle
  # pairing, sessions, T3 Connect devices, projects, threads, themes, traces
  # and policies.
  t3Commands = [
    "help"
    "serve"
    "app"
    "pair"
    "auth"
    "auth pairing"
    "auth pairing create"
    "auth pairing list"
    "auth pairing revoke"
    "auth session"
    "auth session issue"
    "auth session list"
    "auth session revoke"
    "auth connect-device"
    "auth connect-device list"
    "auth connect-device approve"
    "auth connect-device revoke"
    "environment"
    "environment link"
    "environment list"
    "environment unlink"
    "browser"
    "browser setup"
    "project"
    "project add"
    "project remove"
    "project rename"
    "thread"
    "thread list"
    "thread start"
    "thread send"
    "thread show"
    "up"
    "status"
    "service"
    "service install"
    "service restart"
    "service uninstall"
    "service status"
    "service protect"
    "update"
    "install"
    "uninstall"
    "theme"
    "theme set"
    "theme clear"
    "theme show"
    "trace"
    "trace summary"
    "doctor"
    "policy"
    "policy show"
    "policy check"
    "policy settings"
    "policy templates"
    "triage"
    "feedback"
    "feedback list"
    "workflow"
    "workflow start"
    "workflow list"
    "workflow show"
    "workflow resume"
    "workflow cancel"
    "workflow signal"
    "workflow questions"
    "workflow hooks"
    "workflow store"
    "workflow store list"
    "workflow store set"
    "workflow store delete"
    "connect"
  ]
  # `connect`'s: the ones let through and any refused.
  ++ map (c: "connect ${c}") (t3ConnectSubcommands ++ t3ConnectRefused);

  # Each provider's top-level commands, as its help lists them, reviewed for
  # anything that installs or updates the provider (refused in its package
  # with `refuse`). The provider-commands check notes a command a release
  # adds (a guard-review issue; the release still ships): read what it does,
  # refuse it if it installs or updates, then add it here. Commands a help
  # leaves out (cursor-agent's `install`, kiro-cli's `upgrade`) aren't
  # compared; read the bundle for those.
  providerCommands = {
    "antigravity" = [
      "acp"
      "agent"
      "agents"
      "changelog"
      "help"
      "install"
      "mcp"
      "mic-serve"
      "models"
      "plugin"
      "plugins"
      "remote-control"
      "update"
    ];
    "claude-code" = [
      "agents"
      "attach"
      "auth"
      "auto-mode"
      "doctor"
      "gateway"
      "import"
      "install"
      "kill"
      "logs"
      "mcp"
      "plugin"
      "plugins"
      "purge"
      "respawn"
      "rm"
      "setup-token"
      "stop"
      "ultrareview"
      "update"
      "upgrade"
    ];
    "cursor-agent" = [
      "about"
      "agent"
      "bedrock"
      "create-chat"
      "generate-rule"
      "help"
      "install-shell-integration"
      "login"
      "logout"
      "ls"
      "mcp"
      "models"
      "persist"
      "plugin"
      "resume"
      "rule"
      "status"
      "team"
      "uninstall-shell-integration"
      "update"
      "whoami"
      "worker"
    ];
    "fx" = [
      "acp"
      "ask"
      "balance"
      "completion"
      "config"
      "credits"
      "doctor"
      "help"
      "issue"
      "login"
      "logout"
      "mcp"
      "models"
      "permissions"
      "pr"
      "provider"
      "session"
      "sessions"
      "setup"
      "slack"
      "status"
      "teams"
      "update"
      "upgrade"
      "usage"
      "workspace"
    ];
    "grok" = [
      "agent"
      "clone"
      "completions"
      # cursor-worker and workspace are hidden (not in its help); neither
      # installs grok (they start workers and leader exposures).
      "cursor-worker"
      "dashboard"
      "disk-usage"
      "doctor"
      "du"
      "export"
      "help"
      "inspect"
      "leader"
      "login"
      "logout"
      "mcp"
      "memory"
      "models"
      "plugin"
      "sessions"
      "setup"
      "trace"
      "update"
      "usage"
      "v"
      "version"
      "worker"
      "workspace"
      "worktree"
      "wrap"
    ];
    "kiro-cli" = [
      "agent"
      "chat"
      "crew"
      "diagnostic"
      "help"
      "integrations"
      "issue"
      "login"
      "logout"
      "mcp"
      "powers"
      "profile"
      "serve"
      "settings"
      "update"
      "whoami"
    ];
    "muse" = [
      "acp"
      "attach"
      "auth"
      "config"
      "exec"
      "export"
      "init"
      "login"
      "logout"
      "mcp"
      "model-profile"
      "mxp"
      "plugins"
      "resume"
      "sandbox"
      "schema"
      "serve"
      "session-message"
      "sessions"
      "skills"
      "trace"
      "usage"
      "voice"
    ];
    "opencode" = [
      "acp"
      "api"
      "auth"
      "debug"
      "machine"
      "mcp"
      "mini"
      "models"
      "pair"
      "plugin"
      "reload"
      "run"
      "serve"
      "service"
      "session"
      "stats"
      "uninstall"
      "update"
      "upgrade"
    ];
    "pi" = [
      "auth"
      "config"
      "install"
      "list"
      "mcp"
      "remove"
      "uninstall"
      "update"
    ];
  };

  # Each provider's self-update and self-install commands, refused by its
  # wrapper (guard.refuse with its name). update-guards also tests each one
  # refused, and with --help, help only.
  providerRefused = {
    "antigravity" = [
      "update"
      "install"
    ];
    "claude-code" = [
      "install"
      "update"
      "upgrade"
    ];
    "cursor-agent" = [
      "update"
      "upgrade"
      "install"
      "set-channel"
    ];
    "fx" = [
      "update"
      "upgrade"
    ];
    "grok" = [ "update" ];
    # `upgrade` is a hidden alias of `update`.
    "kiro-cli" = [
      "update"
      "upgrade"
    ];
    "opencode" = [
      "upgrade"
      "update"
    ];
  };

  # What, besides `-h` and `--help`, only prints a provider's help or
  # version and runs nothing else: as its first argument (`version`), or
  # right after a refused command (`after`, shell patterns: cursor's global
  # -v also in a cluster, grok's -h cluster). Each probed on the binary.
  providerHelp = {
    "antigravity" = {
      version = [
        "--version"
        "-version"
      ];
      # Go's flag package takes -help as well as --help; -h is an error.
      after = [ "-help" ];
    };
    "claude-code".version = [
      "-v"
      "--version"
    ];
    "cursor-agent" = {
      version = [
        "-v"
        "--version"
      ];
      after = [
        "--version"
        "-v*"
      ];
    };
    "fx".version = [
      "-v"
      "--version"
    ];
    "grok" = {
      version = [
        "-V"
        "-v"
        "--version"
      ];
      after = [ "-h*" ];
    };
    "kiro-cli".version = [
      "-V"
      "--version"
    ];
    "opencode".version = [
      "-v"
      "--version"
    ];
  };

  # Options that make a provider run a refused command itself, refused
  # wherever they come.
  refusedOptions = {
    # claude rewrites a lone `--update` or `--upgrade` to its update command.
    "claude-code" = [
      "--update"
      "--upgrade"
    ];
    # `--no-wizard` starts the wizard too.
    "opencode" = [
      "--wizard"
      "--no-wizard"
    ];
  };

  # What refuseCodex refuses: `codex update`, and below `app-server daemon`
  # and `remote-control` every command but the few known not to install.
  # The daemon's installer and updater there (`update`, `bootstrap`, `start`,
  # `restart`, the hidden `pid-update-loop` they run, `remote-control
  # start`) put codex's standalone copy into ~/.codex/packages, outside Nix
  # (they fail today only because that copy refuses the store's links).
  # Plain `codex remote-control` would too, but with the daemon's auto-start
  # off (the wrapper's `-c features.daemon_auto_start=false`) it runs in the
  # foreground and installs nothing (update-guards checks that). A
  # command new or hidden at those levels is refused until it is reviewed
  # and listed here; codex-guard-flags warns about new ones it can see.
  codexRefused = [ "update" ];
  codexAllowed = {
    "app-server daemon" = [
      "disable-remote-control"
      "enable-remote-control"
      "help"
      "stop"
      "version"
    ];
    "remote-control" = [
      "help"
      "pair"
      "stop"
    ];
  };
  # What those levels list that installs codex (reviewed, and refused).
  codexInstallers = {
    "app-server daemon" = [
      "bootstrap"
      "restart"
      "start"
      "update"
    ];
    "remote-control" = [ "start" ];
  };
  # What `codex app-server` lists, reviewed: the guard matches
  # `app-server daemon` by name, so a new alias of `daemon`, or a new
  # installer here, is noted by codex-guard-flags.
  codexAppServerCommands = [
    "daemon"
    "generate-json-schema"
    "generate-ts"
    "help"
    "proxy"
  ];
  # The commands the guard reads below (none takes arguments of its own),
  # whose help codex-guard-flags reads.
  codexLevels = [ "app-server" ] ++ lib.attrNames codexAllowed;
  # codex's short flags besides -h and -V (`app-server daemon update -y`):
  # a cluster of these that reaches h or V is help to clap (`-yh`).
  codexShortFlags = [ "y" ];
  # Top-level commands codex's help leaves out (found in the binary), so a
  # word after one is never read as a command of codex's own.
  codexHiddenCommands = [
    "cloud-tasks"
    "execpolicy"
    "git-credential"
    "responses-api-proxy"
    "tcp-tunnel"
  ];
  # codex's command line as clap parses it, for refuseCodex. The options
  # that take a separate value, at the top level and under `app-server`,
  # `app-server daemon` and `remote-control` (the levels the guard reads);
  # those that take several (`-i a.png b.png`, until the next option); and
  # the top-level commands and their aliases. The codex-guard-flags check
  # compares all three with codex's help at every bump.
  codexValueOptions = [
    "-C"
    "-a"
    "-c"
    "-m"
    "-p"
    "-s"
    "--add-dir"
    "--ask-for-approval"
    "--cd"
    "--cloud-skills-snapshot"
    "--code-mode-host"
    "--config"
    "--disable"
    "--enable"
    "--listen"
    "--local-provider"
    "--model"
    "--profile"
    "--remote"
    "--remote-auth-token-env"
    "--sandbox"
    "--startup-client-info"
    "--ws-audience"
    "--ws-auth"
    "--ws-issuer"
    "--ws-max-clock-skew-seconds"
    "--ws-shared-secret-file"
    "--ws-token-file"
    "--ws-token-sha256"
  ];
  codexMultiOptions = [
    "-i"
    "--image"
  ];
  codexCommands = [
    "a"
    "agents"
    "app-server"
    "apply"
    "archive"
    "cloud"
    "completion"
    "debug"
    "delete"
    "doctor"
    "e"
    "exec"
    "exec-server"
    "features"
    "fork"
    "help"
    "login"
    "logout"
    "mcp"
    "migrate-nfs-db"
    "migrate-rollouts"
    "plugin"
    "queue"
    "remote-control"
    "resume"
    "review"
    "sandbox"
    "unarchive"
    "update"
  ];

  # Sets $help if `-h` or `--help` comes right after $sub (`update --help`):
  # the command only prints its help then (update-guards checks it for every
  # refused command). Not later: an option's value can be `--help` in every
  # parser here but pi's (`agy install --dir --help` installs, `cursor-agent update
  # --model --help` updates), and agy stops reading options at a plain word.
  # Nor after a `--` before the command: commander still runs the command and
  # hands it `--help` as a word (`claude -- install --help` installs).
  helpWord = ''
    help= seen=
    for arg in "$@"; do
      if [ -n "$seen" ]; then case "$arg" in -h|--help) help=1 ;; esac; break; fi
      [ "$arg" = -- ] && break
      [ "$arg" = "$sub" ] && seen=1
    done'';
in
# A `connect` subcommand is let through or refused, never both.
assert lib.intersectLists t3ConnectSubcommands t3ConnectRefused == [ ];
{
  inherit
    message
    t3ValueFlags
    t3BooleanWords
    t3Commands
    codexValueOptions
    codexMultiOptions
    codexCommands
    codexRefused
    codexAllowed
    codexInstallers
    codexLevels
    codexHiddenCommands
    codexShortFlags
    codexAppServerCommands
    providerCommands
    refusedOptions
    providerHelp
    providerRefused
    ;

  # `text`: the message, when the generic one ("can't update itself") doesn't
  # fit the command.
  refuse =
    {
      name,
      # The words refused (default: the provider's providerRefused).
      commands ?
        providerRefused.${name}
          or (throw "guard.refuse: no providerRefused entry for ${name} (add one, or pass commands)"),
      text ? message name,
      # True for a program with no reviewed command list (agent-browser,
      # boat); otherwise `name` must have a providerHelp entry, so a
      # misspelt name fails to evaluate instead of quietly guarding less.
      simple ? false,
    }:
    let
      alt = lib.concatStringsSep "|";
      refused = alt commands;
      # Options that would run a refused command (opencode's `--wizard`
      # builds a command interactively, `upgrade` first), anywhere before a
      # `--`, whatever command they come with.
      options = refusedOptions.${name} or [ ];
      optionScan = lib.optionalString (options != [ ]) (
        ''for arg in "$@"; do case "$arg" in --) break ;; ''
        + lib.concatMapStringsSep "|" (o: "${o}|${o}=*") options
        + ") ${stopWith text} ;; esac; done\n"
      );
      h =
        if simple then
          null
        else
          providerHelp.${name}
            or (throw "guard.refuse: no providerHelp entry for ${name} (add one, or pass simple = true)");
      # Broadly (the providers with a reviewed command list): a refused word
      # anywhere on the line is refused, except right before `-h`, `--help`
      # or `after` (with no `--` before), and the line runs when its first
      # argument is help, the version or one of the provider's other
      # commands (`claude plugin install x`, `opencode run update`).
      known = lib.subtractLists commands (providerCommands.${name} or [ ]);
      broad = ''
        case "''${1-}" in ${
          alt (
            [
              "-h"
              "--help"
            ]
            ++ h.version or [ ]
            ++ known
          )
        }) exit 0 ;; esac
        dd= pend=
        for arg in "$@"; do
          if [ -n "$pend" ]; then
            pend=
            case "$arg" in -h|--help${
              lib.concatMapStrings (x: "|${x}") (h.after or [ ])
            }) [ -n "$dd" ] || continue ;; esac
            ${stopWith text}
          fi
          [ "$arg" != -- ] || dd=1
          case "$arg" in ${refused}) pend=1 ;; esac
        done
        [ -z "$pend" ] || { ${stopWith text}; }
      '';
      # Without a list (agent-browser, boat): a word right after an option
      # is read as its value, and the next plain word as the command.
      simpleScan = ''
        hit= afteropt= dd=
        for arg in "$@"; do
          if [ -n "$hit" ]; then
            case "$arg" in -h|--help) [ -n "$dd" ] || hit= ;; esac
            break
          fi
          case "$arg" in
            --) dd=1 afteropt=1 ;;
            --*=*) afteropt= ;;
            -*) afteropt=1 ;;
            ${refused}) hit=1 ;;
            *) [ -n "$afteropt" ] || break; afteropt= ;;
          esac
        done
        [ -z "$hit" ] || { ${stopWith text}; }
      '';
    in
    run (optionScan + (if simple then simpleScan else broad));

  # agent-browser's `doctor --fix` runs its "destructive repairs", which
  # include installing Chrome for Testing (plain `doctor` only looks).
  # Refused broadly: whenever `--fix` comes anywhere after a `doctor`, with
  # no `--` between, whatever options come before (`--session x doctor
  # --fix` got past a first-word rule).
  refuseAgentBrowserDoctorFix = run ''
    seen=
    for arg in "$@"; do
      case "$arg" in
        --) break ;;
        doctor) seen=1 ;;
        --fix) [ -z "$seen" ] || { ${
          stopWith (
            "agent-browser is installed by Nix (t3code-nix): doctor --fix would install a browser of its own, which can't start on NixOS. "
            + "Its browser is already set (AGENT_BROWSER_EXECUTABLE_PATH); see \"Agent tools\" in the t3code-nix README."
          )
        }; } ;;
      esac
    done
  '';

  # T3 Code's CLI: `t3 update` downloads upstream's own t3 and switches to
  # it, and `t3 service install` (and its hidden alias `t3 service update`)
  # sets up a user service that runs upstream's t3 from ~/.t3/runtime, as
  # `t3 up` and plain `t3 connect` (`t3 up --connect`) do (tested: a 438 MB
  # download). All bypass Nix and the bundled providers, so
  # programs.t3code.server stands in. The other `t3 service` commands only act
  # on upstream's service, if one is installed, and `t3 connect`'s
  # subcommands only handle T3 Connect's sign-in and link (`t3 connect link`
  # plus the Nix server is T3 Connect without upstream's service, tested):
  # both keep working, as does any `--help`. Matched on the first two
  # arguments that aren't options or an option's value (`--log-level debug`;
  # see t3ValueFlags); a subcommand's own options can't come before it.
  # Known gap: `--wizard`, which builds the command interactively.
  refuseT3 = run ''
    sub= sub2= skip= help=
    for arg in "$@"; do
      # After `--` every word is an argument, never a subcommand or help.
      [ "$arg" = -- ] && break
      if [ -n "$skip" ]; then skip=; continue; fi
      case "$arg" in
        ${lib.concatStringsSep "|" t3ValueFlags}) skip=1 ;;
        --help|-h) help=1 ;;
        -*|${lib.concatStringsSep "|" t3BooleanWords}) ;;
        *) if [ -z "$sub" ]; then sub=$arg; elif [ -z "$sub2" ]; then sub2=$arg; fi ;;
      esac
    done
    [ -n "$help" ] || case "$sub" in
      update) ${stopWith t3Update} ;;
      service) case "$sub2" in install|update) ${stopWith t3Service} ;; esac ;;
      up) ${stopWith t3Up} ;;
      connect) case "$sub2" in ${lib.concatStringsSep "|" t3ConnectSubcommands}) ;; *) ${stopWith t3Up} ;; esac ;;
    esac'';

  # codex: refuses codexRefused's commands, and those below codexAllowed's
  # levels it doesn't allow, wherever clap would find them. It rebuilds the
  # command path as clap does: options are skipped with their values
  # (`--listen off`; `-i` takes words until the next option, `-` among
  # them), and a top-level word that isn't a command is the prompt, which a
  # command may still follow (`codex fix update` runs `update`). From the
  # first command on, every other word joins the path: below `app-server`,
  # `daemon` and `remote-control` it is the next command (they take no
  # arguments of their own; codex-guard-flags checks that), and below any
  # other command (`codex exec ...`) it is that command's business, and the
  # path no longer matches. `--` ends the scan (no command after it); `-h`,
  # `--help`, `-V` or `--version` that isn't an option's value prints help
  # or the version instead (or is an error below the top level). When codex
  # is bumped, read its command table, aliases, hidden and nested commands
  # included, for anything that installs or updates it.
  refuseCodex =
    let
      alt = l: lib.concatMapStringsSep "|" lib.escapeShellArg l;
      under = level: lib.escapeShellArg "${level} ";
    in
    run ''
      path= skip= multi= help=
      for arg in "$@"; do
        if [ -n "$skip" ]; then skip=; continue; fi
        case "$arg" in
          --) break ;;
          -) ;;
          # A cluster is help too when, after any of codexShortFlags, it
          # reaches h or V (`-hc x`, `-yh`): those are codex's only short
          # flags but for value options (codex-guard-flags notes another), so
          # `-ch` is -c with the value h.
          -h|--help|-V|--version) help=1; continue ;;
          -[hV${lib.concatStrings codexShortFlags}]?*)
            rest=''${arg#-}
            while case "$rest" in [${lib.concatStrings codexShortFlags}]*) true ;; *) false ;; esac; do rest=''${rest#?}; done
            case "$rest" in [hV]*) help=1 ;; esac
            continue ;;
          ${alt codexValueOptions}) skip=1 multi=; continue ;;
          ${alt codexMultiOptions}) skip=1 multi=1; continue ;;
          -*) multi=; continue ;;
        esac
        [ -z "$multi" ] || continue
        if [ -n "$path" ]; then path="$path $arg"
        else case "$arg" in ${
          alt (codexCommands ++ codexHiddenCommands)
        }) path=$arg ;; *) continue ;; esac
        fi
      done
      [ -n "$help" ] || case "$path" in
        ${
          lib.concatMapStrings (c: "${lib.escapeShellArg c}|${under c}*) ${stop "codex"} ;;
") codexRefused
        }${
          lib.concatStrings (
            lib.mapAttrsToList (level: allowed: ''
              ${under level}*) cmd=''${path#${under level}}; case "''${cmd%% *}" in ${alt allowed}) ;; *) ${stop "codex"} ;; esac ;;
            '') codexAllowed
          )
        }esac'';

  # pi's `update` also updates extensions and model lists. Refuse the forms
  # that update pi itself: plain `pi update`, and `self`, `pi`, `--self` or
  # `--all` anywhere after it. `pi update --extensions` (or `--models`, or a
  # named package source) still runs, and so does `pi update --help`.
  refusePiSelfUpdate = run ''
    # pi reads a command only from its first argument (`pi --offline update`
    # is a prompt).
    sub=''${1-}
    ${helpWord}
    if [ "$sub" = update ] && [ -z "$help" ]; then
      # Only what comes after `update` says what to update.
      # A target is --extensions, --models, --extension SOURCE or a named
      # source; other options (--force, --approve) aren't, so `pi update
      # --force` updates pi and is refused.
      seen= target= value=
      for arg in "$@"; do
        if [ -z "$seen" ]; then
          [ "$arg" = update ] && seen=1
          continue
        fi
        if [ -n "$value" ]; then value=; target=1; continue; fi
        case "$arg" in
          self|pi|--self|--all) ${stop "pi"} ;;
          --extensions|--models|--extension=*) target=1 ;;
          --extension) value=1 ;;
          # An empty source is no source to pi: it updates itself.
          ""|-*) ;;
          *) target=1 ;;
        esac
      done
      [ -n "$target" ] || { ${stop "pi"}; }
    fi'';
}
