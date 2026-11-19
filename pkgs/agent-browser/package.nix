# agent-browser: a headless browser CLI for agents, by Vercel (`open`,
# `snapshot`, `click`, `fill`, `screenshot`), an agent tool: never part of
# t3code or t3. Its musl release asset is statically linked, installed as
# it is.
#
# `browser` is a name or a package. A name is "ungoogled-chromium" (the
# default), "chromium" or "google-chrome" (unfree), from this flake's
# browser pins (versions/browser-<channel>.json, moved on their own
# schedule) or, with browserChannel = null, this pkgs' own. A package is
# used as it is (its `meta.mainProgram`) and ignores the channel:
#
#   agent-browser.override { browser = "google-chrome"; }
#   agent-browser.override { browserChannel = "stable"; }
#   agent-browser.override { browser = pkgs.chromium; }
{
  lib,
  stdenv,
  fetchurl,
  versions,
  guard,
  makeWrapper,
  ungoogled-chromium,
  chromium,
  google-chrome,
  browser ? "ungoogled-chromium",
  browserChannel ? "unstable",
}:
let
  pin = versions.load "agent-browser";
  names = [
    "ungoogled-chromium"
    "chromium"
    "google-chrome"
  ];
  own = { inherit ungoogled-chromium chromium google-chrome; };
  # What was asked for, apart from the browser it resolves to: a name, or
  # "package" (the module overrides only a name; see nixos/module.nix).
  browserChoice =
    if lib.isDerivation browser then
      "package"
    else if builtins.elem browser names then
      browser
    else
      throw "agent-browser: browser is ${
        lib.concatMapStringsSep ", " builtins.toJSON names
      } or a package, not ${builtins.toJSON browser}";
  fromChannel =
    if browserChannel == null then
      own
    else if
      builtins.elem browserChannel [
        "unstable"
        "stable"
      ]
    then
      versions.browsers browserChannel stdenv.hostPlatform.system
    else
      throw ''agent-browser: browserChannel is "unstable", "stable" or null, not ${builtins.toJSON browserChannel}'';
  chosen = if browserChoice == "package" then browser else fromChannel.${browserChoice};
  # Its program: meta.mainProgram (`chromium`, `google-chrome-stable`), or
  # lib.getExe's own fallback for a package without one.
  executable = lib.getExe chosen;
in
stdenv.mkDerivation (
  versions.installCheck { }
  // {
    pname = "agent-browser";
    inherit (pin) version;

    src = fetchurl (versions.asset pin stdenv.hostPlatform.system);
    dontUnpack = true;

    nativeBuildInputs = [ makeWrapper ];

    dontConfigure = true;
    dontBuild = true;
    # Static: installed as shipped, with nothing for the usual fixup to
    # strip or patch.
    dontStrip = true;
    dontPatchELF = true;

    # - AGENT_BROWSER_EXECUTABLE_PATH: the browser, as a default, so a
    #   user's own value (or --executable-path, or --cdp) still wins.
    # - Refused: `upgrade` (installs a second, unpatched copy with npm, pnpm,
    #   bun or brew, which shadows this one), `install` (downloads Chrome for
    #   Testing, which can't start on NixOS) and `doctor --fix` (the same).
    # - Where unprivileged user namespaces are blocked (Ubuntu 23.10 on),
    #   Chromium from the store can't start its sandbox; it's never turned
    #   off, but a hint names the README section with the remedy.
    installPhase = ''
      runHook preInstall
      install -Dm755 $src $out/libexec/agent-browser/agent-browser
      makeWrapper $out/libexec/agent-browser/agent-browser $out/bin/agent-browser \
        ${
          guard.refuse {
            name = "agent-browser";
            simple = true;
            commands = [ "upgrade" ];
          }
        } \
        ${
          guard.refuse {
            name = "agent-browser";
            simple = true;
            commands = [ "install" ];
            text =
              "agent-browser is installed by Nix (t3code-nix): `install` downloads Chrome for Testing, which can't start on NixOS. "
              + "For Google Chrome, choose browser = \"google-chrome\" (agent-browser.override, or programs.t3code.agentTools.agent-browser.browser), "
              + "or set AGENT_BROWSER_EXECUTABLE_PATH; see \"Agent tools\" in the t3code-nix README.";
          }
        } \
        ${guard.refuseAgentBrowserDoctorFix} \
        --set-default AGENT_BROWSER_EXECUTABLE_PATH ${executable} \
        --run ${lib.escapeShellArg ''[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" != 1 ] || echo 'agent-browser: this system blocks unprivileged user namespaces, so Chromium may not start; see "Agent tools" in the t3code-nix README.' >&2''}
      ${versions.installLicenses pin}
      runHook postInstall
    '';

    passthru = {
      browser = chosen;
      inherit browserChoice browserChannel executable;
      # What the browser pins' nixpkgs allows (the caller's unfree settings).
      browserUnfree = versions.unfreeConfig;
    };

    meta = {
      description = "Headless browser automation CLI for AI agents";
      homepage = "https://github.com/vercel-labs/agent-browser";
      license = lib.licenses.asl20;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = versions.platforms pin;
      mainProgram = "agent-browser";
    };
  }
)
