# Turns wrap.nix's `providers` and `excludeProviders` into a list of
# packages. A provider is named by its t3code driver (providers.nix), by
# "claude", or by its package name here; a package is taken as it is.
{ lib, available }:
let
  # "claude", and each package's own name (claude-code, cursor-agent, …),
  # taken from providers.nix so they can't drift.
  aliases = {
    claude = "claudeAgent";
  }
  // lib.mapAttrs' (d: p: lib.nameValuePair (lib.getName p) d) available;
  names = builtins.attrNames available ++ builtins.attrNames aliases;
  driverOrNull = name: if available ? ${name} then name else aliases.${name} or null;

  # The nearest of `known` within two edits, ignoring case, or null.
  distance = name: other: lib.strings.levenshtein (lib.toLower name) (lib.toLower other);
  nearest =
    name: known:
    let
      near = lib.sort (a: b: distance name a < distance name b) (
        builtins.filter (other: distance name other <= 2) known
      );
    in
    if near != [ ] then builtins.head near else null;
  didYouMean =
    name: known:
    let
      near = nearest name known;
    in
    if near != null then ''; did you mean "${near}"?'' else ".";
  unknown =
    name:
    ''t3code: unknown provider "${name}"''
    + didYouMean name names
    + " The providers are: ${lib.concatStringsSep ", " (builtins.attrNames available)}."
    + " See the README, \"Agent providers\".";
  driver =
    name:
    if !builtins.isString name then
      throw "t3code: excludeProviders takes provider names, not packages"
    else
      let
        d = driverOrNull name;
      in
      if d == null then throw (unknown name) else d;
in
{
  inherit unknown didYouMean;

  # wrap.nix's acpRuntimes: a name that isn't one, with the nearest.
  unknownRuntime =
    name: known:
    ''t3code: unknown ACP runtime "${name}"''
    + didYouMean name known
    + " The runtimes are: ${lib.concatStringsSep ", " known}."
    + " See the README, \"ACP registry agents\".";

  select =
    { providers, excludeProviders }:
    let
      excluded = map driver excludeProviders;
      packages = map (p: if builtins.isString p then available.${driver p} else p) providers;
    in
    # Every exclusion is checked, whether or not anything matches it. A
    # package of ours counts as its driver, so it can be excluded too.
    builtins.deepSeq excluded (
      lib.unique (builtins.filter (p: !builtins.elem (driverOrNull (lib.getName p)) excluded) packages)
    );
}
