# The providers bundled with t3code, by t3code's driver name: exactly the
# built-in drivers of the t3code release being packaged
# (packages/client-runtime/src/providerClients.ts). The t3 smoke test fails
# when t3code adds a driver that isn't here. A provider the set doesn't
# have (the NixOS-stable set before its snapshot has the pin) is left out.
# The driver -> package names are in provider-names.json, which
# scripts/status.ts reads too (the update notice's version files).
pkgs:
let
  all = builtins.fromJSON (builtins.readFile ./provider-names.json);
in
builtins.mapAttrs (_: name: pkgs.${name}) (
  builtins.removeAttrs all (builtins.filter (d: !(pkgs ? ${all.${d}})) (builtins.attrNames all))
)
