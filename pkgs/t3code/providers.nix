# The providers bundled with t3code, by t3code's driver name: exactly the
# built-in drivers of the t3code release being packaged
# (packages/client-runtime/src/providerClients.ts). The t3 smoke test fails
# when t3code adds a driver that isn't here. A provider the set doesn't
# have (the NixOS-stable set before its snapshot has the pin) is left out.
pkgs:
let
  all = {
    codex = "codex";
    claudeAgent = "claude-code";
    cursor = "cursor-agent";
    grok = "grok";
    fx = "fx";
    opencode = "opencode";
    antigravity = "antigravity";
    kiro = "kiro-cli";
    muse = "muse";
    pi = "pi";
  };
in
builtins.mapAttrs (_: name: pkgs.${name}) (
  builtins.removeAttrs all (builtins.filter (d: !(pkgs ? ${all.${d}})) (builtins.attrNames all))
)
