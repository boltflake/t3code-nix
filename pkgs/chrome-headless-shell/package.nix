# The headless browser T3 Code uses for HTML previews (screenshots and
# recording): Chrome for Testing's chrome-headless-shell, at exactly the
# version and archive the t3code release pins (its PreviewBrowser.ts, read by
# the updater into the pin's `browser`). t3code downloads that archive
# itself, but the download is a plain Linux binary: without nix-ld its
# interpreter (/lib64/ld-linux-*.so.2) doesn't exist, so it can't start, and
# LD_LIBRARY_PATH can't help. This is the same archive, patched with
# autoPatchelfHook; the wrapper links it where t3code looks for it
# (../t3code/preview-browser.sh). Library list from nixpkgs' Playwright
# chromium-headless-shell.
{
  lib,
  stdenv,
  fetchurl,
  unzip,
  autoPatchelfHook,
  patchelfUnstable,
  alsa-lib,
  at-spi2-atk,
  expat,
  glib,
  libxcomposite,
  libxdamage,
  libxfixes,
  libxrandr,
  libgbm,
  libgcc,
  libxkbcommon,
  nspr,
  nss,
  versions,
  browser,
}:
let
  platform =
    {
      x86_64-linux = "linux64";
      aarch64-linux = "linux-arm64";
    }
    .${stdenv.hostPlatform.system}
      or (throw "chrome-headless-shell: no build for ${stdenv.hostPlatform.system}");
  pin = browser // {
    name = "chrome-headless-shell";
  };
in
stdenv.mkDerivation {
  pname = "chrome-headless-shell";
  inherit (browser) version;

  src = fetchurl (versions.asset pin stdenv.hostPlatform.system);

  nativeBuildInputs = [
    unzip
    autoPatchelfHook
    # As nixpkgs' Playwright headless shell does, for both architectures.
    patchelfUnstable
  ];
  buildInputs = [
    alsa-lib
    at-spi2-atk
    expat
    glib
    libxcomposite
    libxdamage
    libxfixes
    libxrandr
    libgbm
    libgcc
    libxkbcommon
    nspr
    nss
  ];
  dontConfigure = true;
  dontBuild = true;
  dontStrip = true;

  # The whole folder: the executable finds its .pak files, ICU data and
  # SwiftShader libraries next to itself.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec
    cp -R . $out/libexec/chrome-headless-shell
    install -Dm644 LICENSE.headless_shell -t $out/share/licenses/chrome-headless-shell
    runHook postInstall
  '';

  # t3code's name for this platform, in its tools folder.
  passthru = { inherit platform; };

  meta = {
    description = "Chrome for Testing's headless shell, at the version T3 Code pins, patched for NixOS";
    homepage = "https://developer.chrome.com/blog/chrome-for-testing";
    # Built from Chromium (BSD), but the archive ships as Google Chrome under
    # Google's terms (its ABOUT file), so it's treated as unfree.
    license = lib.licenses.unfree;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = versions.platforms browser;
  };
}
