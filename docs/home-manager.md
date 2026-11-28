# The Home Manager module

`programs.t3code-nix` (`t3code-nix.homeModules.default`, also as
`homeManagerModules`) provides the NixOS module's single-user options with
the same names, defaults, and meaning: `enable`, `channel`, `nixpkgs`,
`providers`, `excludeProviders`, `providersOnPath`, `electron`,
`acpRuntimes`, `telemetry.enable` ([Usage data](details.md#usage-data)),
`updateCheck.enable` ([Update notices](details.md#update-notices)),
`agentTools.*`, `cli.*`, `package`, and `server.*` without `users` and
`openFirewall`.

It installs into your profile (`home.packages`), and `server.enable` writes
`t3code-server` as your own systemd user service. It works on NixOS and on
other Linux distros (`x86_64` and `aarch64`); it is tested with Home
Manager's `master` branch and should work with `release-26.05`.

The NixOS module accepts `programs.t3code-nix` as an alias for
`programs.t3code`, so a block of these options reads the same in both.

## What Home Manager can't do

These are machine-wide settings. Setting one under Home Manager stops the
switch with a message saying where it lives.

| NixOS option | Under Home Manager |
| --- | --- |
| `binaryCache` | add the [binary cache](../README.md#binary-cache) yourself (below) |
| `claudeCodePolicy` | write the policy file yourself (below), or let the NixOS module do it |
| `runtimeCompat` | `nix-ld` is a system setting: on NixOS, use the NixOS module's `runtimeCompat`; elsewhere your system's own loader runs T3 Code's downloads (best effort) |
| `server.openFirewall` | open the port in your system's firewall |
| `openFirewall`, `port` | open the app's port in your system's firewall, and pin the app to it with `package = t3code-nix.packages.${pkgs.stdenv.hostPlatform.system}.t3code.override { port = 3773; }` |
| `server.users` | the unit is yours alone |

**With Home Manager as a NixOS module** and this flake's NixOS module
imported (no `programs.t3code.enable` needed), the NixOS module handles both
automatically for Home Manager users with `programs.t3code-nix`: it writes
the Claude Code policy (`claudeCodePolicy`, on by default) when at least
one such user bundles `claude-code`, and adds the binary cache
(`binaryCache`, on by default) when at least one uses the app, the server,
or an agent tool. (A user whose `enable` or `providers` depends on what
those settings write—such as `osConfig.environment.etc`—causes infinite
recursion and isn't supported.)

**Home Manager on NixOS, standalone** (not as a NixOS module): the NixOS
module can't see your Home Manager config, so add these lines to your NixOS
config yourself:

```nix
# The Claude Code policy (a copy, not a store symlink).
environment.etc."claude-code/managed-settings.d/10-t3code-nix.json" = {
  mode = "0444";
  text = builtins.toJSON {
    env = { DISABLE_UPDATES = "1"; DISABLE_AUTOUPDATER = "1"; DISABLE_INSTALLATION_CHECKS = "1"; };
  };
};
# The binary cache.
nix.settings = {
  substituters = [ "https://t3code-nix.cachix.org" ];
  trusted-public-keys = [ "t3code-nix.cachix.org-1:FwZvqgRcnUjCSEUmdosysof1pTedbm/TTmlk8IeDsJA=" ];
};
```

**On another distro:** put the cache's two values in `/etc/nix/nix.conf` as
`extra-substituters` and `extra-trusted-public-keys` and restart the daemon
(see [Binary cache](../README.md#binary-cache)), and write
`{"env":{"DISABLE_UPDATES":"1","DISABLE_AUTOUPDATER":"1","DISABLE_INSTALLATION_CHECKS":"1"}}`
to `/etc/claude-code/managed-settings.d/10-t3code-nix.json`.
`t3code-nix doctor` checks both and reports the fix for your setup.

## Other Linux distros

- **GPU drivers.** The desktop app is Electron and needs your system's
  graphics drivers. Prefer Home Manager's `targets.genericLinux.gpu`
  (exposes drivers in `/run/opengl-driver` after a one-time `sudo` step, no
  wrapper). Alternatively, if you use `targets.genericLinux.nixGL.packages`,
  the module wraps the desktop app with it—note that nixGL's
  `LD_LIBRARY_PATH` and driver variables are inherited by everything the app
  starts (server, providers, terminal, agent commands), which can cause host
  programs to load Nix's graphics libraries. Don't enable both (Home Manager
  warns).
- **User namespaces.** Electron's sandbox needs unprivileged user
  namespaces. On distros that restrict them (Ubuntu 23.10+ by default), the
  app quits on startup with a `chrome-sandbox` SUID error. Turn the
  restriction off or allow `userns` in an AppArmor profile (see the note
  under [Agent tools](details.md#agent-tools)).
- **Starting the server at boot** needs lingering, which Home Manager can't
  set: `loginctl enable-linger $USER` (on NixOS,
  `users.users.<name>.linger = true`).
- **The overlay:** standalone Home Manager imports its own nixpkgs, so put
  any overlay in `nixpkgs.overlays` inside your Home Manager config, not on
  the `pkgs` you pass in. The module itself needs no overlay.

## Home Manager's own `programs.t3code`

Home Manager has its own `programs.t3code` (settings, keybindings, themes,
and a server). You can keep using it alongside this module for settings,
keybindings, and themes:

- With this module's app enabled, Home Manager's `programs.t3code.package`
  is defaulted to `null` (below `mkDefault`) so it doesn't install a second
  app while its settings still apply. Setting its `package` anyway stops the
  switch with an error naming both.
- With only this module's server enabled, its `package` stays and this
  module's `t3` wins in your profile.
- Both modules' servers can't be enabled together (they contend for port
  3773 and `~/.t3`); enabling its server alongside this module's app stops
  the switch too—use `programs.t3code-nix.server.enable` instead.
- Its settings, keybindings, and themes write to `~/.t3/userdata` (the
  desktop app's home, not a separate `server.home`). Its `userSettings` go
  into the Nix store even in mutable mode, so keep secrets out of them.
  Removing its module leaves mutable settings files and copied themes in
  `~/.t3`.

On a Home Manager without that module, none of this applies.

## The server under Home Manager

Everything in [Running the server](server.md) applies, with these
differences:

- **Switching.** The unit is wanted by `default.target`. With Home
  Manager's default `systemd.user.startServices` (`sd-switch`) and your user
  manager running, the first switch starts it. Switching to a new version
  doesn't restart a running server (`X-SwitchMethod = keep-old`): the new
  version starts on the unit's next start (a reboot with lingering, your
  first session after the manager stopped, or
  `systemctl --user restart t3code-server`). Rollbacks behave the same way.
  With `startServices = "suggest"` (which ignores `keep-old`) or without a
  running user manager, run `systemctl --user daemon-reload` and
  start/restart/stop `t3code-server` yourself.
- **`systemd.user.enable`** must be on (the default on Linux); otherwise
  the switch stops.
- **First boot with lingering** (Home Manager as a NixOS module): your user
  manager may start before Home Manager's activation writes the unit;
  activation then starts it. (`home-manager.startAsUserService` should
  behave the same, untested.)
- **Turning it off:** the next switch removes and stops the unit while
  keeping your T3 home and [database copies](server.md#database-copies). If
  you're removing Home Manager, removing `home-manager.users.<name>`,
  rolling back past the module, or disabling `systemd.user.enable` in the
  same switch, switch first with the server disabled. Otherwise clean up
  manually: `systemctl --user disable --now t3code-server`, remove
  `t3code-server.service` and its `default.target.wants/` link from
  `systemd/user/` under Home Manager's `xdg.configHome` (`~/.config` by
  default), and run `systemctl --user daemon-reload`.
- **Moving between servers** (NixOS module, upstream, Home Manager's own, or
  this one): stop the old one first, then verify with
  `systemctl --user status t3code-server` and `t3code-nix doctor`.
- **Both modules' servers** for the same user (Home Manager as a NixOS
  module): the Home Manager module warns. Your unit in
  `~/.config/systemd/user` shadows the system unit for you; other users may
  still run the system unit on the same port.
- **Several users on one machine** each need their own `port` and T3 home.
- **`environmentFile`** must be readable by your user.
- **Tailscale Serve** is supported with Home Manager as a NixOS module and
  `services.tailscale` enabled (the switch stops without it). Elsewhere `t3`
  looks for `tailscale` on `PATH` (untested). Its HTTPS port is
  machine-wide, so two users on the same `tailscaleServe.port` contend.
