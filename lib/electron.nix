# Which Electron the desktop app runs on: upstream's bundled one, or nixpkgs'
# electron_N-bin of the same major. Pure: no unpacking, no building. The package
# throws `error` and prints `warning`.
#
#   setting   "auto" | "bundled" | "nixpkgs" | an Electron package
#   bundled   the pin's `electron` field: "X.Y.Z", or null when unknown
#   pkgs      the nixpkgs the package set is built on
#   fallback  true when ci/electron-fallback.json has an active entry for
#             this pin (see readFallback)
{ lib }:
let
  semver = v: builtins.isString v && builtins.match "[0-9]+\\.[0-9]+\\.[0-9]+" v != null;
  major = v: lib.head (lib.splitString "." v);

  # nixpkgs' electron_N-bin, or why it can't be used: missing, a removed
  # major (a throwing alias), marked insecure (a major Electron no longer
  # supports), or not available on this platform.
  nixpkgsElectron =
    pkgs: n:
    let
      attr = "electron_${n}-bin";
      p = pkgs.${attr};
      version = builtins.tryEval p.version;
      drv = builtins.tryEval p.drvPath;
      insecure = (p.meta.knownVulnerabilities or [ ]) != [ ];
    in
    if !(pkgs ? ${attr}) then
      {
        why = "this nixpkgs has no ${attr}";
      }
    else if !version.success || !drv.success && !insecure then
      {
        why = "this nixpkgs' ${attr} can't be evaluated (removed)";
      }
    else if !(semver version.value) || major version.value != n then
      {
        why = "this nixpkgs' ${attr} is ${toString version.value}, not major ${n}";
      }
    else if insecure then
      {
        why = "this nixpkgs' ${attr} is marked insecure";
      }
    else if !lib.meta.availableOn pkgs.stdenv.hostPlatform p then
      {
        why = "this nixpkgs' ${attr} isn't available on ${pkgs.stdenv.hostPlatform.system}";
      }
    else
      {
        package = p;
        inherit attr;
        version = version.value;
      };

  choose =
    {
      setting,
      bundled,
      pkgs,
      fallback ? false,
    }:
    let
      known = semver bundled;
      found =
        if known then
          nixpkgsElectron pkgs (major bundled)
        else
          { why = "the bundled version isn't known"; };
      newEnough = found ? package && lib.versionAtLeast found.version bundled;
      bundledLabel = if known then bundled else "unknown";
      useBundled = reason: {
        choice = "bundled";
        name = null;
        version = bundled;
        package = null;
        inherit reason;
      };
      useNixpkgs = reason: {
        choice = "nixpkgs";
        name = found.attr;
        inherit (found) version package;
        inherit reason;
      };
      fallbackWarning = "t3code: this release's nixpkgs Electron failed t3code-nix's tests (see the electron-fallback issue); built on it as asked";
      base =
        if setting == "bundled" then
          useBundled "set to bundled"
        else if setting == "auto" then
          if !known then
            useBundled "auto: the bundled version isn't known"
          else if !(found ? package) then
            useBundled "auto: ${found.why}"
          else if !newEnough then
            useBundled "auto: nixpkgs' ${found.version} is older than bundled ${bundled}"
          else if fallback then
            useBundled "auto: this release's nixpkgs Electron failed t3code-nix's tests on one or both systems (fallback)"
          else
            useNixpkgs "auto: nixpkgs ${found.version} >= bundled ${bundled}"
        else if setting == "nixpkgs" then
          if !known then
            {
              error = "t3code: electron = \"nixpkgs\" needs the bundled Electron version, which this release doesn't record; use electron = \"auto\" or \"bundled\".";
            }
          else if !(found ? package) then
            {
              error = "t3code: electron = \"nixpkgs\" needs nixpkgs' electron_${major bundled}-bin (T3 Code bundles Electron ${bundled}), but ${found.why}; use electron = \"auto\" or \"bundled\", or a newer nixpkgs.";
            }
          else if !newEnough then
            {
              error = "t3code: electron = \"nixpkgs\": this nixpkgs' ${found.attr} is ${found.version}, older than the bundled ${bundled}; use electron = \"auto\" or \"bundled\", or a newer nixpkgs.";
            }
          else
            useNixpkgs "set to nixpkgs (${found.version})"
            // lib.optionalAttrs fallback { warning = fallbackWarning; }
        else if lib.isDerivation setting then
          let
            v = setting.version or null;
          in
          if !known then
            {
              error = "t3code: an Electron package needs the bundled Electron version, which this release doesn't record; use electron = \"auto\" or \"bundled\".";
            }
          else if !(semver v) || major v != major bundled then
            {
              error = "t3code: the Electron package must be major ${major bundled} (T3 Code bundles ${bundled}), not ${toString v}.";
            }
          else
            {
              choice = "package";
              name = lib.getName setting;
              version = v;
              package = setting;
              reason =
                if lib.versionOlder v bundled then
                  "set to a package (${v}, older than bundled ${bundled})"
                else
                  "set to a package (${v})";
            }
            // (
              let
                warnings =
                  lib.optional (setting.stdenv.drvPath or null != pkgs.stdenv.drvPath)
                    "t3code: the Electron package doesn't come from the nixpkgs T3 Code is built on (its stdenv differs); two nixpkgs revisions in one app can break it. Take it from the same nixpkgs."
                  ++ lib.optional fallback "t3code: this release's nixpkgs Electron failed t3code-nix's tests (see the electron-fallback issue); built on your Electron package as asked, which may fail the same way";
              in
              lib.optionalAttrs (warnings != [ ]) { warning = lib.concatStringsSep "\n" warnings; }
            )
        else
          {
            error = "t3code: electron must be \"auto\", \"bundled\", \"nixpkgs\" or an Electron package.";
          };
    in
    base // { bundled = bundledLabel; };

  # The forced-nixpkgs variant is testable only when auto would pick nixpkgs
  # with no fallback (a known bundled version, a usable nixpkgs Electron of
  # its major, at least as new).
  nixpkgsApplicable =
    { bundled, pkgs }:
    (choose {
      setting = "auto";
      inherit bundled pkgs;
    }).choice == "nixpkgs";

  # ci/electron-fallback.json: { "<pin>": { version, assets, nixpkgs } }.
  # The schema: keys among t3code and t3code-nightly; each entry
  # exactly version (a non-empty string), assets (exactly the flake's systems,
  # each an SRI sha256) and nixpkgs (40 hex). Anything else is malformed.
  systems = [
    "aarch64-linux"
    "x86_64-linux"
  ];
  valid =
    data:
    let
      entry =
        e:
        builtins.isAttrs e
        &&
          builtins.attrNames e == [
            "assets"
            "nixpkgs"
            "version"
          ]
        && builtins.isString e.version
        && e.version != ""
        && builtins.isString e.nixpkgs
        && builtins.match "[0-9a-f]{40}" e.nixpkgs != null
        && builtins.isAttrs e.assets
        && builtins.attrNames e.assets == systems
        && builtins.all (
          s:
          builtins.isString e.assets.${s} && builtins.match "sha256-[A-Za-z0-9+/]{43}=" e.assets.${s} != null
        ) systems;
    in
    builtins.isAttrs data
    && data != { }
    && builtins.all (
      k:
      builtins.elem k [
        "t3code"
        "t3code-nightly"
      ]
    ) (builtins.attrNames data)
    && builtins.all (k: entry data.${k}) (builtins.attrNames data);

  # The parsed file, or { } (absent, or of the wrong shape: then with a
  # warning). JSON that doesn't parse fails the evaluation (fromJSON's error
  # escapes tryEval), as the electron-fallback check notes.
  readFallback =
    file:
    if !builtins.pathExists file then
      { }
    else
      let
        parsed = builtins.tryEval (builtins.fromJSON (builtins.readFile file));
      in
      if parsed.success && valid parsed.value then
        parsed.value
      else
        lib.warn
          "t3code-nix: ${toString file} is malformed; ignored (the electron-fallback check fails on it)"
          { };

  # Whether an entry is active for this pin: its version, both systems' .deb
  # hashes and the nixpkgs revision in flake.lock are exactly the entry's.
  activeFor =
    {
      entries,
      pinName,
      pin,
      rev,
    }:
    let
      e = entries.${pinName} or null;
    in
    e != null
    && e.version == pin.version
    && e.nixpkgs == rev
    && builtins.all (s: (pin.assets.${s}.hash or null) == e.assets.${s}) systems;

  # ci/electron-runtime.json (scripts/lib/electron-fallback.ts): { "<pin>": {
  # "<system>": { choice, version, bundled, rev } } }, what each Desktop app
  # pin's auto picks without the fallback. The schema: keys among t3code and
  # t3code-nightly; each exactly the flake's systems; each entry exactly those
  # four keys, bundled and version X.Y.Z or null, rev 40 hex, and nixpkgs with
  # both known or bundled with version = bundled.
  semverOrNull = v: v == null || semver v;
  runtimeEntry =
    e:
    builtins.isAttrs e
    &&
      builtins.attrNames e == [
        "bundled"
        "choice"
        "rev"
        "version"
      ]
    && semverOrNull e.bundled
    && semverOrNull e.version
    && builtins.isString e.rev
    && builtins.match "[0-9a-f]{40}" e.rev != null
    && (
      if e.choice == "nixpkgs" then
        e.version != null && e.bundled != null
      else
        e.choice == "bundled" && e.version == e.bundled
    );
  runtimeValid =
    data:
    builtins.isAttrs data
    && data != { }
    && builtins.all (
      k:
      builtins.elem k [
        "t3code"
        "t3code-nightly"
      ]
      && builtins.isAttrs data.${k}
      && builtins.attrNames data.${k} == systems
      && builtins.all (s: runtimeEntry data.${k}.${s}) systems
    ) (builtins.attrNames data);

  # What's wrong with a record on one system, as messages ([ ] when nothing):
  # malformed, or an entry that describes its tree (the pin's bundled version
  # and flake.lock's nixpkgs revision) and isn't what the package evaluates
  # to. An absent file and entries for another tree are fine: they are
  # never shown.
  #   present    whether the file exists
  #   record     the parsed file (anything when absent)
  #   pins       { <pin> = the pin, or null }
  #   rev        flake.lock's nixpkgs revision
  #   evaluated  { <pin> = { choice, version }, or null }
  runtimeProblems =
    {
      present,
      record,
      system,
      pins,
      rev,
      evaluated,
    }:
    if !present then
      [ ]
    else if !runtimeValid record then
      [ "ci/electron-runtime.json is malformed (see lib/electron.nix)" ]
    else
      lib.concatMap (
        pinName:
        let
          e = record.${pinName}.${system};
          pin = pins.${pinName} or null;
          bundled = if pin != null && semver (pin.electron or null) then pin.electron else null;
          # A bundled choice's version is the pin's `electron` as it is
          # ("unknown", say): anything but X.Y.Z is null, as in the file.
          got =
            let
              g = evaluated.${pinName} or null;
            in
            if g == null then null else g // { version = if semver g.version then g.version else null; };
          show = c: v: "${c} ${if v == null then "(version unknown)" else v}";
        in
        if pin == null || e.bundled != bundled || e.rev != rev then
          [ ]
        else if got == null then
          [ "${pinName} on ${system}: recorded ${show e.choice e.version}, but there is no such package" ]
        else if got.choice != e.choice || got.version != e.version then
          [
            "${pinName} on ${system}: recorded ${show e.choice e.version}, but the package picks ${show got.choice got.version}"
          ]
        else
          [ ]
      ) (builtins.attrNames record);
in
{
  inherit
    choose
    runtimeValid
    runtimeProblems
    nixpkgsApplicable
    valid
    readFallback
    activeFor
    systems
    ;
}
