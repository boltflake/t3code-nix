# The T3 Code desktop app from upstream's .deb, without providers (see
# wrap.nix). Its libraries are re-pointed at nixpkgs, those it opens at run
# time put on its RUNPATH, and its bundled Vulkan loader replaced by nixpkgs'.
# In app.asar (scripts/asar-patch.ts): why its updates are off, in our words,
# and the update notice (update-notice.cjs): its sidebar's update icon shows
# only when there is an update, this flake having a newer T3 Code included.
#
# Electron (lib/electron.nix):
#
#   t3code.override { electron = "auto"; }      # default: nixpkgs' newer patch of the
#                                               # bundled major when usable, else bundled
#   t3code.override { electron = "bundled"; }   # upstream's own
#   t3code.override { electron = "nixpkgs"; }   # nixpkgs', or an evaluation error
#   t3code.override { electron = pkgs.electron_44-bin; }  # same major, same nixpkgs
#
# With nixpkgs' Electron the app folder is nixpkgs' Electron folder, copied,
# its program renamed t3code, with upstream's resources/ in place of
# Electron's own: a real copy with that name, so the app runs packaged
# (app.isPackaged), exactly as upstream's own build does.
{
  lib,
  stdenv,
  fetchurl,
  versions,
  dpkg,
  autoPatchelfHook,
  makeWrapper,
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  cairo,
  cups,
  dbus,
  expat,
  glib,
  gsettings-desktop-schemas,
  gtk3,
  libdrm,
  libgbm,
  libGL,
  libnotify,
  libpulseaudio,
  libsecret,
  libxkbcommon,
  libxkbfile,
  nspr,
  nss,
  pango,
  pipewire,
  systemd,
  vulkan-loader,
  wayland,
  libx11,
  libxcomposite,
  libxdamage,
  libxext,
  libxfixes,
  libxrandr,
  libxtst,
  libxcb,
  libxshmfence,
  patchelf,
  nodejs,
  pkgs,
  # T3 Code's release channel: "latest" or "nightly".
  channel ? "latest",
  electron ? "auto",
  # Read ci/electron-fallback.json (this flake's default packages only; off
  # for the NixOS stable set, the overlay and the comparisons with it).
  electronFallback ? true,
  # The update notice's file on this flake's site, under updates/: this
  # package's own pins' (pkgs/default.nix passes stable/t3code for the
  # NixOS-stable set); null for this channel's, from versions/.
  updateFeed ? null,
}:
let
  ch = versions.channel "t3code-unwrapped" channel;
  pinName = "t3code${ch.suffix}";
  pin = versions.load pinName;
  electronLib = import ../../lib/electron.nix { inherit lib; };
  fallback =
    electronFallback
    && electronLib.activeFor {
      entries = electronLib.readFallback ../../ci/electron-fallback.json;
      inherit pinName pin;
      rev = (lib.importJSON ../../flake.lock).nodes.nixpkgs.locked.rev;
    };
  chosen = electronLib.choose {
    setting = electron;
    bundled = pin.electron or null;
    inherit pkgs fallback;
  };
  chosenOk =
    if chosen ? error then
      throw chosen.error
    else if chosen ? warning then
      lib.warn chosen.warning chosen
    else
      chosen;
  swapped = chosenOk.package != null;
  electronDir = "${chosenOk.package}/libexec/electron";
  # The pin's bundled version, checked against the .deb's program (its
  # compiled-in user-agent string) without running it.
  bundledCheck = lib.optionalString (builtins.isString (pin.electron or null)) ''
    found=$(grep -aoE 'Electron/[0-9]+\.[0-9]+\.[0-9]+' "''${app[0]}/t3code" | sort -u)
    [ "$found" = "Electron/${pin.electron}" ] || {
      echo "the pin says Electron ${pin.electron}, the .deb's program says: ''${found:-nothing}"
      exit 1
    }
  '';
  binName = "t3code${ch.suffix}";
  # The patcher and its archive library only, so other scripts' changes
  # don't rebuild the app.
  patcher = lib.fileset.toSource {
    root = ../../scripts;
    fileset = lib.fileset.unions [
      ../../scripts/asar-patch.ts
      ../../scripts/lib/asar.ts
    ];
  };
  # The wrapper's flags for the notice, from the build's notice file (a
  # shell word): the URL only when the notice fitted.
  noticeFlags = notice: ''
    noticeFlags=()
    if [ "$(cat ${notice})" = on ]; then
      noticeFlags=(--set-default T3CODE_NIX_UPDATE_URL ${updateUrl})
    fi
  '';
  # The file scripts/status.ts publishes for these pins.
  updateUrl = "https://boltflake.github.io/t3code-nix/updates/${
    if updateFeed == null then pinName else updateFeed
  }.json";

  # Opened with dlopen at run time, so autoPatchelf can't see them. They go
  # in front of the program's RUNPATH (runtimeDependencies below), not in an
  # LD_LIBRARY_PATH: that would be inherited by everything the app starts,
  # agent shells included, and break host programs that load these newer
  # libraries against the host's older glibc.
  runtimeLibs = [
    libGL
    vulkan-loader
    systemd
    wayland
    libxkbcommon
    libnotify
    libsecret
    libpulseaudio
    pipewire
  ];
