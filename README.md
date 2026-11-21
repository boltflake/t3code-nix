<img src="docs/header.svg" width="100%" alt="t3code-nix: T3 Code and all agent providers, packaged for Nix within minutes">

<p align="center">
  <a href="https://swsammy.github.io/t3code-nix/"><img src="docs/live-status.svg" width="272" alt="Live: package status"></a>
  <br>
  <a href="https://swsammy.github.io/t3code-nix/"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fswsammy.github.io%2Ft3code-nix%2Fbadges%2Ft3code.json&query=%24.message&label=T3%20Code%20latest&color=3f6cc0&style=flat-square" alt="T3 Code on the latest channel: the version this flake ships now"></a>
  <a href="https://swsammy.github.io/t3code-nix/"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fswsammy.github.io%2Ft3code-nix%2Fbadges%2Ft3code-nightly.json&query=%24.message&label=nightly&color=6e5494&style=flat-square" alt="T3 Code on the nightly channel: the version this flake ships now"></a>
</p>

This flake packages the [<img src="docs/logos/t3code.png" height="16" alt=""> T3 Code](https://github.com/pingdotgg/t3code) desktop app and CLI for x86_64 and aarch64 Linux. It includes every supported agent provider, plus a few useful agent tools. This is a community project, not affiliated with or endorsed by the T3 Code team or any provider's vendor.

<img src="docs/how-updates-reach-you.svg" width="100%" alt="How an update reaches you: an upstream release, checked for every minute, then built and tested on x86_64 and aarch64, this flake updated on GitHub only if both pass, then free packages cached. On your system: update your flake input and rebuild">

- **<ins>Always up to date</ins>.** T3 Code's releases on the latest and nightly channels are detected, tested and published automatically, within minutes of upstream.
- **All supported agents:** Codex, Claude, Cursor, Grok, fx, OpenCode, Antigravity, Kiro, Muse and pi.
- **One line to install.** `programs.t3code.enable = true;` installs the app and every provider.
- **Tested before it's published**. Automatic tests must pass for the flake to update.
- **A binary cache**. Free packages on the latest channel are cached and are ready to run after download.
- **Update notifications.** T3 Code tells you as soon as it sees a newer version of a provider.
- **Nix stays in charge.** Built-in updaters are disabled. When you see the update icon and t3code-nix has published that version, run `nix flake update t3code-nix` and rebuild.

## Contents

- [Quick start](#quick-start)
- [Setup](#setup)
- [Packages](#packages)
- [The NixOS module](#the-nixos-module)
- [Running the server](#running-the-server)
- [Binary cache](#binary-cache)
- [Unfree packages](#unfree-packages)
- [NixOS stable](#nixos-stable)
- [When something isn't working: `t3code-nix doctor`](#when-something-isnt-working-t3code-nix-doctor),
  and [reporting problems](#reporting-problems)
- [Channels, pinning and rolling back](#channels-pinning-and-rolling-back)
- [Following new releases](#following-new-releases)
- [Details](#details)
- [Maintainer notes](#maintainer-notes)

## Quick start

Try **t3code-nix** without touching your config:

```sh
nix run github:swsammy/t3code-nix              # downloads and opens the T3 Code app, with all 10 agent providers
nix run github:swsammy/t3code-nix#t3 -- serve  # starts a T3 Code server
nix run github:swsammy/t3code-nix#codex        # runs one agent (Codex) in the terminal
```

## Setup

<details id="with-flakes" open>
<summary><b>Flake</b></summary>
<br>

Add t3code-nix and its module:

```nix
{
  inputs.t3code-nix.url = "github:swsammy/t3code-nix";
  # Don't add `inputs.t3code-nix.inputs.nixpkgs.follows`: see "Binary cache".

  outputs = { nixpkgs, t3code-nix, ... }: {
    nixosConfigurations.my-machine = nixpkgs.lib.nixosSystem {
      modules = [
        ./configuration.nix                           # your existing system configuration
        t3code-nix.nixosModules.default
        {
          programs.t3code = {
            enable = true;

            # Optional: uncomment what you need
            # providers = [ "codex" "claude" ];       # install only these providers (default: all ten)
            # excludeProviders = [ "grok" ];          # or leave some out
            # channel = "nightly";                    # T3 Code nightly (default: latest)
            # nixpkgs = "stable";                     # NixOS stable's libraries (default: unstable)
            # cli.enable = true;                      # include the headless `t3` CLI
            # server.enable = true;                   # keep T3 Code running in the background for your phone, laptop or browser
            # server.lan = true;                      # reachable on your local network and tailnet
            # server.openFirewall = true;             # open its port (3773) in the firewall
                                                      # Agent Tools:
            # agentTools.agent-browser.enable = true; # a headless browser CLI for agents (lets agents open, click and screenshot web pages)
            # agentTools.boat.enable = true;          # boat.dev's sandbox CLI for agents
          };
        }
      ];
    };
  };
}
```

For a machine with no desktop, run T3 Code as a server, without the
desktop app:

```nix
{
  inputs.t3code-nix.url = "github:swsammy/t3code-nix";
  # Don't add `inputs.t3code-nix.inputs.nixpkgs.follows`: see "Binary cache".

  outputs = { nixpkgs, t3code-nix, ... }: {
    nixosConfigurations.my-server = nixpkgs.lib.nixosSystem {
      modules = [
        ./configuration.nix                           # your existing system configuration
        t3code-nix.nixosModules.default
        {
          programs.t3code = {
            # No `enable = true`: the desktop app isn't installed.
            server.enable = true;                     # keep T3 Code running in the background, with `t3` on PATH
            server.users = [ "amber" ];               # your user name
            server.lan = true;                        # reachable on your local network and tailnet
            server.openFirewall = true;               # open its port (3773) in the firewall

            # Optional: uncomment what you need
            # providers = [ "codex" "claude" ];       # bundle only these (default: all ten)
            # agentTools.agent-browser.enable = true; # lets agents open, click and screenshot web pages
            # agentTools.boat.enable = true;          # boat.dev's sandbox CLI for agents
          };

          # Start the server at boot, without anyone logging in:
          users.users.amber.linger = true;
        }
      ];
    };
  };
}
```

Then pair your devices with `t3 pair` (see [Running the server](#running-the-server)).
All module options are documented in [The NixOS module](#the-nixos-module).

</details>

<details id="not-a-flake-yet">
<summary><b>If your system isn't a flake yet</b></summary>
<br>

Flakes are not enabled by default on NixOS.

1. Turn them on: add this line to your `configuration.nix`:

   ```nix
   nix.settings.experimental-features = [ "nix-command" "flakes" ];
   ```

2. Rebuild:

   ```sh
   sudo nixos-rebuild switch
   ```

3. Turn your system into a flake with T3 Code:

   ```sh
   sudo nix run github:swsammy/t3code-nix#init
   sudo nixos-rebuild switch
   ```

   This creates `/etc/nixos/flake.nix` with T3 Code enabled. It follows the same NixOS branch your channel does, so your system stays on its NixOS release, though the first rebuild can bring that branch's newer updates. An existing `flake.nix` is never overwritten. To see the file first, run `sudo nix run github:swsammy/t3code-nix#init -- --dry-run`.

   Its configuration is named after your host, so a plain `nixos-rebuild switch` builds it. If `/etc/nixos` is a git repository, `init` adds the file to it (or tells you the command, when the repository is another user's). It prints the rebuild command to run; use that one if it differs. `nix run github:swsammy/t3code-nix#init -- --help` lists its options, and the file's comments show the options for the providers, the server and the agent tools.

   To go back, delete `flake.nix` (and `flake.lock`); if you've rebuilt with it, rebuild again (or boot the previous generation). `nix flake init -t github:swsammy/t3code-nix` gives you the same template to fill in yourself.

To try a single command without changing your configuration, put `--extra-experimental-features 'nix-command flakes'` after `nix` instead.

</details>

<details id="without-flakes">
<summary><b>Without flakes</b></summary>
<br>

You don't need flakes to use t3code-nix. Everything the flake has (the
app, the NixOS module and the overlay) also works with the classic Nix
tools: `nix-env`, `nix-shell`, `nix-build`, or an `import` in your
`configuration.nix`.

```sh
# Install the T3 Code app for your user (run it again to update):
nix-env -f https://github.com/swsammy/t3code-nix/archive/main.tar.gz -iA t3code

# Or try the t3 CLI in a temporary shell, without installing anything:
nix-shell -p '(import (fetchTarball "https://github.com/swsammy/t3code-nix/archive/main.tar.gz") { }).t3'
```

```nix
# configuration.nix
let
  t3code-nix = import (fetchTarball "https://github.com/swsammy/t3code-nix/archive/main.tar.gz") { };
in
{
  imports = [ t3code-nix.nixosModules.default ];
  programs.t3code.enable = true;
}
```

- The packages for your machine are right at the top: `t3code` (the
  app), `t3`, `codex` and the rest. To get another machine type's
  packages, pass it in the `{ }`, for example
  `{ system = "aarch64-linux"; }`.
- For anything else the flake has, `t3code-nix.flake` has it all.
- Your own nixpkgs config and overlays don't apply to them, so they're the
  flake's builds, which the binary cache holds.
- For a fixed version, use a commit's tarball
  (`…/archive/<commit>.tar.gz`), or the tarball of a `t3code-v*` tag.

</details>

## Packages

Where to see what the flake has at this moment:

- **[The status page](https://swsammy.github.io/t3code-nix/)**: every
  pinned package's version on `main`, when t3code-nix published it and,
  where upstream's release time is known, how long after it (measured or
  estimated); the median delivery time over the last 30 days, once there
  are enough deliveries to count; and each package's update status, such as
  a newer version found and what it's waiting for, a version being tested,
  or an update held and why.
- **The GitHub Releases**: one per T3 Code version on the latest channel, listing every
  package in that set (see [Following new releases](#following-new-releases)).
- **`t3code-nix doctor`** on your machine: the versions your build bundles,
  and which copy of each provider T3 Code will use there.
- **[`versions/`](versions/)** in the repository: one pin file per upstream
  download (T3 Code's app and CLI for each channel, each provider, boat and
  agent-browser), with its version and files; the nixpkgs pins for NixOS
  stable and agent-browser's browsers; and `stable/`, the set NixOS stable
  uses. The preview browser's pin is inside each T3 Code pin file.

### T3 Code

| Package | What it is |
| --- | --- |
| `t3code` (default) | T3 Code desktop app, latest channel, with all ten providers.<br><br>Its free parts (the app, codex, fx, opencode, pi) come from the [binary cache](#binary-cache). The six unfree providers and the preview browser are downloaded from their vendors |
| `t3code-nightly` | the same, nightly channel (the nightly app itself isn't in the binary cache) |
| `t3` / `t3-nightly` | T3 Code's headless CLI and server, with all ten providers |
| `t3code-free`, `t3-free` | the latest channel's app and headless CLI with only the four free providers (codex, fx, opencode, pi) and no preview browser. Comes ready-made from the binary cache (and its libraries from cache.nixos.org), with nothing to build or patch. |
| `t3code-unwrapped`, `t3-unwrapped` (+ `-nightly`) | the same without providers or the preview browser |
| `chrome-headless-shell` (+ `-nightly`) | the browser T3 Code's HTML previews use, at the version its release pins, patched for NixOS (unfree) |

### Agent providers

`t3code` and `t3` bundle all ten providers. Pick some, or leave some out, by
name:

```nix
t3code.override { providers = [ "codex" "claude" ]; }
t3code.override { excludeProviders = [ "grok" "muse" ]; }
```

The names are T3 Code's own: `codex`, `claudeAgent` (or `claude`), `cursor`,
`grok`, `fx`, `opencode`, `antigravity`, `kiro`, `muse`, `pi`. This flake's
package names (`claude-code`, `cursor-agent`, `kiro-cli`) work too.

`providers` also takes packages, mixed with names if you like
(`providers = [ pkgs.codex "opencode" ]`), for a provider built some other
way.

**Signing in** is per provider and depends on its backend. Most need their
own account, set up once with the provider's own command (for example
`codex login`) or from T3 Code. Some can also run against a local model.

| Package | What it is |
| --- | --- |
| `codex` | Codex: OpenAI's coding agent (daemon auto-start and self-update off) |
| `fx` | fx: Vercel's native coding agent |
| `opencode` | OpenCode: an open-source coding agent built for the terminal |
| `pi` | pi: a minimal terminal coding agent |
| `claude-code` | Claude Code: Anthropic's coding agent (unfree) |
| `cursor-agent` | Cursor Agent: Cursor's coding agent; installs `agent` and `cursor-agent` (unfree) |
| `grok` | Grok Build: xAI's coding agent (unfree) |
| `antigravity` | Antigravity: Google Antigravity's CLI, `agy` (unfree) |
| `kiro-cli` | Kiro CLI: Kiro's coding agent for the terminal (unfree) |
| `muse` | Muse Code: Meta's coding agent (unfree) |

### Setup and troubleshooting

| Package | What it is |
| --- | --- |
| `doctor` | `t3code-nix doctor`: tells you why something isn't working (see [below](#when-something-isnt-working-t3code-nix-doctor)) |
| `init` | sets up a NixOS system that isn't a flake yet as one with T3 Code (see [Setup](#setup)) |

### Extra tools for agents

[Agent tools](#agent-tools), not part of T3 Code:

| Package | What it is |
| --- | --- |
| `boat` | boat: boat.dev's cloud sandboxes from the command line (self-update off) |
| `agent-browser` | agent-browser: Vercel's headless browser CLI for agents. It drives ungoogled-chromium from nixos-unstable by default.<br><br> You can choose `chromium` or `google-chrome` instead, and also take the browser from the newest NixOS release with `browserChannel = "stable"` (see [Agent tools](#agent-tools)). |

The browsers come from nixpkgs. This flake holds each one at a pinned version and moves it forward automatically when nixpkgs gets a newer one and this flake's tests pass with ungoogled-chromium (Chromium and Chrome are tested too; a failure there opens an issue); the current versions are on the status page.

What each package is built from is in
[docs/acceptance-matrix.md](docs/acceptance-matrix.md).

## The NixOS module

`programs.t3code`'s options:

| Option | Default | What it does |
| --- | --- | --- |
| `enable` | `false` | installs `package` for every user |
| `channel` | `"latest"` | `"latest"` or `"nightly"`: T3 Code's release channel; picks the default `package` and the CLI |
| `nixpkgs` | `"unstable"` | `"unstable"` or `"stable"`: build on nixos-unstable's libraries, or on the current stable NixOS release's ([NixOS stable](#nixos-stable)). It applies to the app, the CLI, the server, the doctor and the agent tools. It doesn't change which T3 Code you get (that's `channel`), and `"stable"` can't be combined with `channel = "nightly"` |
| `providers` | `null` (the package's own) | which providers to bundle, by name, as in [Agent providers](#agent-providers) |
| `excludeProviders` | `[ ]` | providers to leave out, by name |
| `providersOnPath` | `true` | puts the bundled providers on `PATH` too, at low priority |
| `electron` | `null` (the package's own: `"auto"`) | which Electron the desktop app runs on: `"auto"`, `"bundled"`, `"nixpkgs"` or an Electron package (see [The desktop app's Electron](#the-desktop-apps-electron)) |
| `acpRuntimes` | `null` (the package's own: none) | runtimes for agents T3 Code installs from the ACP registry: `"nodejs"`, `"uv"` (see [ACP registry agents](#acp-registry-agents)) |
| `agentTools.boat.enable` | `false` | installs [boat](#agent-tools), with or without the app |
| `agentTools.agent-browser.enable` | `false` | installs [agent-browser](#agent-tools), with or without the app |
| `agentTools.agent-browser.package` | this flake's `agent-browser` | which agent-browser: an `.override { … }` of it, or `pkgs.agent-browser` from the overlay |
| `agentTools.agent-browser.browserChannel` | `null` (the package's own) | `"unstable"` or `"stable"`: which of this flake's browser pins its browser comes from |
| `agentTools.agent-browser.browser` | `null` (the package's own: `"ungoogled-chromium"`) | `"ungoogled-chromium"`, `"chromium"` or `"google-chrome"`: which browser it drives (see [Agent tools](#agent-tools)) |
| `cli.enable` | `false` | installs the headless `t3` too (`t3-nightly` on the nightly channel), bundling what the app bundles, with its shell completions |
| `cli.allowUpstreamService` | `false` | lets this flake's `t3` run the commands for [upstream's own service](#upstreams-own-service), which it refuses |
| `server.*` | off | a T3 Code server as a systemd user service: see [Running the server](#running-the-server) |
| `package` | this flake's `t3code` (`t3code-nightly` on the nightly channel) | what to install: `t3code-free`, `t3`, an `.override { … }` of one, or `pkgs.t3code` from the overlay |
| `binaryCache` | `true` | adds the [binary cache](#binary-cache) and its key to `nix.settings` |
| `claudeCodePolicy` | `true` | when claude-code is bundled, writes the policy drop-in `/etc/claude-code/managed-settings.d/10-t3code-nix.json` with claude's update switches, so a project's or your own `.claude/settings.json` can't turn its self-updater back on (see [Provider updates](#provider-updates)); machine-wide, beside any `managed-settings.json` of your own |
| `runtimeCompat` | `false` | turns on `programs.nix-ld` with the libraries T3 Code's own downloads need; works on its own, without `enable` (see [T3 Code over SSH](#t3-code-over-ssh-runtimecompat)) |

### Example

```nix
programs.t3code = {
  enable = true;
  providers = [ "codex" "claude" ];
  cli.enable = true;
};
```

- The CLI from `cli.enable` then bundles what the app ends up with: the
  same providers, and the preview browser only if the app has it.
- A `package` that has no providers to pick (an `-unwrapped` one, or
  nixpkgs' own `t3code`) can't take them. Setting them then stops the
  rebuild, before anything is built, with a message saying so.

### Without the module

- **A package:** take one from the flake
  (`t3code-nix.packages.${system}.t3code`).
- **Home Manager:** put the package in `home.packages`
  (`home.packages = [ t3code-nix.packages.${pkgs.stdenv.hostPlatform.system}.t3code ];`).
  There's no Home Manager module.
- **The overlay**, `t3code-nix.overlays.default`, puts every package under
  `pkgs.t3code-nix` (`pkgs.t3code-nix.t3`, `pkgs.t3code-nix.codex`), and
  the app and most providers at the top level too. Which ones, and why, is
  under [The overlay](#the-overlay).

## Running the server

`programs.t3code.server` runs this flake's `t3 serve` as a systemd user
service, `t3code-server`, so your other devices can reach this machine.

- It has the same channel and providers as the app.
- It needs no nix-ld, and its version comes from the flake like everything
  else.
- It works without `enable`, so a headless machine gets the server and
  `t3` but not the desktop app.

For example, a server for amber that the other devices on your network
can reach:

```nix
programs.t3code.server = {
  enable = true;
  users = [ "amber" ];
  lan = true;
  openFirewall = true;
};
# Start at boot and keep running after logout, not only while amber is
# logged in:
users.users.amber.linger = true;
```

**Starting at boot** is NixOS's own `users.users.<name>.linger`, not an
option here: it's a choice about the user account, and NixOS already has
the one place for it. Without it, the server runs while the user is logged
in.

| Option | Default | What it does |
| --- | --- | --- |
| `server.enable` | `false` | the `t3code-server` user service, and its `t3` on `PATH` |
| `server.users` | `[ ]` (every user that isn't a system user) | whose session runs it. Each server listens on `port`, so on a machine with several users, name one |
| `server.home` | `null` (`~/.t3`) | its T3 home, `T3CODE_HOME` (`%h` is the home folder; no other `%` specifier) |
| `server.port` | `3773` | `T3CODE_PORT` |
| `server.host` | `null` (127.0.0.1) | `T3CODE_HOST`: an address to listen on, for any client (not with `lan`) |
| `server.lan` | `false` | `T3CODE_LAN`: also accept the local network and tailnet (private addresses only; not with `host`) |
| `server.openFirewall` | `false` | opens `port` in the firewall, for `lan` or `host` (Tailscale Serve and T3 Connect need no open port) |
| `server.tailscaleServe.enable`, `.port` | `false`, `443` | serve it on the tailnet with Tailscale Serve (needs `services.tailscale` and `tailscale set --operator=<user>`) |
| `server.logLevel` | `null` (Info) | `T3CODE_LOG_LEVEL`: `All`, `Trace`, `Debug`, `Info`, `Warn`, `Error`, `Fatal` or `None` |
| `server.environmentFile` | `null` | a file of `NAME=value` lines, read at start and kept out of the Nix store, for secrets or other `T3CODE_*` settings (an absolute path, or under `%h/`). Its values win over the options; set the home with `server.home`, not `T3CODE_HOME` here, since `t3code-nix doctor` only knows `server.home` |

**Pairing.** To use the server from another device (a phone, a laptop, a
browser), pair it: run `t3 pair` on this machine and open the code or link
it gives you on the other device.

The other device must be able to reach the server, and by default it can't:
the server listens only on this machine (127.0.0.1). Make it reachable in
one of these ways first:

- `server.lan = true`: devices on your local network and tailnet
- `server.host`: an address of your choice, for any client that reaches it
- `server.tailscaleServe.enable = true`: over HTTPS on your tailnet
- T3 Connect (below): from anywhere, through T3's relay, with no port open

Until then, `t3 pair` and `t3 status` suggest `t3 up` or `t3 connect`;
this flake's `t3` refuses those (see
[Upstream's own service](#upstreams-own-service)).

**T3 Connect** reaches the server through T3's relay with your T3 account,
from anywhere, with no port open. Once per T3 home:

```sh
t3 connect link                           # sign in: open the link it prints
systemctl --user restart t3code-server    # connects on start
t3 connect status                         # "Other devices can reach this machine"
```

With `server.home` set, add `--base-dir` with that home to both `t3`
commands, with `%h` written as your home folder (for example
`--base-dir ~/.t3-server`).

Through the overlay, T3 Connect uses your nixpkgs' cloudflared, which must be
2025.6.1 or newer.

`t3 connect unlink` turns it off (then restart the server to close the
tunnel), and `t3 connect logout` signs out.

**Logs.** The server logs to the user journal
(`journalctl --user -u t3code-server`), pairing details included, so
whoever can read your journal can read those too.

**Upgrades.** A rebuild doesn't restart a running server, since that would
end any agent turns it's running. The new version starts the next time the
server does (at boot, or at login without linger), or when you run
`systemctl --user restart t3code-server`.

### Database copies

Before a new version of the server first starts, the service copies the
database (`~/.t3/userdata/statev2.sqlite`, with SQLite's online backup) to
`~/.t3/t3code-nix-backups/statev2-<previous version>-<time>.sqlite`, and
keeps the newest three. `<previous version>` is the version this service
last started, or `unknown` when the service first starts on a database
that was already there. With `server.home` set, these paths are under that
home instead of `~/.t3`.

- Each copy is the size of the database, which can be several GB
  (`du -h ~/.t3/userdata/statev2.sqlite`).
- A new version may migrate the database so that an older one won't open
  it. If a rollback to an older generation leaves the server failing, put
  back the copy from the version you rolled back to (changes since then
  are lost), with that copy's file name in the `cp` line:

  ```sh
  systemctl --user stop t3code-server
  cp "$HOME/.t3/t3code-nix-backups/statev2-<version>-<time>.sqlite" ~/.t3/userdata/statev2.sqlite
  rm -f ~/.t3/userdata/statev2.sqlite-wal ~/.t3/userdata/statev2.sqlite-shm
  systemctl --user start t3code-server
  ```

- If a copy fails, the server doesn't start (`systemctl --user status
  t3code-server` says why), and the next start tries again.

### One server per T3 home

The desktop app runs a server of its own on `~/.t3`. So while
`t3code-server` uses that home, the desktop app on the same machine says
"This T3 home is unavailable" and quits. On a machine that runs both,
either:

- start the app with another `T3CODE_HOME`, and pair it with the server
  like any other device, or
- give the server its own `home`, and pass `--base-dir` to the `t3`
  commands meant for it (with `%h` written as your home folder, for
  example `--base-dir ~/.t3-server`).

### Upstream's own service

T3 Code can also install a server of its own: `t3 service install`, `t3 up`
and plain `t3 connect` set up `t3code.service` in `~/.config/systemd/user`.
That service runs T3 Code's own download from `~/.t3/runtime`, not this
flake's build: it has none of the bundled providers, updates itself outside
Nix, and on NixOS starts only with
[`runtimeCompat`](#t3-code-over-ssh-runtimecompat). So this flake's `t3`
refuses those commands, and `t3 update`. The rest of `t3 connect` (`link`,
`login`, `status`, `unlink`, `logout`, `publish`) works for `t3code-server`.

If upstream's service is already installed, remove it with
`t3 service uninstall` before turning on `t3code-server`: only one server
can run on a T3 home (see [One server per T3 home](#one-server-per-t3-home)).
`t3 service protect` doesn't work on NixOS (`/etc/systemd` is read-only);
set that kind of protection in NixOS instead, with `systemd.slices`,
`systemd.services."user@"` and
`systemd.user.services.t3code-server.serviceConfig`.

**Using upstream's service on purpose.** Set `enable`, `cli.enable`,
`cli.allowUpstreamService` and `runtimeCompat` (without the module:
`t3.override { allowUpstreamService = true; }` and `programs.nix-ld` with
the libraries `runtimeCompat` lists in `nixos/module.nix`). Leave
`server.enable` off, or give the two servers different homes and ports.

## Binary cache

A public [Cachix](https://www.cachix.org) cache holds the free packages
of the latest channel: `t3code-unwrapped`, `t3-unwrapped`, `codex`, `fx`,
`opencode`, `pi`, and with them all of `t3code-free` and `t3-free`. It
also holds the agent tools `boat` and `agent-browser` (their nixos-unstable
builds).

It holds free software only. So what comes from where depends on the
package you install:

| You install | From this cache | From each vendor, patched on your machine where needed | Put together on your machine |
| --- | --- | --- | --- |
| `t3code` (the default) or `t3` | the app itself, and Codex, fx, OpenCode and pi | Claude Code, Cursor Agent, Grok, Antigravity, Kiro, Muse, and the preview browser | the small wrapper that bundles them |
| `t3code-free` or `t3-free` | everything | nothing | nothing |
| `t3code-nightly` or `t3-nightly` | Only Codex, fx, OpenCode and pi | the nightly app, the six unfree providers and the preview browser | the wrapper |

- "Patched on your machine" means downloading the vendor's ready-made
  program and, where it needs that, adjusting it to run on NixOS (Grok
  and Muse are static programs, used as they are). It takes seconds per
  package; nothing is compiled.
- The libraries all of these use come from cache.nixos.org as usual.
- Choosing `providers` changes the wrapper, which is then put together on
  your machine; the providers you keep come from the same places as above.
- It's on Cachix's free plan for open-source projects: 5 GB, and when that
  fills, the least recently used entries are removed. A full set for both
  systems is about 1.3 GB compressed (measured for T3 Code 0.1.9 on x86_64
  and doubled; libraries already on cache.nixos.org aren't stored again),
  so the cache has room for several releases. Which ones stay is decided by use, not age.
  A package that has gone is downloaded from its vendor and patched on
  your machine again.

Three ways to use it:

- **The NixOS module** adds it whenever it installs anything: the app,
  the server or an agent tool (`programs.t3code.binaryCache`, on by
  default). It takes effect from the rebuild after the one that turns it
  on.
- **`nix run` and other flake commands** are offered it by this flake's
  `nixConfig`. Nix asks first (or pass `--accept-flake-config`), and then
  uses it only if you're in `trusted-users` or the machine already trusts
  this cache. Otherwise it prints a warning and builds without the cache,
  so add it by hand instead.
- **By hand**, on NixOS:

  ```nix
  nix.settings = {
    substituters = [ "https://t3code-nix.cachix.org" ];
    trusted-public-keys = [ "t3code-nix.cachix.org-1:FwZvqgRcnUjCSEUmdosysof1pTedbm/TTmlk8IeDsJA=" ];
  };
  ```

  Elsewhere, the same two values go in `/etc/nix/nix.conf` as
  `extra-substituters` and `extra-trusted-public-keys`; then restart the
  daemon (`sudo systemctl restart nix-daemon`).

**Don't make this flake follow your nixpkgs.** With

```nix
inputs.t3code-nix.inputs.nixpkgs.follows = "nixpkgs";
```

the packages would be built on your nixpkgs instead of the one this flake pins
(all but the NixOS stable set and agent-browser's browsers, which have pins of
their own).

- The cache holds only what the pinned one produces. Unless yours is at the
  same revision, the store paths differ and the cache has none of them.
- Leaving the input alone means your lock file pins two nixpkgs: yours
  and this flake's. Unless they're the same revision, T3 Code uses its own
  copy of the libraries it needs (glibc, GTK, Mesa and so on), next to
  your system's: several hundred MB, downloaded ready-made from
  cache.nixos.org.

## Unfree packages

Seven of the packages this flake bundles are unfree:

- `claude-code`
- `cursor-agent`
- `grok`
- `antigravity`
- `kiro-cli`
- `muse`
- `chrome-headless-shell`, the [preview browser](#the-preview-browser)
  (and its `-nightly` build)

The flake's own packages (`nix run`, `t3code-nix.packages.${system}.*`, and
what the module installs by default) allow exactly these seven, plus Google
Chrome for agent-browser (below). Nothing else. You don't need
`allowUnfree` for them.

Google Chrome isn't bundled: agent-browser uses it only when you choose it
(`browser = "google-chrome"`, see [Agent tools](#agent-tools)), and
choosing it is the opt-in.

Through the overlay, your own nixpkgs config decides, Google Chrome
included. For an all-free install, use `t3code-free` or `t3-free` (see
[T3 Code](#t3-code)). They're on the latest channel only.

## NixOS stable

`programs.t3code.nixpkgs` picks the libraries T3 Code is built on (Mesa,
GTK, nss, glibc, …). It doesn't change which T3 Code you get: that's
`channel`.

| `nixpkgs` | Libraries | Channels | Binary cache |
| --- | --- | --- | --- |
| `"unstable"` (default) | the `nixos-unstable` this flake pins | latest and nightly | yes |
| `"stable"` | the newest NixOS release, at the revision this flake pins and tests (`versions/nixpkgs-stable.json`) | latest only | no |

```nix
programs.t3code = {
  enable = true;
  nixpkgs = "stable";
};
```

Without the module, the set is `t3code-nix.legacyPackages.<system>.stable`
(`.t3code`, `.t3`, `.agent-browser`, …); without flakes, with
`t3code-nix` imported as [above](#without-flakes), it's
`t3code-nix.stable.t3code`.

**When to use it.** The default packages work on a NixOS stable system too.
Choose `"stable"` if:

- the desktop app has graphics problems. With `"stable"`, its Mesa and GBM
  come from the same release as your system's GPU driver
  (`/run/opengl-driver`); unstable's can drift far enough from it to fail.
  (Not tested on every GPU.)
- you'd rather have libraries that change less often, or nothing from
  unstable at all.

It follows this flake's pin, not your system: unless your system is at the
same revision, you still get a second copy of the libraries.

**What's different.**

- **Not cached.** The binary cache holds only the default packages, so
  this set is patched and put together on your machine. Its libraries
  still come from cache.nixos.org. The only thing compiled is wrap-buddy, a
  small tool OpenCode is patched with (seconds).
- **It can lag.** When a new release fails a check on NixOS stable (on
  either system), the stable set stays on the last versions that passed.
  It catches up the next time everything passes there: after a fix in
  nixpkgs, or with a later T3 Code release. The
  [status page](https://swsammy.github.io/t3code-nix/) says when the set is
  behind, a `stable-behind` issue says why, and each release's notes say
  whether NixOS stable has it.
- **agent-browser** takes its browser (ungoogled-chromium by default) from
  this flake's NixOS stable browser pin instead of the unstable one (see
  [Agent tools](#agent-tools)).
- **A `package` you set yourself** (or `agentTools.agent-browser.package`)
  still wins. `nixpkgs` then still picks the CLI, the server and the
  doctor, and the providers follow the app.

**What it isn't.**

- A rollback: to stay on an older T3 Code, pin a tag (see
  [Channels, pinning and rolling back](#channels-pinning-and-rolling-back)).
- Your own nixpkgs: for that, see the overlay (and
  [why not `follows`](#binary-cache)).

## When something isn't working: `t3code-nix doctor`

`programs.t3code.enable` (or `server.enable`) installs `t3code-nix
doctor`, which checks the usual reasons T3 Code or a provider misbehaves
on NixOS, usually in a few seconds (asking claude about its machine
policy can take up to 30). Without the module, run
`nix run github:swsammy/t3code-nix#doctor`. That one doesn't know your
configuration: it checks the default packages, and can't tell whether you
meant to run the server.

```
$ t3code-nix doctor
t3code-nix doctor (T3 Code 0.1.9, latest channel)
Electron 44.10.2 from nixpkgs (bundled: 44.10.1; auto: nixpkgs 44.10.2 >= bundled 44.10.1)

Providers (looked up on this terminal's PATH; T3 Code takes yours from your login
shell, which is usually the same, and falls back to the ones it bundles):
  OK       antigravity 1.5.6 (bundled)
  WARN     claude-code: T3 Code uses your claude, installed outside Nix (/home/me/.local/bin/claude; version not checked), not the bundled 2.1.322
           → if it's an old self-installed copy (a provider's own updater puts them in your home, for example in ~/.local/bin, ~/.grok/bin or ~/.opencode/bin), delete it so the bundled one is used
  OK       codex 0.167.2 (bundled)
  OK       cursor-agent: built into T3 Code (its SDK); nothing to find on PATH
  …
  (A binary path set in T3 Code's own provider settings comes before all of this.)

This system:
  OK       binary cache: https://t3code-nix.cachix.org is set up
  PROBLEM  upstream's service is installed (/home/me/.config/systemd/user/t3code.service), and without nix-ld its downloaded T3 Code can't start
           → `t3 service uninstall`, or `systemctl --user disable --now t3code.service` and delete …
  …
```

Each line is `OK`, `WARN` or `PROBLEM`; `WARN` and `PROBLEM` lines say
what to do under them (`→`). It exits with 1 if there's a problem.

It only reads: it writes nothing of yours and needs no sudo. It runs no
provider except claude's own `doctor`, in a throwaway home, to ask whether
a machine policy keeps claude's updates off (claude may contact its servers
and run `npm config` there). Versions come from store paths, and a provider
installed outside Nix is reported as "version not checked".

### Reporting problems

A security problem goes in a private report, never an issue: see
[SECURITY.md](SECURITY.md). For anything else:

1. Run `t3code-nix doctor` first, and do what its `WARN` and `PROBLEM`
   lines say.
2. If that doesn't fix it, [open an issue](https://github.com/swsammy/t3code-nix/issues)
   with the doctor's output, the t3code-nix commit you're on, what you
   did, and what happened. With flakes, `nix flake metadata /etc/nixos`
   (or your flake's folder) lists each input with its commit; without
   them, give the tarball URL or commit you import. The output shows paths in your
   home folder; edit out anything you'd rather not share.

A problem in T3 Code itself, one that also happens without Nix, belongs
[upstream](https://github.com/pingdotgg/t3code/issues).

## Channels, pinning and rolling back

**Channels.** The latest channel (`"latest"`, upstream's name for its
non-nightly releases) is the default. For nightly, set
`programs.t3code.channel = "nightly"`, or use the `-nightly` packages.
Nightly gets T3 Code's nightly builds only, never a latest-channel
release, even one newer than the newest nightly.
These are T3 Code's own release channels; the libraries underneath are a
separate choice (see [NixOS stable](#nixos-stable)).

Both apps can be installed together (`programs.t3code` installs one; add
the other package yourself). They share `~/.t3`, so nightly can migrate the
database ahead of latest; start one with its own `T3CODE_HOME` to keep them
apart.

**Pinning.** `main` moves with every release. To stay on one set of
versions, point the input at a tag or a commit instead:

```nix
inputs.t3code-nix.url = "github:swsammy/t3code-nix/t3code-v<version>"; # a latest-channel release
# or any commit (for example, to pin a nightly published between release tags):
# inputs.t3code-nix.url = "github:swsammy/t3code-nix/<commit>";
```

Each T3 Code version on the latest channel gets a `t3code-v<version>` tag, on the commit
that first published it, with every package as it was there. Its
[GitHub Release](#following-new-releases) lists them.

**Rolling back.**

- **The whole system:** boot an older generation from the boot menu, or
  run `sudo nixos-rebuild switch --rollback`.
- **Only t3code-nix:** in your flake's folder, lock it to an older tag or
  commit, then rebuild:

  ```sh
  cd /etc/nixos
  sudo nix flake lock --override-input t3code-nix 'github:swsammy/t3code-nix/t3code-v<version>'
  # or a commit: 'github:swsammy/t3code-nix/<commit>'
  sudo nixos-rebuild switch    # or as you usually rebuild, e.g. --flake /etc/nixos#nixos
  ```

  The lock file keeps that until your next `nix flake update`. To stay
  there, pin the input as above.
- **Without flakes:** import an older tag's or commit's tarball
  (`…/archive/t3code-v<version>.tar.gz` or `…/archive/<commit>.tar.gz`)
  instead of `main`'s, then rebuild.
- **The server:** restart it after rolling back (see
  [Running the server](#running-the-server)), and if it then fails, put
  back its [database copy](#database-copies).

**An older set may not download any more.** Every package is the vendor's
own file, and a pin stays fetchable only as long as the vendor keeps that
file. The binary cache can stand in for the free packages while it still
holds them. Booting an older generation needs none of this: its packages
are still in your store.

## Following new releases

Each T3 Code version on the latest channel gets a GitHub Release here, named
`T3 Code <version>`, on its `t3code-v*` tag.

- It lists every package at that commit, and what changed since the
  previous release, with links to the release notes where upstream has
  them.
- It shows how to pin exactly that set.
- A release's tag pins the set as it was first published. Later provider
  updates, and nightlies, land on `main` without a release.
- GitHub's Latest marker is on the release for the version `main` ships
  now. If upstream pulls a release, `main` goes back to the version before
  it, and the marker moves with it.

To hear about them, use Watch → Custom → Releases on the repository page,
or subscribe to the feed at
<https://github.com/swsammy/t3code-nix/releases.atom>.

**nixpkgs.** The nixpkgs this flake pins (for the libraries the apps load
and the helpers around them) moves to the newest `nixos-unstable` with
each new T3 Code on the latest channel, and at least once a week. A move
waits until everything it needs from nixpkgs is on cache.nixos.org, so you
never build any of it yourself, and it's tested like any release.

## Details

### How T3 Code finds its providers

`t3code` and `t3` come with all ten providers T3 Code supports. Two things
about how T3 Code uses them:

- **Your own installs come first.** When T3 Code starts, it reads `PATH`
  from your login shell and searches it *before* the providers this flake
  bundles. So if you've installed, say, codex yourself, T3 Code uses your
  codex, and the bundled ones are only used for providers you don't have.
  Cursor is the exception: T3 Code runs it through its own SDK and looks
  up no command, so the bundled `cursor-agent` (and any of your own) is
  for the terminal only.
- **T3 Code enables only Codex and Claude by default.** The other eight
  (Cursor, Grok, fx, OpenCode, Antigravity, Kiro, Muse, pi) are installed,
  but you switch each one on once in T3 Code's settings.

The module also puts them on your `PATH` (`providersOnPath`), at low
priority, so your own package of the same command wins.

**`~/.t3/bin/t3`**, which the desktop app writes, doesn't bundle the
providers and breaks after garbage collection; use this flake's `t3` instead.

### Provider updates

T3 Code's "update provider" notice still works: it tells you when a newer
version of a provider is out. Once t3code-nix has published it (the
[status page](https://swsammy.github.io/t3code-nix/) shows what it has),
run `nix flake update t3code-nix` and rebuild to get it. The notice comes
from the provider's own release feed, so it can show a version this flake
hasn't published yet.

Providers mostly can't update themselves here, with the two exceptions
below. Their own update and self-install commands (`claude update`,
`codex update`, `pi update --self` and so on) print a short message and do
nothing, because they'd install a second copy outside Nix that can shadow
this one and may not run on NixOS. If T3 Code
shows an Update button, pressing it shows that message.

**claude's settings files.** The wrapper turns claude's self-update off,
but a settings file can turn it back on: a repository's
`.claude/settings.json` (or your own `~/.claude/settings.json`) can set
the update switches in its `env` block, and claude would then update
itself into `~/.local`. Only a claude machine policy ranks above every
settings file. The NixOS module writes one (`claudeCodePolicy`, on by
default) whenever T3 Code, its server or its CLI bundles claude. Without
the module, or for this flake's `claude-code` installed on its own, write
the same file yourself. Make it a copy (`mode`), not a link into the
store, since claude's own doctor flags a policy reached through a link:

```nix
environment.etc."claude-code/managed-settings.d/10-t3code-nix.json" = {
  mode = "0444";
  text = builtins.toJSON {
    env = {
      DISABLE_UPDATES = "1";
      DISABLE_AUTOUPDATER = "1";
      DISABLE_INSTALLATION_CHECKS = "1";
    };
  };
};
```

`t3code-nix doctor` asks the bundled claude whether a machine policy keeps
its updates off: it warns when none does, reports a problem when claude
can't read a policy file, and warns when T3 Code would use a claude
installed outside Nix.

**Codex's daemon updater.** In codex's TUI, the `/daemon` menu's "Install
latest public stable" and "Use this CLI build" run codex's daemon updater
directly, where no wrapper can refuse them
([openai/codex#41188](https://github.com/openai/codex/issues/41188)). They
install only into a daemon package that's already there, in
`~/.codex/packages/app-server-daemon` (or the same folder under
`$CODEX_HOME`). A codex with the daemon's auto-start on leaves one behind,
and so does a `~/.codex` copied from another machine. `t3code-nix doctor`
warns about that folder and about the background server and update loop
it runs (even once the folder is deleted), and says how to stop each
before you delete it.

### The overlay

`t3code-nix.overlays.default` puts every package under `pkgs.t3code-nix`.
The app and the providers are also added at the top level, but never over
a different program nixpkgs has under the same name. With this flake's
pinned nixpkgs, that gives:

| Packages | At the top level of `pkgs`? |
| --- | --- |
| `t3code`, `t3code-nightly`, `t3code-free`, `t3code-unwrapped` (+ `-nightly`) | yes (`t3code` replaces nixpkgs' own, the same program) |
| `codex`, `claude-code`, `kiro-cli`, `agent-browser` | yes, replacing nixpkgs' own (the same programs); the overlay's `agent-browser` uses your nixpkgs' browsers (`ungoogled-chromium` by default) |
| `cursor-agent`, `grok`, `pi`, `boat` | yes (nixpkgs has nothing by those names) |
| `opencode` | no: nixpkgs' `opencode-desktop` builds from nixpkgs' own `opencode`, so that stays (the apps bundle this flake's either way) |
| `fx`, `muse`, `antigravity` | no: nixpkgs' are different programs (a JSON viewer, a MIDI sequencer, and a deprecated alias of the Antigravity IDE, `antigravity-ide`) |
| `t3`, `t3-nightly`, `t3-free`, `t3-unwrapped` (+ `-nightly`) | no: the CLI's packages aren't offered at the top level (and nixpkgs' `t3` is a `tee`) |
| `doctor`, `init`, `chrome-headless-shell` (+ `-nightly`) | no, only under `pkgs.t3code-nix` |

Anything that isn't at the top level is still there as
`pkgs.t3code-nix.<name>`, for example `pkgs.t3code-nix.t3`. If your
nixpkgs gains a different program under one of these names, it keeps it.

The overlay builds on your own nixpkgs. Your nixpkgs config
(`allowUnfree`) decides which unfree packages you can build, and the
binary cache has those builds only if your nixpkgs is at the revision this
flake pins.

### The desktop app's Electron

The desktop app is upstream's own app (`app.asar` and the rest of
`resources/`, unchanged apart from pointing its native libraries at
nixpkgs), running packaged as on any Debian machine. Only the Electron it
runs on can change:

| `electron` | What you get |
| --- | --- |
| `"auto"` (default) | nixpkgs' `electron_N-bin` when it can stand in for upstream's: the same major version and the same release or newer. Otherwise upstream's bundled Electron |
| `"bundled"` | upstream's bundled Electron, always |
| `"nixpkgs"` | nixpkgs' `electron_N-bin`, under the same conditions as `"auto"`, but never upstream's. Where `"auto"` would fall back for one of those reasons, evaluation stops with an error that says why and what to use instead. If nixpkgs' Electron failed t3code-nix's tests for this release, it's still used, with a warning |
| a package | the Electron you pass. It must be the bundled major version, though an older patch release is fine. Take nixpkgs' `electron_N-bin`, where N is that major, from the same nixpkgs the app is built on (`t3code-nix.inputs.nixpkgs.legacyPackages.<system>`, or the overlay's `pkgs`): mixing two nixpkgs revisions in one app can break it |

The [status page](https://swsammy.github.io/t3code-nix/) shows which
Electron the current releases run; `t3code-nix doctor` shows yours.

```nix
# With the module: upstream's Electron, or a specific one
programs.t3code.electron = "bundled";
# or (use the bundled major the status page shows):
# programs.t3code.electron =
#   t3code-nix.inputs.nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system}.electron_44-bin;

# Without the module, on the package:
t3code-nix.packages.${system}.t3code.override { electron = "bundled"; }
```

- **Why `"auto"` prefers nixpkgs':** Electron security fixes reach you
  with this flake's nixpkgs (see [its schedule](#following-new-releases)),
  instead of waiting for the next T3 Code release. Upstream tested its
  release on its own Electron patch, so the app may run a newer patch of
  the same major than upstream did. If you report a bug upstream, include
  your Electron version, or check it with `"bundled"` first.
  `t3code-nix doctor` shows which Electron you have and why.
- **When nixpkgs' Electron fails t3code-nix's tests** and upstream's
  passes, that release ships on upstream's Electron instead, until a new
  T3 Code release or a nixpkgs update gives nixpkgs' another try; an issue
  says so, and the status page and the release notes show it. `"nixpkgs"`
  still builds on it if you ask, with a warning.
- **The `t3` CLI** is unaffected: its Node is built into the program.

### The preview browser

T3 Code takes HTML preview screenshots and recordings with a headless
Chrome (Chrome for Testing's `chrome-headless-shell`). It downloads that
into `~/.t3/tools/` on first use, and the download can't run on NixOS
without nix-ld.

So `t3code` and `t3` bring the same Chrome build their release pins,
patched to run on NixOS. On each start they link it where T3 Code looks
for it: `~/.t3/tools/chrome-headless-shell/<platform>/<version>` (or under
`T3CODE_HOME`, or `t3 --base-dir`). T3 Code then never downloads it.

- A copy of that same version it downloaded before is replaced by the
  link; other versions are left alone.
- On hosts that restrict user namespaces (Ubuntu 23.10 and later) nothing
  is linked: there T3 Code's own download and `t3 browser setup` work as
  they do upstream.
- It adds about 290 MB to `t3code` (about 400 MB to `t3`, which otherwise
  needs fewer system libraries).
- Leave it out with `t3code.override { withPreviewBrowser = false; }`; a
  link an earlier start made stays until you delete it.
- It's unfree: the archive ships as Google Chrome, under Google's terms.
  To be fully free, use `t3code-free` or `t3-free`, which leave it out
  already. If you pick free providers with an override instead, also set
  `withPreviewBrowser = false`.

### Agent tools

Besides T3 Code and its providers, the flake ships a few agent tools:
command-line tools that the agents T3 Code runs use themselves. They're
not included as part of `t3code` or `t3`.

```nix
# With the module:
programs.t3code.agentTools.boat.enable = true;
programs.t3code.agentTools.agent-browser.enable = true;

# Or without it, as plain packages:
environment.systemPackages = [
  t3code-nix.packages.${pkgs.stdenv.hostPlatform.system}.boat
  t3code-nix.packages.${pkgs.stdenv.hostPlatform.system}.agent-browser
];
```

**boat** runs [<img src="docs/logos/boat.svg" height="14" alt=""> boat.dev](https://boat.dev) cloud sandboxes (`boat run`,
`boat new`, `boat exec`). Its update check is off and `boat self-update`
says it's installed by Nix. Sign-in is boat's own (`boat login`), kept in
`~/.config/ascii/boat/config.json`, which this flake never touches. If
boat's own installer put a copy in `~/.ascii/bin`, remove it and its shell
startup lines so this one runs.

**agent-browser** drives a headless browser for agents (`open`,
`snapshot`, `click`, `fill`, `screenshot`), with its dashboard, MCP
server and skills built in. It drives ungoogled-chromium by default;
plain Chromium and Google Chrome are one option away:

```nix
programs.t3code.agentTools.agent-browser.browser = "google-chrome"; # or "chromium"
t3code-nix.packages.${system}.agent-browser.override { browser = "google-chrome"; } # without the module
```

| Browser | What it's for |
| --- | --- |
| `ungoogled-chromium` (default) | everyday agent work, with nothing from Google on its own |
| `chromium` | plain Chromium, without ungoogled's patches |
| `google-chrome` | checking a site in Google's Chrome, for example with Widevine (DRM video), which the Chromiums refuse. Unfree; downloaded from Google |

The browsers come from their own pinned nixpkgs, separate from the one
your system uses, so they usually mean another nixpkgs download. It
follows nixos-unstable by default (the `browser-unstable` pin), or the
newest NixOS release (`browser-stable`) with the module's
`browserChannel = "stable"` (or `.override { browserChannel = "stable"; }`).
Each pin moves when a browser's version changes, and at least weekly. The
status page shows each browser's version. The
[NixOS stable](#nixos-stable) set uses `browser-stable` by default.

- Any other browser: `agent-browser.override { browser = pkgs.brave; }`
  (its `meta.mainProgram` runs; for a package without one, set
  `AGENT_BROWSER_EXECUTABLE_PATH`), or your own
  `AGENT_BROWSER_EXECUTABLE_PATH` (or `--executable-path`, or `--cdp`),
  which wins over the package's.
- `agent-browser upgrade` (a second copy from a package manager),
  `install` and `doctor --fix` (each downloads Chrome for Testing, which
  can't start on NixOS) say it's installed by Nix; `install` points to
  `browser = "google-chrome"`. Plain `doctor` works.
- **What leaves the machine:** when it starts a browser, agent-browser
  reads Google's Chrome release feed (`chromereleases.googleblog.com`) and
  warns if the browser is behind a release with security fixes, so a pin
  that falls behind says so. `AGENT_BROWSER_NO_VERSION_CHECK=1` turns that
  off. Beyond that, the browsers fetch what the agent opens; Chromium and
  Chrome also contact Google services on their own, ungoogled-chromium
  doesn't. Choosing Chrome also downloads it from Google.
- **User namespaces:** Chromium's sandbox needs unprivileged user
  namespaces. Where they're restricted (Ubuntu 23.10 and later), the
  wrapper says so when you run it. Turn the restriction off with
  `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`, and to keep
  it, put the line `kernel.apparmor_restrict_unprivileged_userns = 0` in a
  file in `/etc/sysctl.d/`; or allow `userns` for this Chromium's path
  in an AppArmor profile. The wrapper never turns the sandbox off.

### Dictation

T3 Code's voice dictation works with nothing to set up. Its server runs
the speech engine that comes with each release (transcribe-cpp, on the CPU
or a Vulkan GPU). T3 Code downloads the speech models itself, from Hugging
Face, when you choose one in its settings; they range from 35 MB to many
GB. Each release is tested here: the engine's libraries resolve in the app
and the CLI, its worker starts, and it transcribes a short spoken clip.

Codex's own voice mode (`/voice` in codex's terminal UI) is a different
thing, and it doesn't work out of the box on NixOS: it stops with "voice audio
devices could not open". Its audio helper has its own copy of ALSA, which
looks for its configuration in `/usr/share/alsa` and `/usr/lib/alsa-lib`.
NixOS has neither, and codex starts the helper with a fixed environment,
so a setting from outside can't point it elsewhere. This flake leaves the
fix to codex
([openai/codex#61732](https://github.com/openai/codex/issues/61732)); until
then, codex's `/voice` is a known gap on NixOS.

### ACP registry agents

Besides its ten providers, T3 Code can install agents from the public
[ACP registry](https://agentclientprotocol.com) while it runs. This flake
doesn't package those agents, but it can give T3 Code what its installer
needs. An agent from npm needs `npm` and `node` on T3 Code's `PATH`, and
one from uv needs `uv`; without them T3 Code says the agent's runner is
missing. Agents shipped as a downloaded program need no runner, but may
need [`runtimeCompat`](#t3-code-over-ssh-runtimecompat) to start on NixOS.

```nix
# With the module:
programs.t3code.acpRuntimes = [ "nodejs" ];

# Or without it, on the package:
t3code-nix.packages.${pkgs.stdenv.hostPlatform.system}.t3code.override { acpRuntimes = [ "nodejs" ]; }
```

| Value | Adds | Added to `t3`'s closure (x86_64) | For |
| --- | --- | --- | --- |
| `[ ]` (default) | nothing | 0 | agents shipped as a program (with `runtimeCompat` if they need it) |
| `[ "nodejs" ]` | Node, with npm | about 142 MB | npm agents |
| `[ "uv" ]` | uv and Python | about 200 MB | uv agents |
| `[ "nodejs" "uv" ]` | all of it | about 342 MB | npm and uv agents |

- They go at the end of T3 Code's `PATH`, after the providers. T3 Code
  puts your login shell's `PATH` first, so your own Node or uv always wins;
  these only fill a gap. The agents' own shell commands can see them too
  when you have none of your own.
- `uv` comes with a full Python, so uv uses it instead of downloading one
  (a downloaded Python can't start on NixOS without nix-ld).
- An npm agent whose install downloads a program of its own may still need
  `runtimeCompat`.
- With the module, `acpRuntimes` applies to the app and to the CLI and
  server it installs.

### T3 Code over SSH: `runtimeCompat`

`runtimeCompat` is for T3 Code servers that still come from T3 Code's own
download: mainly the one another machine installs here, and upstream's own
service if you [use it on purpose](#upstreams-own-service). When T3 Code on
another machine connects to this one over SSH, it installs and runs its own
server here, which can't start on NixOS otherwise. For a server on this
machine, use [`server`](#running-the-server) instead.

```nix
programs.t3code.runtimeCompat = true;
```

It turns on `programs.nix-ld`, with the libraries that server needs. It
works on its own, without `enable` or `server.enable`. It's
off by default because nix-ld changes how every unpatched program on the
system starts. It's also best effort: this flake doesn't pin what T3 Code
downloads.

### Supported systems

`x86_64-linux` and `aarch64-linux`.

## Maintainer notes

Setting up the watcher and cache, the issues the update runs open, and the rules for changing providers are in [MAINTAINING.md](MAINTAINING.md).

## License

This repository is licensed under the [MIT license](LICENSE). The packaged
programs are not part of this repository. Each packaged program's
`meta.license` gives its vendor's license: `unfree` for the seven
proprietary ones, which are under their vendors' terms.

Thanks to [sadjow/codex-cli-nix](https://github.com/sadjow/codex-cli-nix),
[numtide/llm-agents.nix](https://github.com/numtide/llm-agents.nix) and
[LikelyLucid/t3code-nix](https://github.com/LikelyLucid/t3code-nix) for
showing the way.

T3 Code, the providers and boat are their owners' products, and their
names and logos belong to them; they appear here only to say what this
flake packages. Packaging problems belong in this repository's issues, not
upstream's.
