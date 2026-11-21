# Checks beyond "every package builds and passes its version probe".
# They run in the Nix sandbox: no network, loopback only.
{
  lib,
  runCommand,
  fetchurl,
  nodejs_26,
  typescript,
  git,
  openssh,
  fontconfig,
  makeFontsConf,
  dejavu_fonts,
  writeClosure,
  getent,
  stdenv,
  pkgs,
  path,
  self,
  cache,
  overlayPkgs,
  overlayAllowed,
  packages,
  # Where the pins are read from: versions/, or versions/stable/ for the
  # NixOS-stable suite (the same checks on the stable set, see flake.nix).
  pinsDir ? ../versions,
  # The same set built without allowing unfree packages, for free-variant;
  # null: the overlay without allowUnfree (the default suite).
  freeSet ? null,
  # The flake's packages with ci/electron-fallback.json ignored, for the
  # checks that compare the overlay (which never reads it) with them.
  noFallback ? packages,
}:
let
  pinOf = name: lib.importJSON (pinsDir + "/${name}.json");
  # The program a provider wrapper runs (its last exec line), as shell.
  target =
    pkg: bin: ''$(sed -n 's/^exec .*"\(\/nix\/store\/[^"]*\)".*/\1/p' ${pkg}/bin/${bin} | tail -1)'';
  versions = import ./versions.nix {
    inherit lib fetchurl pinsDir;
    inherit (pkgs) versionCheckHook;
  };
  # A stand-in browser for agent-browser's gating checks, which never evaluate
  # a real optional browser (chromium, google-chrome): their problems report.
  standIn =
    name: runCommand name { meta.mainProgram = name; } "mkdir -p $out/bin && touch $out/bin/${name}";
  # A set without nightly packages (the stable set) leaves their entries out.
  present = builtins.filter (x: x != null);
  presentRows = builtins.filter (r: builtins.head r != null);
  # Each provider with a reviewed command list (lib/guard.nix): its package,
  # command and refused commands. update-guards tests each refused command
  # refused, and with --help or -h help only, and each version form allowed;
  # the hand-written rows add each vendor's quirks.
  guardTables = lib.mapAttrsToList (n: commands: {
    pkg = packages.${n} or null;
    bin = if packages ? ${n} then packages.${n}.meta.mainProgram else n;
    inherit commands;
    version = guard.providerHelp.${n}.version or [ ];
  }) guard.providerRefused;
  # agent-browser on the browser-stable pin's ungoogled-chromium: what the
  # module's `browserChannel = "stable"` installs. Not a package of its own
  # (that override is the way to get it); built here as a check, and smoked
  # by scripts/ci/test.ts. Null where agent-browser or the pin is missing.
  agent-browser-stable-chromium =
    if packages ? agent-browser && builtins.pathExists (pinsDir + "/browser-stable.json") then
      packages.agent-browser.override { browserChannel = "stable"; }
    else
      null;
  guard = import ./guard.nix { inherit lib; };
  # t3code driver id -> the bundled package that provides it.
  drivers = import ../pkgs/t3code/providers.nix packages;
  expected = builtins.toFile "t3-expected-providers.json" (
    builtins.toJSON (lib.mapAttrs (_: p: p.version) drivers)
  );
  # Just the smoke script and its one helper, so changes elsewhere in scripts/
  # don't rerun the smoke tests.
  smokeScripts = runCommand "t3-smoke-scripts" { } ''
    mkdir -p $out/lib
    cp ${../scripts/t3-smoke.ts} $out/t3-smoke.ts
    cp ${../scripts/lib/proc.ts} $out/lib/proc.ts
  '';
  smoke =
    t3:
    runCommand "${t3.name}-smoke"
      {
        nativeBuildInputs = [
          nodejs_26
          git
          openssh
          fontconfig # fc-match, for `t3 browser setup`
          pkgs.util-linux # unshare: the smoke runs in a PID namespace of its own
        ];
        FONTCONFIG_FILE = makeFontsConf { fontDirectories = [ dejavu_fonts ]; };
      }
      ''
        node ${smokeScripts}/t3-smoke.ts ${t3}/bin/t3 ${expected} ${t3.previewBrowser.platform} ${t3.previewBrowser.version}
        touch $out
      '';

  # The bundled server pins exactly the browser archive we ship: its
  # PreviewBrowser.ts version and SHA-256, compiled into the CLI and into the
  # desktop app's app.asar.
  preview-browser-pin =
    let
      pairs = presentRows [
        [
          packages.t3-unwrapped
          "t3"
          "libexec/t3/t3"
        ]
        [
          (packages.t3-unwrapped-nightly or null)
          "t3-nightly"
          "libexec/t3/t3"
        ]
        [
          packages.t3code-unwrapped
          "t3code"
          "libexec/t3code/resources/app.asar"
        ]
        [
          (packages.t3code-unwrapped-nightly or null)
          "t3code-nightly"
          "libexec/t3code-nightly/resources/app.asar"
        ]
      ];
      check =
        p:
        let
          b = (pinOf (builtins.elemAt p 1)).browser;
          file = "${builtins.elemAt p 0}/${builtins.elemAt p 2}";
          hex = builtins.convertHash {
            hash = b.assets.${stdenv.hostPlatform.system}.hash;
            toHashFormat = "base16";
          };
        in
        ''
          grep -qaF '"${b.version}"' ${file} || { echo "${file} doesn't pin browser ${b.version}"; exit 1; }
          grep -qaF '${hex}' ${file} || { echo "${file} doesn't pin the archive ${hex}"; exit 1; }
        '';
    in
    runCommand "preview-browser-pin" { } (lib.concatMapStrings check pairs + "touch $out");

  # Dictation: t3code's server runs transcribe-cpp (libtranscribe.so with
  # ggml's CPU and Vulkan backends) in a worker, with models it downloads
  # from Hugging Face at run time. Nothing is packaged for it; these checks
  # make sure a release keeps working.
  speechScript = runCommand "speech-check-script" { } ''
    mkdir $out
    cp ${../scripts/speech-check.ts} $out/speech-check.ts
  '';
  # [package, pin name, where its node_modules are, the file the catalog is
  # compiled into]
  speechApps = presentRows [
    [
      packages.t3-unwrapped
      "t3"
      "libexec/t3/node_modules"
      "libexec/t3/t3"
    ]
    [
      (packages.t3-unwrapped-nightly or null)
      "t3-nightly"
      "libexec/t3/node_modules"
      "libexec/t3/t3"
    ]
    [
      packages.t3code-unwrapped
      "t3code"
      "libexec/t3code/resources/app.asar.unpacked/node_modules"
      "libexec/t3code/resources/app.asar"
    ]
    [
      (packages.t3code-unwrapped-nightly or null)
      "t3code-nightly"
      "libexec/t3code-nightly/resources/app.asar.unpacked/node_modules"
      "libexec/t3code-nightly/resources/app.asar"
    ]
  ];
  speechPin = name: (pinOf name).speech;

  # Every library transcribe-cpp ships resolves, in the CLI and the desktop
  # app (whose worker is Electron's executable, so this is its evidence).
  speech-libs = runCommand "speech-libs" { } (
    lib.concatMapStrings (
      a:
      let
        dir = "${builtins.elemAt a 0}/${builtins.elemAt a 2}/@transcribe-cpp";
      in
      ''
        [ -n "$(find ${dir} -name libtranscribe.so)" ] || { echo "${dir}: no libtranscribe.so"; exit 1; }
        n=0
        while read -r f; do
          n=$((n + 1))
          deps=$(${lib.getBin stdenv.cc.libc}/bin/ldd "$f" 2>&1) || { echo "$f: $deps"; exit 1; }
          if grep -q "not found" <<< "$deps"; then echo "$f:"; grep "not found" <<< "$deps"; exit 1; fi
        done < <(find ${dir} -name '*.so*' -type f)
        echo "${dir}: $n libraries resolve"
      ''
    ) speechApps
    + "touch $out"
  );

  # The release's catalog still lists the model speech-smoke uses: its file
  # name and SHA-256, compiled into the CLI and app.asar. A model kept from
  # an earlier catalog (fromCatalog false) isn't the release's to check.
  speech-model-pin = runCommand "speech-model-pin" { } (
    lib.concatMapStrings (
      a:
      let
        s = speechPin (builtins.elemAt a 1);
        file = "${builtins.elemAt a 0}/${builtins.elemAt a 3}";
      in
      lib.optionalString s.fromCatalog ''
        grep -qaF '${s.filename}' ${file} || { echo "${file} doesn't list ${s.filename}"; exit 1; }
        grep -qaF '${s.sha256}' ${file} || { echo "${file} doesn't list the model ${s.sha256}"; exit 1; }
      ''
    ) speechApps
    + "touch $out"
  );

  # Upstream's worker starts, as the server starts it, and lists devices.
  speechWorker =
    t3:
    runCommand "${t3.name}-speech-worker" { nativeBuildInputs = [ nodejs_26 ]; } ''
      export HOME=$TMPDIR
      node ${speechScript}/speech-check.ts worker ${t3}/libexec/t3/t3
      touch $out
    '';

  # The packaged engine transcribes a spoken clip on the CPU, with the
  # release's pinned test model (a fixed-output download).
  speechSmoke =
    t3: name:
    let
      s = speechPin name;
      model = fetchurl {
        inherit (s) url sha256;
        name = s.filename;
      };
    in
    runCommand "${t3.name}-speech-smoke"
      {
        nativeBuildInputs = [
          nodejs_26
          pkgs.espeak-ng
        ];
      }
      ''
        export HOME=$TMPDIR
        espeak-ng -v en-us -s 150 -w clip.wav "hello world, testing one two three"
        node ${speechScript}/speech-check.ts transcribe ${t3}/libexec/t3/node_modules/transcribe-cpp ${model} clip.wav
        touch $out
      '';

  # ACP registry runtimes (wrap.nix's acpRuntimes): what each value puts on
  # the wrapper's PATH, in which place, and that t3code then finds the
  # runner an npm or uv agent needs (scripts/acp-check.ts, against a seeded
  # registry cache: nothing is fetched).
  acpScripts = runCommand "acp-check-scripts" { } ''
    mkdir -p $out/lib
    cp ${../scripts/acp-check.ts} $out/acp-check.ts
    cp ${../scripts/lib/proc.ts} $out/lib/proc.ts
  '';
  acp-runtimes =
    let
      t3With =
        acpRuntimes:
        packages.t3.override {
          inherit acpRuntimes;
          providers = [ "codex" ];
          withPreviewBrowser = false;
        };
      none = t3With [ ];
      node = t3With [ "nodejs" ];
      uv = t3With [ "uv" ];
      both = t3With [
        "uv"
        "nodejs"
      ];
      bin = p: "${lib.getBin p}/bin";
      nodeBin = bin pkgs.nodejs;
      uvBins = "${bin pkgs.uv}:${bin pkgs.python3}";
      codexBin = bin packages.codex;
      defaults = writeClosure [
        packages.t3
        packages.t3code
      ];
    in
    runCommand "acp-runtimes"
      {
        nativeBuildInputs = [
          nodejs_26
          pkgs.uv
          pkgs.python3
        ];
      }
      ''
        export HOME=$TMPDIR
        fail() { echo "$*"; exit 1; }
        # The PATH a wrapper gives t3, run from PATH=/base.
        # (Each block from a PATH= line to its export: --suffix adds an if.)
        pathOf() { sed -n '/^PATH=/,/^export PATH$/p' "$1/bin/t3" > path.sh; (PATH=/base; . ./path.sh; echo "$PATH"); }

        # The default adds nothing: no runner in the closures, none on PATH.
        for p in ${pkgs.nodejs} ${pkgs.uv}; do
          ! grep -qxF "$p" ${defaults} || fail "the default closure has $p"
        done
        for w in ${packages.t3} ${none}; do
          case "$(pathOf $w)" in *${nodeBin}*|*${bin pkgs.uv}*|*${bin pkgs.python3}*) fail "$w puts a runtime on PATH" ;; esac
        done

        # Each value: exactly its packages, after the providers and the
        # user's PATH, so the user's own wins.
        for c in "${node} ${nodeBin}" "${uv} ${uvBins}" "${both} ${uvBins}:${nodeBin}"; do
          set -- $c
          path=$(pathOf $1)
          case "$path" in ${codexBin}:*/base:$2) ;; *) fail "$1: PATH is $path, expected the providers, /base, then $2" ;; esac
        done

        # t3code finds the runner on the wrapper's PATH, and nowhere else.
        node ${acpScripts}/acp-check.ts ${none}/bin/t3 - - ${bin pkgs.coreutils}
        node ${acpScripts}/acp-check.ts ${both}/bin/t3 ${nodeBin}/npm ${bin pkgs.uv}/uv ${bin pkgs.coreutils}

        # uv uses the bundled python3, offline, rather than downloading one.
        # (only-system: uv's look for its own Pythons reads /bin/sh's ELF
        # interpreter to tell the libc, and the sandbox has no /bin/sh.)
        PATH=${uvBins} UV_PYTHON_DOWNLOADS=never UV_PYTHON_PREFERENCE=only-system uv venv --offline --no-cache -q venv
        py=$(readlink -f venv/bin/python)
        case "$py" in ${pkgs.python3}/*) ;; *) fail "uv's venv runs $py, not ${pkgs.python3}" ;; esac
        touch $out
      '';

  # fx's updater stays off however its settings ask: the wrapper's
  # FX_AUTO_UPGRADE=0 outranks ~/.fx/settings.json's auto_upgrade (fx's
  # documented precedence), which `fx config set` writes. fx reports where
  # each value comes from (`config list --show-origin`, offline); the last
  # line for a key is the one it uses (`config get` doesn't count the
  # environment, so it can't show this). The whole listing goes to the log
  # first, so a renamed key or format still shows what fx said.
  fx-upgrade-off = runCommand "fx-upgrade-off" { } ''
    used() {
      home=$(mktemp -d) && mkdir -m 700 $home/.fx
      echo '{"auto_upgrade":true,"update_channel":"dev"}' > $home/.fx/settings.json
      HOME=$home timeout 30 "$1" config list --show-origin | tee /dev/stderr | grep -P '\tauto_upgrade=' | tail -n 1
    }
    # Unwrapped, the settings file wins, so the comparison means something.
    # Each in an assignment of its own: fx failing stops the build.
    control=$(used ${packages.fx}/libexec/fx/fx)
    [ "$control" = "$(printf 'file:~/.fx/settings.json\tauto_upgrade=true')" ] \
      || { echo "control: fx uses auto_upgrade from: $control"; exit 1; }
    got=$(used ${packages.fx}/bin/fx)
    [ "$got" = "$(printf 'env:FX_AUTO_UPGRADE\tauto_upgrade=false')" ] \
      || { echo "wrapped: fx uses auto_upgrade from: $got"; exit 1; }
    touch $out
  '';

  # boat's update check stays off: both runs send boat's requests to a
  # recorder on loopback (BOAT_API_URL; a proxy can't see them, boat uses
  # rustls with its own roots), signed out, with a fresh config whose last
  # check is 0, then run `boat status`. The control run, the package's
  # executable without the wrapper, must ask for a version and write the
  # time of its check; the wrapped one must do neither. Nothing leaves
  # loopback.
  boat-self-update-off = runCommand "boat-self-update-off" { nativeBuildInputs = [ nodejs_26 ]; } ''
    cat > recorder.mjs <<'EOF'
    import { createServer } from "node:http";
    import { appendFileSync, writeFileSync } from "node:fs";
    const srv = createServer((req, res) => { appendFileSync("requests", req.url + "\n"); res.writeHead(404).end(); });
    srv.listen(0, "127.0.0.1", () => writeFileSync("port", String(srv.address().port)));
    EOF
    touch requests
    node recorder.mjs & rec=$!
    for i in $(seq 50); do [ -s port ] && break; sleep 0.1; done
    run() {
      home=$(mktemp -d) && mkdir -p $home/.config/ascii/boat
      echo '{"last_update_check":0}' > $home/.config/ascii/boat/config.json
      : > requests
      HOME=$home XDG_CONFIG_HOME=$home/.config BOAT_API_URL=http://127.0.0.1:$(cat port) timeout 30 "$1" status >/dev/null 2>&1 || true
      checked=$(grep -o '"last_update_check": *[0-9]*' $home/.config/ascii/boat/config.json | grep -o '[0-9]*$')
    }
    run ${packages.boat}/libexec/boat/boat
    grep -q '^/api/boat/cli/version?' requests || { echo "control: no update check reached the recorder"; cat requests; exit 1; }
    [ "$checked" != 0 ] || { echo "control: last_update_check stayed 0"; exit 1; }
    run ${packages.boat}/bin/boat
    # It ran as far as boat's own first request, so the rest means something.
    grep -q '^/api/boat/dashboard/bootstrap' requests || { echo "wrapped: boat never reached the recorder"; cat requests; exit 1; }
    ! grep -q '^/api/boat/cli/version' requests || { echo "wrapped: boat checked for an update"; cat requests; exit 1; }
    [ "$checked" = 0 ] || { echo "wrapped: last_update_check moved to $checked"; exit 1; }
    kill $rec
    touch $out
  '';

  # Agent tools are never part of T3 Code: in no closure of the app or the
  # CLI, any channel or variant.
  agent-tools-separate =
    let
      apps = present [
        packages.t3code
        (packages.t3code-nightly or null)
        packages.t3code-free
        packages.t3
        (packages.t3-nightly or null)
        packages.t3-free
      ];
      tools = present [
        packages.boat
        packages.agent-browser
        agent-browser-stable-chromium
      ];
    in
    runCommand "agent-tools-separate" { } ''
      ${lib.concatMapStrings (t: ''
        if grep -qxF ${t} ${writeClosure apps}; then echo "${t.name} is in T3 Code's closure"; exit 1; fi
      '') tools}
      touch $out
    '';

  # agent-browser's browser choice, gating: only what can't depend on the two
  # optional browsers (chromium, google-chrome), whose own checks are in
  # their report-only variants (legacyPackages.<system>.agentBrowserVariants).
  # Evaluation only, except a wrapper around a fake browser.
  agent-browser-browsers =
    let
      ab = packages.agent-browser;
      pinned = (pinOf "browser-${ab.browserChannel}").outPaths.${stdenv.hostPlatform.system};
      # A stand-in browser: never a real one, so nothing large is built.
      fake = runCommand "fake-chrome" { meta.mainProgram = "fake-chrome"; } ''
        mkdir -p $out/bin && printf '#!/bin/sh\n' > $out/bin/fake-chrome && chmod +x $out/bin/fake-chrome
      '';
      withFake = ab.override { browser = fake; };
      # The wrapper with its final exec swapped for `env`, to read what it sets.
      envOf = pkg: ''
        sed 's|^exec ".*/libexec/agent-browser/agent-browser"|exec env|' ${pkg}/bin/agent-browser > ./w
        chmod +x ./w
      '';
    in
    conditions "agent-browser-browsers"
      {
        "the default is ungoogled-chromium at the pin's store path" =
          ab.browserChoice == "ungoogled-chromium"
          && builtins.unsafeDiscardStringContext ab.executable == "${pinned}/bin/chromium";
        "a package's meta.mainProgram is what runs (lib.getExe)" =
          withFake.browserChoice == "package"
          &&
            builtins.unsafeDiscardStringContext withFake.executable
            == builtins.unsafeDiscardStringContext "${fake}/bin/fake-chrome";
        "an unknown name fails evaluation" = fails (ab.override { browser = "firefox"; }).executable;
      }
      ''
        ${envOf withFake}
        ./w | grep -qxF "AGENT_BROWSER_EXECUTABLE_PATH=${fake}/bin/fake-chrome" \
          || { echo "the wrapper doesn't default to the package's browser"; exit 1; }
        AGENT_BROWSER_EXECUTABLE_PATH=/elsewhere ./w | grep -qxF AGENT_BROWSER_EXECUTABLE_PATH=/elsewhere \
          || { echo "a user's AGENT_BROWSER_EXECUTABLE_PATH doesn't win"; exit 1; }
        if HOME=$TMPDIR ${withFake}/bin/agent-browser install > out 2>&1; then echo "install wasn't refused"; exit 1; fi
        grep -qF 'browser = "google-chrome"' out || { echo "install's message doesn't name google-chrome"; cat out; exit 1; }
      '';

  # The wrapper's link script, against t3code's base-dir rules and an
  # earlier download (preview-browser.sh).
  preview-browser-link = runCommand "preview-browser-link" { nativeBuildInputs = [ getent ]; } ''
    . ${packages.t3.passthru.linkPreviewBrowser}
    export HOME=$TMPDIR/home
    mkdir -p $HOME $TMPDIR/cwd $TMPDIR/target
    cd $TMPDIR/cwd
    target=$TMPDIR/target
    link() { t3codeLinkPreviewBrowser "$@"; }
    expect() { [ "$(readlink -- "$1/tools/chrome-headless-shell/p/1")" = "$target" ] || { echo "FAIL: $2"; exit 1; }; }

    # The setting is host-wide and visible here. On a host that restricts user
    # namespaces only the skip can be tested.
    if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
      link 1 $target p 1
      [ ! -e $HOME/.t3 ] || { echo "FAIL: linked on a host that restricts user namespaces"; exit 1; }
      echo "preview-browser-link: host restricts user namespaces; only the skip is tested"
      touch $out
      exit 0
    fi

    link 1 $target p 1;                         expect $HOME/.t3 "default ~/.t3"
    T3CODE_HOME=$TMPDIR/env link 1 $target p 1; expect $TMPDIR/env "T3CODE_HOME"
    T3CODE_HOME=$TMPDIR/env link 1 $target p 1 serve --base-dir $TMPDIR/flag
                                                expect $TMPDIR/flag "--base-dir beats T3CODE_HOME"
    link 1 $target p 1 serve --base-dir=$TMPDIR/eq; expect $TMPDIR/eq "--base-dir=DIR"
    link 1 $target p 1 serve --base-dir rel;    expect $TMPDIR/cwd/rel "relative to the cwd"
    link 1 $target p 1 serve --base-dir "~/tilde"; expect $HOME/tilde "~/ expanded"
    link 1 $target p 1 serve --base-dir "$TMPDIR/with space"; expect "$TMPDIR/with space" "spaces"
    link 1 $target p 1 --base-dir $TMPDIR/a --base-dir $TMPDIR/b; expect $TMPDIR/b "the last one wins"
    link 1 $target p 1 run -- --base-dir $TMPDIR/after; [ ! -e $TMPDIR/after ] || { echo "FAIL: after --"; exit 1; }
    link 0 $target p 1 --base-dir $TMPDIR/desk; [ ! -e $TMPDIR/desk ] || { echo "FAIL: desktop has no --base-dir"; exit 1; }
    T3CODE_HOME=deskrel link 0 $target p 1;     expect $HOME/deskrel "desktop: relative to the home folder"

    # Trimmed like t3code; whitespace only means the default; "~\".
    link 1 $target p 1 serve --base-dir "  $TMPDIR/trim  "; expect $TMPDIR/trim "trimmed"
    T3CODE_HOME="   " link 1 $target p 1;     expect $HOME/.t3 "blank T3CODE_HOME"
    rm -rf $HOME/.t3
    link 1 $target p 1 serve --base-dir '~\bs'; expect $HOME/bs '"~\" expanded'
    # No HOME: the account's home folder, as t3code (os.homedir) uses.
    account=$(getent passwd "$(id -u)" | cut -d: -f6)
    ( unset HOME; link 1 $target p 1 );         expect "$account/.t3" "the account's home without HOME"
    ( unset HOME; link 1 $target p 1 serve --base-dir $TMPDIR/nohome ); expect $TMPDIR/nohome "absolute without HOME"

    # An earlier download is replaced; a correct link is left alone.
    d=$TMPDIR/dl/tools/chrome-headless-shell/p/1
    mkdir -p $d && touch $d/chrome-headless-shell
    T3CODE_HOME=$TMPDIR/dl link 1 $target p 1; expect $TMPDIR/dl "replaces a download"
    [ -z "$(ls -A $TMPDIR/dl/tools/chrome-headless-shell/p | grep -v '^1$')" ] || { echo "FAIL: leftovers"; exit 1; }
    before=$(stat -c %i $d)
    T3CODE_HOME=$TMPDIR/dl link 1 $target p 1
    [ "$(stat -c %i $d)" = "$before" ] || { echo "FAIL: relinked a correct link"; exit 1; }
    echo "preview-browser-link: all cases pass"
    touch $out
  '';

  # Leaving the browser out drops it from the closure.
  preview-browser-optional =
    let
      without = packages.t3.override { withPreviewBrowser = false; };
    in
    runCommand "preview-browser-optional" { } ''
      if grep -q chrome-headless-shell ${writeClosure [ without ]}; then
        echo "withPreviewBrowser = false still has the browser in its closure"; exit 1
      fi
      grep -q chrome-headless-shell ${writeClosure [ packages.t3 ]}
      touch $out
    '';

  # A check made of named conditions that are settled while evaluating, plus
  # an optional script. It fails naming the false ones.
  conditions =
    name: tests: script:
    let
      failed = builtins.attrNames (lib.filterAttrs (_: ok: !ok) tests);
    in
    runCommand name { } (
      if failed == [ ] then
        script + "\ntouch $out"
      else
        "echo ${lib.escapeShellArg "${name}: not true: ${lib.concatStringsSep "; " failed}"}; exit 1"
    );
  fails = value: !(builtins.tryEval (builtins.deepSeq value value)).success;

  # `providers` and `excludeProviders` on the wrapped packages
  # (pkgs/t3code/select-providers.nix).
  provider-selection =
    let
      pick = args: map lib.getName (packages.t3.override args).providers;
      inherit
        (import ../pkgs/t3code/select-providers.nix {
          inherit lib;
          available = drivers;
        })
        unknown
        unknownRuntime
        ;
      runtimes = acpRuntimes: (packages.t3.override { inherit acpRuntimes; }).passthru.acpRuntimes;
    in
    conditions "provider-selection" {
      "ACP runtimes by name, once each, in the order given" =
        runtimes [ ] == [ ]
        &&
          runtimes [
            "uv"
            "nodejs"
            "uv"
          ] == [
            "uv"
            "nodejs"
          ];
      "a misspelt ACP runtime, or a package, is an error" =
        fails (runtimes [ "nodej" ]) && fails (runtimes [ pkgs.nodejs ]);
      "the runtime error suggests the nearest name, and lists them" =
        lib.hasInfix ''unknown ACP runtime "nodej"; did you mean "nodejs"?'' (
          unknownRuntime "nodej" [
            "nodejs"
            "uv"
          ]
        )
        && lib.hasInfix "runtimes are: nodejs, uv." (
          unknownRuntime "pnpm" [
            "nodejs"
            "uv"
          ]
        )
        && !lib.hasInfix "did you mean" (
          unknownRuntime "pnpm" [
            "nodejs"
            "uv"
          ]
        );
      "every provider by default" =
        pick { } == map lib.getName (builtins.attrValues drivers) && builtins.length (pick { }) == 10;
      "by driver name, in the order given" =
        pick {
          providers = [
            "pi"
            "claudeAgent"
            "kiro"
          ];
        } == [
          "pi"
          "claude-code"
          "kiro-cli"
        ];
      "the README's example" =
        pick {
          providers = [
            "codex"
            "claude"
          ];
        } == [
          "codex"
          "claude-code"
        ];
      "every driver name and every package name is a provider" =
        pick { providers = builtins.attrNames drivers; } == pick { }
        && pick { providers = pick { }; } == pick { };
      "packages still work, mixed with names" =
        pick {
          providers = [
            packages.codex
            "opencode"
            git
          ];
        } == [
          "codex"
          "opencode"
          "git"
        ];
      "a provider named twice is bundled once" =
        pick {
          providers = [
            "claude"
            "claudeAgent"
            packages.claude-code
          ];
        } == [ "claude-code" ];
      "excludeProviders" =
        pick {
          excludeProviders = [
            "grok"
            "kiro-cli"
          ];
        } == lib.subtractLists [ "grok" "kiro-cli" ] (pick { });
      "excludeProviders also removes a provider given as a package" =
        pick {
          providers = [
            packages.codex
            "pi"
          ];
          excludeProviders = [ "codex" ];
        } == [ "pi" ];
      "a typo is an error" = fails (pick {
        providers = [ "codx" ];
      });
      "a typo in excludeProviders is an error" = fails (pick {
        excludeProviders = [ "gork" ];
      });
      "so is one nothing reaches: no providers, or after a match" =
        fails (pick {
          providers = [ ];
          excludeProviders = [ "gork" ];
        })
        && fails (pick {
          providers = [ "codex" ];
          excludeProviders = [
            "codex"
            "gork"
          ];
        });
      "a package in excludeProviders is an error" = fails (pick {
        excludeProviders = [ packages.grok ];
      });
      "the error suggests the nearest name" =
        lib.hasInfix ''unknown provider "codx"; did you mean "codex"?'' (unknown "codx")
        && lib.hasInfix ''did you mean "claude"?'' (unknown "Claud")
        && lib.hasInfix ''did you mean "kiro-cli"?'' (unknown "kiro-cl");
      "nothing near means no suggestion, and the list" =
        !lib.hasInfix "did you mean" (unknown "gemini")
        && lib.hasInfix "antigravity, claudeAgent, codex" (unknown "gemini");
    } "";

  # t3code-free and t3-free: free packages only, all the way down, so the
  # binary cache may hold them.
  free-variant =
    let
      free = [
        packages.t3code-free
        packages.t3-free
      ];
    in
    conditions "free-variant" {
      # The set's free providers (four in the flake's; the stable set may
      # lack one until its snapshot moves).
      "the free providers" =
        map lib.getName packages.t3-free.providers == map lib.getName (
          builtins.filter (p: !builtins.elem (lib.getName p) (import ../pkgs/unfree.nix)) (
            builtins.attrValues drivers
          )
        );
      "no preview browser" = builtins.all (p: p.previewBrowser == null) free;
      "named -free, apart from the full packages" =
        lib.getName packages.t3code-free == "t3code-free" && lib.getName packages.t3-free == "t3-free";
      "the full packages are not free to an overlay user" =
        if freeSet == null then
          fails overlayPkgs.t3code.drvPath && fails overlayPkgs.t3code-nix.t3.drvPath
        else
          fails freeSet.t3code.drvPath && fails freeSet.t3.drvPath;
      # Evaluating them without allowUnfree proves nothing unfree is anywhere
      # in their build graph (cache.ts checks the closure again before each
      # push).
      "an overlay user without allowUnfree gets the same derivations" =
        if freeSet == null then
          overlayPkgs.t3code-free.drvPath == noFallback.t3code-free.drvPath
          && overlayPkgs.t3code-nix.t3-free.drvPath == packages.t3-free.drvPath
        else
          freeSet.t3code-free.drvPath == packages.t3code-free.drvPath
          && freeSet.t3-free.drvPath == packages.t3-free.drvPath;
    } "";

  # No package depends on which commit it was built from (self.rev and the
  # like), so the paths the tests built are the published commit's paths and
  # the cache job's manifest holds. Packages get only nixpkgs (pkgs/default.nix
  # never sees `self`); this keeps it so.
  no-self-rev = runCommand "no-self-rev" { } ''
    # The flake's own revision only (a fetcher's `rev = …` is fine).
    if grep -rnE '\b(self|sourceInfo)\.(rev|shortRev|dirtyRev|dirtyShortRev|lastModified|lastModifiedDate|narHash)\b|\bsourceInfo\b' \
        ${../flake.nix} ${../pkgs} ${../nixos} \
        $(find ${./.} -name '*.nix' ! -name checks.nix); then
      echo "the Nix code above refers to the flake's revision"; exit 1
    fi
    touch $out
  '';

  # The overlay never puts one of ours over a different nixpkgs program of
  # the same name (lib/overlay.nix). `pkgs` is the same nixpkgs without the
  # overlay; "ours" means the top-level name is our package's very
  # derivation (both with the unfree packages the flake allows).
  overlay =
    let
      names = import ./overlay.nix;
      ours = builtins.attrNames (removeAttrs packages [ "default" ]);
      o = overlayAllowed;
      # Names first: nixpkgs' unfree packages under these names (the
      # Antigravity IDE) aren't allowed here, so their drvPath can't be read.
      # tryEval: nixpkgs may turn a name into a throwing alias.
      # "Ours": the overlay's own package under that name (pkgs.t3code-nix).
      isOurs =
        n:
        o ? ${n}
        && (builtins.tryEval o.${n}.name).success
        && o.${n}.name == o.t3code-nix.${n}.name
        && o.${n}.drvPath == o.t3code-nix.${n}.drvPath;
      # Built on the user's own Chromium through the overlay (see
      # pkgs/default.nix's browserChannel); everything else as the flake has it.
      ownBrowser = [ "agent-browser" ];
      standIns = o.appendOverlays [
        (_: _: {
          chromium = standIn "chromium";
          google-chrome = standIn "google-chrome-stable";
        })
      ];
      # The overlay without allowUnfree, with an unfree stand-in for Chrome.
      unfreeStandIn = overlayPkgs.appendOverlays [
        (_: _: {
          google-chrome = (standIn "google-chrome-stable").overrideAttrs (old: {
            meta = old.meta // {
              license = lib.licenses.unfree;
            };
          });
        })
      ];
      # A user's nixpkgs whose Electron of the bundled major is older than
      # the bundled one (evaluation only): the overlay's auto picks bundled.
      bundledElectron = (pinOf "t3code").electron or null;
      electronAttr = "electron_${lib.head (lib.splitString "." bundledElectron)}-bin";
      # A usable stand-in (any real derivation), whatever nixpkgs' own
      # electron_N-bin is (it may be insecure or removed by then).
      olderElectron = o.appendOverlays [
        (_: prev: {
          ${electronAttr} = prev.hello // {
            version = "${lib.head (lib.splitString "." bundledElectron)}.0.0";
            meta = { };
          };
        })
      ];
    in
    conditions "overlay" {
      "every package is under pkgs.t3code-nix, as the flake builds it" =
        builtins.attrNames o.t3code-nix == ours
        && builtins.all (n: o.t3code-nix.${n}.drvPath == noFallback.${n}.drvPath) (
          lib.subtractLists ownBrowser ours
        );
      "the overlay's agent-browser uses the user's own ungoogled-chromium; with browserChannel = \"stable\", the pin's" =
        o.t3code-nix.agent-browser.browser.outPath == o.ungoogled-chromium.outPath
        &&
          (o.t3code-nix.agent-browser.override { browserChannel = "stable"; }).drvPath
          == agent-browser-stable-chromium.drvPath;
      # Stand-ins for the user's chromium and google-chrome: the gating checks
      # never evaluate a real optional browser (their problems only report).
      "the overlay's browser names pick the user's own chromium and google-chrome" =
        (standIns.t3code-nix.agent-browser.override { browser = "chromium"; }).browser == standIns.chromium
        &&
          (standIns.t3code-nix.agent-browser.override { browser = "google-chrome"; }).browser
          == standIns.google-chrome;
      # overlayPkgs has no allowUnfree. Neither condition evaluates a real
      # Chrome (a broken one must never block ungoogled): the user's own is a
      # stand-in, and for a pin, the unfree settings its nixpkgs import gets.
      "without the user's allowUnfree, Chrome fails through the overlay" =
        fails
          (unfreeStandIn.t3code-nix.agent-browser.override { browser = "google-chrome"; }).browser.outPath
        && !fails
          (overlayPkgs.t3code-nix.agent-browser.override { browser = "ungoogled-chromium"; }).executable;
      "the browser pins' nixpkgs takes the caller's unfree settings: the user's through the overlay, the flake's for its own" =
        let
          chrome = {
            pname = "google-chrome";
            name = "google-chrome-1";
            meta.license = lib.licenses.unfree;
          };
          allows = u: u.allowUnfree || u.allowUnfreePredicate chrome;
        in
        !(allows overlayPkgs.t3code-nix.agent-browser.browserUnfree)
        && !(allows
          (overlayPkgs.t3code-nix.agent-browser.override { browserChannel = "stable"; }).browserUnfree
        )
        && allows o.t3code-nix.agent-browser.browserUnfree
        && allows packages.agent-browser.browserUnfree
        && allows agent-browser-stable-chromium.browserUnfree;
      # (A bundled N.0.0 has no older patch of its major to stand in.)
      "with an older nixpkgs Electron, the overlay's auto picks bundled" =
        bundledElectron == null
        || bundledElectron == "${lib.head (lib.splitString "." bundledElectron)}.0.0"
        ||
          olderElectron.t3code-nix.t3code-unwrapped.passthru.electron.reason
          == "auto: nixpkgs' ${lib.head (lib.splitString "." bundledElectron)}.0.0 is older than bundled ${bundledElectron}";
      "no top-level name replaces a different nixpkgs program" = builtins.all (
        n: !(pkgs ? ${n}) || !(isOurs n) || builtins.elem n names.sameAsNixpkgs
      ) ours;
      # Real packages in nixpkgs (its `antigravity` is only a deprecated
      # alias, covered by the condition above while it exists).
      "fx, muse and t3 stay nixpkgs' programs" =
        builtins.all (n: pkgs ? ${n} && !(isOurs n) && o.${n}.name == pkgs.${n}.name)
          [
            "fx"
            "muse"
            "t3"
          ];
      "the app and the same-program providers are ours" = builtins.all isOurs names.sameAsNixpkgs;
      "providers nixpkgs lacks are added" = builtins.all isOurs [
        "cursor-agent"
        "grok"
        "pi"
      ];
      "candidates are packages of ours" = lib.subtractLists ours names.candidates == [ ];
      "every package is either a candidate or listed as notTopLevel, not both" =
        lib.sort lib.lessThan (names.candidates ++ names.notTopLevel) == ours;
      "nothing but candidates at the top level" = builtins.all (
        n: builtins.elem n names.candidates || !(isOurs n)
      ) ours;
    } "";

  # The NixOS module, evaluated on a bare system.
  module-eval =
    let
      system =
        module: settings:
        (import (path + "/nixos/lib/eval-config.nix") {
          system = null;
          modules = [
            module
            {
              nixpkgs.pkgs = pkgs;
              programs.t3code = settings;
            }
          ];
        }).config;
      # The cache option is also checked with a made-up cache, so the check
      # doesn't depend on lib/cache.nix's values.
      example = {
        url = "https://example.cachix.org";
        publicKey = "example.cachix.org-1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      };
      withCache = import ../nixos/module.nix {
        inherit (self) packages;
        cache = example;
      };
      real = system self.nixosModules.default { enable = true; };
      on = system withCache { enable = true; };
      noCache = system withCache {
        enable = true;
        binaryCache = false;
        runtimeCompat = true;
        package = packages.t3-free;
      };
      off = system withCache { };
      noPolicy = system self.nixosModules.default {
        enable = true;
        claudeCodePolicy = false;
      };
      serverOnly = system self.nixosModules.default {
        server.enable = true;
        server.users = [ "u" ];
      };
      otherPackage = system self.nixosModules.default {
        package = pkgs.hello;
        server.enable = true;
        server.users = [ "u" ];
      };
      policy = c: c.environment.etc."claude-code/managed-settings.d/10-t3code-nix.json" or null;
      # The plain options.
      nightly = system self.nixosModules.default {
        enable = true;
        channel = "nightly";
        cli.enable = true;
      };
      picked = system self.nixosModules.default {
        enable = true;
        providers = [
          "codex"
          "claude"
        ];
        excludeProviders = [ "claude-code" ];
        cli.enable = true;
      };
      freePicked = system self.nixosModules.default {
        enable = true;
        package = packages.t3code-free;
        providers = [ "codex" ];
      };
      freeCli = system self.nixosModules.default {
        enable = true;
        package = packages.t3code-free;
        cli.enable = true;
      };
      customCli = system self.nixosModules.default {
        enable = true;
        package = packages.t3code.override { providers = [ "pi" ]; };
        cli.enable = true;
      };
      # A package of another kind: `override` without `passthru`.
      plain = {
        type = "derivation";
        name = "plain";
        outPath = "/plain";
        override = _: plain;
      };
      other = system self.nixosModules.default {
        enable = true;
        package = plain;
      };
      typo = system self.nixosModules.default {
        enable = true;
        providers = [ "codx" ];
      };
      unwrapped = system self.nixosModules.default {
        enable = true;
        package = packages.t3code-unwrapped;
        excludeProviders = [ "grok" ];
      };
      # acpRuntimes: set, kept from the package, cleared, on another package.
      acpSet = system self.nixosModules.default {
        enable = true;
        acpRuntimes = [ "nodejs" ];
        cli.enable = true;
      };
      acpKept = system self.nixosModules.default {
        enable = true;
        package = packages.t3code.override { acpRuntimes = [ "uv" ]; };
        cli.enable = true;
      };
      acpCleared = system self.nixosModules.default {
        enable = true;
        package = packages.t3code.override { acpRuntimes = [ "uv" ]; };
        acpRuntimes = [ ];
        cli.enable = true;
      };
      acpFree = system self.nixosModules.default {
        enable = true;
        package = packages.t3code-free;
        acpRuntimes = [ "uv" ];
      };
      acpServer = system self.nixosModules.default {
        server.enable = true;
        acpRuntimes = [ "nodejs" ];
      };
      # Agent tools, with and without the app.
      boatAlone = system withCache { agentTools.boat.enable = true; };
      boatWithApp = system self.nixosModules.default {
        enable = true;
        agentTools.boat.enable = true;
      };
      abAlone = system withCache { agentTools.agent-browser.enable = true; };
      abStable = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          browserChannel = "stable";
        };
      };
      abOwnBrowser = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          package = packages.agent-browser.override { browser = pkgs.chromium; };
          browserChannel = "stable";
        };
      };
      abKept = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          package = agent-browser-stable-chromium;
        };
      };
      abOverlay = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          package = overlayAllowed.agent-browser;
          browserChannel = "unstable";
        };
      };
      abChrome = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          browser = "google-chrome";
        };
      };
      abChromiumStable = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          browser = "chromium";
          browserChannel = "stable";
        };
      };
      abOwnBrowserNamed = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          package = packages.agent-browser.override { browser = standIn "own-browser"; };
          browser = "google-chrome";
        };
      };
      abKeptChannel = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          package = agent-browser-stable-chromium;
          browser = "chromium";
        };
      };
      abOverlayNamed = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          package = overlayAllowed.agent-browser;
          browser = "chromium";
        };
      };
      abNixpkgs = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          package = pkgs.agent-browser;
          browser = "chromium";
        };
      };
      abNixpkgsUnset = system self.nixosModules.default {
        agentTools.agent-browser = {
          enable = true;
          package = pkgs.agent-browser;
        };
      };
      browserOf = c: map (p: p.browser.outPath) (installed c "agent-browser");
      # What the installed package was asked for (its passthru), so these
      # conditions never evaluate a real optional browser.
      choiceOf =
        c:
        map (p: [
          p.browserChoice
          p.browserChannel
        ]) (installed c "agent-browser");
      pinned =
        channel:
        let
          p = lib.importJSON (../versions + "/browser-${channel}.json");
        in
        p.outPaths.${stdenv.hostPlatform.system};
      boatOffCache = system withCache {
        agentTools.boat.enable = true;
        binaryCache = false;
      };
      acpOther = system self.nixosModules.default {
        enable = true;
        package = plain;
        acpRuntimes = [ "nodejs" ];
      };
      # electron: unset (the package's own, auto), set, on an explicit
      # package of this flake, and on a package that can't take it.
      electronUnset = system self.nixosModules.default { enable = true; };
      electronSet = system self.nixosModules.default {
        enable = true;
        electron = "bundled";
      };
      electronFree = system self.nixosModules.default {
        enable = true;
        package = packages.t3code-free;
        electron = "bundled";
      };
      electronCli = system self.nixosModules.default {
        enable = true;
        package = packages.t3;
        electron = "bundled";
      };
      # A wrapper from before acpRuntimes: providers, but no acpRuntimes.
      older = plain // {
        providers = [ ];
        passthru.providers = [ ];
        override = args: if args ? acpRuntimes then throw "unexpected argument acpRuntimes" else older;
      };
      acpOlder = system self.nixosModules.default {
        enable = true;
        package = older;
        acpRuntimes = [ "nodejs" ];
      };
      # The server (programs.t3code.server).
      server =
        settings:
        system self.nixosModules.default {
          server = {
            enable = true;
          }
          // settings;
        };
      srvDefault = server { };
      srvSet = server {
        users = [ "alice" ];
        home = "%h/.t3-server";
        port = 4000;
        lan = true;
        openFirewall = true;
        logLevel = "Debug";
        environmentFile = "/run/secrets/t3";
      };
      srvPicked = system self.nixosModules.default {
        channel = "nightly";
        providers = [ "codex" ];
        server.enable = true;
      };
      srvAllowed = system self.nixosModules.default {
        server.enable = true;
        cli.allowUpstreamService = true;
      };
      cliAlone = system self.nixosModules.default { cli.enable = true; };
      compatAlone = system self.nixosModules.default { runtimeCompat = true; };
      unitOf = c: c.systemd.user.services.t3code-server;
      exec = c: (unitOf c).serviceConfig.ExecStart;
      envOf = c: removeAttrs (unitOf c).environment [ "PATH" ];
      # Ours among the installed packages, by name.
      installed = c: name: builtins.filter (p: lib.getName p == name) c.environment.systemPackages;
      providersOf = c: name: map (p: map lib.getName p.providers) (installed c name);
      acpOf = c: name: map (p: p.passthru.acpRuntimes) (installed c name);
      # Only the module's own: a bare system fails others (no boot loader).
      failedAssertion =
        c: builtins.any (a: !a.assertion && lib.hasPrefix "programs.t3code:" a.message) c.assertions;
      names = map lib.getName;
      cached = c: builtins.elem example.url c.nix.settings.substituters;
      keyed = c: builtins.elem example.publicKey c.nix.settings.trusted-public-keys;
    in
    conditions "module-eval" {
      "enable installs this flake's t3code" =
        builtins.elem packages.t3code real.environment.systemPackages;
      "cli.enable alone warns that it does nothing; with enable, it doesn't" =
        builtins.any (lib.hasPrefix "programs.t3code.cli.enable installs") cliAlone.warnings
        && !builtins.any (lib.hasPrefix "programs.t3code.cli.enable") real.warnings;
      "the real cache is added exactly when it has a key" =
        builtins.elem cache.url real.nix.settings.substituters == (cache.publicKey != null)
        && (cache.publicKey == null || builtins.elem cache.publicKey real.nix.settings.trusted-public-keys);
      "nix-ld stays off by default" = !real.programs.nix-ld.enable;
      "claude's machine policy turns its updates off when claude is bundled, as a copied file" =
        (policy real).mode == "0444"
        &&
          (builtins.fromJSON (policy real).text).env == {
            DISABLE_UPDATES = "1";
            DISABLE_AUTOUPDATER = "1";
            DISABLE_INSTALLATION_CHECKS = "1";
          };
      "no claude policy without claude, or with claudeCodePolicy = false" =
        policy noCache == null && policy picked == null && policy noPolicy == null;
      "claude's policy is written for a server-only host, and when the server's t3 bundles claude though the app's package has no list" =
        policy serverOnly != null && policy otherPackage != null;
      "binaryCache adds the substituter and its key" = cached on && keyed on;
      "cache.nixos.org stays" = builtins.elem "https://cache.nixos.org/" on.nix.settings.substituters;
      "binaryCache = false adds neither" = !cached noCache && !keyed noCache;
      "package is installed instead of the default" =
        builtins.elem packages.t3-free noCache.environment.systemPackages
        && !builtins.elem packages.t3code noCache.environment.systemPackages;
      "runtimeCompat turns on nix-ld" = noCache.programs.nix-ld.enable;
      "runtimeCompat has every library t3 links against" =
        lib.subtractLists (names noCache.programs.nix-ld.libraries) (
          names packages.t3-unwrapped.buildInputs
        ) == [ ];
      "runtimeCompat works on its own (an SSH-only host), installing nothing else" =
        compatAlone.programs.nix-ld.enable
        && names compatAlone.programs.nix-ld.libraries == names noCache.programs.nix-ld.libraries
        && installed compatAlone "t3code" == [ ]
        && installed compatAlone "t3" == [ ]
        && installed compatAlone "t3code-nix-doctor" == [ ]
        # The names do match what enable installs.
        && installed real "t3code" != [ ]
        && installed real "t3code-nix-doctor" != [ ];
      "nothing happens without enable" =
        !cached off
        && !keyed off
        && !off.programs.nix-ld.enable
        && !builtins.elem packages.t3code off.environment.systemPackages;
      "channel = nightly installs t3code-nightly, and cli.enable t3-nightly" =
        builtins.elem (packages.t3code-nightly or null) nightly.environment.systemPackages
        && builtins.elem (packages.t3-nightly or null) nightly.environment.systemPackages
        && installed nightly "t3code" == [ ];
      "channel = \"latest\" is the default, and \"stable\" isn't a channel" =
        real.programs.t3code.channel == "latest"
        &&
          builtins.elem packages.t3code
            (system self.nixosModules.default {
              enable = true;
              channel = "latest";
            }).environment.systemPackages
        &&
          fails
            (system self.nixosModules.default {
              enable = true;
              channel = "stable";
            }).programs.t3code.channel;
      "the packages' channel is \"latest\" or \"nightly\", nothing else" =
        let
          bad =
            p:
            fails (p.override { channel = "stable"; }).drvPath
            && fails (p.override { channel = "beta"; }).drvPath;
          same = p: (p.override { channel = "latest"; }).drvPath == p.drvPath;
        in
        bad packages.t3code-unwrapped
        && bad packages.t3-unwrapped
        && bad packages.doctor
        && same packages.t3code-unwrapped
        && same packages.t3-unwrapped
        && same packages.doctor
        && packages.t3code-unwrapped.pname == "t3code-unwrapped"
        && packages.t3code-unwrapped.version == (pinOf "t3code").version
        && packages.t3-unwrapped.pname == "t3-unwrapped"
        && packages.t3-unwrapped.version == (pinOf "t3").version;
      "no CLI unless cli.enable" = installed real "t3" == [ ];
      "cli.enable installs the CLI package, with its completions" =
        map (p: p.drvPath) (installed nightly "t3-nightly") == [ (packages.t3-nightly or null).drvPath ];
      "providers and excludeProviders pick the app's and the CLI's providers" =
        providersOf picked "t3code" == [ [ "codex" ] ] && providersOf picked "t3" == [ [ "codex" ] ];
      "they override whatever package is" =
        providersOf freePicked "t3code-free" == [ [ "codex" ] ] && !failedAssertion freePicked;
      "a misspelt provider fails the build" = fails (providersOf typo "t3code");
      "electron: unset, the package's own choice (auto)" =
        map (p: p.passthru.electron.reason) (installed electronUnset "t3code")
        == [ packages.t3code.passthru.electron.reason ];
      "electron: set, it reaches the app" =
        map (p: p.passthru.electron.reason) (installed electronSet "t3code") == [ "set to bundled" ]
        && !failedAssertion electronSet;
      "electron: on an explicit package of this flake" =
        map (p: p.passthru.electron.reason) (installed electronFree "t3code-free") == [ "set to bundled" ];
      "electron: a package that can't take it fails an assertion" = failedAssertion electronCli;
      "acpRuntimes reaches the app and the CLI" =
        acpOf acpSet "t3code" == [ [ "nodejs" ] ] && acpOf acpSet "t3" == [ [ "nodejs" ] ];
      "unset, the package's own list stays, and the CLI follows the app" =
        acpOf acpKept "t3code" == [ [ "uv" ] ] && acpOf acpKept "t3" == [ [ "uv" ] ];
      "[ ] clears it" = acpOf acpCleared "t3code" == [ [ ] ] && acpOf acpCleared "t3" == [ [ ] ];
      "it applies to t3code-free too" =
        acpOf acpFree "t3code-free" == [ [ "uv" ] ] && !failedAssertion acpFree;
      "the server's t3 gets it" =
        lib.hasPrefix "${(packages.t3.override { acpRuntimes = [ "nodejs" ]; })}/bin/" (exec acpServer);
      "a package that can't take it fails an assertion" = failedAssertion acpOther;
      "so does a wrapper from before it, rather than an evaluation error" =
        failedAssertion acpOlder
        && (builtins.tryEval (builtins.deepSeq (map (p: p.name) acpOlder.environment.systemPackages) true))
          .success;
      "the default package has none" = acpOf real "t3code" == [ [ ] ];
      "agentTools.boat.enable installs the flake's boat, alone or with the app" =
        builtins.elem packages.boat boatAlone.environment.systemPackages
        && builtins.elem packages.boat boatWithApp.environment.systemPackages
        && installed boatAlone "t3code" == [ ];
      "no boat unless asked" =
        !builtins.elem packages.boat real.environment.systemPackages
        && !builtins.elem packages.boat off.environment.systemPackages;
      "agentTools.agent-browser.enable installs it with the unstable pin's Chromium, and the cache" =
        browserOf abAlone == [ (pinned "unstable") ] && cached abAlone && installed abAlone "t3code" == [ ];
      "browserChannel picks the stable pin's Chromium" = browserOf abStable == [ (pinned "stable") ];
      "unset, the package's own choice stays" = browserOf abKept == [ (pinned "stable") ];
      "an overridden browser wins over browserChannel" =
        browserOf abOwnBrowser == [ pkgs.chromium.outPath ];
      "the module's browserChannel works on the overlay's agent-browser" =
        browserOf abOverlay == [ (pinned "unstable") ];
      "browser picks a named browser from the package's pin, or from the chosen one" =
        choiceOf abChrome == [
          [
            "google-chrome"
            "unstable"
          ]
        ]
        &&
          choiceOf abChromiumStable == [
            [
              "chromium"
              "stable"
            ]
          ];
      "a package whose browser is a package keeps it, whatever browser says" =
        browserOf abOwnBrowserNamed == [ (standIn "own-browser").outPath ];
      "browser alone keeps the package's channel" =
        choiceOf abKeptChannel == [
          [
            "chromium"
            "stable"
          ]
        ];
      "the module's browser works on the overlay's agent-browser (its user's own)" =
        choiceOf abOverlayNamed == [
          [
            "chromium"
            null
          ]
        ];
      "another agent-browser with browser set fails an assertion; unset, it's installed as it is" =
        failedAssertion abNixpkgs
        && !failedAssertion abNixpkgsUnset
        && builtins.elem pkgs.agent-browser abNixpkgsUnset.environment.systemPackages;
      "no agent-browser unless asked" = installed real "agent-browser" == [ ];
      "boat alone adds the binary cache, unless binaryCache is off" =
        cached boatAlone && !cached boatOffCache && !cached off;
      "server.host is written as it is: systemd doesn't expand its `%`" =
        (envOf (server {
          host = "fe80::1%wlan0";
        })).T3CODE_HOST == "fe80::1%%wlan0";
      "server.environmentFile is absolute or under %h/, `%` only as `%h`" =
        builtins.all
          (
            f:
            fails
              (unitOf (server {
                environmentFile = f;
              })).serviceConfig.EnvironmentFile
          )
          [
            "secrets/t3.env"
            "%u/t3.env"
            "/run/t3-%u.env"
            "/run/secrets/t3.env\nUnsetEnvironment=T3CODE_HOME"
          ]
        &&
          builtins.all
            (
              f:
              (unitOf (server {
                environmentFile = f;
              })).serviceConfig.EnvironmentFile == f
            )
            [
              "/run/secrets/t3"
              "%h/.config/t3.env"
              "-%h/t3.env"
            ];
      "server.home takes `%` only as `%h`" =
        builtins.all
          (
            h:
            fails
              (envOf (server {
                home = h;
              })).T3CODE_HOME
          )
          [
            "%h/t3-%u"
            "/srv/t3/%U"
            "%%h"
            "%h/t3\nx"
          ]
        &&
          (envOf (server {
            home = "%h/.t3-server";
          })).T3CODE_HOME == "%h/.t3-server"
        &&
          (envOf (server {
            home = "/srv/t3";
          })).T3CODE_HOME == "/srv/t3";
      "server.users takes user names, not a UID, @system or nothing" =
        builtins.all
          (
            u:
            fails
              (unitOf (server {
                users = [ u ];
              })).unitConfig.ConditionUser
          )
          [
            "1000"
            "@system"
            ""
            "a b"
            "!alice"
            "a%ub"
          ]
        &&
          (unitOf (server {
            users = [
              "alice.b"
              "3dprinter"
            ];
          })).unitConfig.ConditionUser == [
            "|alice.b"
            "|3dprinter"
          ];
      "the CLI bundles what the app bundles" =
        providersOf freeCli "t3" == providersOf freeCli "t3code-free"
        && builtins.all (p: p.previewBrowser == null) (installed freeCli "t3")
        && providersOf customCli "t3" == [ [ "pi" ] ];
      "a package of another kind is installed as it is" =
        builtins.elem plain other.environment.systemPackages && !failedAssertion other;
      "with a package that has no providers they fail an assertion" =
        failedAssertion unwrapped && !failedAssertion real && !failedAssertion picked;
      "enable installs a doctor that knows this configuration" =
        let
          docOf = c: builtins.head (installed c "t3code-nix-doctor");
        in
        installed real "t3code-nix-doctor" != [ ]
        && installed srvDefault "t3code-nix-doctor" != [ ]
        && installed off "t3code-nix-doctor" == [ ]
        && (docOf nightly).drvPath != (docOf real).drvPath;
      "no server unless server.enable" =
        !(real.systemd.user.services ? t3code-server) && !(off.systemd.user.services ? t3code-server);
      "the server runs this flake's t3 serve, installs that t3 and not the app" =
        exec srvDefault == "${lib.getExe packages.t3} serve"
        && map (p: p.drvPath) (installed srvDefault "t3") == [ packages.t3.drvPath ]
        && installed srvDefault "t3code" == [ ]
        && !failedAssertion srvDefault;
      "it isn't t3code.service, which upstream's own unit in ~/.config would shadow" =
        !(srvDefault.systemd.user.services ? t3code);
      "it takes the channel and providers" =
        let
          t3 = builtins.head (installed srvPicked "t3-nightly");
        in
        map lib.getName t3.providers == [ "codex" ] && exec srvPicked == "${lib.getExe t3} serve";
      "defaults: port 3773, this machine only, ~/.t3, every normal user" =
        envOf srvDefault == {
          T3CODE_PORT = "3773";
          T3CODE_LAN = "false";
          T3CODE_TAILSCALE_SERVE = "false";
          T3CODE_TAILSCALE_SERVE_PORT = "443";
        }
        && (unitOf srvDefault).unitConfig.ConditionUser == [ "!@system" ]
        && srvDefault.networking.firewall.allowedTCPPorts == [ ];
      "the options reach the unit" =
        envOf srvSet == {
          T3CODE_PORT = "4000";
          T3CODE_LAN = "true";
          T3CODE_TAILSCALE_SERVE = "false";
          T3CODE_TAILSCALE_SERVE_PORT = "443";
          T3CODE_HOME = "%h/.t3-server";
          T3CODE_LOG_LEVEL = "Debug";
        }
        && (unitOf srvSet).serviceConfig.EnvironmentFile == "/run/secrets/t3"
        && (unitOf srvSet).unitConfig.ConditionUser == [ "|alice" ]
        && builtins.elem 4000 srvSet.networking.firewall.allowedTCPPorts;
      "a server that finds its home owned isn't restarted, nor by a rebuild" =
        (unitOf srvDefault).serviceConfig.RestartPreventExitStatus == 78
        && !(unitOf srvDefault).restartIfChanged;
      "host with lan, or Tailscale Serve without Tailscale, fail an assertion" =
        failedAssertion (server {
          host = "0.0.0.0";
          lan = true;
        })
        && failedAssertion (server {
          tailscaleServe.enable = true;
        })
        && !failedAssertion (server {
          host = "0.0.0.0";
        });
      "a server without the app has the cache, the runtimes and the provider check" =
        let
          headless = system withCache {
            server.enable = true;
            runtimeCompat = true;
          };
        in
        cached headless
        && headless.programs.nix-ld.enable
        && failedAssertion (
          system self.nixosModules.default {
            server.enable = true;
            package = plain;
            providers = [ "codex" ];
          }
        );
      "cli.allowUpstreamService gives a t3 without the guard" =
        (builtins.head (installed srvAllowed "t3")).drvPath
        == (packages.t3.override { allowUpstreamService = true; }).drvPath
        && packages.t3.drvPath != (packages.t3.override { allowUpstreamService = true; }).drvPath;
    } "";

  # The module's server unit, as far as the sandbox can run it: the
  # database copy before a new version starts, and `t3 serve` answering from
  # the unit's environment alone. lib/vm-test.nix runs the unit itself.
  server-unit =
    let
      port = 37731;
      unit =
        (import (path + "/nixos/lib/eval-config.nix") {
          system = null;
          modules = [
            self.nixosModules.default
            {
              nixpkgs.pkgs = pkgs;
              programs.t3code.server = {
                enable = true;
                inherit port;
              };
            }
          ];
        }).config.systemd.user.services.t3code-server;
      env = removeAttrs unit.environment [ "PATH" ];
      version = lib.getVersion packages.t3;
    in
    runCommand "server-unit"
      {
        nativeBuildInputs = [
          pkgs.sqlite
          pkgs.curl
        ];
      }
      ''
        export HOME=$(mktemp -d)
        backup=${unit.serviceConfig.ExecStartPre}
        db=$HOME/.t3/userdata/statev2.sqlite
        dir=$HOME/.t3/t3code-nix-backups
        # The build shell has nullglob: a glob that matches nothing is no
        # arguments.
        count() { set -- $dir/statev2-*.sqlite; echo $#; }
        one() { [ $# = 1 ] && [ -f "$1" ] || { echo "expected one file, got: $*"; exit 1; }; }

        # No database yet: nothing to copy; the version is recorded.
        $backup
        [ "$(cat $dir/last-version)" = ${version} ] && [ "$(count)" = 0 ]

        # The same version again: no copy.
        mkdir -p $(dirname $db)
        sqlite3 $db "pragma journal_mode=wal; create table t(x); insert into t values (42);"
        $backup
        [ "$(count)" = 0 ] || { echo "copied without a version change"; exit 1; }

        # A new version: a consistent copy named after the one before.
        echo 0.0.1 > $dir/last-version
        $backup
        one $dir/statev2-0.0.1-*.sqlite
        [ "$(sqlite3 $dir/statev2-0.0.1-*.sqlite 'select x from t')" = 42 ]
        [ "$(cat $dir/last-version)" = ${version} ]
        [ "$(stat -c %a $dir)" = 700 ]

        # Only the newest three are kept.
        for v in 0.0.2 0.0.3 0.0.4; do echo $v > $dir/last-version; $backup; done
        [ "$(count)" = 3 ] || { echo "kept $(count) copies"; ls $dir; exit 1; }
        set -- $dir/statev2-0.0.1-*; [ $# = 0 ] || { echo "the oldest copy is kept"; exit 1; }
        one $dir/statev2-0.0.4-*.sqlite

        # Committed data still in the WAL, with another connection open (the
        # desktop app, say), is in the copy.
        { echo "pragma wal_autocheckpoint=0; insert into t values (43);"; sleep 10; } | sqlite3 $db &
        holder=$!
        for i in $(seq 50); do [ "$(sqlite3 $db 'select count(*) from t')" = 2 ] && break; sleep 0.2; done
        [ -s $db-wal ]
        echo 0.0.9 > $dir/last-version
        $backup
        one $dir/statev2-0.0.9-*.sqlite
        [ "$(sqlite3 $dir/statev2-0.0.9-*.sqlite 'select group_concat(x) from t')" = 42,43 ]
        kill $holder 2>/dev/null || true; wait $holder 2>/dev/null || true

        # A relative T3CODE_HOME is under the working directory, %h, and
        # `~/` is the home folder.
        mkdir -p $HOME/rel/userdata && cp $db $HOME/rel/userdata/statev2.sqlite
        (cd $HOME && T3CODE_HOME=rel $backup)
        one $HOME/rel/t3code-nix-backups/statev2-unknown-*.sqlite
        mkdir -p $HOME/tilde/userdata && cp $db $HOME/tilde/userdata/statev2.sqlite
        (cd / && T3CODE_HOME='~/tilde' $backup)
        one $HOME/tilde/t3code-nix-backups/statev2-unknown-*.sqlite
        rm -r $HOME/tilde/t3code-nix-backups
        (cd / && T3CODE_HOME='~\tilde' $backup)
        one $HOME/tilde/t3code-nix-backups/statev2-unknown-*.sqlite

        # Trimmed, as t3 does; blank is ~/.t3.
        rm -r $HOME/tilde/t3code-nix-backups
        (cd / && T3CODE_HOME=' ~/tilde
        ' $backup)
        one $HOME/tilde/t3code-nix-backups/statev2-unknown-*.sqlite
        echo 0.0.7 > $dir/last-version
        (cd / && T3CODE_HOME='   ' $backup)
        one $dir/statev2-0.0.7-*.sqlite

        # A copy cut short is removed before the next.
        touch $dir/statev2-0.0.8-x.sqlite.part
        echo 0.0.8 > $dir/last-version
        $backup
        set -- $dir/*.part; [ $# = 0 ] || { echo "a .part copy is left"; exit 1; }

        # A failed copy leaves the version unrecorded, so the next start
        # tries again, and the unit doesn't start.
        echo 0.0.5 > $dir/last-version
        chmod 500 $dir
        if $backup 2>/dev/null; then echo "a failed copy succeeded"; exit 1; fi
        chmod 700 $dir
        [ "$(cat $dir/last-version)" = 0.0.5 ]

        # The server, configured by the unit's environment only.
        ${lib.concatStrings (lib.mapAttrsToList (n: v: "export ${n}=${lib.escapeShellArg v}
") env)}
        ${unit.serviceConfig.ExecStart} > $HOME/server.log 2>&1 &
        pid=$!
        for i in $(seq 120); do
          curl -sf -o /dev/null http://127.0.0.1:${toString port}/ && break
          kill -0 $pid 2>/dev/null || { echo "t3 serve exited"; cat $HOME/server.log; exit 1; }
          sleep 1
        done
        curl -sf -o /dev/null http://127.0.0.1:${toString port}/ || { echo "no answer on ${toString port}"; cat $HOME/server.log; exit 1; }
        kill $pid; wait $pid || true
        touch $out
      '';

  # `t3code-nix doctor` (pkgs/doctor) against fake systems: a good one and
  # many broken ones. Fake nix and systemctl answer from the scenario and
  # log their calls; the home folder is read-only and must stay unchanged.
  # (Not named `doctor`, which would hide the package from the checks.)
  doctor-scenarios =
    let
      fake =
        name: bins:
        runCommand name { } (
          "mkdir -p $out/bin\n"
          + lib.concatMapStrings (b: "printf '#!/bin/sh\\n' > $out/bin/${b}; chmod +x $out/bin/${b}\n") bins
        );
      # Like a wrapped t3: a script that runs a t3-unwrapped build.
      fakeCli =
        name:
        runCommand name { } ''
          mkdir -p $out/bin
          printf '#!/bin/sh\nexec /nix/store/00000000000000000000000000000000-t3-unwrapped-0.1.9/bin/t3 "$@"\n' > $out/bin/t3
          chmod +x $out/bin/t3
        '';
      cli = fakeCli "t3-0.1.9";
      otherCli = fakeCli "t3-0.1.10";
      foreignCli = fake "t3code-0.1.8" [ "t3" ];
      codex = fake "codex-1.0" [ "codex" ];
      # Executables that only wait: codex stands in for codex's daemon update
      # loop, which the doctor knows by its exe and arguments; helper doesn't.
      waitingCodex = pkgs.runCommandCC "waiting-codex" { } ''
        mkdir -p $out/bin
        printf '#include <unistd.h>\nint main(void) { for (;;) pause(); }\n' > main.c
        $CC -o $out/bin/codex main.c
        cp $out/bin/codex $out/bin/helper
      '';
      # Its `doctor` prints what the scenario puts in its root's claude-doctor
      # file, and exits with claude-doctor-rc (the doctor asks claude about
      # its machine policy).
      claude = runCommand "claude-code-2.0" { } ''
        mkdir -p $out/bin
        cat > $out/bin/claude <<'EOF'
        #!/bin/sh
        [ "''${1-}" = doctor ] || exit 0
        # Shell builtins only: the doctor may run it with a minimal PATH.
        while IFS= read -r l; do echo "$l"; done < "$T3CODE_DOCTOR_ROOT/claude-doctor"
        rc=0; [ ! -e "$T3CODE_DOCTOR_ROOT/claude-doctor-rc" ] || read -r rc < "$T3CODE_DOCTOR_ROOT/claude-doctor-rc"
        exit "$rc"
        EOF
        chmod +x $out/bin/claude
      '';
      # As the wrapper's shim: agy_acp_server.par is a link to agy.
      agy = runCommand "antigravity-3.0" { } ''
        mkdir -p $out/bin
        printf '#!/bin/sh\n' > $out/bin/agy
        chmod +x $out/bin/agy
        ln -s agy $out/bin/agy_acp_server.par
      '';
      cursor = fake "cursor-agent-4.0" [ "agent" ];
      # Bundled, but not in the store (as with `nix run …#doctor`).
      pi = {
        name = "pi-9.0";
        outPath = "/nix/store/00000000000000000000000000000000-pi-9.0";
      };
      cacheUrl = "https://example.cachix.org";
      cacheKey = "example.cachix.org-1:AAAA";
      doctorWith =
        bundled: server:
        packages.doctor.override {
          t3code = {
            name = "t3code-0.1.9";
            passthru.providers = bundled;
          };
          t3 = cli;
          availableProviders = {
            inherit codex pi cursor;
            claudeAgent = claude;
            antigravity = agy;
          };
          cache = {
            url = cacheUrl;
            publicKey = cacheKey;
          };
          inherit server;
        };
      doctor = doctorWith [
        codex
        claude
        agy
        cursor
      ] "on";
      # Claude and antigravity not bundled; pi bundled but missing; codex
      # bundled from another build than the default one.
      otherCodex = fake "codex-1.1" [ "codex" ];
      fewer = doctorWith [
        otherCodex
        pi
      ] "on";
      serverOff = doctorWith [ codex ] "off";
      # claude bundled but not on this machine (another build's doctor).
      goneClaude = doctorWith [
        codex
        {
          name = "claude-code-2.0";
          outPath = "/nix/store/00000000000000000000000000000000-claude-code-2.0";
        }
      ] "on";
      withServerHome =
        home:
        (doctorWith [
          codex
          agy
        ] "on").override
          { serverHome = home; };
      serverHome = withServerHome "%h/.t3-server";
      serverHomeSlash = withServerHome "%h/";
      # Relative: under the home folder, where the server runs.
      serverHomeRelative = withServerHome ".t3-server";
      serverUnknown = doctorWith [ codex ] "unknown";
      withServerUsers = users: (doctorWith [ codex ] "on").override { serverUsers = users; };
      serverForBob = withServerUsers [
        "bob"
        "carol"
      ];
      serverForAlice = withServerUsers [
        "alice"
        "bob"
      ];
      serverForRoot = withServerUsers [ "root" ];
      sameVersionClaude = fake "claude-code-2.0" [
        "claude"
        "x"
      ];
      olderCodex = fake "codex-0.9" [ "codex" ];
      # The NixOS-stable set's doctor: the cache doesn't hold it.
      onStable = (doctorWith [ codex ] "on").override { nixpkgs = "stable"; };
      # The desktop app's Electron line, for each kind of choice.
      withElectron =
        electron:
        (doctorWith [ codex ] "on").override {
          t3code = {
            name = "t3code-0.1.9";
            passthru = {
              providers = [ codex ];
              inherit electron;
            };
          };
        };
      electronNixpkgs = withElectron {
        choice = "nixpkgs";
        name = "electron_44-bin";
        version = "44.10.2";
        bundled = "44.10.1";
        reason = "auto: nixpkgs 44.10.2 >= bundled 44.10.1";
      };
      electronFallback = withElectron {
        choice = "bundled";
        name = null;
        version = "44.10.1";
        bundled = "44.10.1";
        reason = "auto: this release's nixpkgs Electron failed t3code-nix's tests on one or both systems (fallback)";
      };
      electronPackage = withElectron {
        choice = "package";
        name = "electron";
        version = "44.9.3";
        bundled = "44.10.1";
        reason = "set to a package (44.9.3, older than bundled 44.10.1)";
      };
      drivers = builtins.attrNames (import ../pkgs/t3code/providers.nix packages);
    in
    assert lib.assertMsg (
      builtins.attrNames packages.doctor.commands == drivers
    ) "pkgs/doctor: every driver in providers.nix needs its command";
    runCommand "doctor-scenarios"
      {
        # Installed, as the app's providers are.
        providers = [
          codex
          claude
          agy
          cursor
          otherCodex
        ];
      }
      ''
        set -u
        work=$(mktemp -d)
        mkdir -p $work/bin
        # Untrusted users' own settings (NIX_USER_CONF_FILES) must not count:
        # this nix answers from the system's files when they're switched off.
        cat > $work/bin/nix <<SH
        #!${stdenv.shell}
        echo "nix \$*" >> $work/calls
        [ ! -e $work/scenario/nix-fails ] || exit 1
        conf=$work/scenario/user
        [ "\''${NIX_USER_CONF_FILES:-}" != /dev/null ] || conf=$work/scenario/system
        case "\$*" in
          *"config show substituters") cat \$conf-substituters ;;
          *"config show trusted-public-keys") cat \$conf-keys ;;
          *"config show trusted-substituters") cat $work/scenario/system-trusted-substituters ;;
          *"store info --json") [ ! -e $work/scenario/info-fails ] || exit 1; cat $work/scenario/storeinfo ;;
          *) exit 1 ;;
        esac
        SH
        cat > $work/bin/systemctl <<SH
        #!${stdenv.shell}
        echo "systemctl \$*" >> $work/calls
        cat $work/scenario/unit
        SH
        chmod +x $work/bin/*

        run() { # doctor, name, expected exit status
          local doc=$1 name=$2 want=$3
          chmod -R u+w $work/home 2>/dev/null || true
          rm -rf "''${work:?}"/home && mkdir -p $work/home && cp -r $work/scenario/home/. $work/home/
          chmod -R a-w $work/home
          before=$(cd $work/home && find . -exec stat -c '%n %s %Y' {} + | sort)
          # The doctor's own tools come from its package: with minimal-path,
          # only the scenario's fakes are on PATH.
          p=$work/scenario/path:$work/bin
          [ -e $work/scenario/minimal-path ] || p=$p:$PATH
          set +e
          if [ -e $work/scenario/no-home ]; then
            env -u HOME -u XDG_CONFIG_HOME T3CODE_DOCTOR_ROOT=$work/scenario/root PATH="$p" \
              $doc/bin/t3code-nix doctor > $work/out 2>&1
          else
            T3CODE_DOCTOR_USER=$(cat $work/scenario/user 2>/dev/null || echo alice) T3CODE_DOCTOR_UID=$(cat $work/scenario/uid 2>/dev/null || echo 1000) \
              T3CODE_HOME=$(cat $work/scenario/t3home 2>/dev/null) HOME=$work/home T3CODE_DOCTOR_ROOT=$work/scenario/root \
              PATH="$p" $doc/bin/t3code-nix doctor > $work/out 2>&1
          fi
          got=$?
          set -e
          echo "== $name (exit $got)"; cat $work/out
          [ "$got" = "$want" ] || { echo "$name: exit $got, expected $want"; exit 1; }
          after=$(cd $work/home && find . -exec stat -c '%n %s %Y' {} + | sort)
          [ "$before" = "$after" ] || { echo "$name: the home folder changed"; exit 1; }
        }
        has() { grep -qF -- "$1" $work/out || { echo "missing: $1"; exit 1; }; }
        hasnt() { if grep -qF -- "$1" $work/out; then echo "unexpected: $1"; exit 1; fi; }
        cmd() { printf '#!/bin/sh\n' > $work/scenario/path/$1; chmod +x $work/scenario/path/$1; }
        nixld() { for ld in lib64/ld-linux-x86-64.so.2 lib/ld-linux-aarch64.so.1; do ln -sfn "$1" $work/scenario/root/$ld; done; }
        noloader() { rm -f "''${work:?}"/scenario/root/lib64/* "''${work:?}"/scenario/root/lib/*; }

        scenario() { # reset the fake system to a good NixOS one
          chmod -R u+w $work/scenario 2>/dev/null || true
          rm -rf "''${work:?}"/scenario "''${work:?}"/calls
          mkdir -p $work/scenario/path $work/scenario/home $work/scenario/root/lib64 $work/scenario/root/lib $work/scenario/root/etc
          touch $work/scenario/root/etc/NIXOS
          # claude reports the module's machine policy (claudeCodePolicy).
          echo 'Auto-updates: disabled (set by env: DISABLE_UPDATES)' > $work/scenario/root/claude-doctor
          for f in system user; do
            echo "${cacheUrl} https://cache.nixos.org/" > $work/scenario/$f-substituters
            echo "cache.nixos.org-1:x ${cacheKey}" > $work/scenario/$f-keys
          done
          : > $work/scenario/system-trusted-substituters
          echo '{"trusted":false,"url":"daemon"}' > $work/scenario/storeinfo
          printf 'loaded\nactive\n' > $work/scenario/unit
          ln -s ${cli}/bin/t3 $work/scenario/path/t3
          nixld /nix/store/x-nix-ld-2.0/libexec/nix-ld
        }
        upstream() { mkdir -p $work/scenario/home/.config/systemd/user; touch $work/scenario/home/.config/systemd/user/t3code.service; }
        # Antigravity's own download in the T3 home $1, for both systems.
        agydl() { for a in x64 arm64; do mkdir -p "$1/tools/antigravity-acp/linux-$a"; touch "$1/tools/antigravity-acp/linux-$a/active.json"; done; }
        # The doctor run from $work/cwd with PATH=$1: warnings only (exit 0).
        frompath() {
          local got=0
          (cd $work/cwd && HOME=$work/home T3CODE_DOCTOR_ROOT=$work/scenario/root PATH="$1" \
            ${doctor}/bin/t3code-nix doctor > $work/out 2>&1) || got=$?
          [ "$got" = 0 ] || { cat $work/out; echo "PATH=$1: exit $got, expected 0"; exit 1; }
        }
        # The doctor $1 with HOME=$work/h&me: warnings only (exit 0).
        inhome() {
          local got=0
          HOME="$work/h&me" T3CODE_DOCTOR_ROOT=$work/scenario/root PATH="$work/scenario/path:$work/bin:$PATH" \
            $1/bin/t3code-nix doctor > $work/out 2>&1 || got=$?
          [ "$got" = 0 ] || { cat $work/out; echo "h&me: exit $got, expected 0"; exit 1; }
        }

        # Everything right.
        scenario
        run ${doctor} good 0
        has "OK       codex 1.0 (bundled)"
        has "OK       claude-code 2.0 (bundled)"
        has "OK       antigravity 3.0 (bundled)"
        has "OK       cursor-agent: built into T3 Code (its SDK)"
        has "OK       pi: not bundled in this build, and no pi on PATH (T3 Code lists it as not installed)"
        has "OK       binary cache: ${cacheUrl} is set up"
        has "OK       upstream's own service: not installed"
        has "OK       runtimeCompat (nix-ld): on"
        has "OK       server: t3code-server is running"
        has "OK       t3: this build's"
        has "No problems found."
        hasnt "WARN"
        hasnt "PROBLEM"

        # Several things wrong at once, on NixOS without nix-ld.
        scenario
        cmd claude
        cmd agy # not what T3 Code looks for
        cmd agent # cursor's CLI: T3 Code doesn't look for it
        echo "https://cache.nixos.org/" > $work/scenario/system-substituters
        upstream
        noloader
        printf 'loaded\nfailed\n' > $work/scenario/unit
        rm -f "''${work:?}"/scenario/path/t3; cmd t3
        run ${doctor} broken 1
        has "WARN     claude-code: T3 Code uses your claude, installed outside Nix ($work/scenario/path/claude; version not checked), not the bundled 2.0"
        has "OK       antigravity 3.0 (bundled)"
        has "OK       cursor-agent: built into T3 Code"
        has "PROBLEM  binary cache: not set up for the system, and you aren't a trusted user"
        has "PROBLEM  upstream's service is installed"
        has "without nix-ld its downloaded T3 Code can't start"
        has "systemctl --user disable --now t3code.service"
        has "runtimeCompat (nix-ld): off"
        has "PROBLEM  server: t3code-server has failed"
        has "WARN     t3: $work/scenario/path/t3 isn't from Nix"
        has "3 problem(s) found."
        [ "$(grep -c '^  *→ ' $work/out)" = 5 ]

        # The desktop app's Electron, under the header: which and why.
        scenario
        run ${electronNixpkgs} electron-nixpkgs 0
        has "Electron 44.10.2 from nixpkgs (bundled: 44.10.1; auto: nixpkgs 44.10.2 >= bundled 44.10.1)"
        run ${electronFallback} electron-fallback 0
        has "Electron 44.10.1, bundled (auto: this release's nixpkgs Electron failed t3code-nix's tests on one or both systems (fallback))"
        run ${electronPackage} electron-package 0
        has "Electron 44.9.3 from electron (bundled: 44.10.1; set to a package (44.9.3, older than bundled 44.10.1))"
        run ${doctor} electron-none 0
        hasnt "Electron "

        # NixOS stable: named in the header, and the cache line is only
        # information, whatever the cache settings (nix isn't even asked).
        scenario
        echo "https://cache.nixos.org/" > $work/scenario/system-substituters
        run ${onStable} nixos-stable 0
        has "t3code-nix doctor (T3 Code 0.1.9, latest channel, on NixOS stable)"
        has "OK       binary cache: NixOS stable isn't in it, so it's built locally (nothing to do)"
        hasnt "binary cache: not set up"
        [ ! -e $work/calls ] || ! grep -q "^nix " $work/calls
        run ${doctor} not-stable 1
        has "t3code-nix doctor (T3 Code 0.1.9, latest channel)"
        hasnt "on NixOS stable"

        # The cache only in the user's own nix.conf: fine when trusted, not
        # otherwise; a trailing slash is the same URL; trust unknown.
        scenario
        echo "https://cache.nixos.org/" > $work/scenario/system-substituters
        run ${doctor} user-conf-untrusted 1
        has "PROBLEM  binary cache: not set up for the system"
        echo '{"trusted":true,"url":"daemon"}' > $work/scenario/storeinfo
        run ${doctor} user-conf-trusted 0
        has "OK       binary cache: ${cacheUrl} is set up"
        scenario
        echo "${cacheUrl}/ https://cache.nixos.org/" > $work/scenario/system-substituters
        run ${doctor} trailing-slash 0
        has "OK       binary cache: ${cacheUrl} is set up"
        echo "${cacheUrl}?priority=10 https://cache.nixos.org/" > $work/scenario/system-substituters
        run ${doctor} with-query 0
        has "OK       binary cache: ${cacheUrl} is set up"
        # Untrusted, but the system allows the user's own substituter.
        scenario
        echo "https://cache.nixos.org/" > $work/scenario/system-substituters
        echo "${cacheUrl}" > $work/scenario/system-trusted-substituters
        run ${doctor} trusted-substituters 0
        has "OK       binary cache: ${cacheUrl} is set up"
        echo "https://cache.nixos.org/" > $work/scenario/user-substituters
        run ${doctor} trusted-substituters-unused 0
        has "WARN     binary cache: the system allows ${cacheUrl} (trusted-substituters) and has its key, but you don't use it"
        echo "cache.nixos.org-1:x" > $work/scenario/system-keys
        run ${doctor} trusted-substituters-no-key 1
        has "PROBLEM  binary cache: not set up for the system"
        scenario
        echo "https://cache.nixos.org/" > $work/scenario/system-substituters
        touch $work/scenario/info-fails
        run ${doctor} info-fails 0
        has "WARN     binary cache: not set up for the system, and the Nix daemon couldn't be asked"

        # Warnings only: a trusted user without the cache, a server
        # restarting, another t3code-nix build's t3, a Nix-packaged
        # provider (and another build of the same version), the command
        # antigravity's shim provides.
        scenario
        for f in system user; do echo "https://cache.nixos.org/" > $work/scenario/$f-substituters; done
        echo '{"trusted":true,"url":"daemon"}' > $work/scenario/storeinfo
        printf 'loaded\nactivating\n' > $work/scenario/unit
        ln -sf ${otherCli}/bin/t3 $work/scenario/path/t3
        ln -s ${olderCodex}/bin/codex $work/scenario/path/codex
        ln -s ${sameVersionClaude}/bin/claude $work/scenario/path/claude
        # A link whose real file has no harness beside it is skipped, even
        # with one beside the link (T3 Code looks beside the real file).
        mkdir -p $work/scenario/real
        printf '#!/bin/sh\n' > $work/scenario/real/agy_acp_server.par; chmod +x $work/scenario/real/agy_acp_server.par
        ln -s $work/scenario/real/agy_acp_server.par $work/scenario/path/agy_acp_server.par
        cmd localharness_external
        run ${doctor} warnings 0
        has "OK       antigravity 3.0 (bundled)"
        cp $work/scenario/path/localharness_external $work/scenario/real/
        run ${doctor} warnings-agy 0
        has "WARN     binary cache: not set up; you're a trusted user"
        has "WARN     server: t3code-server is starting or restarting"
        has "WARN     t3: $work/scenario/path/t3 is t3code-nix's, but another build (t3-0.1.10)"
        has "WARN     codex: T3 Code uses your codex, from another Nix package (codex-0.9"
        has "WARN     claude-code: T3 Code uses your claude, from another build of the same version"
        has "WARN     antigravity: T3 Code uses your agy_acp_server.par, installed outside Nix"
        rm -f "''${work:?}"/scenario/path/localharness_external "''${work:?}"/scenario/real/localharness_external
        # The CLI's name in another case still counts (isAntigravityCli).
        printf '#!/bin/sh\n' > $work/scenario/real/AGY; chmod +x $work/scenario/real/AGY
        ln -sf $work/scenario/real/AGY $work/scenario/path/agy_acp_server.par
        run ${doctor} agy-upper 0
        has "WARN     antigravity: T3 Code uses your agy_acp_server.par, installed outside Nix"

        # Antigravity's own download comes first; upstream's service on a
        # system with nix-ld is only a warning; t3 from another package.
        scenario
        agydl $work/scenario/home/.t3
        upstream
        ln -sf ${foreignCli}/bin/t3 $work/scenario/path/t3
        run ${doctor} antigravity-upstream 0
        has "WARN     antigravity: the app's, CLI's and server's T3 Code uses the runtime it downloaded"
        has "WARN     upstream's service is installed"
        has "fine if you set it up on purpose (cli.allowUpstreamService)"
        has "WARN     t3: $work/scenario/path/t3 comes from another Nix package (t3code-0.1.8)"
        # T3CODE_HOME as T3 Code reads it: `~/…`, `~\…`, padded, or blank.
        for h in '~/.t3' '~\.t3' '  ~/.t3  ' '   '; do
          printf '%s' "$h" > $work/scenario/t3home
          run ${doctor} "t3home '$h'" 0
          has "WARN     antigravity: the app's, CLI's and server's T3 Code uses the runtime it downloaded into $work/home/.t3/tools"
        done
        # A bare `~` is the home folder itself.
        agydl $work/scenario/home
        printf '%s' '~' > $work/scenario/t3home
        run ${doctor} "t3home '~'" 0
        has "WARN     antigravity: the app and CLI's T3 Code uses the runtime it downloaded into $work/home/tools"
        has "WARN     antigravity: the server's T3 Code uses the runtime it downloaded into $work/home/.t3/tools"
        rm -f "''${work:?}"/scenario/t3home

        # Not NixOS: a real loader, no runtimeCompat needed, upstream's
        # service can start; t3 not on PATH.
        scenario
        rm -f "''${work:?}"/scenario/root/etc/NIXOS "''${work:?}"/scenario/path/t3
        noloader
        touch $work/scenario/root/lib64/ld-linux-x86-64.so.2 $work/scenario/root/lib/ld-linux-aarch64.so.1
        upstream
        run ${doctor} not-nixos 0
        has "OK       runtimeCompat: not needed (not NixOS"
        has "WARN     upstream's service is installed"
        has "OK       t3: not on PATH"

        # claude's machine policy, as claude's own doctor reports it.
        has "OK       claude-code: its machine policy keeps its updates off"
        # The same with nothing but the scenario's fakes on PATH: the doctor
        # brings its own tools (without awk, the policy check was once
        # skipped and the doctor said no problems).
        scenario
        touch $work/scenario/minimal-path
        run ${doctor} minimal-path 0
        has "OK       claude-code: its machine policy keeps its updates off"
        hasnt "command not found"
        scenario
        echo 'Auto-updates: enabled' > $work/scenario/root/claude-doctor
        run ${doctor} claude-no-policy 0
        has "WARN     claude-code: no machine policy turns its updates off"
        scenario
        echo 'Auto-updates: disabled (set by env: DISABLE_AUTOUPDATER)' > $work/scenario/root/claude-doctor
        run ${doctor} claude-autoupdater-only 0
        has "WARN     claude-code: no machine policy turns its updates off"
        scenario
        echo '/etc/claude-code/managed-settings.d/20.json: Managed settings document could not be parsed as a JSON object' > $work/scenario/root/claude-doctor
        echo 1 > $work/scenario/root/claude-doctor-rc
        run ${doctor} claude-policy-malformed 1
        has "PROBLEM  claude-code: claude rejects its machine policy: /etc/claude-code/managed-settings.d/20.json: Managed settings document could not be parsed"
        # A claude that couldn't answer (crashed, printed nothing) is a
        # warning, not a problem; so is one with no temporary folder.
        scenario
        : > $work/scenario/root/claude-doctor
        echo 1 > $work/scenario/root/claude-doctor-rc
        run ${doctor} claude-no-answer 0
        has "WARN     claude-code: couldn't ask claude whether a machine policy keeps its updates off"
        scenario
        run ${goneClaude} claude-not-here 0
        has "WARN     claude-code: couldn't ask claude whether a machine policy keeps its updates off: this doctor's claude (/nix/store/00000000000000000000000000000000-claude-code-2.0/bin/claude) isn't on this machine"
        scenario
        TMPDIR=$work/nowhere run ${doctor} claude-no-tmp 0
        has "WARN     claude-code: couldn't ask claude whether a machine policy keeps its updates off: no temporary folder"

        # A codex daemon package left in ~/.codex (the /daemon menu can update
        # it outside Nix) is a warning, not a problem.
        scenario
        mkdir -p $work/scenario/home/.codex/packages/app-server-daemon/releases
        run ${doctor} codex-daemon-package 0
        has "WARN     codex: $work/home/.codex/packages/app-server-daemon is a Codex daemon package folder made outside this flake's wrapper"
        hasnt "update loop from outside Nix"
        # CODEX_HOME moves it: that folder counts, ~/.codex's doesn't.
        mkdir -p $work/scenario/home/alt/packages/app-server-daemon
        CODEX_HOME=$work/home/alt run ${doctor} codex-home-package 0
        has "WARN     codex: $work/home/alt/packages/app-server-daemon is a Codex daemon package folder"
        hasnt "$work/home/.codex/packages"
        rm -r $work/scenario/home/alt/packages
        CODEX_HOME=$work/home/alt run ${doctor} codex-home-elsewhere 0
        hasnt "app-server-daemon"
        # The processes such a package runs, recorded in app-server-daemon/:
        # its daemon (daemon.pid) and its update loop (daemon-updater.pid),
        # which `daemon stop` leaves running. A live one, from a codex outside
        # the store, is named with its PID; anything else isn't.
        state=$work/scenario/home/.codex/app-server-daemon
        mkdir -p $state $work/outside
        cp ${waitingCodex}/bin/codex ${waitingCodex}/bin/helper $work/outside/
        chmod u+w $work/outside/*
        # A record as codex writes one: its PID and identity (this boot's ID,
        # the start time in ticks); $identity can spoil it.
        identity=real
        start() { # pid file, command…: start it, record it
          local file=$1 boot ticks st
          shift
          "$@" &
          started=$!
          boot=$(< /proc/sys/kernel/random/boot_id)
          st=$(< /proc/$started/stat)
          read -ra fields <<< "''${st##*) }"
          ticks=''${fields[19]}
          case $identity in
            reused) ticks=$((ticks + 1)) ;;
            otherboot) boot=00000000-0000-0000-0000-000000000000 ;;
          esac
          if [ "$identity" = badtime ]; then
            echo "{\"pid\":$started,\"processStartTime\":\"x\"}" > $state/$file
          elif [ "$identity" = legacy ]; then
            # codex before 0.156: the start time as `ps -o lstart=` prints it
            read -r st < <(${pkgs.procps}/bin/ps -p $started -o lstart=)
            echo "{\"pid\":$started,\"processStartTime\":\"$st\"}" > $state/$file
          else
            echo "{\"pid\":$started,\"processStartTime\":\"x\",\"processIdentity\":{\"bootId\":\"$boot\",\"startTicks\":$ticks}}" > $state/$file
          fi
        }
        stop() { kill $started; wait $started 2>/dev/null || true; }
        start daemon-updater.pid $work/outside/codex app-server daemon pid-update-loop --restore-release x
        run ${doctor} codex-update-loop 0
        has "WARN     codex: a Codex update loop from outside Nix is running (PID $started"
        has "it keeps updating the copy in $work/home/.codex/packages/app-server-daemon"
        has "kill $started"
        stop
        run ${doctor} codex-update-loop-dead 0
        hasnt "update loop from outside Nix"
        hasnt "No such file"
        start daemon.pid $work/outside/codex app-server --listen unix:// --analytics-default-enabled --managed-daemon
        run ${doctor} codex-server 0
        has "WARN     codex: Codex's background server from outside Nix is running (PID $started"
        has "codex app-server daemon stop"
        stop
        rm $state/daemon.pid
        # With the package folder already deleted, its executable too: both
        # are still named, and the loop no longer "keeps updating" anything.
        rm -r $work/scenario/home/.codex/packages
        mkdir -p $work/outside/del && cp $work/outside/codex $work/outside/del/codex
        start daemon-updater.pid $work/outside/del/codex app-server daemon pid-update-loop
        rm $work/outside/del/codex
        run ${doctor} codex-update-loop-deleted 0
        has "WARN     codex: a Codex update loop from outside Nix is running (PID $started"
        hasnt "it keeps updating"
        hasnt "daemon package folder"
        stop
        # Not them: a live process that only mentions it in later arguments;
        # a codex running something else (another command, or the server
        # recorded as the loop); another program with the right
        # arguments; the store's own codex.
        decoy() {
          local name=$1; shift
          start "$@"
          run ${doctor} "$name" 0
          hasnt "from outside Nix is running"
          stop
        }
        decoy codex-loop-args daemon-updater.pid bash -c 'while :; do sleep 1; done' x codex app-server daemon pid-update-loop
        decoy codex-loop-other-codex daemon-updater.pid $work/outside/codex exec app-server daemon pid-update-loop
        decoy codex-loop-server daemon-updater.pid $work/outside/codex app-server --managed-daemon
        decoy codex-loop-not-codex daemon-updater.pid $work/outside/helper app-server daemon pid-update-loop
        decoy codex-loop-store daemon-updater.pid ${waitingCodex}/bin/codex app-server daemon pid-update-loop
        decoy codex-server-other-codex daemon.pid $work/outside/codex exec app-server --managed-daemon
        decoy codex-server-unmanaged daemon.pid $work/outside/codex app-server --listen unix://
        decoy codex-server-store daemon.pid ${waitingCodex}/bin/codex app-server --managed-daemon
        # A record from codex before 0.156 (no processIdentity) whose start
        # time matches is still named.
        identity=legacy
        start daemon.pid $work/outside/codex app-server --listen unix:// --managed-daemon
        run ${doctor} codex-server-legacy 0
        has "WARN     codex: Codex's background server from outside Nix is running (PID $started"
        stop
        start daemon-updater.pid $work/outside/codex app-server daemon pid-update-loop
        run ${doctor} codex-loop-legacy 0
        has "WARN     codex: a Codex update loop from outside Nix is running (PID $started"
        stop
        rm $state/daemon.pid
        # The right codex process, but not the one recorded: a reused PID
        # (another start time), a record from another boot or machine, and
        # a pre-0.156 record whose start time doesn't match.
        for identity in reused otherboot badtime; do
          decoy codex-server-$identity daemon.pid $work/outside/codex app-server --listen unix:// --managed-daemon
          decoy codex-loop-$identity daemon-updater.pid $work/outside/codex app-server daemon pid-update-loop
        done
        identity=real
        rm $state/daemon.pid
        # Another live PID, with no identity at all.
        echo "{\"pid\":$$}" > $state/daemon-updater.pid
        run ${doctor} codex-update-loop-other 0
        hasnt "from outside Nix is running"

        # The server's own home (programs.t3code.server.home) is checked too,
        # and T3 Code's own Codex download is mentioned.
        scenario
        agydl $work/scenario/home/.t3-server
        mkdir -p $work/scenario/home/.t3/tools/codex
        touch $work/scenario/home/.t3/tools/codex/active.json
        run ${serverHome} server-home 0
        has "WARN     antigravity: the server's T3 Code uses the runtime it downloaded into $work/home/.t3-server/tools"
        # Only the server's home has one: the app's PATH check still runs.
        has "OK       antigravity 3.0 (bundled)"
        has "(T3 Code also has its own Codex download in $work/home/.t3/tools/codex"
        hasnt "app-server-daemon"
        mkdir -p $work/elsewhere
        (cd $work/elsewhere && run ${serverHomeRelative} server-home-relative 0)
        has "WARN     antigravity: the server's T3 Code uses the runtime it downloaded into $work/home/.t3-server/tools"
        # A home folder with & in it; server.home = "%h/" is the home itself.
        agydl "$work/h&me/.t3-server"
        agydl "$work/h&me"
        inhome ${serverHome}
        has "the server's T3 Code uses the runtime it downloaded into $work/h&me/.t3-server/tools"
        inhome ${serverHomeSlash}
        has "the server's T3 Code uses the runtime it downloaded into $work/h&me/tools/antigravity-acp"

        # Fewer providers bundled: yours are still found; a bundled one that
        # isn't installed is said; one bundled from another build is that
        # build; an unbundled provider at the default build's path is yours.
        scenario
        cmd claude
        run ${fewer} fewer 0
        has "OK       claude-code: your own claude, installed outside Nix"
        has "OK       antigravity: not bundled in this build, and no agy_acp_server.par on PATH"
        has "WARN     pi 9.0 is bundled, but isn't installed here"
        has "OK       codex 1.1 (bundled)"
        ln -s ${otherCodex}/bin/codex $work/scenario/path/codex
        ln -s ${agy}/bin/agy_acp_server.par $work/scenario/path/agy_acp_server.par
        run ${fewer} fewer-on-path 0
        has "OK       codex 1.1 (bundled)"
        has "OK       antigravity: your own agy_acp_server.par, from another Nix package (antigravity-3.0"

        # PATH as T3 Code reads it: an empty entry is skipped (not the
        # current folder), and an entry is trimmed and unquoted.
        scenario
        mkdir -p $work/cwd "$work/my bin"
        sys=$work/scenario/path:$work/bin:$PATH
        printf '#!/bin/sh\n' > $work/cwd/claude; chmod +x $work/cwd/claude
        frompath "$sys:"
        has "OK       claude-code 2.0 (bundled)"
        printf '#!/bin/sh\n' > "$work/my bin/claude"; chmod +x "$work/my bin/claude"
        frompath " \"$work/my bin\" :$sys"
        has "WARN     claude-code: T3 Code uses your claude, installed outside Nix ($work/my bin/claude; version not checked)"
        frompath "$work/my bin/:$sys"
        has "WARN     claude-code: T3 Code uses your claude, installed outside Nix ($work/my bin/claude; version not checked)"
        # ".." is taken back by text, as path.join does, not through a link.
        mkdir -p $work/elsewhere/sub "$work/elsewhere/my bin"
        ln -s $work/elsewhere/sub $work/link
        printf '#!/bin/sh\n' > "$work/elsewhere/my bin/claude"; chmod +x "$work/elsewhere/my bin/claude"
        frompath "$work/link/../my bin:$sys"
        has "WARN     claude-code: T3 Code uses your claude, installed outside Nix ($work/my bin/claude; version not checked)"
        # A relative entry starting with "-" is a path, not an option.
        mkdir -p $work/cwd/-tools
        ln -s ${sameVersionClaude}/bin/claude $work/cwd/-tools/claude
        frompath "./-tools:$sys"
        has "WARN     claude-code: T3 Code uses your claude, from another build of the same version"
        if grep -q "invalid option" $work/out; then echo "readlink took a path as options"; exit 1; fi
        # Only double quotes are dropped, any number at either end.
        frompath "\"\"$work/my bin:$sys"
        has "WARN     claude-code: T3 Code uses your claude, installed outside Nix ($work/my bin/claude; version not checked)"
        frompath "'$work/my bin':$sys"
        has "OK       claude-code 2.0 (bundled)"

        # The server: not enabled; no unit from this doctor's configuration;
        # enabled but not loaded (systemctl's real answer).
        scenario
        printf 'not-found\ninactive\n' > $work/scenario/unit
        run ${serverOff} server-off 0
        has "OK       server (programs.t3code.server): not enabled"
        run ${serverUnknown} server-unknown 0
        has "OK       server: there's no t3code-server unit"
        run ${doctor} server-not-loaded 0
        has "WARN     server: enabled, but its unit isn't loaded for you"
        # server.users names others (the unit is loaded, and skipped, for
        # everyone): it says whom it runs for; naming this user, the usual
        # answer (after a rebuild that added them, the unit just isn't
        # started yet).
        printf 'loaded\ninactive\n' > $work/scenario/unit
        run ${serverForBob} server-not-for-you 0
        has "OK       server: t3code-server runs for bob carol (programs.t3code.server.users), not for you (alice)"
        hasnt "isn't running"
        run ${serverForAlice} server-for-you 0
        has "WARN     server: t3code-server isn't running"
        # None named: every user but a system one (root here), unless named.
        echo root > $work/scenario/user
        echo 0 > $work/scenario/uid
        run ${doctor} server-system-user 0
        has "OK       server: t3code-server runs for every user that isn't a system user"
        hasnt "isn't running"
        run ${serverForRoot} server-system-user-named 0
        has "WARN     server: t3code-server isn't running"
        # Taken out of server.users while it runs (a rebuild doesn't stop it):
        # still running for this user; failed: reported as failed.
        echo alice > $work/scenario/user
        echo 1000 > $work/scenario/uid
        printf 'loaded\nactive\n' > $work/scenario/unit
        run ${serverForBob} server-left-running 0
        has "WARN     server: t3code-server is still running for you (alice), from before"
        printf 'loaded\nfailed\n' > $work/scenario/unit
        run ${serverForBob} server-left-failed 1
        has "PROBLEM  server: t3code-server has failed"
        # Turned off while it runs: still running, from before.
        printf 'not-found\nactive\n' > $work/scenario/unit
        run ${serverOff} server-off-running 0
        has "WARN     server: programs.t3code.server is off, but t3code-server is still running from before"
        # Masked: say so (running or not); a unit that couldn't be loaded.
        printf 'masked\ninactive\n' > $work/scenario/unit
        run ${serverForAlice} server-masked 0
        has "WARN     server: t3code-server is masked, so it can't start"
        printf 'masked\nactive\n' > $work/scenario/unit
        run ${serverForAlice} server-masked-running 0
        has "WARN     server: t3code-server is masked, but still running"
        printf 'bad-setting\ninactive\n' > $work/scenario/unit
        run ${serverForAlice} server-bad-setting 1
        has "PROBLEM  server: t3code-server's unit couldn't be loaded"
        rm $work/scenario/user $work/scenario/uid

        # No nix; a nix that fails; no HOME at all.
        scenario
        mv $work/bin/nix $work/bin/nix.off
        run ${doctor} no-nix 0
        has "WARN     binary cache: can't check, nix isn't on PATH"
        mv $work/bin/nix.off $work/bin/nix
        scenario
        touch $work/scenario/nix-fails
        run ${doctor} nix-fails 0
        has "WARN     binary cache: can't check (\`nix config show\` failed)"
        hasnt "trusted user"
        scenario
        touch $work/scenario/no-home
        run ${doctor} no-home 0
        has "No problems found."

        # Only reads: nothing but `config show`, `store info` and `show`.
        scenario
        run ${doctor} calls 0
        if grep -v "^nix --extra-experimental-features nix-command config show \|^nix --extra-experimental-features nix-command store info --json$\|^systemctl --user show t3code-server.service " $work/calls; then
          echo "a call that isn't a read"; exit 1
        fi
        touch $out
      '';

  # `t3code-nix init` (pkgs/init) against fake systems: which branch and
  # host name it picks, what it writes (the template with just those two
  # lines and their comments changed), and what it refuses to do. Fake
  # nix-channel, nixos-version and nix answer from the scenario.
  init-scenarios =
    runCommand "init-scenarios"
      {
        nativeBuildInputs = [
          git
          pkgs.nix
        ];
      }
      ''
        set -u
        init=${packages.init}/bin/t3code-nix-init
        tpl=${../templates/default/flake.nix}
        cat=${pkgs.coreutils}/bin/cat
        work=$(mktemp -d)
        mkdir -p $work/bin $work/extra $work/root/proc/sys/kernel $work/home $work/roothome
        # nix-channel lists $HOME's channels, as the real one does.
        cat > $work/bin/nix-channel <<SH
        #!${stdenv.shell}
        [ ! -e $work/channel-fails ] || { echo broken >&2; exit 1; }
        $cat "\$HOME/channels" 2> /dev/null || true
        SH
        cat > $work/bin/nixos-version <<SH
        #!${stdenv.shell}
        [ ! -e $work/version-fails ] || exit 1
        $cat $work/version
        SH
        cat > $work/bin/nix <<SH
        #!${stdenv.shell}
        [ ! -e $work/nix-fails ] || { echo "no config show here" >&2; exit 1; }
        case "\$*" in
          *"config show experimental-features") $cat $work/features ;;
          *) exit 1 ;;
        esac
        SH
        chmod +x $work/bin/*
        export HOME=$work/home GIT_CONFIG_NOSYSTEM=1 NIX_STATE_DIR=$work/nix-state
        git config --global user.email t@example.org
        git config --global user.name t
        # The build user owns everything here: it stands for the folder's
        # and repository's owner.
        self=$(id -u)

        # Scenario defaults: a release channel build, flakes on, this
        # user, configuration.nix in the default folder ($root/etc/nixos).
        etc=$work/root/etc/nixos
        reset() {
          chmod -R u+w $work/root/etc $work/top 2> /dev/null || true
          rm -rf $work/root/etc $work/top $work/link "$work/with space" $work/*-fails $work/extra/*
          mkdir -p $etc
          echo '{ }' > $etc/configuration.nix
          d=$etc
          rm -f $work/roothome/channels $work/home/channels
          echo '26.05.13936.ac588ef1c914 (Yarara)' > $work/version
          echo 'fetch-closure flakes nix-command' > $work/features
          echo my-box > $work/root/proc/sys/kernel/hostname
          uid=$self
          path="$work/extra:$work/bin:$PATH"
        }
        run() { # name, expected exit status, init's arguments (--dir unless default)
          local name=$1 want=$2 got=0
          shift 2
          [ "$d" = "$etc" ] || set -- --dir "$d" "$@"
          T3CODE_INIT_ROOT=$work/root T3CODE_INIT_UID=$uid T3CODE_INIT_ROOT_HOME=$work/roothome \
            PATH="$path" $init "$@" > $work/out 2>&1 || got=$?
          echo "== $name (exit $got)"; cat $work/out
          [ "$got" = "$want" ] || { echo "$name: exit $got, expected $want"; exit 1; }
        }
        has() { grep -qF -- "$1" $work/out || { echo "missing: $1"; exit 1; }; }
        hasLine() { grep -qxF -- "$1" $work/out || { echo "missing line: $1"; exit 1; }; }
        hasnt() { if grep -qF -- "$1" $work/out; then echo "unexpected: $1"; exit 1; fi; }
        wrote() { grep -qxF -- "$1" "$d/flake.nix" || { echo "flake.nix lacks: $1"; exit 1; }; }
        # Nothing written, and no temporary file left behind.
        clean() {
          [ ! -e "$d/flake.nix" ] || { echo "flake.nix written"; exit 1; }
          [ -z "$(find "$d/" -maxdepth 1 -name '.flake.nix.*')" ] || { echo "temporary file left"; exit 1; }
        }

        # The usual case: /etc/nixos, a release from nixos-version, this
        # host's name, so a plain rebuild.
        reset
        run release 0
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";'
        wrote '      nixosConfigurations."my-box" = nixpkgs.lib.nixosSystem {'
        wrote '      # Build it with `sudo nixos-rebuild switch`.'
        wrote '    #   the running system'"'"'s version (26.05.13936.ac588ef1c914).'
        has 'nixpkgs: nixos-26.05, from the running system'"'"'s version (26.05.13936.ac588ef1c914)'
        hasLine '  sudo nixos-rebuild switch'
        has "To go back before rebuilding, delete $etc/flake.nix."
        hasnt "Flakes aren't"
        hasnt "configuration's name"
        [ "$(stat -c %a $etc/flake.nix)" = 644 ]
        [ -z "$(find $etc -name '.flake.nix.*')" ]
        # Nix parses it.
        nix-instantiate --parse $etc/flake.nix > /dev/null
        # Everything else is the template's: only its opening comment (5
        # lines), the comment over the nixpkgs line (8), that line, the
        # comment over the configuration (2) and its first line are gone.
        [ "$(grep -vxFf $etc/flake.nix $tpl | wc -l)" = 17 ] || { echo "more of the template changed"; exit 1; }
        grep -vxFf $tpl $etc/flake.nix > $work/added
        [ "$(wc -l < $work/added)" = 6 ] || { echo "more lines added than expected"; cat $work/added; exit 1; }

        # Run again: flake.nix exists, nothing changes.
        cp $etc/flake.nix $work/before
        run exists 0
        has 'exists already'
        cmp $work/before $etc/flake.nix

        # nixos-unstable, from a channel build's version.
        reset
        echo '26.11pre912345.0123456789ab (Zebra)' > $work/version
        run unstable 0
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";'

        # A flake build's or a git checkout's version doesn't tell: stop.
        for v in '26.05.20261113.f1e5c35 (Yarara)' '26.11pre-git (Zebra)' 'garbage'; do
          reset
          echo "$v" > $work/version
          run "version $v" 1
          has '--branch'
          clean
        done
        # nixos-version failing: stop, saying what was tried.
        reset
        touch $work/version-fails
        uid=0
        run version-fails 1
        has 'root has no nixos channel; nixos-version says nothing'
        clean

        # Root: the system's nixos channel wins over the version, read from
        # root's home even when sudo kept the caller's HOME.
        reset
        uid=0
        printf 'home-manager https://example.org/hm\nnixos https://nixos.org/channels/nixos-25.11-small/\n' > $work/roothome/channels
        echo 'nixos https://nixos.org/channels/nixos-unstable' > $work/home/channels
        run channel 0
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11-small";'
        has 'the system'"'"'s nixos channel (https://nixos.org/channels/nixos-25.11-small)'
        for c in https://channels.nixos.org/nixos-unstable https://nixos.org/channels/nixpkgs-unstable; do
          reset
          uid=0
          echo "nixos $c" > $work/roothome/channels
          run "channel $c" 0
          wrote "    nixpkgs.url = \"github:NixOS/nixpkgs/''${c##*/}\";"
        done
        # A channel that isn't one of NixOS's own: stop, don't guess;
        # suggest its name when that's a branch.
        reset
        uid=0
        echo "nixos https://example.org/my-nixpkgs" > $work/roothome/channels
        run other-channel 1
        has "your system's nixos channel is https://example.org/my-nixpkgs"
        has '--branch nixos-26.05.'
        clean
        reset
        uid=0
        echo "nixos https://mirror.example.org/nix-channels/nixos-25.11" > $work/roothome/channels
        run mirror-channel 1
        has '--branch nixos-25.11.'
        clean
        # nix-channel failing: the version instead.
        reset
        uid=0
        touch $work/channel-fails
        run channel-fails 0
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";'
        # Not root: another user's channels aren't the system's.
        reset
        echo 'nixos https://nixos.org/channels/nixos-unstable' > $work/home/channels
        run user-channel 0
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";'

        # --branch and --host: the command to build it names the host, in
        # the file and the output.
        reset
        run flags 0 --branch nixos-unstable --host other_box
        wrote '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";'
        wrote '    # The branch given with --branch when init ran.'
        wrote '      nixosConfigurations."other_box" = nixpkgs.lib.nixosSystem {'
        wrote "      # Build it with \`sudo nixos-rebuild switch --flake $etc#other_box\`."
        has 'nixpkgs: nixos-unstable, from --branch.'
        hasLine "  sudo nixos-rebuild switch --flake $etc#other_box"
        hasnt "configuration's name"
        reset
        run bad-branch 1 --branch master
        clean
        reset
        run bad-host 1 --host 'a"b'
        clean

        # A dotted host name is kept (quoted); one that can't be a name
        # becomes `nixos`, said so; only then.
        reset
        echo 'my.box' > $work/root/proc/sys/kernel/hostname
        run dotted-host 0
        wrote '      nixosConfigurations."my.box" = nixpkgs.lib.nixosSystem {'
        hasLine '  sudo nixos-rebuild switch'
        nix-instantiate --parse $etc/flake.nix > /dev/null
        reset
        echo 'my box' > $work/root/proc/sys/kernel/hostname
        run bad-hostname 0
        wrote '      nixosConfigurations."nixos" = nixpkgs.lib.nixosSystem {'
        has 'Your host name, my box, can'"'"'t be'
        hasLine "  sudo nixos-rebuild switch --flake $etc#nixos"
        reset
        echo nixos > $work/root/proc/sys/kernel/hostname
        d=$work/top
        mkdir -p $d && echo '{ }' > $d/configuration.nix
        run host-nixos-elsewhere 0
        hasnt "configuration's name"

        # Printed commands are quoted for pasting.
        reset
        d="$work/with space"
        mkdir -p "$d" && echo '{ }' > "$d/configuration.nix"
        run spaces 0
        has "--flake $(printf '%q' "$d#my-box")"

        # A relative folder is printed absolute; one with # or ? is refused.
        reset
        mkdir -p $work/top/conf && echo '{ }' > $work/top/conf/configuration.nix
        (cd $work/top && run relative 0 --dir conf)
        hasLine "  sudo nixos-rebuild switch --flake $work/top/conf#my-box"
        # Not another conf found through CDPATH.
        rm $work/top/conf/flake.nix
        mkdir -p $work/cdpath/conf && echo '{ }' > $work/cdpath/conf/configuration.nix
        (cd $work/top && CDPATH=$work/cdpath run cdpath 0 --dir conf)
        hasLine "  sudo nixos-rebuild switch --flake $work/top/conf#my-box"
        [ ! -e $work/cdpath/conf/flake.nix ]
        rm -rf $work/cdpath
        reset
        d="$work/my#conf"
        mkdir -p "$d" && echo '{ }' > "$d/configuration.nix"
        run hash-in-dir 1
        has 'has a # or ? in it'
        clean
        rm -rf "$d"

        # --dry-run prints and writes nothing.
        reset
        run dry-run 0 --dry-run
        has '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";'
        clean

        # Refusals: no configuration.nix; a folder it can't write to.
        reset
        rm $etc/configuration.nix
        run no-configuration 1
        has 'no configuration.nix'
        reset
        chmod a-w $etc
        run read-only 1
        has "can't write to"
        clean
        # Flakes off: written (nixos-rebuild turns them on itself), and
        # said; the check failing is said differently.
        reset
        echo 'nix-command' > $work/features
        run flakes-off 0
        has 'Flakes aren'"'"'t turned on'
        has 'nix.settings.experimental-features = [ "nix-command" "flakes" ];'
        reset
        touch $work/nix-fails
        run nix-fails 0
        has "Couldn't check whether flakes are turned on (nix said: no config show here)"
        # Channel paths in configuration.nix: a flake can't use them.
        reset
        echo '{ imports = [ <home-manager/nixos> ./hardware-configuration.nix ]; }' > $etc/configuration.nix
        printf '{\n  "%s" = 1;\n}\n' "\''${toString <nixpkgs>}" > $etc/other.nix
        echo '{ imports = [ <nixpkgs/nixos/modules/installer/scan/not-detected.nix> ]; }' > $etc/hardware-configuration.nix
        run channel-paths 0
        has 'These files use <…> paths'
        hasLine '  configuration.nix'
        hasLine '  hardware-configuration.nix'
        hasLine '  other.nix'
        # The same through a linked --dir.
        reset
        echo '{ imports = [ <home-manager/nixos> ]; }' > $etc/configuration.nix
        ln -s $etc $work/link
        d=$work/link
        run channel-paths-linked-dir 0
        hasLine '  configuration.nix'
        reset
        # Text that only looks like one, in a string and a comment.
        printf '{\n  # press <Enter>\n  x = "<uuid>";\n  y = "(__findFile __nixPath \\"z\\")";\n  z = "(__findFile __nixPath ";\n  w = "x (__findFile __nixPath ''${"q"}";\n}\n' > $etc/configuration.nix
        run no-channel-paths 0
        hasnt '<…>'
        # A quote in the folder's name doesn't turn the scan around.
        reset
        d="$work/one\"q"
        mkdir -p "$d"
        echo '{ a = ./p; b = <nixpkgs>; }' > "$d/configuration.nix"
        echo '{ a = ./p; b = "(__findFile __nixPath "; c = ")"; }' > "$d/other.nix"
        run quote-in-folder 0
        hasLine '  configuration.nix'
        hasnt '  other.nix'
        rm -rf "$d"
        # A big file (about 1 MB) is scanned in seconds, not minutes.
        reset
        { echo '{ x = ['; for i in $(seq 60000); do echo "\"item $i {\""; done; echo ']; }'; } > $etc/big.nix
        start=$(date +%s)
        run big-file 0
        [ $(( $(date +%s) - start )) -lt 60 ] || { echo "the scan took a minute or more"; exit 1; }
        hasnt '<…>'
        # configuration.nix linked from outside the folder: said.
        reset
        mkdir -p $work/top
        mv $etc/configuration.nix $work/top/configuration.nix
        ln -s $work/top/configuration.nix $etc/configuration.nix
        run linked-configuration 0
        has "configuration.nix goes through an absolute link ($etc/configuration.nix -> $work/top/configuration.nix)"
        # Absolute, even to a file in the folder: the store copy can't follow
        # it.
        reset
        mkdir -p $etc/hosts
        mv $etc/configuration.nix $etc/hosts/box.nix
        ln -s $etc/hosts/box.nix $etc/configuration.nix
        run absolute-link-inside 0
        has "configuration.nix goes through an absolute link ($etc/configuration.nix -> $etc/hosts/box.nix)"
        # A chain: relative, then absolute.
        reset
        mkdir -p $etc/hosts
        mv $etc/configuration.nix $etc/hosts/box.nix
        ln -s $etc/hosts/box.nix $etc/current.nix
        ln -s current.nix $etc/configuration.nix
        run absolute-in-chain 0
        has "configuration.nix goes through an absolute link ($etc/current.nix -> $etc/hosts/box.nix)"
        # A link to a file in the folder that isn't named .nix: scanned.
        reset
        echo '{ imports = [ <home-manager/nixos> ]; }' > $etc/box.conf
        rm $etc/configuration.nix
        ln -s box.conf $etc/configuration.nix
        run linked-not-nix 0
        has "  configuration.nix (that is, $etc/box.conf)"
        hasnt 'is a link to'
        # Relative, out of the folder (no repository).
        reset
        mkdir -p $work/root/etc/shared
        mv $etc/configuration.nix $work/root/etc/shared/configuration.nix
        ln -s ../shared/configuration.nix $etc/configuration.nix
        run relative-link-outside 0
        has "configuration.nix is a link to $work/root/etc/shared/configuration.nix, outside $etc"
        # A link within the same repository is fine (the flake sees it).
        reset
        mkdir -p $work/top/hosts/box $work/top/shared
        echo '{ imports = [ <home-manager/nixos> ]; }' > $work/top/shared/configuration.nix
        ln -s ../../shared/configuration.nix $work/top/hosts/box/configuration.nix
        git -C $work/top init -q
        git -C $work/top add .
        d=$work/top/hosts/box
        run linked-in-repo 0
        hasnt 'link'
        has "  configuration.nix (that is, $work/top/shared/configuration.nix)"
        hasnt "git doesn't track yet"
        # The same, the linked file untracked: said, with the command.
        reset
        mkdir -p $work/top/hosts/box $work/top/shared
        echo '{ }' > $work/top/shared/configuration.nix
        ln -s ../../shared/configuration.nix $work/top/hosts/box/configuration.nix
        git -C $work/top init -q
        d=$work/top/hosts/box
        run linked-untracked 0
        has "configuration.nix links through files git doesn't track yet"
        hasLine "  git -C $work/top add $work/top/shared/configuration.nix"
        # Ignored: add -f. And a link in the chain git doesn't track.
        reset
        mkdir -p $work/top/hosts/box $work/top/shared
        echo '{ }' > $work/top/shared/real.nix
        ln -s real.nix $work/top/shared/current.nix
        ln -s ../../shared/current.nix $work/top/hosts/box/configuration.nix
        echo shared/real.nix > $work/top/.gitignore
        git -C $work/top init -q
        git -C $work/top add .gitignore hosts
        d=$work/top/hosts/box
        run linked-chain-untracked 0
        hasLine "  git -C $work/top add $work/top/shared/current.nix"
        hasLine "  git -C $work/top add -f $work/top/shared/real.nix"
        # A linked folder on the way: untracked, it's listed; absolute, said.
        reset
        mkdir -p $work/top/hosts/box $work/top/shared
        echo '{ }' > $work/top/shared/configuration.nix
        ln -s shared $work/top/sl
        ln -s ../../sl/configuration.nix $work/top/hosts/box/configuration.nix
        git -C $work/top init -q
        git -C $work/top add hosts shared
        d=$work/top/hosts/box
        run linked-folder-untracked 0
        hasLine "  git -C $work/top add $work/top/sl"
        hasnt 'absolute link'
        reset
        mkdir -p $work/top/hosts/box $work/top/shared
        echo '{ }' > $work/top/shared/configuration.nix
        ln -s $work/top/shared $work/top/sl
        ln -s ../../sl/configuration.nix $work/top/hosts/box/configuration.nix
        git -C $work/top init -q
        git -C $work/top add .
        d=$work/top/hosts/box
        run linked-folder-absolute 0
        has "configuration.nix goes through an absolute link ($work/top/sl -> $work/top/shared)"
        # Out of the folder and back: said.
        reset
        mkdir -p $work/root/etc/outside
        ln -s ../nixos $work/root/etc/outside/back
        mv $etc/configuration.nix $etc/real.nix
        ln -s ../outside/back/real.nix $etc/configuration.nix
        run out-and-back 0
        has "configuration.nix's links go through $work/root/etc, outside $etc"
        has "point the link at $etc/real.nix by a path that stays inside."
        # An ignored link in the folder, not named .nix: listed, add -f.
        reset
        git -C $etc init -q
        echo '{ }' > $etc/real.conf
        ln -s real.conf $etc/hop
        rm $etc/configuration.nix
        ln -s hop $etc/configuration.nix
        printf 'hop\nreal.conf\n' > $etc/.gitignore
        git -C $etc add configuration.nix .gitignore
        run ignored-hop 0
        hasLine "  git -C $etc add -f $etc/hop"
        hasLine "  git -C $etc add -f $etc/real.conf"
        # Untracked (not ignored) in the folder: listed once, with the rest.
        reset
        git -C $etc init -q
        mv $etc/configuration.nix $etc/real.nix
        ln -s real.nix $etc/configuration.nix
        run untracked-once 0
        [ "$(grep -c 'real.nix' $work/out)" = 1 ] || { echo "real.nix listed more than once"; exit 1; }
        hasnt "git doesn't track yet. Run:"

        # A git repository: flake.nix staged; untracked and ignored files
        # listed.
        reset
        git -C $etc init -q
        echo hardware-configuration.nix > $etc/.gitignore
        git -C $etc add configuration.nix .gitignore
        echo '{ }' > $etc/hardware-configuration.nix
        echo '{ }' > $etc/extra.nix
        run git 0
        [ "$(git -C $etc diff --cached --name-only)" = "$(printf '.gitignore\nconfiguration.nix\nflake.nix')" ]
        has '  extra.nix'
        has 'These .nix files are ignored:'
        has '  hardware-configuration.nix'
        has "git -C $etc add -f <file>"
        # The repository above the folder, reached through a link.
        reset
        mkdir -p $work/top/sub
        echo '{ }' > $work/top/sub/configuration.nix
        git -C $work/top init -q
        git -C $work/top add sub/configuration.nix
        ln -s $work/top/sub $work/link
        d=$work/link
        run nested-git 0
        has "Added flake.nix to the git repository in $work/top."
        [ "$(git -C $work/top diff --cached --name-only)" = "$(printf 'sub/configuration.nix\nsub/flake.nix')" ]
        # Root, in a repository someone else owns: not staged (it would
        # leave root's files in their .git); the owner is told what to run.
        reset
        uid=0
        git -C $etc init -q
        run others-repo 0
        has "As the repository's owner, run:"
        hasLine "  git -C $etc add flake.nix"
        [ -z "$(git -C $etc diff --cached --name-only)" ]
        # git add failing: its reason, and what to run.
        reset
        git -C $etc init -q
        echo flake.nix > $etc/.gitignore
        run git-fails 0
        has 'adding flake.nix failed:'
        has 'ignored by one of your .gitignore files'
        has "git -C $etc add flake.nix"
        # git refusing to look (say, safe.directory): its reason.
        reset
        printf '#!${stdenv.shell}\necho "fatal: detected dubious ownership in repository" >&2\nexit 128\n' > $work/extra/git
        chmod +x $work/extra/git
        run git-refuses 0
        has "git couldn't check whether"
        has 'detected dubious ownership'
        # No git, but a .git folder.
        reset
        mkdir $etc/.git
        path=$work/bin
        run no-git 0
        has "is a git repository, and the flake only sees files git tracks"

        touch $out
      '';

  # The flake template, instantiated with this flake as its t3code-nix
  # input (as `nix flake init` would leave it, with a stand-in for the
  # user's configuration.nix): it must evaluate to a whole NixOS system.
  # Its commented examples aren't evaluated; they were checked by hand when
  # written (all of them on except the nightly channel, which NixOS stable
  # doesn't allow, and each providers line alone).
  template =
    let
      dir = ../templates/default;
      tpl = import (dir + "/flake.nix");
      system = stdenv.hostPlatform.system;
      configuration = {
        nixpkgs.hostPlatform = system;
        fileSystems."/" = {
          device = "/dev/sda1";
          fsType = "ext4";
        };
        boot.loader.grub.device = "nodev";
        system.stateVersion = "26.05";
      };
      # nixpkgs as the template sees it: lib.nixosSystem (eval-config, as
      # nixpkgs' flake defines it), with the stand-in swapped in.
      withConfiguration = {
        lib = lib // {
          nixosSystem =
            args:
            import (path + "/nixos/lib/eval-config.nix") (
              {
                system = null;
              }
              // args
              // {
                modules = map (m: if m == dir + "/configuration.nix" then configuration else m) args.modules;
              }
            );
        };
      };
      outputs = tpl.outputs {
        self = outputs;
        nixpkgs = withConfiguration;
        t3code-nix = self;
      };
      host = outputs.nixosConfigurations.nixos.config;
    in
    conditions "template" {
      "the flake exports it, and it holds only flake.nix (init never overwrites a file)" =
        self.templates.default.path == dir && builtins.attrNames (builtins.readDir dir) == [ "flake.nix" ];
      "its inputs are this flake and nixos-unstable, not following each other" =
        tpl.inputs.t3code-nix.url == "github:swsammy/t3code-nix"
        && tpl.inputs.nixpkgs.url == "github:NixOS/nixpkgs/nixos-unstable"
        && !(tpl.inputs.t3code-nix ? inputs);
      "it imports the user's configuration.nix and enables T3 Code" =
        host.programs.t3code.enable && host.fileSystems."/".device == "/dev/sda1";
      "the whole system evaluates" = lib.hasSuffix ".drv" host.system.build.toplevel.drvPath;
    } "";

  # default.nix, as `nix-env -f`, `import (fetchTarball …)` and a
  # channel-based NixOS configuration use it: the same packages, module and
  # overlay as the flake's.
  default-nix =
    let
      system = stdenv.hostPlatform.system;
      plain = import ../default.nix { inherit system; };
      nixos =
        (import (path + "/nixos/lib/eval-config.nix") {
          system = null;
          modules = [
            plain.nixosModules.default
            {
              nixpkgs.pkgs = pkgs;
              programs.t3code.enable = true;
            }
          ];
        }).config;
      overlaid = import path {
        inherit system;
        overlays = [ plain.overlays.default ];
      };
      drv = p: p.drvPath;
    in
    conditions "default-nix" {
      "this system's packages are the flake's, at the top level" =
        builtins.all (n: drv plain.${n} == drv packages.${n})
          [
            "t3code"
            "t3"
            "t3-free"
            "codex"
            "doctor"
          ];
      "every flake output is there; `default` (the app again) isn't at the top level" =
        plain.flake.packages.${system}.t3.drvPath == packages.t3.drvPath
        && plain.flake ? nixosModules
        && plain.flake ? overlays
        && !(plain ? default);
      "its NixOS module installs T3 Code" = builtins.elem packages.t3code.drvPath (
        map drv nixos.environment.systemPackages
      );
      "its overlay works" = overlaid.t3code-nix.t3-free.drvPath == packages.t3-free.drvPath;
      # NixOS stable through default.nix: the flake's stable package names
      # (listed from the snapshot's pin files alone, never importing its
      # nixpkgs), and nothing on a system without packages.
      "default.nix's stable set has the flake's stable names, and none elsewhere" =
        builtins.attrNames plain.stable == builtins.attrNames self.legacyPackages.${system}.stable
        && (import ../default.nix { system = "x86_64-darwin"; }).stable == { };
      # The browser pins' fetchTarball needs no flakes feature.
      "agent-browser and its pinned Chromium evaluate without flakes" =
        plain.agent-browser.drvPath == packages.agent-browser.drvPath
        &&
          plain.agent-browser.browser.outPath == (lib.importJSON ../versions/browser-unstable.json)
          .outPaths.${system};
    } "";

  # Shell completions, where NixOS links them from: the CLI's
  # (pkgs/t3code/wrap.nix) in every CLI package, for the command `t3` (the
  # module's cli.enable installs one of these packages, module-eval), and
  # those of the providers and agent tools that generate their own.
  completions = runCommand "completions" { } (
    lib.concatMapStrings
      (n: ''
        d=${packages.${n}}/share
        for f in bash-completion/completions/${n} zsh/site-functions/_${n} fish/vendor_completions.d/${n}.fish; do
          [ -s $d/$f ] || { echo "${n}: share/$f is missing or empty"; exit 1; }
        done
        grep -qE '^ *complete .*[ =]${n}$' $d/bash-completion/completions/${n} \
          || { echo "${n}: its bash completion doesn't complete ${n}"; exit 1; }
        head -1 $d/zsh/site-functions/_${n} | grep -qx '#compdef ${n}' \
          || { echo "${n}: its zsh completion doesn't start with #compdef ${n}"; exit 1; }
        grep -q '^complete -c ${n} ' $d/fish/vendor_completions.d/${n}.fish \
          || { echo "${n}: its fish completion doesn't complete ${n}"; exit 1; }
        echo "${n}: completions"
      '')
      (
        builtins.filter (n: packages ? ${n}) [
          "codex"
          "boat"
          "grok"
          "opencode"
        ]
      )
    +
      lib.concatMapStrings
        (t3: ''
          for f in share/bash-completion/completions/t3 share/zsh/site-functions/_t3 share/fish/vendor_completions.d/t3.fish; do
            [ -s ${t3}/$f ] || { echo "${t3.name}: $f is missing or empty"; exit 1; }
          done
          grep -q '^complete -F _t3 t3$' ${t3}/share/bash-completion/completions/t3
          head -1 ${t3}/share/zsh/site-functions/_t3 | grep -qx '#compdef t3'
          grep -q '^complete -c t3 ' ${t3}/share/fish/vendor_completions.d/t3.fish
          echo "${t3.name}: completions for t3"
        '')
        (present [
          packages.t3
          packages.t3-free
          (packages.t3-nightly or null)
        ])
    + "touch $out"
  );

  # lib/cache.nix is the one definition of the binary cache; flake.nix's
  # nixConfig (which Nix can't evaluate) and the README have to repeat it.
  cache-settings =
    let
      nixConfig = (import ../flake.nix).nixConfig or null;
      # The template gives the same lines to new users' flakes.
      templateConfig = (import ../templates/default/flake.nix).nixConfig or null;
      readme = builtins.readFile ../README.md;
    in
    conditions "cache-settings" (
      if cache.publicKey == null then
        {
          "no cache (lib/cache.nix has no key), so flake.nix must have no nixConfig" = nixConfig == null;
          "no cache, so the template must have no nixConfig either" = templateConfig == null;
          "no cache, so the README must not give a key" = !lib.hasInfix ".cachix.org-1:" readme;
        }
      else
        {
          "the template's nixConfig must be exactly lib/cache.nix's substituter and key" =
            templateConfig == {
              extra-substituters = [ cache.url ];
              extra-trusted-public-keys = [ cache.publicKey ];
            };
          "flake.nix's nixConfig must be exactly lib/cache.nix's substituter and key" =
            nixConfig == {
              extra-substituters = [ cache.url ];
              extra-trusted-public-keys = [ cache.publicKey ];
            };
          "the README must give lib/cache.nix's substituter and key" =
            lib.hasInfix cache.url readme && lib.hasInfix cache.publicKey readme;
        }
    ) "";

  # macOS has a default package that only says it isn't supported
  # (lib/unsupported.nix), and nothing else.
  unsupported-systems =
    let
      other = lib.subtractLists [ "x86_64-linux" "aarch64-linux" ] (builtins.attrNames self.packages);
      stub = self.packages.aarch64-darwin.default;
    in
    conditions "unsupported-systems"
      {
        "other systems have only a default package" = builtins.all (
          s: builtins.attrNames self.packages.${s} == [ "default" ]
        ) other;
      }
      ''
        # What building it does, with this system's shell.
        if ${stdenv.shell} ${lib.escapeShellArgs stub.args} 2>err; then
          echo "the stub succeeded"; exit 1
        fi
        grep -qxF 't3code-nix supports Linux only (x86_64-linux, aarch64-linux)' err
      '';

  # Every self-update or self-install command must be refused before the
  # provider runs (see lib/guard.nix): message, exit 1, nothing written.
  # t3code's "update provider" button runs some of these.
  refused = lib.unique (
    presentRows (
      lib.concatMap (
        c:
        map (cmd: [
          c.pkg
          c.bin
          cmd
        ]) c.commands
      ) guardTables
    )
    ++ refusedRows
  );
  refusedRows = presentRows [
    [
      packages.agent-browser
      "agent-browser"
      "upgrade"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "install"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "install --with-deps"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "doctor --fix"
    ]
    [
      packages.boat
      "boat"
      "self-update"
    ]
    [
      packages.boat
      "boat"
      "--json self-update"
    ]
    [
      packages.claude-code
      "claude"
      "update"
    ]
    [
      packages.claude-code
      "claude"
      "install"
    ]
    [
      packages.claude-code
      "claude"
      "upgrade"
    ]
    [
      packages.claude-code
      "claude"
      "--verbose update"
    ]
    [
      packages.codex
      "codex"
      "--no-alt-screen update"
    ]
    [
      packages.codex
      "codex"
      "update"
    ]
    # Not a command since codex 0.171.0, so its next word is the command.
    [
      packages.codex
      "codex"
      "stdio-to-uds update"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon update"
    ]
    [
      packages.codex
      "codex"
      "-c x=y app-server daemon bootstrap"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon --enable goals bootstrap"
    ]
    [
      packages.codex
      "codex"
      "app-server -c x=y daemon update --yes"
    ]
    [
      packages.codex
      "codex"
      "hello update"
    ]
    [
      packages.codex
      "codex"
      "-m x update"
    ]
    [
      packages.codex
      "codex"
      "-i a.png b.png -c x=y update"
    ]
    [
      packages.codex
      "codex"
      "app-server --listen off daemon update"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon -c x=y update"
    ]
    [
      packages.codex
      "codex"
      "fix -c x=y app-server daemon update"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon pid-update-loop"
    ]
    [
      packages.codex
      "codex"
      "-ch update"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon update -yc h"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon update -y"
    ]
    [
      packages.pi
      "pi"
      "update ''"
    ]
    [
      packages.pi
      "pi"
      "update '' --force"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon -c x=y pid-update-loop"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon reinstall-someday"
    ]
    [
      packages.codex
      "codex"
      "remote-control --json reinstall-someday"
    ]
    [
      packages.claude-code
      "claude"
      "update -- --help"
    ]
    [
      packages.antigravity
      "agy"
      "update x --help"
    ]
    [
      packages.antigravity
      "agy"
      "update x -h"
    ]
    [
      packages.claude-code
      "claude"
      "--model --help update"
    ]
    [
      packages.antigravity
      "agy"
      "install --dir --help"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "update --model --help"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "upgrade --api-key -h"
    ]
    [
      packages.claude-code
      "claude"
      "update --force --help"
    ]
    [
      packages.claude-code
      "claude"
      "-- update --help"
    ]
    [
      packages.claude-code
      "claude"
      "-- install -h"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "-- install --help"
    ]
    [
      packages.pi
      "pi"
      "update self -h"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon start"
    ]
    [
      packages.codex
      "codex"
      "remote-control start"
    ]
    [
      packages.cursor-agent
      "agent"
      "update"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "update"
    ]
    [
      packages.cursor-agent
      "agent"
      "upgrade"
    ]
    [
      packages.cursor-agent
      "agent"
      "install 2026.11.11-b912975"
    ]
    [
      packages.cursor-agent
      "agent"
      "set-channel lab"
    ]
    [
      packages.grok
      "grok"
      "update"
    ]
    # What the broad rule refuses although upstream wouldn't update (the
    # cost of lib/guard.nix's refuse: a one-word prompt or an option's value
    # that is a refused name, an option before another command).
    [
      packages.claude-code
      "claude"
      "update -p"
    ]
    [
      packages.claude-code
      "claude"
      "install --print"
    ]
    [
      packages.claude-code
      "claude"
      "-vh update"
    ]
    [
      packages.claude-code
      "claude"
      "--resume update"
    ]
    [
      packages.claude-code
      "claude"
      "--betas a b update"
    ]
    [
      packages.claude-code
      "claude"
      "--verbose plugin install nonexistent-plugin"
    ]
    [
      packages.claude-code
      "claude"
      "-p update"
    ]
    [
      packages.claude-code
      "claude"
      "--name qa -p update"
    ]
    [
      packages.claude-code
      "claude"
      "--print install"
    ]
    [
      packages.grok
      "grok"
      "-p update"
    ]
    [
      packages.opencode
      "opencode"
      "--prompt update"
    ]
    [
      packages.antigravity
      "agy"
      "-p update"
    ]
    [
      packages.cursor-agent
      "agent"
      "fix the bug update"
    ]
    # Other options right after a refused command (afterRefused lists the
    # few that only print help or the version).
    [
      packages.grok
      "grok"
      "update --force-reinstall"
    ]
    [
      packages.grok
      "grok"
      "update --version 1.0.0"
    ]
    [
      packages.grok
      "grok"
      "update --check"
    ]
    [
      packages.grok
      "grok"
      "update --alpha"
    ]
    [
      packages.grok
      "grok"
      "--zz-not-an-option x update --force-reinstall"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "update -f"
    ]
    [
      packages.cursor-agent
      "agent"
      "install -w"
    ]
    [
      packages.cursor-agent
      "agent"
      "update -e x"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "update -H x"
    ]
    [
      packages.cursor-agent
      "agent"
      "upgrade --force"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "--zz-not-an-option x update -f"
    ]
    # An option's value before the command (lib/guard.nix's refuse).
    [
      packages.claude-code
      "claude"
      "--update"
    ]
    [
      packages.claude-code
      "claude"
      "--upgrade"
    ]
    [
      packages.opencode
      "opencode"
      "--no-wizard"
    ]
    [
      packages.opencode
      "opencode"
      "run --no-wizard"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "--session x doctor --fix"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "--headed doctor --fix"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "doctor --quick --fix"
    ]
    [
      packages.claude-code
      "claude"
      "--add-dir --model --settings x update"
    ]
    [
      packages.claude-code
      "claude"
      "--add-dir --help --model x update"
    ]
    [
      packages.claude-code
      "claude"
      "--add-dir -p -c update"
    ]
    [
      packages.claude-code
      "claude"
      "--tools --model -n x upgrade"
    ]
    [
      packages.claude-code
      "claude"
      "--betas --model --effort x install"
    ]
    [
      packages.claude-code
      "claude"
      "-p update cc://x"
    ]
    [
      packages.claude-code
      "claude"
      "--print install stable cc://x"
    ]
    [
      packages.opencode
      "opencode"
      "--print-logs true upgrade --method curl"
    ]
    [
      packages.opencode
      "opencode"
      "--print-logs n update"
    ]
    [
      packages.claude-code
      "claude"
      "--agent-name --help update"
    ]
    [
      packages.claude-code
      "claude"
      "--agent-name --version install"
    ]
    [
      packages.claude-code
      "claude"
      "--agent-name -p update"
    ]
    [
      packages.claude-code
      "claude"
      "--agent-name --model update"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "--http-version --help update"
    ]
    [
      packages.cursor-agent
      "agent"
      "--http-version -h update"
    ]
    [
      packages.grok
      "grok"
      "--harness --help hello update"
    ]
    [
      packages.antigravity
      "agy"
      "--undefok --help update"
    ]
    [
      packages.claude-code
      "claude"
      "--agent-name x update"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "--http-version 1.1 update"
    ]
    [
      packages.grok
      "grok"
      "--harness x y update"
    ]
    [
      packages.grok
      "grok"
      "--print x y update"
    ]
    [
      packages.claude-code
      "claude"
      "--debug - update"
    ]
    [
      packages.claude-code
      "claude"
      "--add-dir a - --verbose update"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "--resume - update"
    ]
    [
      packages.grok
      "grok"
      "--resume - y update"
    ]
    [
      packages.antigravity
      "agy"
      "--undefok x update"
    ]
    [
      packages.claude-code
      "claude"
      "--zz-not-an-option x install"
    ]
    [
      packages.cursor-agent
      "agent"
      "--zz-not-an-option x update"
    ]
    [
      packages.grok
      "grok"
      "--zz-not-an-option x y update"
    ]
    [
      packages.antigravity
      "agy"
      "--zz-not-an-option x install"
    ]
    [
      packages.opencode
      "opencode"
      "--zz-not-an-option x upgrade"
    ]
    [
      packages.fx
      "fx"
      "--zz-not-an-option x update"
    ]
    [
      packages.kiro-cli
      "kiro-cli"
      "--zz-not-an-option x update"
    ]
    [
      packages.claude-code
      "claude"
      "--debug --model x update"
    ]
    [
      packages.claude-code
      "claude"
      "--resume --model x install"
    ]
    [
      packages.claude-code
      "claude"
      "-- update -p --help"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "--resume --model x update"
    ]
    [
      packages.cursor-agent
      "agent"
      "--worktree --model x update"
    ]
    [
      packages.grok
      "grok"
      "--resume --model x hello update"
    ]
    [
      packages.grok
      "grok"
      "--effort high hello update"
    ]
    [
      packages.grok
      "grok"
      "--ref main hello update"
    ]
    [
      packages.grok
      "grok"
      "--system-prompt x hello update"
    ]
    [
      packages.claude-code
      "claude"
      "--add-dir a mcp --verbose update"
    ]
    [
      packages.claude-code
      "claude"
      "--add-dir a plugin -- update --help"
    ]
    [
      packages.claude-code
      "claude"
      "-dp update"
    ]
    [
      packages.claude-code
      "claude"
      "--add-dir=a update"
    ]
    [
      packages.antigravity
      "agy"
      "-model x update"
    ]
    [
      packages.grok
      "grok"
      "-m x update"
    ]
    [
      packages.claude-code
      "claude"
      "--add-dir a b --verbose update"
    ]
    [
      packages.claude-code
      "claude"
      "--allowedTools a b --verbose install"
    ]
    [
      packages.claude-code
      "claude"
      "--add-dir a b -- update --help"
    ]
    [
      packages.claude-code
      "claude"
      "--model mcp update"
    ]
    [
      packages.grok
      "grok"
      "hello update"
    ]
    [
      packages.grok
      "grok"
      "--cwd /tmp fix update"
    ]
    [
      packages.grok
      "grok"
      "'' update"
    ]
    [
      packages.opencode
      "opencode"
      "--wizard"
    ]
    [
      packages.opencode
      "opencode"
      "run --wizard"
    ]
    [
      packages.claude-code
      "claude"
      "--model x update"
    ]
    [
      packages.claude-code
      "claude"
      "--model x install"
    ]
    [
      packages.claude-code
      "claude"
      "--model=x upgrade"
    ]
    [
      packages.claude-code
      "claude"
      "--model x --verbose update"
    ]
    [
      packages.claude-code
      "claude"
      "--settings a.json --model x install"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "--model x update"
    ]
    [
      packages.cursor-agent
      "agent"
      "--api-key k install 2026.11.11-b912975"
    ]
    [
      packages.cursor-agent
      "agent"
      "--model x set-channel lab"
    ]
    [
      packages.grok
      "grok"
      "--model x update"
    ]
    [
      packages.antigravity
      "agy"
      "--model x update"
    ]
    [
      packages.antigravity
      "agy"
      "--agent x install"
    ]
    [
      packages.opencode
      "opencode"
      "--log-level debug upgrade"
    ]
    [
      packages.opencode
      "opencode"
      "--log-level debug update"
    ]
    [
      packages.fx
      "fx"
      "--model x update"
    ]
    [
      packages.kiro-cli
      "kiro-cli"
      "--agent x update"
    ]
    [
      packages.boat
      "boat"
      "--profile x self-update"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "--session x upgrade"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "--session x install"
    ]
    [
      packages.kiro-cli
      "kiro-cli"
      "update"
    ]
    [
      packages.kiro-cli
      "kiro-cli"
      "upgrade"
    ]
    [
      packages.opencode
      "opencode"
      "upgrade"
    ]
    [
      packages.opencode
      "opencode"
      "update --method curl"
    ]
    [
      packages.fx
      "fx"
      "update"
    ]
    [
      packages.fx
      "fx"
      "upgrade"
    ]
    [
      packages.antigravity
      "agy"
      "update"
    ]
    [
      packages.antigravity
      "agy"
      "install"
    ]
    [
      packages.pi
      "pi"
      "update"
    ]
    [
      packages.pi
      "pi"
      "update --self"
    ]
    [
      packages.pi
      "pi"
      "update self"
    ]
    [
      packages.pi
      "pi"
      "update --all"
    ]
    [
      packages.pi
      "pi"
      "update --force"
    ]
    [
      packages.pi
      "pi"
      "update -a"
    ]
    [
      packages.t3
      "t3"
      "update"
    ]
    [
      packages.t3
      "t3"
      "update 0.2.0"
    ]
    [
      packages.t3
      "t3"
      "--yes update"
    ]
    [
      packages.t3
      "t3"
      "service install"
    ]
    [
      packages.t3
      "t3"
      "service update"
    ]
    [
      packages.t3
      "t3"
      "--log-level debug update"
    ]
    [
      packages.t3
      "t3"
      "--log-level debug service install"
    ]
    [
      packages.t3
      "t3"
      "--log-level=debug service --log-level debug install"
    ]
    # The root command's options with a value, before the subcommand.
    [
      packages.t3
      "t3"
      "--base-dir /x update"
    ]
    [
      packages.t3
      "t3"
      "--port 3773 service install"
    ]
    [
      packages.t3
      "t3"
      "--mode web --host 0.0.0.0 update"
    ]
    [
      packages.t3
      "t3"
      "--tailscale-serve-port 443 --dev-url http://x service update"
    ]
    [
      packages.t3
      "t3"
      "--bootstrap-fd 3 --completions bash update"
    ]
    # `t3 up` and plain `t3 connect` install upstream's service too.
    [
      packages.t3
      "t3"
      "up"
    ]
    [
      packages.t3
      "t3"
      "up --lan --yes"
    ]
    [
      packages.t3
      "t3"
      "--base-dir /x up --connect"
    ]
    [
      packages.t3
      "t3"
      "connect"
    ]
    [
      packages.t3
      "t3"
      "connect --headless --base-dir /x"
    ]
    # A boolean option's value is never the subcommand.
    [
      packages.t3
      "t3"
      "connect --headless true"
    ]
    # A `connect` subcommand not let through (as a new one upstream adds).
    [
      packages.t3
      "t3"
      "connect enable"
    ]
    [
      packages.t3
      "t3"
      "--lan yes up"
    ]
    [
      packages.t3
      "t3"
      "--no-browser 0 update"
    ]
    # After `--`, `-h` is an argument (here a version), not help.
    [
      packages.t3
      "t3"
      "update -- -h"
    ]
    [
      (packages.t3-nightly or null)
      "t3"
      "up"
    ]
    [
      (packages.t3-nightly or null)
      "t3"
      "service install"
    ]
  ];
  # Not refused: a prompt that merely starts with "update", and extension
  # updates for pi. They may fail for other reasons in the sandbox (no
  # network, no login); only the refusal message matters here.
  allowed = lib.unique (
    presentRows (
      lib.concatMap (
        c:
        map (v: [
          c.pkg
          c.bin
          v
        ]) c.version
      ) guardTables
    )
    ++ allowedRows
  );
  allowedRows = presentRows [
    [
      packages.agent-browser
      "agent-browser"
      "--version"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "skills list"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "doctor --offline --quick"
    ]
    [
      packages.boat
      "boat"
      "--version"
    ]
    [
      packages.boat
      "boat"
      "help"
    ]
    [
      packages.claude-code
      "claude"
      "-p 'update this function'"
    ]
    # The command is a plain word before any refused one.
    [
      packages.cursor-agent
      "agent"
      "upgrade --version"
    ]
    [
      packages.cursor-agent
      "agent"
      "set-channel -v"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "install --version"
    ]
    [
      packages.cursor-agent
      "cursor-agent"
      "update --version"
    ]
    [
      packages.cursor-agent
      "agent"
      "install -v"
    ]
    [
      packages.cursor-agent
      "agent"
      "update -vh"
    ]
    [
      packages.grok
      "grok"
      "workspace update"
    ]
    [
      packages.claude-code
      "claude"
      "--version update"
    ]
    [
      packages.grok
      "grok"
      "-V update"
    ]
    [
      packages.cursor-agent
      "agent"
      "-v update"
    ]
    [
      packages.kiro-cli
      "kiro-cli"
      "-V update"
    ]
    [
      packages.opencode
      "opencode"
      "--version update"
    ]
    [
      packages.antigravity
      "agy"
      "--version update"
    ]
    [
      packages.fx
      "fx"
      "--version update"
    ]
    [
      packages.grok
      "grok"
      "sessions update"
    ]
    [
      packages.cursor-agent
      "agent"
      "mcp list update"
    ]
    [
      packages.kiro-cli
      "kiro-cli"
      "chat update"
    ]
    [
      packages.agent-browser
      "agent-browser"
      "open https://example.invalid/update"
    ]
    [
      packages.claude-code
      "claude"
      "plugin install nonexistent-plugin"
    ]
    [
      packages.claude-code
      "claude"
      "mcp get update"
    ]
    [
      packages.opencode
      "opencode"
      "run update"
    ]
    [
      packages.pi
      "pi"
      "update --extensions"
    ]
    [
      packages.pi
      "pi"
      "update --extension self"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon stop"
    ]
    # The rest of `t3 service` acts on upstream's service, if there is one.
    [
      packages.t3
      "t3"
      "service status"
    ]
    [
      packages.t3
      "t3"
      "service uninstall"
    ]
    # An option's value is never the subcommand.
    [
      packages.t3
      "t3"
      "--base-dir update service status"
    ]
    # codex's daemon commands that don't install anything.
    [
      packages.codex
      "codex"
      "app-server daemon version"
    ]
    # A hidden command's own words, the version, help below the daemon.
    [
      packages.codex
      "codex"
      "execpolicy check --rules r.rules apt update"
    ]
    [
      packages.codex
      "codex"
      "tcp-tunnel update"
    ]
    [
      packages.codex
      "codex"
      "git-credential update"
    ]
    [
      packages.codex
      "codex"
      "-V update"
    ]
    [
      packages.codex
      "codex"
      "-i a.png - update"
    ]
    [
      packages.codex
      "codex"
      "app-server daemon help update"
    ]
    [
      packages.codex
      "codex"
      "remote-control help start"
    ]
    # pi reads a command only from its first argument: these are prompts.
    [
      packages.pi
      "pi"
      "--offline update"
    ]
    [
      packages.pi
      "pi"
      "--verbose update"
    ]
    [
      packages.pi
      "pi"
      "--verbose update --self"
    ]
    [
      packages.pi
      "pi"
      "-p update"
    ]
    # Words that only look like a refused codex command: an option's value,
    # a prompt after another command, images, help, a prompt after `--`.
    [
      packages.codex
      "codex"
      "-- update"
    ]
    [
      packages.codex
      "codex"
      "exec --output-last-message remote-control start"
    ]
    [
      packages.codex
      "codex"
      "exec --output-schema app-server --output-last-message daemon update"
    ]
    [
      packages.codex
      "codex"
      "app-server --cloud-skills-snapshot daemon generate-json-schema --out start"
    ]
    [
      packages.codex
      "codex"
      "-i a.png update"
    ]
    [
      packages.codex
      "codex"
      "help update"
    ]
    # T3 Connect's own subcommands (sign-in, link) and any help.
    [
      packages.t3
      "t3"
      "connect status"
    ]
    [
      packages.t3
      "t3"
      "connect --headless true status"
    ]
    [
      packages.t3
      "t3"
      "connect --base-dir /x link --help"
    ]
    # The guard turned off.
    [
      (packages.t3.override { allowUpstreamService = true; })
      "t3"
      "update"
    ]
  ];
  # Every refused command with `--help` or `-h` right after it: passed,
  # and it prints its help, or for agy's `-h` a usage error (not just an
  # absent refusal, since an update that ran would only fail here for want
  # of a network). codex's and t3's guards take help anywhere; a few forms.
  helpOnly =
    presentRows [
      [
        packages.grok
        "grok"
        "update -hh"
      ]
      [
        packages.grok
        "grok"
        "update -hV"
      ]
      [
        packages.antigravity
        "agy"
        "update -help"
      ]
      [
        packages.antigravity
        "agy"
        "install -help"
      ]
      [
        packages.claude-code
        "claude"
        "--model x update --help"
      ]
      [
        packages.opencode
        "opencode"
        "--log-level debug upgrade --help"
      ]
      [
        packages.codex
        "codex"
        "update --help"
      ]
      [
        packages.codex
        "codex"
        "update -h"
      ]
      [
        packages.codex
        "codex"
        "app-server daemon update --help"
      ]
      [
        packages.codex
        "codex"
        "app-server daemon start -h"
      ]
      [
        packages.codex
        "codex"
        "app-server daemon pid-update-loop --help"
      ]
      [
        packages.codex
        "codex"
        "remote-control start --help"
      ]
      [
        packages.codex
        "codex"
        "-c x=y app-server daemon -h bootstrap"
      ]
      [
        packages.codex
        "codex"
        "app-server daemon -hc x version"
      ]
      [
        packages.codex
        "codex"
        "app-server daemon update -yh"
      ]
      [
        packages.t3
        "t3"
        "update --help"
      ]
      [
        packages.t3
        "t3"
        "update -h"
      ]
      [
        packages.t3
        "t3"
        "up --help"
      ]
      [
        packages.t3
        "t3"
        "service install -h"
      ]
      [
        packages.t3
        "t3"
        "connect -h"
      ]
      [
        (packages.t3-nightly or null)
        "t3"
        "update --help false"
      ]
    ]
    ++
      lib.concatMap
        (
          c:
          lib.concatMap (cmd: [
            [
              c.pkg
              c.bin
              "${cmd} --help"
            ]
            [
              c.pkg
              c.bin
              "${cmd} -h"
            ]
          ]) c.commands
        )
        (
          builtins.filter (c: c.pkg != null) (
            guardTables
            ++ [
              {
                pkg = packages.pi or null;
                bin = "pi";
                commands = [ "update" ];
              }
            ]
          )
        );
  # codex commands that run, not refused, and must install nothing in a fresh
  # home. Plain `codex remote-control` starts the daemon (an install into
  # ~/.codex/packages) unless its auto-start is off, as the wrapper sets. The
  # TUI's /daemon menu runs the vendor binary itself (libexec/codex/bin/codex),
  # so no guard sees it (openai/codex#41188); without a daemon package already
  # selected (the doctor warns about one) it installs nothing, and `says` shows
  # it took that path rather than failing offline.
  installsNothing = [
    { args = "remote-control"; }
    { args = "x remote-control"; }
    { args = "remote-control --json"; }
    {
      exe = "libexec/codex/bin/codex";
      args = "app-server daemon update";
      says = "requires a daemon package selected from its managed releases directory";
    }
    {
      exe = "libexec/codex/bin/codex";
      args = "app-server daemon update --from-cli --yes";
      says = "no daemon package is selected";
    }
  ];
  # Every option of `t3`, `t3 connect` and `t3 service` that takes a separate
  # value is one the guard skips, on the latest and nightly channels alike. In the help, an option's first column is
  # its names (`--a, -b`) and, if it takes one, its value's type (`string`,
  # `<a|b>`, whatever upstream prints): any word that isn't a name.
  # (`[=type]` is an optional value, taken only with `=`: no separate one.)
  # With `-v none=1`, the options that take no separate value instead.
  valueOptions = builtins.toFile "value-options.awk" ''
    /^  -/ { sub(/^  /, ""); split($0, col, /   */); n = split(col[1], w, " "); value = 0
      for (i = 1; i <= n; i++) if (w[i] !~ /^-/ && w[i] !~ /^\[=/) value = 1
      if (value != (none == 1)) for (i = 1; i <= n; i++) if (w[i] ~ /^-/) { sub(/,$/, "", w[i]); print w[i] } }
  '';
  # The commands a help lists, as upstream's help renders them: the rows
  # under SUBCOMMANDS and under each named group (`Name:`), whatever the name
  # looks like, and an alias after a comma, until EXAMPLES (the only heading
  # that follows them). Blank lines and other text at the margin (a
  # description's next lines) don't end it, so no row after them is missed;
  # an indented one, or one after a margin line ending in `:`, is read as a
  # command, which only adds a note. A long name may have only one space
  # before its description, so a row's words are split on spaces.
  subcommands = builtins.toFile "subcommands.awk" ''
    $0 == "SUBCOMMANDS" || /^[^ ].*:$/ { s = 1; next }
    $0 == "EXAMPLES" { s = 0; next }
    /^[^ ]/ || /^$/ { next }
    s && /^  [^ ]/ { sub(/^ +/, ""); split($0, w, / +/)
      if (w[1] ~ /,$/) { sub(/,$/, "", w[1]); print w[1]; print w[2] } else print w[1] }
  '';
  # The guard checks hold no release: what doesn't match lib/guard.nix
  # becomes a note, which the update run turns into a guard-review issue for
  # that package (scripts/ci/narrow.ts), while the release ships. Each such
  # check's output is a directory: `checked` lists the packages it compared
  # (one with no note closes its issue), `notes` holds `PACKAGE<TAB>text`
  # lines. Only a broken parser (its self-test) fails the check.
  notes = ''
    mkdir -p $out
    : > $out/checked
    : > $out/notes
    notes=$out/notes
    # note PACKAGE TEXT
    note() { printf '%s\t%s\n' "$1" "$2" >> "$notes"; }
  '';
  # Notes `what`, then the names, if ./have lists anything `list` lacks. What
  # only `list` has (a name one channel or an older release lacks) is just
  # printed.
  reviewed = pkg: what: list: ''
    sort -u -o have have
    printf '%s\n' ${lib.escapeShellArgs list} | sort -u > want
    [ -z "$(comm -13 want have)" ] || note ${lib.escapeShellArg pkg} ${lib.escapeShellArg what}" $(comm -13 want have | paste -sd ' ')"
    comm -23 want have | sed 's/^/(not listed by this t3: /; s/$/)/'
  '';
  # Notes `what` if an option in `list` (one the guard skips a value after)
  # takes no value in the help `file` (a boolean, or an optional `=value`):
  # the guard would skip the subcommand after it. Absent from it is fine
  # (upstream rejects an unknown option).
  takesValue = file: pkg: what: list: ''
    awk -v none=1 -f ${valueOptions} ${file} | sort -u > takes-none
    printf '%s\n' ${lib.escapeShellArgs list} | sort -u > skipped
    [ -z "$(comm -12 skipped takes-none)" ] || note ${lib.escapeShellArg pkg} ${lib.escapeShellArg what}" $(comm -12 skipped takes-none | paste -sd ' ')"
  '';
  # Every command a t3 lists, at any depth: `walk T3 REVIEWED` prints their
  # paths (`auth pairing create`). A help that fails fails the walk (its
  # subtree would go unseen), and it goes only into reviewed commands, so it
  # ends even when a help repeats its parent's (an unreviewed command is
  # the check anyway).
  walk = pkgs.writeShellScript "walk" ''
    set -eu
    t3=$1 reviewed=$2
    queue=("")
    while [ ''${#queue[@]} -gt 0 ]; do
      path=''${queue[0]}
      queue=("''${queue[@]:1}")
      help=$(timeout 30 "$t3" $path --help 2>&1) || { echo "\`t3 $path --help\` failed:" >&2; echo "$help" >&2; exit 1; }
      for sub in $(printf '%s\n' "$help" | awk -f ${subcommands}); do
        child="''${path:+$path }$sub"
        echo "$child"
        if grep -qxF -- "$child" "$reviewed"; then queue+=("$child"); fi
      done
    done
  '';
  # What a t3 lists that the guard depends on, against lib/guard.nix's lists.
  # A help that fails is noted too (nothing is compared then).
  guardMatches =
    { t3, pkg }:
    let
      bin = "${t3.passthru.unwrapped}/bin/t3";
    in
    ''
      echo ${pkg} >> $out/checked
      (
        export HOME=$(mktemp -d)
        # Options that take a value, of the root command and of `connect` and
        # `service` (they come before the subcommand the guard reads).
        : > help.txt
        for cmd in "" connect service; do timeout 30 ${bin} $cmd --help >> help.txt || { echo "\`t3 $cmd --help\` failed"; exit 1; }; done
        awk -f ${valueOptions} help.txt > have
        # An empty parse would note nothing: one option t3 has always had.
        grep -qx -- --log-level have || { echo "no --log-level among t3's value options: has the help's layout changed?"; exit 1; }
        ${reviewed pkg "options that take a value, missing from lib/guard.nix's t3ValueFlags:"
          guard.t3ValueFlags
        }
        ${takesValue "help.txt" pkg
          "lib/guard.nix's t3ValueFlags has options this t3 lists as taking no value; take them out:"
          guard.t3ValueFlags
        }
        # The words a boolean option takes as its value (upstream's completion
        # script lists them).
        timeout 30 ${bin} --completions powershell \
          | sed -n "s/^ *\$booleanLiterals = @(\(.*\))\$/\1/p" | tr -d "' " | tr , '\n' > have
        [ -s have ] || { echo "no \$booleanLiterals in t3's completion script"; exit 1; }
        ${reviewed pkg "boolean words missing from lib/guard.nix's t3BooleanWords:" guard.t3BooleanWords}
        # Every command, at any depth.
        printf '%s\n' ${lib.escapeShellArgs guard.t3Commands} > reviewed-commands
        ${walk} ${bin} reviewed-commands > have || exit 1
        grep -qx update have || { echo "the command walk found no \`update\`"; exit 1; }
        ${reviewed pkg (
          "commands lib/guard.nix's t3Commands hasn't reviewed. Read what each does in the"
          + " bundle; if it installs upstream's own t3 or service, refuse it in refuseT3 (a `connect` one:"
          + " list it in t3ConnectRefused); then add it to t3Commands:"
        ) guard.t3Commands}
      ) || note ${pkg} "couldn't read this t3's help (see the t3-guard-flags log), so the guard's lists weren't compared"
    '';
  t3-guard-flags = runCommand "t3-guard-flags" { } (
    notes
    +
      # The parsers themselves: an option of a type not seen yet, an alias and
      # a boolean; commands in a group, with odd or long names, an alias, a
      # description running on (a blank line, more text, capitals) and an
      # example that isn't one.
      ''
        printf '%s\n' 'USAGE' '  t3 <subcommand>' "" 'FLAGS' '  --x string  An option.' "" 'SUBCOMMANDS' \
          '  serve      Run it.' '  _x         Hidden-ish.' '  Boot, b    Odd case, alias.' \
          '  service-reinstall-all Does a thing.' '  multi      First paragraph.' "" 'Second paragraph.' \
          'WARNING' '  after      A row after it.' "" 'Maintenance:' '  bootstrap  Installs.' "" \
          'EXAMPLES' '  t3 up --lan' \
          | awk -f ${subcommands} | sort | tr '\n' ' ' > parsed
        [ "$(cat parsed)" = "Boot _x after b bootstrap multi serve service-reinstall-all " ] \
          || { echo "subcommands.awk: got $(cat parsed)"; exit 1; }
        printf '  --foo, -f number     new\n  --bar, -b            a boolean\n  --log-level <a|b>    old\n  --opt [=string]      optional\n' > options
        awk -f ${valueOptions} options | sort | tr '\n' ' ' > parsed
        [ "$(cat parsed)" = "--foo --log-level -f " ] || { echo "value-options.awk: got $(cat parsed)"; exit 1; }
        awk -v none=1 -f ${valueOptions} options | sort | tr '\n' ' ' > parsed
        [ "$(cat parsed)" = "--bar --opt -b " ] || { echo "value-options.awk (none): got $(cat parsed)"; exit 1; }
        notes=selftest; : > selftest
        ${takesValue "options" "x" "" [
          "--foo"
          "--log-level"
          "--gone"
        ]}
        [ ! -s selftest ] || { echo "takesValue: noted options that take one"; exit 1; }
        ${takesValue "options" "x" "" [
          "--foo"
          "--bar"
        ]}
        grep -qx 'x	 --bar' selftest || { echo "takesValue: missed --bar, a boolean"; exit 1; }
        : > selftest
        ${takesValue "options" "x" "" [ "--opt" ]}
        grep -qx 'x	 --opt' selftest || { echo "takesValue: missed --opt, an optional value"; exit 1; }
        printf '%s\n' a c > have
        ${reviewed "x" "new:" [
          "a"
          "b"
        ]}
        grep -qx 'x	new: c' selftest || { echo "reviewed: missed c"; exit 1; }
        notes=$out/notes
        # The walk, on a fake t3: one whose every help repeats the root's ends;
        # one whose `browser --help` fails fails it.
        printf '%s\n' update browser > reviewed
        printf '#!/bin/sh\nprintf "SUBCOMMANDS\\n  update   U.\\n  browser  B.\\n"\n' > loops && chmod +x loops
        timeout 10 ${walk} ./loops reviewed > walked || { echo "walk: didn't end on helps that repeat their parent's"; exit 1; }
        [ "$(sort walked | tr '\n' ' ')" = "browser browser browser browser update update update browser update update " ] \
          || { echo "walk: got $(sort walked | tr '\n' ' ')"; exit 1; }
        printf '#!/bin/sh\n[ "$1" = browser ] && exit 42\nprintf "SUBCOMMANDS\\n  browser  B.\\n"\n' > fails && chmod +x fails
        if ${walk} ./fails reviewed > walked 2>/dev/null; then echo "walk: a failing help passed"; exit 1; fi
      ''
    + lib.concatMapStrings guardMatches [
      {
        t3 = packages.t3;
        pkg = "t3";
      }
      {
        t3 = (packages.t3-nightly or null);
        pkg = "t3-nightly";
      }
    ]
  );
  # codex's help (clap's layout), for codex-guard-flags. Each option as
  # `KIND NAME`, one line per name: `value` (takes one separate value),
  # `multi` (`<FILE>...`: several, until the next option), `flag`, or
  # `other` (an optional `[<X>]`, several placeholders, or `--x=<X>`, which
  # refuseCodex doesn't know how to skip).
  clapOptions = builtins.toFile "clap-options.awk" ''
    /^  -[^ -]/ || /^      --/ { line = $0; sub(/^ +/, "", line); n = split(line, w, /,? +/)
      kind = "flag"; vals = 0
      for (i = 1; i <= n; i++) {
        if (w[i] ~ /^\[/ || w[i] ~ /^--?[^ ]*=/) kind = "other"
        else if (w[i] ~ /^</) { vals++; if (kind == "flag") kind = (w[i] ~ /\.\.\.$/) ? "multi" : "value" }
      }
      if (vals > 1) kind = "other"
      for (i = 1; i <= n; i++) if (w[i] ~ /^-/) { sub(/=.*/, "", w[i]); print kind, w[i] } }
  '';
  # The commands a clap help lists under `Commands:`, and their aliases
  # (`[aliases: e]`, which may sit on a description's next line).
  clapCommands = builtins.toFile "clap-commands.awk" ''
    $0 == "Commands:" { s = 1; next }
    /^[^ ]/ { s = 0 }
    s && /^  [^ ]/ { split(substr($0, 3), w, / +/); print w[1] }
    s && /\[aliases?: / { a = $0; sub(/.*\[aliases?: /, "", a); sub(/\].*/, "", a)
      n = split(a, x, /, */); for (i = 1; i <= n; i++) print x[i] }
  '';
  # lib/guard.nix's codex lists against codex's help, at the top level and
  # at codexLevels, noting what doesn't match (see `notes`):
  # - an option the help lists as taking a value that the guard doesn't
  #   skip (it could hide a command after it), or one the guard skips that
  #   takes none (it would skip a command); one refuseCodex can't skip at all
  # - several-value options and top-level commands that differ either way
  #   (a name the guard holds that codex dropped, a command now a prompt
  #   word, would let a command through)
  # - a command at codexAllowed's levels that is neither allowed nor a known
  #   installer (refused until reviewed), a command under `app-server` that
  #   isn't in codexAppServerCommands, or a level that takes arguments
  # - a hidden top-level command that is gone
  codex-guard-flags = runCommand "codex-guard-flags" { } (
    notes
    + ''
      # The parsers themselves, on a help in clap's layout.
      printf '%s\n' 'Usage: x [OPTIONS] <COMMAND>' "" 'Commands:' '  exec      Run. [aliases: e]' \
        '  apply     A long description' '            that runs on [aliases: a, ap]' '  help      Help.' "" \
        'Arguments:' '  [PROMPT]' '          A prompt' "" 'Options:' \
        '  -c, --config <key=value>' '          Text --not-an-option <X>' '      --enable <FEATURE>' \
        '  -i, --image <FILE>...' '      --oss' '      --opt [<X>]' '      --two <A> <B>' '      --eq=<X>' \
        '  -h, --help' '          Print help' > help
      awk -f ${clapCommands} help | sort | tr '\n' ' ' > parsed
      [ "$(cat parsed)" = "a ap apply e exec help " ] || { echo "clap-commands.awk: got $(cat parsed)"; exit 1; }
      awk -f ${clapOptions} help | sort | tr '\n' ',' > parsed
      want="flag --help,flag --oss,flag -h,multi --image,multi -i,other --eq,other --opt,other --two,value --config,value --enable,value -c,"
      [ "$(cat parsed)" = "$want" ] || { echo "clap-options.awk: got $(cat parsed)"; exit 1; }

      echo codex >> $out/checked
      export HOME=$(mktemp -d)
      codex=${packages.codex}/libexec/codex/bin/codex
      words() { paste -sd ' '; }
      differ() { # what, want, have
        if ! cmp -s "$2" "$3"; then
          note codex "$1 $( (comm -13 "$2" "$3" | sed 's/^/+/'; comm -23 "$2" "$3" | sed 's/^/-/') | words)"
        fi
      }
      (
        : > options
        for level in "" ${lib.escapeShellArgs guard.codexLevels}; do
          timeout 30 $codex $level --help > help 2>/dev/null || { echo "\`codex $level --help\` failed"; exit 1; }
          awk -f ${clapOptions} help >> options
          awk -f ${clapCommands} help | sort -u > "commands-$level"
          # refuseCodex reads every word below a level as its next command.
          if [ -n "$level" ] && grep -q '^Arguments:' help; then
            note codex "\`codex $level\` takes arguments; refuseCodex assumes it takes none"
          fi
        done
        grep -q '^value --listen$' options && grep -qx update commands- || { echo "codex's help didn't parse"; exit 1; }
        # refuseCodex reads a cluster of codexShortFlags reaching h or V as
        # help: every short flag, at these levels and on the installer
        # commands, must be one of them (else `-xh` would be refused, or a new
        # value option read as a flag).
        : > short
        for cmd in update ${
          lib.escapeShellArgs (
            lib.concatLists (
              lib.mapAttrsToList (level: cmds: map (c: "${level} ${c}") cmds) guard.codexInstallers
            )
          )
        }; do
          timeout 30 $codex $cmd --help 2>/dev/null | awk -f ${clapOptions} >> short || { echo "\`codex $cmd --help\` failed"; exit 1; }
        done
        cat options short | sed -n 's/^flag -\([^-]\)$/\1/p' | sort -u > have
        printf '%s\n' h V ${lib.escapeShellArgs guard.codexShortFlags} | sort -u > want
        [ -z "$(comm -13 want have)" ] \
          || note codex "short flags missing from lib/guard.nix's codexShortFlags (refuseCodex reads their clusters): $(comm -13 want have | words)"
        [ -z "$(cat options short | sed -n 's/^\(value\|multi\) -\([^-]\)$/\2/p' | sort -u | comm -12 - want)" ] \
          || note codex "lib/guard.nix's codexShortFlags has value options: $(cat options short | sed -n 's/^\(value\|multi\) -\([^-]\)$/\2/p' | sort -u | comm -12 - want | words)"
        [ -z "$(sed -n 's/^other //p' options)" ] \
          || note codex "options refuseCodex can't skip: $(sed -n 's/^other //p' options | sort -u | words)"
        printf '%s\n' ${lib.escapeShellArgs guard.codexValueOptions} | sort -u > want
        sed -n 's/^value //p' options | sort -u > have
        [ -z "$(comm -13 want have)" ] \
          || note codex "options that take a value, missing from lib/guard.nix's codexValueOptions: $(comm -13 want have | words)"
        sed -n 's/^flag //p' options | sort -u > flags
        [ -z "$(comm -12 want flags)" ] \
          || note codex "lib/guard.nix's codexValueOptions has options codex lists as taking no value: $(comm -12 want flags | words)"
        comm -23 want have | sed 's/^/(not listed by this codex: /; s/$/)/'
        printf '%s\n' ${lib.escapeShellArgs guard.codexMultiOptions} | sort -u > want
        sed -n 's/^multi //p' options | sort -u > have
        differ "several-value options differ from lib/guard.nix's codexMultiOptions:" want have
        printf '%s\n' ${lib.escapeShellArgs guard.codexCommands} | sort -u > want
        differ "commands differ from lib/guard.nix's codexCommands (read what a new one does first):" want commands-
        printf '%s\n' ${lib.escapeShellArgs guard.codexAppServerCommands} | sort -u > want
        differ "commands under \`codex app-server\` differ from lib/guard.nix's codexAppServerCommands (a new alias of daemon passes the guard):" want commands-app-server
        ${lib.concatStrings (
          lib.mapAttrsToList (level: allowed: ''
            printf '%s\n' ${lib.escapeShellArgs (allowed ++ guard.codexInstallers.${level})} | sort -u > want
            [ -z "$(comm -13 want ${lib.escapeShellArg "commands-${level}"})" ] \
              || note codex ${lib.escapeShellArg "commands under `codex ${level}`, refused until lib/guard.nix's codexAllowed or codexInstallers lists them:"}" $(comm -13 want ${lib.escapeShellArg "commands-${level}"} | words)"
          '') guard.codexAllowed
        )}
        for cmd in ${lib.escapeShellArgs guard.codexHiddenCommands}; do
          timeout 30 $codex "$cmd" --help 2>/dev/null | grep -q "^Usage: codex [a-z]" \
            || note codex "lib/guard.nix's codexHiddenCommands names \`$cmd\`, which this codex doesn't have"
        done
      ) || note codex "couldn't read this codex's help (see the codex-guard-flags log), so the guard's lists weren't compared"
    ''
  );
  # The top-level commands a provider's help lists, whatever library drew
  # it: the rows under `Commands:`, `COMMANDS`, `SUBCOMMANDS` or `Available
  # subcommands:` (two spaces in; blank lines and deeper-indented
  # descriptions don't end it, the next line at the margin does). A row's
  # first word is the command (after the program's own name, as pi prints
  # it), with aliases after `|` or `,`, or in clap's `[aliases: x]`.
  helpCommands = builtins.toFile "help-commands.awk" ''
    /^(Commands|COMMANDS|SUBCOMMANDS|Available subcommands):?$/ { s = 1; next }
    /^[^ ]/ { s = 0 }
    s && /^  [^ ]/ {
      n = split(substr($0, 3), w, / +/); i = 1
      if (w[1] == bin) i = 2
      while (i < n && w[i] ~ /,$/) { sub(/,$/, "", w[i]); print w[i]; i++ }
      if (w[i] !~ /^[<\[]/) { m = split(w[i], a, /\|/); for (j = 1; j <= m; j++) print a[j] }
    }
    s && /\[aliases?: / { a0 = $0; sub(/.*\[aliases?: /, "", a0); sub(/\].*/, "", a0)
      m = split(a0, x, /, */); for (j = 1; j <= m; j++) print x[j] }
  '';
  # Each provider's commands against lib/guard.nix's providerCommands: one a
  # release adds is noted (see `notes`), to be read for an installer.
  provider-commands =
    let
      # Each provider's program, and the commands its help must list (its
      # refused ones that the help shows, or for muse, which refuses
      # nothing, one it has always had): a help whose list was lost, wholly
      # or in part, says so instead of noting nothing.
      bins = {
        antigravity = [
          "agy"
          "update"
          "install"
        ];
        claude-code = [
          "claude"
          "update"
          "upgrade"
          "install"
        ];
        cursor-agent = [
          "cursor-agent"
          "update"
        ];
        fx = [
          "fx"
          "update"
          "upgrade"
        ];
        grok = [
          "grok"
          "update"
        ];
        kiro-cli = [
          "kiro-cli"
          "update"
        ];
        muse = [
          "muse"
          "exec"
        ];
        opencode = [
          "opencode"
          "upgrade"
          "update"
        ];
        pi = [
          "pi"
          "update"
        ];
      };
    in
    runCommand "provider-commands" { } (
      notes
      + ''
        # The parser on each layout: commander's `a|b` and wrapped
        # descriptions, an Effect-style `a, b`, pi's `prog cmd`, clap's
        # aliases, fx's blank lines, and the end at the next heading.
        printf '%s\n' 'Usage: prog [options]' "" 'Commands:' '  update|upgrade [options]   Update.' \
          '                             more text, not a command' '  upgrade, update    Effect.' \
          '  prog install <x>   pi style' '  du     Disk [aliases: disk-usage, d]' "" '  ask <prompt>   After a blank.' \
          '  <command> --help   Not a command' 'Options:' '  --flag   Not a command' > help
        awk -v bin=prog -f ${helpCommands} help | sort | tr '\n' ' ' > parsed
        [ "$(cat parsed)" = "ask d disk-usage du install update update upgrade upgrade " ] \
          || { echo "help-commands.awk: got $(cat parsed)"; exit 1; }
      ''
      + lib.concatStrings (
        lib.mapAttrsToList (
          pkg: cmds:
          let
            bin = lib.head bins.${pkg};
            anchors = lib.tail bins.${pkg};
          in
          ''
            echo ${pkg} >> $out/checked
            (
              export HOME=$(mktemp -d)
              cd $HOME
              # stdout, unless the help goes to stderr (agy's), so a warning
              # line can't end the list.
              timeout 30 ${packages.${pkg}}/bin/${bin} --help > help 2> err < /dev/null || true
              [ -s help ] || cp err help
              awk -v bin=${bin} -f ${helpCommands} help | sort -u > have
              for c in ${lib.escapeShellArgs anchors}; do
                grep -qx -- "$c" have || { echo "\`${bin} --help\` lists no $c: has its layout changed?"; cat help; exit 1; }
              done
              printf '%s\n' ${lib.escapeShellArgs cmds} | sort -u > want
              [ -z "$(comm -13 want have)" ] || note ${pkg} ${lib.escapeShellArg "commands lib/guard.nix's providerCommands hasn't reviewed (if one installs or updates ${bin}, refuse it in its package):"}" $(comm -13 want have | paste -sd ' ')"
              comm -23 want have | sed 's/^/(not listed by this ${bin}: /; s/$/)/'
            ) || note ${pkg} ${lib.escapeShellArg "couldn't read ${bin}'s commands (see the provider-commands log), so they weren't compared"}
          ''
        ) guard.providerCommands
      )
    );
  # The guards' --run snippets leave the program's environment as the user
  # had it: each runs in a subshell, so a variable the user exported under
  # a name a guard uses internally reaches the program unchanged. Each
  # guard wraps `env` here and is run with those names exported.
  guard-environment =
    let
      names = [
        "afteropt"
        "arg"
        "at"
        "c"
        "cmd"
        "dd"
        "dd2"
        "end"
        "fix"
        "help"
        "hit"
        "i"
        "last"
        "maybe"
        "multi"
        "n"
        "opt"
        "path"
        "pend"
        "prompt"
        "rest"
        "seen"
        "skip"
        "sub"
        "sub2"
        "target"
        "unsure"
        "value"
      ];
      guards = {
        t3 = guard.refuseT3;
        codex = guard.refuseCodex;
        pi = guard.refusePiSelfUpdate;
        agent-browser-doctor = guard.refuseAgentBrowserDoctorFix;
        # The simple form, without help forms.
        boat = guard.refuse {
          name = "boat";
          simple = true;
          commands = [ "update" ];
        };
      }
      // lib.mapAttrs (
        name: _:
        guard.refuse {
          inherit name;
          commands = [ "update" ];
        }
      ) guard.providerHelp;
    in
    runCommand "guard-environment" { nativeBuildInputs = [ pkgs.makeWrapper ]; } (
      lib.concatStrings (
        lib.mapAttrsToList (n: g: ''
          makeWrapper ${pkgs.writeShellScript "print-environment" "exec ${pkgs.coreutils}/bin/env"} w-${n} ${g}
          env ${lib.concatMapStringsSep " " (v: "${v}=mine") names} ./w-${n} --zz x -dx -p hello > out-${n}
          for v in ${toString names}; do
            grep -qx "$v=mine" out-${n} || { echo "${n}'s guard changed \$$v: $(grep "^$v=" out-${n} || echo unset)"; exit 1; }
          done
        '') guards
      )
      + "touch $out"
    );
  # T3 Connect's relay client is nixpkgs' cloudflared: every wrapper names it
  # in T3CODE_CLOUDFLARED_PATH (looked at before t3's own downloads and PATH)
  # and puts it on PATH, and it is at least the version t3 asks for (older,
  # and t3 would refuse it rather than use it).
  relay-client =
    runCommand "relay-client"
      {
        nativeBuildInputs = [
          pkgs.cloudflared
          pkgs.jq
        ];
      }
      (
        lib.concatMapStrings
          (pkg: ''
            for bin in ${pkg}/bin/*; do
              grep -q -- "T3CODE_CLOUDFLARED_PATH.*${pkgs.cloudflared}/bin/cloudflared" "$bin" \
                || { echo "$bin: T3CODE_CLOUDFLARED_PATH doesn't name nixpkgs' cloudflared"; exit 1; }
              grep -q -- '-cloudflared-[^/]*/bin' "$bin" || { echo "$bin: no cloudflared on its PATH"; exit 1; }
            done
          '')
          (present [
            packages.t3
            (packages.t3-nightly or null)
            packages.t3code
            packages.t3-free
          ])
        + ''
          have=$(cloudflared --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        ''
        +
          lib.concatMapStrings
            (pkg: ''
              min=$(grep -aoE 'CLOUDFLARED_MIN_VERSION = "[0-9.]+"' ${pkg.passthru.unwrapped}/libexec/t3/t3 | grep -oE '[0-9.]+' | head -1)
              [ -n "$min" ] || { echo "${pkg.name}: no CLOUDFLARED_MIN_VERSION in its bundle"; exit 1; }
              [ "$(printf '%s\n' "$min" "$have" | sort -V | head -1)" = "$min" ] \
                || { echo "${pkg.name}: cloudflared $have is older than t3's minimum, $min"; exit 1; }
              echo "${pkg.name}: cloudflared $have, t3 asks for $min or newer"
              # What t3 itself picks: nixpkgs' cloudflared when the variable is unset,
              # empty or blank (t3 takes those as unset), the user's when it names one.
              export HOME=$(mktemp -d)
              mkdir $HOME/mine && ln -s ${pkgs.cloudflared}/bin/cloudflared $HOME/mine/cloudflared
              for value in unset "" " " $HOME/mine/cloudflared; do
                if [ "$value" = unset ]; then unset T3CODE_CLOUDFLARED_PATH; else export T3CODE_CLOUDFLARED_PATH="$value"; fi
                want=${pkgs.cloudflared}/bin/cloudflared
                [ "$value" = $HOME/mine/cloudflared ] && want=$value
                got=$(${pkg}/bin/t3 connect status --json | jq -r '.relayClient | "\(.source) \(.executablePath)"')
                [ "$got" = "override $want" ] || { echo "${pkg.name}: T3CODE_CLOUDFLARED_PATH='$value': t3 picked $got"; exit 1; }
              done
              unset T3CODE_CLOUDFLARED_PATH
            '')
            (present [
              packages.t3
              (packages.t3-nightly or null)
            ])
        + "touch $out"
      );
  # Every .nix file is as `nix fmt` leaves it (run that to fix one). Branch
  # CI only (scripts/ci/test.ts BRANCH_ONLY): a nixpkgs bump with a newer
  # nixfmt never fails on it.
  nix-format =
    runCommand "nix-format"
      {
        nativeBuildInputs = [ pkgs.nixfmt ];
        src = lib.fileset.toSource {
          root = ../.;
          fileset = lib.fileset.fileFilter (f: f.hasExt "nix") ../.;
        };
      }
      ''
        find $src -name '*.nix' -print0 | xargs -0 nixfmt --check \
          || { echo "run \`nix fmt\` and commit the result"; exit 1; }
        touch $out
      '';
  # Background updaters off, as docs/acceptance-matrix.md lists them: each
  # wrapper sets its provider's switch, and each environment switch is still
  # one the program it runs mentions (a release that renamed it would bring
  # its updater back unnoticed). cursor's program is a launcher for its
  # bundled JavaScript, so its whole libexec is searched.
  updater-switches = runCommand "updater-switches" { } (
    let
      # A wrapper sets NAME to exactly VALUE (`--set`), or passes a flag on
      # its exec line (`--add-flags`), before the user's arguments.
      sets = pkg: bin: name: value: {
        inherit pkg bin name;
        line = "export ${name}='${value}'";
        whole = true;
        program = ''"${target pkg bin}"'';
      };
      # The same, for cursor (see above).
      setsJs =
        pkg: bin: name: value:
        sets pkg bin name value // { program = "-r ${pkg}/libexec"; };
      flag = pkg: bin: f: {
        inherit pkg bin;
        line = " ${f} ";
        whole = false;
      };
    in
    lib.concatMapStrings
      (
        c:
        ''
          grep ${lib.optionalString c.whole "-x"} -F -- ${lib.escapeShellArg c.line} ${c.pkg}/bin/${c.bin} \
            | grep -q ${if c.whole then "." else "'\"\\$@\" *$'"} \
            || { echo ${lib.escapeShellArg "${c.bin}: its wrapper lacks: ${c.line}"}; exit 1; }
        ''
        + lib.optionalString c.whole ''
          grep -aqF ${c.name} ${c.program} \
            || { echo "${c.bin}: its program no longer mentions ${c.name}, the switch its wrapper sets"; exit 1; }
        ''
      )
      [
        # codex reads no environment switch for its updater (codex-layout
        # checks it still knows these config keys).
        (flag packages.codex "codex" "-c features.daemon_auto_start=false")
        (flag packages.codex "codex" "-c check_for_update_on_startup=false")
        (sets packages.claude-code "claude" "DISABLE_AUTOUPDATER" "1")
        (sets packages.claude-code "claude" "DISABLE_INSTALLATION_CHECKS" "1")
        (sets packages.claude-code "claude" "DISABLE_UPDATES" "1")
        (setsJs packages.cursor-agent "cursor-agent" "AGENT_CLI_UPDATE_CHECK_URL"
          "http://127.0.0.1:9/cursor-agent-is-installed-by-nix"
        )
        (setsJs packages.cursor-agent "agent" "AGENT_CLI_UPDATE_CHECK_URL"
          "http://127.0.0.1:9/cursor-agent-is-installed-by-nix"
        )
        (sets packages.grok "grok" "GROK_DISABLE_AUTOUPDATER" "1")
        (sets packages.kiro-cli "kiro-cli" "KIRO_NO_AUTO_UPDATE" "1")
        (flag packages.cursor-agent "cursor-agent" "--disable-auto-update")
        (flag packages.cursor-agent "agent" "--disable-auto-update")
        (sets packages.opencode "opencode" "OPENCODE_DISABLE_AUTOUPDATE" "true")
        (sets packages.fx "fx" "FX_AUTO_UPGRADE" "0")
        (sets packages.boat "boat" "BOAT_NO_UPDATE" "1")
        (sets packages.antigravity "agy" "AGY_CLI_DISABLE_AUTO_UPDATE" "true")
      ]
    + "touch $out"
  );

  # What the static providers and agent tools and the whole-tree ones
  # install from their vendor's release is the vendor's, as shipped: a lone
  # static executable byte for byte; a whole tree (cursor, pi) with every
  # path present, the same execute bits, and every file byte for byte but
  # the dynamically linked ELF files autoPatchelf patches (and a script's
  # first line, whose shebang is patched). codex: codex-layout.
  as-shipped =
    let
      # The vendor's file FROM (or a path in the check) is OUT.
      file = n: from: out: ''
        [ -x ${out} ] || { echo "${n}: ${out} isn't executable"; exit 1; }
        cmp ${from} ${out} || { echo "${n}: ${out} isn't the vendor's, byte for byte"; exit 1; }
        echo "${n}: as shipped"
      '';
      # The archive's tree FROM (after unpacking) is OUT, by the shell tree().
      tree =
        n: from: out:
        "tree ${n} ${from} ${out}\n";
      unpack = n: "mkdir ${n} && tar -xzf ${packages.${n}.src} -C ${n}\n";
      each = {
        agent-browser = p: file "agent-browser" p.src (target p "agent-browser");
        boat = p: file "boat" p.src (target p "boat");
        cursor-agent =
          p:
          unpack "cursor-agent"
          + tree "cursor-agent" "cursor-agent/dist-package" "${p}/libexec/cursor-agent"
          # Its static helpers (rg, crepectl, and cursorsandbox on x86_64)
          # are still in the archive, so the comparison covered them.
          + ''
            n=$(find cursor-agent/dist-package -type f -exec file -b {} + | grep -cE 'ELF.*(statically|static-pie) linked' || true)
            [ "$n" -ge ${
              if stdenv.hostPlatform.isx86_64 then "3" else "2"
            } ] || { echo "cursor-agent: found only $n static helpers in its archive"; exit 1; }
          '';
        fx = p: unpack "fx" + file "fx" "fx/fx" (target p "fx");
        grok = p: file "grok" p.src (target p "grok");
        muse = p: file "muse" p.src "${p}/bin/muse";
        pi = p: unpack "pi" + tree "pi" "pi/pi" "${p}/libexec/pi";
      };
    in
    runCommand "as-shipped" { nativeBuildInputs = [ pkgs.file ]; } (
      ''
        tree() {
          local n=$1 a=$2 o=$3 k=0 f rel x y
          while IFS= read -r -d "" f; do
            rel=''${f#"$a"}
            [ -e "$o$rel" ] || [ -L "$o$rel" ] || { echo "$n: its archive's ''${rel#/} is missing"; exit 1; }
            [ -f "$f" ] && [ ! -L "$f" ] || continue
            if [ -x "$f" ]; then x=1; else x=; fi
            if [ -x "$o$rel" ]; then y=1; else y=; fi
            [ "$x" = "$y" ] || { echo "$n: ''${rel#/} is''${x:+ not} executable, unlike its archive's"; exit 1; }
            ! file -b "$f" | grep -q '^ELF.*dynamically linked' || continue
            if head -c 2 "$f" | tr -d '\0' | grep -q '^#!'; then
              cmp <(tail -n +2 "$f") <(tail -n +2 "$o$rel") || { echo "$n: ''${rel#/} differs from its archive's (beyond the shebang)"; exit 1; }
            else
              cmp "$f" "$o$rel" || { echo "$n: ''${rel#/} differs from its archive's"; exit 1; }
            fi
            k=$((k + 1))
          done < <(find "$a" -mindepth 1 -print0)
          [ "$k" -gt 0 ] || { echo "$n: nothing in its archive was compared"; exit 1; }
          echo "$n: its archive's tree as shipped ($k files byte for byte)"
        }
      ''
      + lib.concatStrings (
        lib.mapAttrsToList (n: f: lib.optionalString (packages ? ${n}) (f packages.${n})) each
      )
      + "touch $out"
    );

  # What the provider wrappers do beyond their updater switches
  # (updater-switches) and guards (update-guards), from their text and by
  # running them: the tools each puts first on PATH (this set's), the name
  # each program sees itself run as, claude's certificate-store default,
  # opencode's libstdc++ (its file watcher's add-on is loaded from inside
  # the binary, where patching can't reach), cursor's `agent` keeping its
  # name, and every install check being versions.installCheck (tested on a
  # fake program).
  provider-wrappers =
    let
      has = pkg: bin: line: ''
        grep -qxF -- ${lib.escapeShellArg line} ${pkg}/bin/${bin} \
          || { echo ${lib.escapeShellArg "${bin}: its wrapper lacks the line: ${line}"}; exit 1; }
      '';
      onPath =
        pkg: bin: tool:
        has pkg bin "PATH='${tool}/bin'$PATH";
      execAs = pkg: bin: name: ''
        grep -qE '^exec -a "?${name}"? ' ${pkg}/bin/${bin} \
          || { echo "${bin}: doesn't run the program as ${name}"; exit 1; }
      '';
      c = packages.claude-code or null;
      g = packages.grok or null;
      a = packages.antigravity or null;
      o = packages.opencode or null;
      u = packages.cursor-agent or null;
      m = packages.muse or null;
      # Every provider and agent tool, with exactly what its bin/ holds: the
      # checks below run on each (its bin/, meta, install check, and every
      # ELF file resolving). A new provider fails until it is added here.
      bins = {
        antigravity = [ "agy" ];
        claude-code = [ "claude" ];
        codex = [
          "codex"
          "codex-code-mode-host"
        ];
        cursor-agent = [
          "agent"
          "cursor-agent"
        ];
        fx = [ "fx" ];
        grok = [ "grok" ];
        kiro-cli = [ "kiro-cli" ];
        muse = [ "muse" ];
        opencode = [ "opencode" ];
        pi = [ "pi" ];
        # Agent tools
        agent-browser = [ "agent-browser" ];
        boat = [ "boat" ];
      };
      present' = lib.filterAttrs (n: _: packages ? ${n}) bins;
      providerNames = map lib.getName (
        builtins.attrValues (import ../pkgs/t3code/providers.nix packages)
      );
      unfree = import ../pkgs/unfree.nix;
      metaOk =
        n:
        let
          p = packages.${n};
        in
        usesInstallCheck n
        && lib.assertMsg (p.dontStrip or false
        ) "${n}: dontStrip must be true (stripping breaks its binaries or isn't wanted)"
        && lib.assertMsg (
          (p.meta.license.shortName == "unfree") == builtins.elem n unfree
        ) "${n}: its licence is unfree exactly when pkgs/unfree.nix lists it"
        && lib.assertMsg (
          p.meta.sourceProvenance == [ lib.sourceTypes.binaryNativeCode ]
        ) "${n}: sourceProvenance must be binaryNativeCode only"
        && lib.assertMsg (
          p.meta.platforms == builtins.attrNames (pinOf n).assets
        ) "${n}: meta.platforms must be its pin's systems"
        && lib.assertMsg (builtins.elem p.meta.mainProgram
          bins.${n}
        ) "${n}: meta.mainProgram must be one of its commands";
      # A package's install check is versions.installCheck, as given (one a
      # package overrode after it would fail here).
      usesInstallCheck =
        n:
        let
          p = packages.${n};
        in
        lib.assertMsg (p.doInstallCheck or false) "${n}: its install check (the version check) must run"
        && lib.assertMsg (builtins.any (d: lib.getName d == "version-check-hook") (
          p.drvAttrs.nativeBuildInputs or [ ]
        )) "${n}: its install check must use nixpkgs' versionCheckHook"
        && lib.assertMsg (
          (p.versionCheckProgramArg or null) == "--version"
        ) "${n}: its version check must run exactly --version"
        && lib.assertMsg (lib.hasPrefix versions.installCheckScript
          (p.postInstallCheck or "")
        ) "${n}: its install check must be versions.installCheck (which also requires --version to exit 0)";
      # The other packages with an install check use the same one.
      others = [
        "t3-unwrapped"
        "t3-unwrapped-nightly"
      ];
      # versions.installCheck itself, on a program that prints the version
      # and exits with `status`.
      fakeVersion =
        status:
        stdenv.mkDerivation (
          versions.installCheck { }
          // {
            pname = "fake-version";
            version = "1.2.3";
            dontUnpack = true;
            installPhase = ''
              mkdir -p $out/bin
              printf '#!${stdenv.shell}\necho fake 1.2.3\nexit ${toString status}\n' > $out/bin/fake
              chmod +x $out/bin/fake
            '';
            meta.mainProgram = "fake";
          }
        );
    in
    assert lib.assertMsg (builtins.all (n: bins ? ${n})
      providerNames
    ) "provider-wrappers: every provider in pkgs/t3code/providers.nix needs an entry in bins";
    assert builtins.all metaOk (builtins.attrNames present');
    # (A set without nightly packages, the stable set, lacks one of these.)
    assert builtins.all usesInstallCheck (builtins.filter (n: packages ? ${n}) others);
    runCommand "provider-wrappers"
      {
        nativeBuildInputs = [
          pkgs.patchelf
          pkgs.file
        ];
      }
      (
        # A command that prints the version but fails fails the build; one
        # that exits 0 passes.
        ''
          grep -q 'fake --version exited with status 1' ${pkgs.testers.testBuildFailure (fakeVersion 1)}/testBuildFailure.log \
            || { echo "versions.installCheck let a failing --version pass"; exit 1; }
          [ -x ${fakeVersion 0}/bin/fake ]
        ''
        + lib.concatStrings (
          lib.mapAttrsToList (n: want: ''
            [ "$(ls -A ${packages.${n}}/bin | sort | paste -sd ' ')" = ${lib.escapeShellArg (toString want)} ] \
              || { echo "${n}: bin holds $(ls -A ${packages.${n}}/bin | paste -sd ' '), not ${toString want}"; exit 1; }
          '') present'
        )
        + lib.optionalString (c != null) (
          onPath c "claude" pkgs.bubblewrap
          + onPath c "claude" pkgs.socat
          + has c "claude" "export CLAUDE_CODE_CERT_STORE=\${CLAUDE_CODE_CERT_STORE-'system'}"
          + execAs c "claude" "claude"
          # The second line behind the guard: with the wrapper's settings, claude
          # itself refuses its update commands and installs nothing.
          + ''
            (
              eval "$(grep -E "^export [A-Z_]+='[^']*'$" ${c}/bin/claude)"
              h=$(mktemp -d)
              out=$(cd $h && HOME=$h timeout 60 ${target c "claude"} update 2>&1 < /dev/null || true)
              case "$out" in *"Updates are disabled"*) ;; *) echo "claude: with its wrapper's settings, update isn't refused by claude itself: $out"; exit 1 ;; esac
              [ ! -e $h/.local ] || { echo "claude: update wrote ~/.local"; exit 1; }
            )
            # The doctor's question about claude's machine policy, against
            # the real claude: its doctor says this exactly when
            # DISABLE_UPDATES is set.
            (
              h=$(mktemp -d)
              out=$(cd $h && timeout 60 env -i HOME=$h DISABLE_UPDATES=1 ${target c "claude"} doctor 2>&1 < /dev/null || true)
              case "$out" in *"Auto-updates: disabled (set by env: DISABLE_UPDATES)"*) ;; *) echo "claude: its doctor no longer says 'Auto-updates: disabled (set by env: DISABLE_UPDATES)', which the t3code-nix doctor reads: $out"; exit 1 ;; esac
            )
          ''
        )
        # The real t3code-nix doctor, with no machine policy here but the
        # switch in the caller's environment and settings, must still warn:
        # it asks claude without them.
        + lib.optionalString (c != null && packages ? doctor) ''
          (
            h=$(mktemp -d)
            mkdir -p $h/.claude
            echo '{"env":{"DISABLE_UPDATES":"1"}}' > $h/.claude/settings.json
            out=$(cd $h && HOME=$h DISABLE_UPDATES=1 timeout 120 ${packages.doctor}/bin/t3code-nix-doctor 2>&1 < /dev/null || true)
            case "$out" in *"WARN     claude-code: no machine policy turns its updates off"*) ;; *) echo "doctor: with no machine policy it didn't warn about claude's (the caller's DISABLE_UPDATES and settings must not count):"; echo "$out" | grep -i claude; exit 1 ;; esac
          )
        ''
        + lib.optionalString (g != null) (execAs g "grok" "grok")
        # Every dynamically linked ELF file in these outputs, as built:
        # this set's loader (when it names one) and every needed library
        # found; cursor's Linux add-ons also load in its bundled node.
        + lib.concatMapStrings (n: ''
          while IFS= read -r -d "" f; do
            file -b "$f" | grep -q '^ELF.*dynamically linked' || continue
            case "$(file -b "$f")" in *"${
              if stdenv.hostPlatform.isx86_64 then "x86-64" else "aarch64"
            }"*) ;; *) continue ;; esac
            if [ -e "$(dirname "$f")/.$(basename "$f").wrapbuddy" ]; then
              # wrap-buddy (pkgs/opencode/wrap-buddy.nix) turns the loader
              # header off, leaving the vendor's path in the file, and loads
              # this set's at start: ask the started program what it loaded.
              [ -x "$f" ] || { echo "${n}: ''${f#${packages.${n}}/} is patched by wrap-buddy but can't run"; exit 1; }
              libs=$(timeout -k 5 60 env LD_TRACE_LOADED_OBJECTS=1 "$f" 2>&1) \
                || { echo "${n}: ''${f#${packages.${n}}/} didn't start to list its libraries:"; echo "$libs"; exit 1; }
              case "$libs" in *"${stdenv.cc.bintools.dynamicLinker} "*) ;; *)
                echo "${n}: ''${f#${packages.${n}}/} doesn't start with this set's loader:"; echo "$libs"; exit 1 ;; esac
            else
              i=$(patchelf --print-interpreter "$f" 2>/dev/null || true)
              [ -z "$i" ] || [ "$i" = ${stdenv.cc.bintools.dynamicLinker} ] \
                || { echo "${n}: ''${f#${packages.${n}}/} asks for loader $i"; exit 1; }
              libs=$(${lib.getBin stdenv.cc.libc}/bin/ldd "$f" 2>&1 || true)
            fi
            case "$libs" in *"not found"*) echo "${n}: ''${f#${packages.${n}}/} has unresolved libraries:"; echo "$libs" | grep "not found"; exit 1 ;; esac
          done < <(find ${packages.${n}}/ -type f -print0)
        '') (builtins.attrNames present')
        + lib.optionalString (u != null) ''
          (
            export HOME=$(mktemp -d)
            cd $HOME
            for a in $(find ${u}/libexec/cursor-agent -name '*.node' -path '*linux*' -o -name '*.node' ! -path '*/prebuilds/*' | sort -u); do
              case "$(file -b "$a")" in *"${
                if stdenv.hostPlatform.isx86_64 then "x86-64" else "aarch64"
              }"*) ;; *) continue ;; esac
              ${u}/libexec/cursor-agent/node -e 'require(process.argv[1])' "$a" \
                || { echo "cursor-agent: ''${a#${u}/} doesn't load in its node"; exit 1; }
            done
          )
        ''
        # Both cursor commands put nixpkgs' coreutils on PATH.
        + lib.optionalString (u != null) (
          onPath u "cursor-agent" pkgs.coreutils + onPath u "agent" pkgs.coreutils
        )
        # Each start of cursor writes its opt-out marker for the "Grok agent
        # host" switch when missing (cursor's config folder: CURSOR_CONFIG_DIR,
        # XDG_CONFIG_HOME/cursor, ~/.cursor), keeps an existing one, and
        # starts anyway when it can't write.
        + lib.optionalString (u != null) ''
          (
            # marks BIN MARKERS WHAT [NAME=VALUE...]: BIN started in a fresh
            # home $h (working folder $h/w) with that environment (@ stands
            # for $h) leaves a marker in each folder MARKERS names under $h.
            marks() {
              local b=$1 m=$2 what=$3
              shift 3
              h=$(mktemp -d)
              mkdir $h/w
              (cd $h/w && env HOME=$h "''${@//@/$h}" timeout 60 ${u}/bin/$b --version > /dev/null 2>&1 < /dev/null || true)
              for x in $m; do
                [ -e "$h/$x/grok-switch-opt-out.json" ] || { echo "cursor-agent: $what: $x has no marker"; exit 1; }
              done
            }
            for b in agent cursor-agent; do
              marks $b .cursor "$b with only HOME"
              grep -q '"schema":1' $h/.cursor/grok-switch-opt-out.json \
                || { echo "cursor-agent: $b's marker isn't in cursor's format"; exit 1; }
            done
            marks cursor-agent c "CURSOR_CONFIG_DIR" CURSOR_CONFIG_DIR=@/c
            marks cursor-agent x/cursor "XDG_CONFIG_HOME" XDG_CONFIG_HOME=@/x
            marks cursor-agent "c x/cursor .cursor" "all three set" CURSOR_CONFIG_DIR=@/c XDG_CONFIG_HOME=@/x
            # Every folder cursor could use is marked, with no attempt to
            # repeat its trim(): a value cursor ignores (a lone U+00A0)
            # still leaves ~/.cursor, which cursor then uses, marked; a
            # relative name is marked as given, in the working folder, and
            # an empty HOME means .cursor there.
            marks agent .cursor "a Unicode-space CURSOR_CONFIG_DIR" CURSOR_CONFIG_DIR=$'\302\240'
            marks cursor-agent .cursor "a Unicode-space XDG_CONFIG_HOME" XDG_CONFIG_HOME=$'\302\240'
            marks agent w/$'\351\205\215\347\275\256' "a relative non-ASCII CURSOR_CONFIG_DIR" CURSOR_CONFIG_DIR=$'\351\205\215\347\275\256'
            marks cursor-agent w/rel-dir "a relative CURSOR_CONFIG_DIR" CURSOR_CONFIG_DIR=rel-dir
            marks cursor-agent w/.cursor "an empty HOME" HOME=
            # A folder that can't be written skips none of the others.
            h=$(mktemp -d)
            mkdir $h/ro && chmod 555 $h/ro
            HOME=$h CURSOR_CONFIG_DIR=$h/ro/c XDG_CONFIG_HOME=$h/x timeout 60 ${u}/bin/cursor-agent --version > /dev/null 2>&1 < /dev/null || true
            for m in x/cursor .cursor; do
              [ -e $h/$m/grok-switch-opt-out.json ] || { echo "cursor-agent: an unwritable CURSOR_CONFIG_DIR left $m without a marker"; exit 1; }
            done
            # An existing marker is kept; a read-only home doesn't stop cursor.
            h=$(mktemp -d)
            mkdir -p $h/.cursor && echo keep > $h/.cursor/grok-switch-opt-out.json
            HOME=$h timeout 60 ${u}/bin/cursor-agent --version > /dev/null 2>&1 < /dev/null || true
            [ "$(cat $h/.cursor/grok-switch-opt-out.json)" = keep ] || { echo "cursor-agent: an existing marker was changed"; exit 1; }
            h=$(mktemp -d)
            chmod 555 $h
            HOME=$h timeout 60 ${u}/bin/cursor-agent --version 2>&1 < /dev/null | grep -qF ${lib.escapeShellArg u.version} \
              || { echo "cursor-agent: with a read-only home it didn't start"; exit 1; }
          )
        ''
        # With the wrapper's settings, cursor's own `update` command fails at
        # its update check (exiting non-zero, not by the time limit) and
        # installs nothing: older releases can't fetch from the closed port;
        # newer ones refuse the URL (it must be https on cursor.com or
        # downloads.cursor.com) before fetching, and that refusal must be the
        # last thing they print (a warning followed by a try elsewhere would
        # fail offline here too, and mustn't pass). The menu's /update shares
        # that check (read in cursor's code; no test drives the TUI).
        + lib.optionalString (u != null) ''
          (
            eval "$(grep -E "^export [A-Z_]+='[^']*'$" ${u}/bin/cursor-agent)"
            export PATH=${pkgs.coreutils}/bin
            h=$(mktemp -d)
            status=0
            out=$(cd $h && HOME=$h timeout 60 ${u}/libexec/cursor-agent/cursor-agent update 2>&1 < /dev/null) || status=$?
            [ $status != 0 ] && [ $status != 124 ] || { echo "cursor-agent: its update command exited $status (0: it didn't fail; 124: it hung): $out"; exit 1; }
            last=''${out##*$'\n'}
            case "$out" in
              *"Failed to fetch update info from http://127.0.0.1:9/"*) ;;
              *) [ "$last" = "Error: Update failed: Refusing the update check URL: it has to be an https URL." ] \
                   || { echo "cursor-agent: with its wrapper's settings, its updater didn't stop at the update check: $out"; exit 1; } ;;
            esac
            [ ! -e $h/.local ] || { echo "cursor-agent: update wrote ~/.local"; exit 1; }
          )
        ''
        + lib.optionalString (a != null) (
          execAs a "agy" "agy"
          + ''
            export HOME=$(mktemp -d)
            (cd $HOME && ${a}/bin/agy --help 2>&1 || true) | grep -q '^Usage of agy:' \
              || { echo "agy: its help doesn't call it agy"; exit 1; }
          ''
        )
        + lib.optionalString (o != null) (
          onPath o "opencode" pkgs.fzf
          + onPath o "opencode" pkgs.ripgrep
          + ''
            t=${target o "opencode"}
            # wrap-buddy adds libstdc++ when it starts, not in the headers:
            # ask the started program.
            libs=$(timeout -k 5 60 env LD_TRACE_LOADED_OBJECTS=1 "$t" 2>&1) \
              || { echo "opencode: $t didn't start to list its libraries:"; echo "$libs"; exit 1; }
            case "$libs" in *"libstdc++.so.6 => /nix/store/"*) ;; *)
              echo "opencode: $t doesn't load libstdc++ from the store (its file watcher needs it):"; echo "$libs"; exit 1 ;; esac
          ''
        )
        + lib.optionalString (u != null) ''
          for b in agent cursor-agent; do
            t=${target u "$b"}
            [ "$(basename "$t")" = $b ] || { echo "$b: runs the launcher as $(basename "$t"), so it names itself that"; exit 1; }
            [ "$(readlink -f "$t")" = "$(readlink -f ${u}/libexec/cursor-agent/cursor-agent)" ] \
              || { echo "$b: doesn't run cursor's launcher"; exit 1; }
          done
        ''
        + "touch $out"
      );

  # Every provider and agent tool installs its pin's licence files
  # (versions.installLicenses), byte for byte, in share/licenses/<pin name>
  # (a package may add more from its archive, as fx does).
  # A package whose pin lists none today is also built with a sample entry
  # added to its pin, so a release that starts shipping one gets it.
  licences =
    let
      names = builtins.filter (n: packages ? ${n}) [
        "agent-browser"
        "antigravity"
        "boat"
        "claude-code"
        "codex"
        "cursor-agent"
        "fx"
        "grok"
        "kiro-cli"
        "muse"
        "opencode"
        "pi"
      ];
      base = versions;
      sample = (pinOf "opencode").licenses;
      withSample = base // {
        load = n: base.load n // { licenses = sample; };
      };
      expect =
        pkg: pin:
        lib.concatStrings (
          lib.mapAttrsToList (
            path: l:
            let
              file = fetchurl {
                inherit (l) url hash;
                name = "${pin.name}-${pin.version}-${baseNameOf path}";
              };
            in
            ''
              cmp ${file} ${pkg}/share/licenses/${pin.name}/${baseNameOf path} \
                || { echo "${pkg.name}: share/licenses/${pin.name}/${baseNameOf path} isn't the pin's licence"; exit 1; }
            ''
          ) (pin.licenses or { })
        )
        + ''
          echo "${pkg.name}: ${
            toString (builtins.length (builtins.attrNames (pin.licenses or { })))
          } pinned licence file(s) installed"
        '';
    in
    runCommand "licences" { } (
      lib.concatMapStrings (n: expect packages.${n} (pinOf n)) names
      + lib.concatMapStrings (
        n: expect (packages.${n}.override { versions = withSample; }) (pinOf n // { licenses = sample; })
      ) (builtins.filter (n: (pinOf n).licenses or { } == { }) names)
      + "touch $out"
    );

  # codex's package (pkgs/codex/package.nix) against the vendor's archive;
  # also the wrapper's PATH, the config keys codex must still know and its
  # two licence files by name. Each rule's fail message says what it checks.
  codex-layout =
    runCommand "codex-layout"
      {
        nativeBuildInputs = [
          pkgs.zstd
          pkgs.patchelf
          pkgs.glibc.bin
        ];
        bwrapLine = "PATH='${lib.getBin pkgs.bubblewrap}/bin'$PATH";
      }
      ''
        fail() { echo "codex-layout: $*"; exit 1; }
        pkg=${packages.codex}
        tree=$pkg/libexec/codex
        mkdir vendor && tar --zstd -xf ${packages.codex.src} -C vendor
        diff <(cd vendor && find . | sort) <(cd $tree && find . | sort) \
          || fail "libexec/codex doesn't hold the archive's paths (- archive, + package)"
        # The same files executable as in the archive (rg is a link to nixpkgs').
        diff <(cd vendor && find . -type f -perm /111 ! -path ./codex-path/rg | sort) \
          <(cd $tree && find . -type f -perm /111 | sort) \
          || fail "libexec/codex's executable files differ from the archive's (- archive, + package)"
        isElf() { [ "$(head -c 4 "$1" | od -An -c | tr -d ' ')" = '177ELF' ]; }
        loader=$(cat ${stdenv.cc}/nix-support/dynamic-linker)
        elves=0
        # Every archive path but rg: links keep their target; the voice
        # runtime's ELF files are patched (this set's loader, the same
        # libraries needed, every one found); everything else is byte for
        # byte, and no other ELF file asks for a loader (a vendor binary
        # turning dynamic would fail on NixOS).
        while IFS= read -r -d "" f; do
          v=vendor/$f p=$tree/$f
          if [ -L "$v" ]; then
            [ "$(readlink "$v")" = "$(readlink "$p")" ] || fail "$f: link target changed"
          elif [[ "$f" == ./codex-resources/voice/* ]] && isElf "$v"; then
            elves=$((elves + 1))
            [ "$(patchelf --print-needed "$v")" = "$(patchelf --print-needed "$p")" ] \
              || fail "$f needs other libraries than the archive's"
            if interp=$(patchelf --print-interpreter "$p" 2>/dev/null); then
              [ "$interp" = "$loader" ] || fail "$f: interpreter $interp, not $loader"
            fi
            libs=$(ldd "$p" 2>&1) || fail "$f: ldd failed: $libs"
            case "$libs" in *"not found"*) fail "$f: $(grep 'not found' <<< "$libs")" ;; esac
          else
            cmp -s "$v" "$p" || fail "$f differs from the archive"
            if isElf "$p" && interp=$(patchelf --print-interpreter "$p" 2>/dev/null); then
              fail "$f asks for the loader $interp: only the voice runtime is patched"
            fi
          fi
        done < <(cd vendor && find . \( -type f -o -type l \) ! -path ./codex-path/rg -print0)
        [ "$elves" -gt 0 ] || fail "no ELF files under codex-resources/voice"

        rg=$(readlink -f $tree/codex-path/rg)
        [ "$rg" = "$(readlink -f ${lib.getExe pkgs.ripgrep})" ] \
          || fail "codex-path/rg is $rg, not ${lib.getExe pkgs.ripgrep}"

        grep -qxF -- "$bwrapLine" $pkg/bin/codex || fail "bin/codex doesn't put $bwrapLine first"
        # codex never reads it, and every process codex starts would inherit it.
        ! grep -q DISABLE_AUTOUPDATER $pkg/bin/codex || fail "bin/codex sets DISABLE_AUTOUPDATER"
        for key in daemon_auto_start check_for_update_on_startup; do
          grep -aqF $key $tree/bin/codex || fail "libexec/codex/bin/codex no longer knows the config key $key"
        done
        # licences compares only what the pin lists: these two must stay in it.
        for f in share/licenses/codex/LICENSE share/licenses/codex/NOTICE; do
          [ -s $pkg/$f ] || fail "$f is missing or empty"
        done
        # Its completions and bin/ listing: completions and provider-wrappers.
        [ "$(readlink -f $pkg/bin/codex-code-mode-host)" = "$tree/bin/codex-code-mode-host" ] \
          || fail "bin/codex-code-mode-host isn't libexec/codex/bin/codex-code-mode-host"
        # Also catches the archive dropping one, which the diffs above can't see.
        for f in bin/codex bin/codex-code-mode-host libexec/codex/bin/codex-exec-server; do
          [ -x $pkg/$f ] || fail "$f isn't executable"
        done
        echo "codex-layout: archive tree intact, rg from nixpkgs, $elves voice ELF files resolve"
        touch $out
      '';

  update-guards =
    let
      # EXE ARGS run in a fresh home ($home), the output in $home.out, the
      # exit status in $status. A refusal is immediate; a command that runs
      # instead (a session, a server) is stopped after 20 s, not waited for.
      run = exe: args: ''
        home=$(mktemp -d)
        status=0
        (cd $home && HOME=$home timeout 20 ${exe} ${args} </dev/null >$home.out 2>&1) || status=$?
      '';
      refusedText = "grep -q 'is installed by Nix (t3code-nix)' $home.out";
      # One script per [ pkg bin args ] row.
      rows =
        f: lib.concatMapStrings (c: f (builtins.elemAt c 0) (builtins.elemAt c 1) (builtins.elemAt c 2));
    in
    runCommand "update-guards" { } (
      rows (
        pkg: bin: args:
        run "${pkg}/bin/${bin}" args
        + ''
          [ "$status" != 0 ] && [ "$status" != 124 ] || { echo "${bin} ${args}: ran instead of being refused"; exit 1; }
          ${refusedText} || { echo "${bin} ${args}: no refusal message"; cat $home.out; exit 1; }
          [ -z "$(ls -A $home)" ] || { echo "${bin} ${args}: wrote files"; ls -A $home; exit 1; }
          echo "refused: ${bin} ${args}"
        ''
      ) refused
      + rows (
        pkg: bin: args:
        run "${pkg}/bin/${bin}" args
        + ''
          if ${refusedText}; then echo "${bin} ${args}: refused, but it isn't an update"; exit 1; fi
          echo "allowed: ${bin} ${args}"
        ''
      ) allowed
      + rows (
        pkg: bin: args:
        run "${pkg}/bin/${bin}" args
        + ''
          if ${refusedText}; then echo "${bin} ${args}: refused, but it only prints help"; exit 1; fi
          grep -qiE '^ *usage|^USAGE|^DESCRIPTION' $home.out || { echo "${bin} ${args}: printed no help"; cat $home.out; exit 1; }
          echo "help: ${bin} ${args}"
        ''
      ) helpOnly
      + lib.concatMapStrings (
        {
          exe ? "bin/codex",
          args,
          says ? null,
        }:
        run "${packages.codex}/${exe}" args
        + ''
          if ${refusedText}; then echo "${exe} ${args}: refused"; exit 1; fi
          ${lib.optionalString (says != null) ''
            grep -qF ${lib.escapeShellArg says} $home.out \
              || { echo "${exe} ${args}: expected: ${says}"; cat $home.out; exit 1; }
          ''}
          [ ! -e $home/.codex/packages ] || { echo "${exe} ${args}: installed a package"; find $home/.codex/packages | head; exit 1; }
          echo "installs nothing: ${exe} ${args}"
        ''
      ) installsNothing
      + "touch $out"
    );
  # The TypeScript sources as Node runs them (no build step).
  sources = runCommand "t3code-nix-sources" { } ''
    mkdir -p $out
    cp -r ${../shared} $out/shared
    cp -r ${../scripts} $out/scripts
    cp -r ${../tests} $out/tests
    cp -r ${../watcher} $out/watcher
    cp -r ${../ci} $out/ci
    mkdir $out/pkgs && cp ${../pkgs/unfree.nix} $out/pkgs/unfree.nix
    # The status page's package list is checked against these, and the
    # workflows' and actions' wiring that tests read.
    cp ${../README.md} $out/README.md
    # Not the snapshot: only the stable checks read it, so moving it changes
    # no other check (the equivalence step relies on that).
    cp -r ${
      builtins.path {
        name = "versions";
        path = ../versions;
        filter = path: _: baseNameOf path != "stable";
      }
    } $out/versions
    mkdir $out/.github && cp -r ${../.github/workflows} $out/.github/workflows
    cp -r ${../.github/actions} $out/.github/actions
    cp ${../.github/zizmor.yml} $out/.github/zizmor.yml
    cp ${../.github/actionlint.yaml} $out/.github/actionlint.yaml
    cp ${../.github/dependabot.yml} $out/.github/dependabot.yml
    # test.ts's branch-only check names are checked against it.
    mkdir $out/lib && cp ${./checks.nix} $out/lib/checks.nix
    cp ${../package.json} $out/package.json
    cp ${../tsconfig.json} $out/tsconfig.json
  '';

  # The channel rules, the updater and the workflow's job scripts, against
  # recorded and faked responses and real git repositories; then the
  # workflows and composite actions, linted: actionlint for mistakes (with
  # shellcheck on the run: scripts), zizmor for security problems, offline
  # (the sandbox has no GitHub API) and failing on a file it can't read; zizmor
  # also on the Dependabot config (its cooldown audit wants 7 days); and
  # shellcheck on scripts/ci/*.sh, which actionlint doesn't see. The
  # copy has no .git, so the files are found and named. Findings we accept are
  # ignored where they occur, with the reason next to them (.github/zizmor.yml
  # has the settings).
  unit =
    runCommand "unit"
      {
        nativeBuildInputs = [
          nodejs_26
          git
          pkgs.actionlint
          pkgs.zizmor
          pkgs.util-linux # unshare, for tests/smoke.test.ts
          pkgs.jq # ci.yml's `tested` script, run by tests/ci.test.ts
          pkgs.shellcheck # scripts/ci/*.sh (actionlint checks only run: steps)
        ];
      }
      ''
        cp -r ${sources}/. . && chmod -R u+w .
        export HOME=$(mktemp -d)
        node --test tests/*.test.ts
        zizmor() {
          command zizmor --offline --strict-collection --no-progress \
            --config .github/zizmor.yml "$@"
        }
        # A plain assignment, so a failing find stops the check.
        found=$(find .github/workflows -name '*.yml' -o -name '*.yaml')
        [ -n "$found" ] || { echo "no workflows found"; exit 1; }
        mapfile -t workflows <<< "$found"
        found=$(find .github/actions -name action.yml -o -name action.yaml)
        [ -n "$found" ] || { echo "no composite actions found"; exit 1; }
        mapfile -t actions <<< "$found"
        # Its config names the runner labels it doesn't know yet.
        actionlint -config-file .github/actionlint.yaml "''${workflows[@]}"
        zizmor "''${workflows[@]}" "''${actions[@]}" .github/dependabot.yml
        found=$(find scripts/ci -name '*.sh')
        [ -n "$found" ] || { echo "no scripts/ci/*.sh found"; exit 1; }
        mapfile -t shells <<< "$found"
        shellcheck "''${shells[@]}"
        # The linters still catch something with these settings: a broken
        # expression (actionlint's exit code 1: problems found), and a run:
        # script that expands an issue's title (zizmor's 14: a high finding).
        bad=$(mktemp -d)
        printf 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "''${{ github.nope( }}"\n' \
          > $bad/expr.yml
        printf 'on: issues\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "''${{ github.event.issue.title }}"\n' \
          > $bad/title.yml
        code=0 && actionlint $bad/expr.yml > $bad/expr.out || code=$?
        [ $code = 1 ] || { echo "actionlint: exit $code, not 1, on a broken expression"; exit 1; }
        grep -qF '[expression]' $bad/expr.out || { echo "actionlint didn't report the expression:"; cat $bad/expr.out; exit 1; }
        code=0 && zizmor $bad/title.yml || code=$?
        [ $code = 14 ] || { echo "zizmor: exit $code, not 14, on a template injection"; exit 1; }
        touch $out
      '';

  # Node's type definitions, for the type check only (pinned npm tarballs;
  # nothing from npm runs).
  typesNode = fetchurl {
    url = "https://registry.npmjs.org/@types/node/-/node-26.6.6.tgz";
    hash = "sha512-MzQj+8Kx3XI40OmUAE6Qoh58ZMNstNNMwn2nfd3qWsfe7nDNSqJNzes4njhz6AHwrSHOffSLwXU6yb474Q4aog==";
  };
  undiciTypes = fetchurl {
    url = "https://registry.npmjs.org/undici-types/-/undici-types-8.9.0.tgz";
    hash = "sha512-KTDyRTYX8sWmKXAikPHHSyc63CRPETMctyjKFupcC6OBLXT3xsN0e9aF7m+mIXutFWpUXuedtowG7iLOzp0kQg==";
  };
  typecheck = runCommand "typecheck" { nativeBuildInputs = [ typescript ]; } ''
    cp -r ${sources}/. . && chmod -R u+w .
    mkdir -p node_modules/@types/node node_modules/undici-types
    tar -xzf ${typesNode} -C node_modules/@types/node --strip-components=1
    tar -xzf ${undiciTypes} -C node_modules/undici-types --strip-components=1
    tsc -p .
    touch $out
  '';
  # The desktop app's Electron (lib/electron.nix): the choice as a pure
  # function, the fallback file, and the forced variants that branch and update
  # CI build and smoke beside what `auto` picks.
  electronLib = import ./electron.nix { inherit lib; };
  electron-choice =
    let
      fake =
        version: extra:
        {
          type = "derivation";
          name = "electron-${version}";
          inherit version;
          drvPath = "/nix/store/00000000000000000000000000000000-electron-${version}.drv";
          outPath = "/nix/store/00000000000000000000000000000000-electron-${version}";
          meta = { };
          inherit (pkgs) stdenv;
        }
        // extra;
      nixpkgsWith = attrs: { inherit (pkgs) stdenv; } // attrs;
      choose =
        setting: bundled: nix: fallback:
        electronLib.choose {
          inherit setting bundled fallback;
          pkgs = nix;
        };
      at = v: nixpkgsWith { electron_44-bin = fake v { }; };
      auto = bundled: nix: choose "auto" bundled nix false;
      newer = at "44.10.2";
      removed = nixpkgsWith { electron_44-bin = throw "electron_44-bin has been removed"; };
      insecure = nixpkgsWith {
        electron_44-bin = fake "44.10.2" {
          drvPath = throw "marked as insecure";
          meta.knownVulnerabilities = [ "end of life" ];
        };
      };
      otherPlatform = nixpkgsWith {
        electron_44-bin = fake "44.10.2" { meta.platforms = [ "riscv64-linux" ]; };
      };
      entry = {
        version = "0.1.10";
        assets = {
          aarch64-linux = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
          x86_64-linux = "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
        };
        nixpkgs = lib.fixedWidthString 40 "a" "";
      };
      pin = {
        version = "0.1.10";
        assets = {
          aarch64-linux.hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
          x86_64-linux.hash = "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
        };
      };
      active =
        e: p: rev:
        electronLib.activeFor {
          entries = {
            t3code = e;
          };
          pinName = "t3code";
          pin = p;
          inherit rev;
        };
    in
    conditions "electron-choice" {
      "auto: a newer nixpkgs patch of the bundled major" =
        (auto "44.10.1" newer).choice == "nixpkgs"
        && (auto "44.10.1" newer).reason == "auto: nixpkgs 44.10.2 >= bundled 44.10.1";
      "auto: the same version" = (auto "44.10.2" newer).choice == "nixpkgs";
      "auto: an older nixpkgs patch" =
        (auto "44.10.3" newer).choice == "bundled"
        && (auto "44.10.3" newer).reason == "auto: nixpkgs' 44.10.2 is older than bundled 44.10.3";
      "auto: no such major" =
        (auto "45.0.1" newer).choice == "bundled"
        && (auto "45.0.1" newer).reason == "auto: this nixpkgs has no electron_45-bin";
      "auto: a removed major (a throwing alias)" =
        (auto "44.10.1" removed).choice == "bundled"
        && lib.hasInfix "removed" (auto "44.10.1" removed).reason;
      "auto: a major marked insecure" =
        (auto "44.10.1" insecure).reason == "auto: this nixpkgs' electron_44-bin is marked insecure";
      "auto: not available on this platform" = (auto "44.10.1" otherPlatform).choice == "bundled";
      "auto and nixpkgs: an attribute whose package is another major" =
        (auto "44.10.1" (at "45.0.0")).reason
        == "auto: this nixpkgs' electron_44-bin is 45.0.0, not major 44"
        && (choose "nixpkgs" "44.10.1" (at "45.0.0") false) ? error;
      "auto: an unknown bundled version" =
        (auto null newer).choice == "bundled"
        && (auto null newer).reason == "auto: the bundled version isn't known"
        && (auto null newer).bundled == "unknown";
      "auto: an active fallback picks bundled" =
        (choose "auto" "44.10.1" newer true).choice == "bundled"
        && lib.hasInfix "(fallback)" (choose "auto" "44.10.1" newer true).reason;
      "bundled" = (choose "bundled" "44.10.1" newer false).reason == "set to bundled";
      "nixpkgs: works when auto would" = (choose "nixpkgs" "44.10.1" newer false).choice == "nixpkgs";
      "nixpkgs: an error saying what to do when it can't" =
        lib.hasInfix "use electron = \"auto\" or \"bundled\"" (choose "nixpkgs" "45.0.1" newer false).error
        && lib.hasInfix "older than the bundled" (choose "nixpkgs" "44.10.3" newer false).error
        && lib.hasInfix "doesn't record" (choose "nixpkgs" null newer false).error;
      "nixpkgs: a warning under an active fallback" = (choose "nixpkgs" "44.10.1" newer true) ? warning;
      "a package of the bundled major, older allowed" =
        (choose (fake "44.9.3" { }) "44.10.1" newer false).choice == "package"
        &&
          (choose (fake "44.9.3" { }) "44.10.1" newer false).reason
          == "set to a package (44.9.3, older than bundled 44.10.1)";
      "a package of another major is an error" =
        (choose (fake "43.8.7" { }) "44.10.1" newer false) ? error;
      "a package from another nixpkgs warns" =
        (choose (fake "44.10.2" { stdenv.drvPath = "/nix/store/other.drv"; }) "44.10.1" newer false)
          ? warning;
      "a package from another nixpkgs under an active fallback warns twice" =
        let
          w =
            (choose (fake "44.10.2" { stdenv.drvPath = "/nix/store/other.drv"; }) "44.10.1" newer true).warning;
        in
        lib.hasInfix "its stdenv differs" w && lib.hasInfix "your Electron package" w;
      "an entry is active only for its version, files and revision" =
        active entry pin entry.nixpkgs
        && !active entry (pin // { version = "0.1.11"; }) entry.nixpkgs
        && !active entry (
          pin
          // {
            assets = pin.assets // {
              x86_64-linux.hash = "sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";
            };
          }
        ) entry.nixpkgs
        && !active entry pin (lib.fixedWidthString 40 "b" "");
      "the schema" =
        electronLib.valid { t3code = entry; }
        && !electronLib.valid { }
        && !electronLib.valid { t3 = entry; }
        && !electronLib.valid {
          t3code = entry // {
            extra = 1;
          };
        }
        && !electronLib.valid {
          t3code = entry // {
            assets = { inherit (entry.assets) x86_64-linux; };
          };
        }
        && !electronLib.valid {
          t3code = entry // {
            nixpkgs = "abc";
          };
        };
      "the record: the schema" =
        let
          ok = {
            choice = "nixpkgs";
            version = "44.10.2";
            bundled = "44.10.1";
            rev = lib.fixedWidthString 40 "a" "";
          };
          recordOf = e: {
            t3code = {
              aarch64-linux = ok;
              x86_64-linux = e;
            };
          };
        in
        electronLib.runtimeValid (recordOf ok)
        && electronLib.runtimeValid (recordOf {
          choice = "bundled";
          version = null;
          bundled = null;
          inherit (ok) rev;
        })
        && !electronLib.runtimeValid { }
        && !electronLib.runtimeValid { t3 = (recordOf ok).t3code; }
        && !electronLib.runtimeValid {
          t3code = {
            x86_64-linux = ok;
          };
        }
        && !electronLib.runtimeValid (recordOf (ok // { extra = 1; }))
        && !electronLib.runtimeValid (recordOf (ok // { choice = "package"; }))
        && !electronLib.runtimeValid (recordOf (ok // { version = null; }))
        && !electronLib.runtimeValid (recordOf (ok // { choice = "bundled"; }))
        && !electronLib.runtimeValid (recordOf (ok // { rev = "abc"; }))
        && !electronLib.runtimeValid (recordOf (ok // { bundled = "unknown"; }));
      "the record: only an entry that describes its tree and disagrees is wrong" =
        let
          rev = lib.fixedWidthString 40 "a" "";
          entry = choice: version: bundled: {
            inherit
              choice
              version
              bundled
              rev
              ;
          };
          recordOf = e: {
            t3code = {
              aarch64-linux = e;
              x86_64-linux = e;
            };
          };
          problems =
            record: pin: got:
            electronLib.runtimeProblems {
              inherit record rev;
              present = record != "absent";
              system = "x86_64-linux";
              pins = {
                t3code = pin;
              };
              evaluated = {
                t3code = got;
              };
            };
          pin = {
            electron = "44.10.1";
          };
          nixpkgs = {
            choice = "nixpkgs";
            version = "44.10.2";
          };
          good = recordOf (entry "nixpkgs" "44.10.2" "44.10.1");
        in
        problems good pin nixpkgs == [ ]
        # A wrong choice, or the right choice with a wrong version.
        && problems (recordOf (entry "bundled" "44.10.1" "44.10.1")) pin nixpkgs != [ ]
        && problems (recordOf (entry "nixpkgs" "44.10.3" "44.10.1")) pin nixpkgs != [ ]
        # Another tree's entries: another bundled version, another revision.
        && problems (recordOf (entry "bundled" "44.10.0" "44.10.0")) pin nixpkgs == [ ]
        &&
          problems (recordOf (
            entry "bundled" "44.10.1" "44.10.1" // { rev = lib.fixedWidthString 40 "b" ""; }
          )) pin nixpkgs == [ ]
        # No file passes; a malformed one doesn't, a file that says null
        # included.
        && problems "absent" pin nixpkgs == [ ]
        && problems null pin nixpkgs != [ ]
        && problems { t3code = { }; } pin nixpkgs != [ ]
        # An unknown bundled version is null all the way, though the package
        # says the pin's own word for it.
        &&
          problems (recordOf (entry "bundled" null null)) { electron = "unknown"; } {
            choice = "bundled";
            version = "unknown";
          } == [ ]
        &&
          problems (recordOf (entry "bundled" null null)) { electron = null; } {
            choice = "bundled";
            version = null;
          } == [ ]
        # A recorded pin whose package is gone.
        && problems good pin null != [ ];
      "the packages: passthru matches the choice, and nixpkgs throws when it can't" =
        let
          app = packages.t3code-unwrapped or null;
        in
        app == null
        || (
          app.passthru.electron.bundled == (
            let
              v = (pinOf "t3code").electron or null;
            in
            if builtins.isString v && builtins.match "[0-9]+\\.[0-9]+\\.[0-9]+" v != null then v else "unknown"
          )
          && fails (app.override { electron = pkgs.electron_43-bin or (fake "43.8.7" { }); }).drvPath
        );
    } "";
  # ci/electron-fallback.json, when present: the schema and canonical form
  # (sorted keys, two-space JSON, newline-terminated). JSON that doesn't parse
  # fails every evaluation already.
  electron-fallback =
    let
      file = ../ci/electron-fallback.json;
      present = builtins.pathExists file;
      ok = !present || electronLib.valid (lib.importJSON file);
    in
    runCommand "electron-fallback" { nativeBuildInputs = [ pkgs.jq ]; } (
      if !ok then
        "echo 'ci/electron-fallback.json is malformed (see lib/electron.nix)'; exit 1"
      else if present then
        ''
          jq -S --indent 2 . ${file} | cmp - ${file} || { echo "ci/electron-fallback.json isn't in canonical form"; exit 1; }
          touch $out
        ''
      else
        "touch $out"
    );
  # ci/electron-runtime.json, when present (scripts/lib/electron-fallback.ts):
  # well-formed and canonical, and on this system every entry that describes
  # main's tree (its pin's bundled version, flake.lock's nixpkgs revision) is
  # what the package itself picks (auto, without the fallback). Entries for
  # another tree are stale, never shown, and pass.
  electron-runtime =
    let
      file = ../ci/electron-runtime.json;
      present = builtins.pathExists file;
      # The record is about main's pins (versions/), whatever pinsDir is.
      pin =
        n:
        if builtins.pathExists (../versions + "/${n}.json") then
          lib.importJSON (../versions + "/${n}.json")
        else
          null;
      apps = {
        t3code = "t3code-unwrapped";
        t3code-nightly = "t3code-unwrapped-nightly";
      };
      problems = electronLib.runtimeProblems {
        inherit present;
        record = if present then lib.importJSON file else null;
        system = pkgs.stdenv.hostPlatform.system;
        pins = lib.mapAttrs (n: _: pin n) apps;
        rev = (lib.importJSON ../flake.lock).nodes.nixpkgs.locked.rev;
        evaluated = lib.mapAttrs (
          _: a:
          if noFallback ? ${a} then
            {
              inherit (noFallback.${a}.passthru.electron) choice version;
            }
          else
            null
        ) apps;
      };
    in
    runCommand "electron-runtime" { nativeBuildInputs = [ pkgs.jq ]; } (
      if problems != [ ] then
        ''
          echo ${lib.escapeShellArg (lib.concatStringsSep "\n" problems)}
          echo "To write it again: node scripts/ci/electron-runtime.ts write"
          exit 1
        ''
      else if present then
        ''
          jq -S --indent 2 . ${file} | cmp - ${file} || { echo "ci/electron-runtime.json isn't in canonical form"; exit 1; }
          touch $out
        ''
      else
        "touch $out"
    );
  # The forced variants per channel: bundled, and nixpkgs (ignoring the
  # fallback file), or a "not applicable" marker when nixpkgs has no usable
  # Electron of the bundled major at least as new, or the bundled version
  # isn't known. They always exist, so the check names stay fixed.
  electronVariants =
    app: unwrapped: pinName:
    if app == null then
      {
        bundled = null;
        nixpkgs = null;
      }
    else
      {
        bundled = app.override { electron = "bundled"; };
        nixpkgs =
          if
            electronLib.nixpkgsApplicable {
              bundled = (pinOf pinName).electron or null;
              inherit pkgs;
            }
          then
            app.override {
              unwrapped = unwrapped.override {
                electron = "nixpkgs";
                electronFallback = false;
              };
            }
          else
            runCommand "${pinName}-electron-nixpkgs-not-applicable" {
              passthru.electronNotApplicable = true;
            } "echo 'no usable nixpkgs Electron of the bundled major' > $out";
      };
  # The swapped app folder against upstream's (the latest channel): the same
  # app.asar and non-native files, no default_app.asar, the program linked
  # against the same libraries as upstream's Electron, and every top-level
  # file upstream ships there.
  electron-swap =
    let
      swapped = packages.t3code-unwrapped or null;
      applicable = swapped != null && swapped.passthru.electron.choice == "nixpkgs";
      bundled = swapped.override { electron = "bundled"; };
      nixElectron = pkgs.${swapped.passthru.electron.name};
    in
    runCommand "electron-swap" { nativeBuildInputs = [ pkgs.patchelf ]; } (
      if !applicable then
        "touch $out"
      else
        ''
          s=${swapped}/libexec/t3code b=${bundled}/libexec/t3code e=${nixElectron}/libexec/electron
          cmp $s/resources/app.asar $b/resources/app.asar
          [ ! -e $s/resources/default_app.asar ]
          # Every non-ELF file of resources/ is upstream's.
          (cd $b/resources && find . -type f) | while read -r f; do
            head -c4 "$b/resources/$f" | grep -q ELF && continue
            cmp "$s/resources/$f" "$b/resources/$f"
          done
          # Linked like upstream's Electron: the bundled app's RPATH (only
          # this package's libraries), not nixpkgs' every-feature one.
          rpath() { patchelf --print-rpath "$1/t3code" | tr : '\n' | sed "s|^$1\$|SELF|" | grep -v '^\$ORIGIN$' | sort; }
          [ "$(rpath $s)" = "$(rpath $b)" ] \
            || { echo "t3code's RPATH isn't the bundled app's"; exit 1; }
          cmp $s/resources.pak $e/resources.pak
          # Nothing upstream ships beside Electron's own files is lost (only
          # resources/ comes from the .deb): every top-level entry of the
          # bundled folder is in the swapped one, but for Electron's license,
          # which nixpkgs names LICENSE.
          for f in $(cd $b && ls -A); do
            [ "$f" = LICENSE.electron.txt ] && f=LICENSE
            [ -e "$s/$f" ] || { echo "the swapped app lacks $f, which upstream's has"; exit 1; }
          done
          touch $out
        ''
    );
  latestChannelElectron = electronVariants (packages.t3code or null) (packages.t3code-unwrapped
    or null
  ) "t3code";
  nightlyElectron = electronVariants (packages.t3code-nightly or null
  ) (packages.t3code-unwrapped-nightly or null) "t3code-nightly";

in
{
  inherit
    update-guards
    updater-switches
    as-shipped
    codex-layout
    licences
    provider-wrappers
    guard-environment
    t3-guard-flags
    codex-guard-flags
    provider-commands
    relay-client
    nix-format
    unit
    typecheck
    preview-browser-pin
    preview-browser-link
    preview-browser-optional
    provider-selection
    free-variant
    module-eval
    server-unit
    doctor-scenarios
    init-scenarios
    template
    default-nix
    completions
    cache-settings
    unsupported-systems
    overlay
    no-self-rev
    ;
  t3-smoke = smoke packages.t3;
  t3-nightly-smoke = smoke (packages.t3-nightly or null);
  inherit
    speech-libs
    speech-model-pin
    acp-runtimes
    boat-self-update-off
    fx-upgrade-off
    agent-tools-separate
    agent-browser-browsers
    agent-browser-stable-chromium
    ;
  t3-speech-worker = speechWorker packages.t3-unwrapped;
  t3-nightly-speech-worker = speechWorker (packages.t3-unwrapped-nightly or null);
  t3-speech-smoke = speechSmoke packages.t3-unwrapped "t3";
  t3-nightly-speech-smoke = speechSmoke (packages.t3-unwrapped-nightly or null) "t3-nightly";
  inherit
    electron-choice
    electron-fallback
    electron-runtime
    electron-swap
    ;
  t3code-electron-bundled = latestChannelElectron.bundled;
  t3code-electron-nixpkgs = latestChannelElectron.nixpkgs;
  t3code-nightly-electron-bundled = nightlyElectron.bundled;
  t3code-nightly-electron-nixpkgs = nightlyElectron.nixpkgs;
}