in
stdenv.mkDerivation {
  pname = "t3code-unwrapped${ch.suffix}";
  inherit (pin) version;

  src = fetchurl (versions.asset pin stdenv.hostPlatform.system);
  # nixpkgs' dpkg hook unpacks the .deb into root/.
  sourceRoot = "root";

  nativeBuildInputs = [
    dpkg
    autoPatchelfHook
    makeWrapper
    nodejs
  ]
  ++ lib.optional swapped patchelf;
  buildInputs = [
    stdenv.cc.cc.lib
    alsa-lib
    at-spi2-atk
    at-spi2-core
    cairo
    cups
    dbus
    expat
    glib
    gtk3
    libdrm
    libgbm
    nspr
    nss
    pango
    libxkbfile
    libx11
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxtst
    libxcb
    libxshmfence
  ]
  ++ runtimeLibs;
  # Put in front of the RUNPATH of the app's executables.
  runtimeDependencies = map lib.getLib runtimeLibs;
  # The musl variants of the native add-ons are never loaded on glibc.
  autoPatchelfIgnoreMissingDeps = [ "libc.musl-*.so.1" ];

  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;
  # The copy must not keep electron_N-bin alive (its RPATH named it).
  disallowedRequisites = lib.optional swapped chosenOk.package;

  # Runtime settings live here, so "unwrapped" only means "without providers":
  # - T3CODE_DISABLE_AUTO_UPDATE: Nix decides the version. Upstream's reason
  #   for it, shown under "Updates unavailable", only names the setting, so
  #   app.asar gets ours in its place (asar-patch.ts fails the build if
  #   upstream's sentence changes).
  # - T3CODE_NIX_UPDATE_URL (a default: a value already set wins, a blank
  #   one, which is off, included): the notice's file, only when the notice
  #   fitted this release. When it didn't (upstream's web UI changed shape),
  #   the app is built without it, as before the notice, and
  #   share/t3code-nix/${binName}/update-notice (each channel's own, so
  #   both can share a profile) says why; the build doesn't fail.
  # - T3CODE_DESKTOP_LAUNCHER_PATH: the t3code:// handler the app registers
  #   runs `${binName}` through the user's profile, not a store path, so it
  #   survives upgrades and garbage collection.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec $out/bin $out/share/applications
    # "opt/T3 Code (Beta)" on the latest channel, "opt/T3 Code (Nightly)" for nightly.
    app=(opt/*)
    [ ''${#app[@]} = 1 ] || { echo "expected one app folder in opt/: ''${app[*]}"; exit 1; }
    ${bundledCheck}
    ${
      if swapped then
        ''
          # nixpkgs' Electron, renamed, with upstream's resources/.
          mkdir -p $out/libexec/${binName}
          cp -r ${electronDir}/. $out/libexec/${binName}/
          chmod -R u+w $out/libexec/${binName}
          rm -rf $out/libexec/${binName}/resources
          mv $out/libexec/${binName}/electron $out/libexec/${binName}/t3code
          cp -r "''${app[0]}/resources" $out/libexec/${binName}/resources
          # Linked like the bundled app: nixpkgs builds electron_N-bin's
          # RPATH for every optional feature (GTK 4, GStreamer, speech…),
          # which the app doesn't use and which would add ~200 MB to its
          # closure. Cleared here; autoPatchelf then links each file against
          # this package's own libraries, as it does upstream's Electron.
          for f in $out/libexec/${binName}/*; do
            [ -f "$f" ] && [ ! -L "$f" ] && patchelf --print-rpath "$f" >/dev/null 2>&1 || continue
            patchelf --set-rpath '$ORIGIN' "$f"
          done
          if grep -rlF ${chosenOk.package} $out/libexec/${binName}; then
            echo "these files still refer to ${chosenOk.package}"
            exit 1
          fi
        ''
      else
        ''
          cp -r "''${app[0]}" $out/libexec/${binName}
          # nixpkgs' Vulkan loader, which finds NixOS's drivers, in place of
          # the bundled one, as nixpkgs' Electron has it: the transcription
          # add-on (libggml-vulkan.so) links libvulkan.so.1 from this folder.
          ln -sf ${lib.getLib vulkan-loader}/lib/libvulkan.so.1 $out/libexec/${binName}/libvulkan.so.1
        ''
    }
    ${versions.dropMusl "$out/libexec/${binName}"}
    asar=$out/libexec/${binName}/resources/app.asar
    chmod u+w $asar
    mkdir -p $out/share/t3code-nix/${binName}
    notice=$out/share/t3code-nix/${binName}/update-notice
    node ${patcher}/asar-patch.ts $asar \
      'Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.' \
      'Nix manages this install. Please rebuild your system to update T3 Code.' \
      $notice ${./update-notice.cjs}
    ${noticeFlags "$notice"}
    cp -r usr/share/icons $out/share/
    # Each channel's icons under its own name, so both apps can be
    # installed and keep their own pictures (nightly's differ).
    ${lib.optionalString (binName != "t3code") ''
      find $out/share/icons -name 't3code.*' | while read -r f; do
        mv "$f" "$(dirname "$f")/${binName}.''${f##*.}"
      done
    ''}

    # GTK's GSettings schemas, as wrapGAppsHook adds them: without a portal
    # file chooser, Electron opens GTK's own dialog, and GLib aborts the app
    # when it finds no schemas ("No GSettings schemas are installed").
    makeWrapper $out/libexec/${binName}/t3code $out/bin/${binName} \
      --prefix XDG_DATA_DIRS : ${glib.getSchemaDataDirPath gtk3}:${glib.getSchemaDataDirPath gsettings-desktop-schemas} \
      --set T3CODE_DISABLE_AUTO_UPDATE 1 \
      "''${noticeFlags[@]}" \
      --set T3CODE_DESKTOP_LAUNCHER_PATH ${binName}

    # Our own entry: profile-stable Exec, the t3code:// handler, and the
    # window class the app really reports (setDesktopName: X11 WM_CLASS and
    # Wayland app_id), so docks group its windows under this launcher.
    # Upstream fixed the .deb after 0.1.9 (pingdotgg/t3code#10895); the file
    # keeps its name because the app writes a hidden com.t3tools.T3Code.desktop
    # of its own to ~/.local/share/applications.
    entry=$out/share/applications/${binName}.desktop
    sed -e 's|^Exec=.*|Exec=${binName} %U|' \
        -e 's|^StartupWMClass=.*|StartupWMClass=com.t3tools.T3Code|' \
        -e 's|^Icon=.*|Icon=${binName}|' \
        usr/share/applications/t3code.desktop > $entry
    grep -q '^MimeType=.*x-scheme-handler/t3code;' $entry
    grep -qx 'StartupWMClass=com.t3tools.T3Code' $entry
    grep -qx 'Icon=${binName}' $entry
    [ -n "$(find $out/share/icons -name '${binName}.*')" ]

    ${versions.installLicenses pin}
    runHook postInstall
  '';

  # The notice's URL for these pins (whether the wrapper sets it is the
  # build's share/t3code-nix/<binName>/update-notice: `on`, or `off: <why>`).
  passthru.updateUrl = updateUrl;
  # For the update-notice check: the snippet above, given a notice file.
  passthru.noticeFlags = noticeFlags;

  passthru.electron = {
    inherit (chosenOk)
      choice
      name
      version
      bundled
      reason
      ;
  };

  meta = {
    description = "T3 Code desktop app, without providers";
    homepage = "https://github.com/pingdotgg/t3code";
    license = lib.licenses.mit;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = versions.platforms pin;
    mainProgram = binName;
  };
}
