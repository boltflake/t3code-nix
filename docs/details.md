# Reference & details

Deep-dive documentation for `t3code-nix` features, module options, and
packaging details. See [README.md](../README.md) for setup and overview.

- [The app's Network access](#the-apps-network-access)
- [Usage data](#usage-data)
- [Update notices](#update-notices)
- [How T3 Code finds its providers](#how-t3-code-finds-its-providers)
- [Provider updates](#provider-updates)
- [The overlay](#the-overlay)
- [The desktop app's Electron](#the-desktop-apps-electron)
- [The preview browser](#the-preview-browser)
- [Agent tools](#agent-tools)
- [Dictation](#dictation)
- [ACP registry agents](#acp-registry-agents)
- [T3 Code over SSH: `runtimeCompat`](#t3-code-over-ssh-runtimecompat)

## The app's Network access

The desktop app's **Network access** (Settings → Sharing & access) lets
devices on your network and tailnet pair with the app's own server. NixOS's
firewall blocks them until the app's port is open:

```nix
programs.t3code = {
  enable = true;
  openFirewall = true;
  # port = 3780; # if 3773 is taken, e.g. by the server
};
```

- **The port.** Normally the app picks the first free port from 3773 up,
  which could miss the opened port. With `openFirewall`, the wrapper sets
  `T3CODE_PORT` to `port` (when unset or blank), pinning it. A non-blank
  `T3CODE_PORT` you set yourself wins while the firewall still opens `port`.
  If something else holds the port, the app's server can't start (it reports
  this and keeps retrying). Ports below 1024 normally need root.
- **The package** must be this flake's desktop app (`t3code`,
  `t3code-nightly`, `t3code-free`, or an `.override` of one); another stops
  evaluation. A `port` pinned on the package gives way to `port`, with a
  warning if they differ.
- **With the server** on the same machine, both need different ports (and
  [different T3 homes](server.md#one-server-per-t3-home)). Setting the app's
  port equal to `server.port` fails evaluation; open the server's port with
  `server.openFirewall`.
- **Several users on one machine:** the pin is machine-wide, so while one
  user holds the port, another can't start its server. Give other users
  their own `T3CODE_PORT` in their session environment and open those ports
  with `networking.firewall.allowedTCPPorts`. (A manual `t3 serve` will also
  pick up that `T3CODE_PORT` unless passed `--port`.)
- **Pinning without opening** (custom firewall rules, e.g. `tailscale0`
  only, or no firewall): leave `openFirewall` off and pin the package
  instead: `package = t3code-nix.packages.${pkgs.stdenv.hostPlatform.system}.t3code.override { port = 3780; };`.
  Setting `port` without `openFirewall` does nothing and warns.
- **Network access stays the app's setting:** enable it in the app. When
  off, the app binds only to `127.0.0.1` (though any other process listening
  on that port on a network interface would be reachable through the open
  port).
- T3 Connect and Tailscale HTTPS ([Tailscale Serve](server.md)) need no open
  port.
- Terminals and agents launched by the app don't inherit `T3CODE_PORT`.

## Usage data

T3 Code's desktop app and server send product usage events (provider, model,
token counts—no prompts, responses, or file contents) to `ingest.t3.codes`,
and T3 Connect relay traces to Axiom when a build has a tracing endpoint.
See upstream's
[Product usage data](https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md).
It is on by default, matching upstream. To turn it off:

```nix
programs.t3code.telemetry.enable = false; # programs.t3code-nix in Home Manager
```

Without the module:
`t3code-nix.packages.${system}.t3code.override { telemetry = false; }` (also
`t3`, `t3code-free`, and the overlay's `pkgs.t3code`).

- **How it works:** the app, CLI, and server wrappers set
  `T3CODE_TELEMETRY_ENABLED=false` unless a non-blank value is already set
  in the launch environment (terminal, `server.environmentFile`, or user
  manager). Launching from a desktop menu uses the wrapper's value unless
  your desktop session environment sets it (`~/.profile`, `environment.d`,
  `home.sessionVariables`). It doesn't set `DO_NOT_TRACK`, which would
  affect every agent T3 Code spawns.
- **Other ways:** `DO_NOT_TRACK=1` in T3 Code's environment also disables it
  (and overrides `T3CODE_TELEMETRY_ENABLED=true`), as does a
  [managed policy](https://github.com/pingdotgg/t3code/blob/main/docs/user/managed-policy.md)
  with `limits.telemetry: false` in `/etc/t3code/policy.json`.
- **When it applies:** on next start. Quit and relaunch the desktop app, and
  restart `t3code-server` with `systemctl --user restart t3code-server`
  (after `systemctl --user daemon-reload` if the unit changed).
- **Turning it back on** (`true`) simply stops setting the variable; an
  override, env var, or policy file still keeps it off. (The desktop app
  caches the last value until it reads your login shell.)
- **Agent feedback**, if enabled in T3 Code, stays local while usage data is
  off. (Bug reports you submit manually are separate.)
- **The desktop app's own `t3`** (`~/.t3/bin/t3`, sometimes linked to
  `~/.local/bin`) bypasses this flake's wrapper; a `t3 serve` started via
  it won't get this setting or bundled providers (agent commands run inside
  the app still inherit the app's environment). Use `cli.enable` instead;
  `t3code-nix doctor` warns about a non-Nix `t3` on `PATH`.
- **Not covered:** your own OpenTelemetry export (`T3CODE_OTLP_*`), the
  mobile app, the hosted web app, remote/SSH backends using upstream's
  downloads, [upstream's own service](server.md#upstreams-own-service), and
  non-flake installs.
- **`t3code-nix doctor`** reports your build's setting and warns if your
  shell overrides it, sets an invalid value, or if the running server
  started under a different setting.

## Update notices

The desktop app's update icon (round arrow at the bottom of the sidebar)
shows only when there is an update:

- **t3code-nix has a newer T3 Code or newer bundled providers** (for your
  channel/set: latest, nightly, or NixOS stable): the tooltip summarizes
  what's available and clicking lists each update with your current version
  and tells you to update `t3code-nix` and rebuild. Nothing is downloaded
  automatically; after rebuilding, the icon stays until you restart the app.
- **An upstream update** (a remote T3 server that self-updates, or a
  provider installed outside Nix): behaves as upstream does.

Only bundled providers from `t3code-nix` are tracked (all ten by default, or
the subset from `providers`/`excludeProviders`). A provider you installed
yourself earlier on `PATH` isn't tracked here.

A provider counts as newer when its version on `main` is higher, or when it
matches a different vendor build suffix (such as cursor-agent's
`2026.11.22-e9042b2` or muse's `1.4.25-R9361.1`), since those suffixes can't
be ordered. Right after such a bump, a build from a `main` newer than the
status site may briefly show the site's older build until the site rebuilds
(hourly) and the next check runs (every 4 hours).

The app fetches one small JSON file published with the
[status page](https://boltflake.github.io/t3code-nix/)
(`updates/t3code.json`, `updates/t3code-nightly.json`, or
`updates/stable/t3code.json`) 15 seconds after startup, every 4 hours, and
on click—through your system proxy, with a fixed User-Agent
(`t3code-nix update check`) and no cookies, ID, or version. GitHub Pages
sees your IP address and which file; your bundled provider list stays local.

To disable it:

```nix
programs.t3code.updateCheck.enable = false; # programs.t3code-nix in Home Manager
```

Or without the module: `t3code.override { updateCheck = false; }` (also
`t3code-nightly`, `t3code-free`, and the overlay's `pkgs.t3code`).

- **Environment variables:** `T3CODE_NIX_UPDATE_URL` (HTTPS; plain HTTP only
  for `127.0.0.1` in tests) and `T3CODE_NIX_PROVIDERS` (JSON file path) can
  override the defaults; a blank URL disables the check. Opting out blanks
  both over inherited values, and the app strips both from child processes.
- **Managed policy:** `/etc/t3code/policy.json` limiting updates (or
  unreadable) disables the check.
- **Upstream changes:** update notices patch upstream's built app during
  packaging; if an upstream release changes that code too much, the package
  still ships with upstream's default Nix notice until the patch is updated.
- The added strings are English-only.

## How T3 Code finds its providers

`t3code` and `t3` bundle all ten supported providers. Two behaviors to note:

- **Your own installs win.** T3 Code reads `PATH` from your login shell and
  searches it *before* bundled providers, so your own install of a provider
  takes precedence. (Exception: Cursor runs via T3 Code's built-in SDK, so
  the bundled `cursor-agent` is for terminal use only.)
- **Only Codex and Claude are enabled by default in T3 Code.** The other
  eight (`Cursor`, `Grok`, `fx`, `OpenCode`, `Antigravity`, `Kiro`, `Muse`,
  `pi`) are installed, and you enable each once in T3 Code's settings.

The module also exposes bundled providers on `PATH` at low priority
(`providersOnPath`, on by default), so your own packages win. Avoid
`~/.t3/bin/t3` written by the desktop app—it lacks bundled providers and
breaks after garbage collection; use this flake's `t3` instead.

## Provider updates

Bundled providers update when you update `t3code-nix` and rebuild. Self-update
commands (`claude update`, `codex update`, `pi update --self`, etc.) print a
notice and exit, so they don't drop a second unpatched copy outside Nix.

Two exceptions to be aware of:

- **Claude Code's settings files.** A project's `.claude/settings.json` or
  `~/.claude/settings.json` can override the wrapper's env vars and
  re-enable self-updates into `~/.local`. Only a machine policy outranks
  settings files. The NixOS module writes one automatically
  (`claudeCodePolicy`, on by default) whenever Claude Code is bundled.
  Without the module, write it yourself as a copy (`mode`, not a store
  symlink, which `claude doctor` flags):

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

  `t3code-nix doctor` checks that Claude sees a valid policy and warns if a
  non-Nix `claude` shadows the bundled one.
- **Codex's daemon updater.** In Codex's TUI, `/daemon` menu options can
  invoke the daemon updater directly inside
  `~/.codex/packages/app-server-daemon`
  ([openai/codex#41188](https://github.com/openai/codex/issues/41188)) if a
  daemon package already exists there. `t3code-nix doctor` warns about that
  folder and any running daemon/update loop and tells you how to stop and
  remove them.

## The overlay

`t3code-nix.overlays.default` puts every package under `pkgs.t3code-nix` and
also adds the app and non-colliding providers at the top level of `pkgs`
(never overwriting a different program in nixpkgs):

| Packages | At the top level of `pkgs`? |
| --- | --- |
| `t3code`, `t3code-nightly`, `t3code-free`, `t3code-unwrapped` (+ `-nightly`) | yes (`t3code` replaces nixpkgs' own and includes its CLI; see below) |
| `codex`, `claude-code`, `kiro-cli`, `agent-browser` | yes, replacing nixpkgs' own (`agent-browser` uses your nixpkgs' browsers, `ungoogled-chromium` by default) |
| `cursor-agent`, `grok`, `pi`, `boat` | yes |
| `opencode` | no: keeps nixpkgs' `opencode` for `opencode-desktop` (the apps still bundle this flake's) |
| `fx`, `muse`, `antigravity` | no: nixpkgs has different programs under those names |
| `t3`, `t3-nightly`, `t3-free`, `t3-unwrapped` (+ `-nightly`) | no (nixpkgs' `t3` is a `tee`) |
| `doctor`, `init`, `chrome-headless-shell` (+ `-nightly`) | no, under `pkgs.t3code-nix` only |

Everything else is available under `pkgs.t3code-nix.<name>` (e.g.
`pkgs.t3code-nix.t3`).

**Top-level `pkgs.t3code`** includes `bin/t3code`, `bin/t3code-desktop`, and
`bin/t3` (`pkgs.t3code-nix.t3code.override { withCli = true; }`) so modules
expecting nixpkgs' layout (like Home Manager's own `programs.t3code`) work
with it:

- Adds ~0.5 GB (~5.4 GB vs ~4.9 GB with all providers). The bundled `t3`
  tracks the CLI release independently, so it may briefly differ in version
  right after a release.
- Takes this flake's arguments (`providers = [ "antigravity" "claude" "codex" ]`),
  not nixpkgs' (`enableClaude`, `enableGit`, etc., which fail with an error).
- Installing alongside another `t3` causes a `bin/t3` collision: install
  only one, adjust priority (`lib.hiPrio` / `--priority`), or pass
  `pkgs.t3code.override { withCli = false; }`.
- `withCli = true` also works on `t3code-nightly` (no `t3code-desktop`) and
  `t3code-free`.
- With the NixOS module and `package = pkgs.t3code`, enabling `cli.enable`
  or `server.enable` installs the module's own `t3` at higher priority.

The overlay builds against your own nixpkgs: your `allowUnfree` config
applies, and the binary cache only hits if your nixpkgs revision matches
this flake's pin.

## The desktop app's Electron

The desktop app runs upstream's `app.asar` and `resources/` unchanged apart
from Nix library paths, Nix update wording, and
[update notices](#update-notices). You can control which Electron binary it
uses:

| `electron` | What you get |
| --- | --- |
| `"auto"` (default) | nixpkgs' `electron_N-bin` if it matches the bundled major version and is at least the bundled patch release; otherwise upstream's bundled Electron |
| `"bundled"` | upstream's bundled Electron, always |
| `"nixpkgs"` | nixpkgs' `electron_N-bin` under the same rules, failing evaluation instead of falling back (still used with a warning if it failed tests) |
| a package | that Electron package (must match the bundled major version; take it from the same nixpkgs the app is built on) |

```nix
programs.t3code.electron = "bundled";
# Or a specific package (matching the bundled major shown on the status page):
# programs.t3code.electron =
#   t3code-nix.inputs.nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system}.electron_44-bin;
# Without the module:
t3code-nix.packages.${system}.t3code.override { electron = "bundled"; }
```

- `"auto"` prefers nixpkgs' Electron so security fixes arrive with this
  flake's nixpkgs updates. If nixpkgs' Electron fails tests while upstream's
  passes, the release ships on upstream's Electron until a future update
  passes again (shown on the status page and release notes).
- `t3code-nix doctor` shows which Electron you're running and why. Before
  filing an upstream bug, check whether it reproduces with `"bundled"`.
- The `t3` CLI is unaffected (its Node runtime is built in).

## The preview browser

T3 Code uses Chrome for Testing's `chrome-headless-shell` for HTML preview
screenshots and recordings. Upstream downloads it into `~/.t3/tools/` on
first use, which fails on NixOS without `nix-ld`.

`t3code` and `t3` bundle the release's pinned `chrome-headless-shell`,
patched for NixOS, and symlink it into
`~/.t3/tools/chrome-headless-shell/<platform>/<version>` (respecting
`T3CODE_HOME` / `t3 --base-dir`) on startup.

- Replaces an existing download of that exact version; leaves other versions
  alone.
- On hosts that restrict user namespaces (Ubuntu 23.10+), nothing is linked
  so upstream's download and `t3 browser setup` behave normally.
- Adds ~290 MB to `t3code` (~400 MB to `t3`).
- Opt out with `t3code.override { withPreviewBrowser = false; }` (remove any
  existing symlink manually) or use `t3code-free` / `t3-free`. It is unfree
  (Google Chrome terms).

## Agent tools

Standalone CLI tools that agents can use—not bundled into `t3code` or `t3`:

```nix
# With the module:
programs.t3code.agentTools.boat.enable = true;
programs.t3code.agentTools.agent-browser.enable = true;

# Without the module:
environment.systemPackages = [
  t3code-nix.packages.${pkgs.stdenv.hostPlatform.system}.boat
  t3code-nix.packages.${pkgs.stdenv.hostPlatform.system}.agent-browser
];
```

**boat** runs [<img src="logos/boat.svg" height="14" alt=""> boat.dev](https://boat.dev)
cloud sandboxes (`boat run`, `boat new`, `boat exec`). Self-update is
disabled; sign in with `boat login` (stored in
`~/.config/ascii/boat/config.json`). Remove any prior `~/.ascii/bin` install
and its shell startup lines so the Nix copy is used.

**agent-browser** drives a headless browser for agents (`open`, `snapshot`,
`click`, `fill`, `screenshot`) with dashboard, MCP server, and skills built
in. Defaults to `ungoogled-chromium`; switch with:

```nix
programs.t3code.agentTools.agent-browser.browser = "google-chrome"; # or "chromium"
t3code-nix.packages.${system}.agent-browser.override { browser = "google-chrome"; }
```

| Browser | What it's for |
| --- | --- |
| `ungoogled-chromium` (default) | everyday agent work, without Google services |
| `chromium` | plain Chromium |
| `google-chrome` | sites needing Google Chrome (e.g. Widevine DRM); unfree, downloaded from Google |

Browsers come from dedicated nixpkgs pins (`browser-unstable` by default, or
`browser-stable` via `browserChannel = "stable"` and under
[NixOS stable](../README.md#nixos-stable)), updated automatically when
browser versions change and at least weekly.

- **Custom browser:** pass a package
  (`agent-browser.override { browser = pkgs.brave; }`) or set
  `AGENT_BROWSER_EXECUTABLE_PATH` / `--executable-path` / `--cdp`.
- `agent-browser upgrade`, `install`, and `doctor --fix` report that it is
  installed by Nix (plain `doctor` works).
- **Network traffic:** on startup, `agent-browser` checks Google's Chrome
  release feed (`chromereleases.googleblog.com`) to warn about outdated
  browsers (`AGENT_BROWSER_NO_VERSION_CHECK=1` disables this). Chromium and
  Chrome also contact Google services on their own; `ungoogled-chromium`
  does not.
- **User namespaces (Ubuntu 23.10+):** Chromium's sandbox needs unprivileged
  user namespaces. If restricted, run
  `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` (persist via
  `/etc/sysctl.d/`) or allow `userns` for the Chromium path in an AppArmor
  profile. The wrapper never disables the sandbox.

## Dictation

T3 Code's voice dictation works out of the box via its bundled speech engine
(`transcribe-cpp`, CPU or Vulkan GPU). T3 Code downloads speech models from
Hugging Face (35 MB to several GB) when you pick one in settings. Each
release is tested to verify libraries resolve, the worker starts, and a
spoken clip transcribes.

Codex's own `/voice` mode in the terminal UI is separate and currently fails
on NixOS (`"voice audio devices could not open"`) because its audio helper
hardcodes `/usr/share/alsa` and `/usr/lib/alsa-lib` with a fixed environment
([openai/codex#61732](https://github.com/openai/codex/issues/61732)).

## ACP registry agents

T3 Code can install extra agents at runtime from the
[ACP registry](https://agentclientprotocol.com). This flake doesn't package
them, but can supply the runners their installers need:

```nix
programs.t3code.acpRuntimes = [ "nodejs" ];
# Without the module:
t3code-nix.packages.${pkgs.stdenv.hostPlatform.system}.t3code.override { acpRuntimes = [ "nodejs" ]; }
```

| Value | Adds | Added to `t3` closure (`x86_64`) | For |
| --- | --- | --- | --- |
| `[ ]` (default) | nothing | 0 | standalone binary agents (with `runtimeCompat` if needed) |
| `[ "nodejs" ]` | Node + npm | ~142 MB | npm agents |
| `[ "uv" ]` | `uv` + full Python | ~200 MB | `uv` agents (avoids downloading an unpatched Python) |
| `[ "nodejs" "uv" ]` | both | ~342 MB | npm and `uv` agents |

They are appended to the end of T3 Code's `PATH` (after your login shell's
`PATH` and bundled providers), so your own Node or `uv` always wins. An npm
agent that downloads a native binary may still need `runtimeCompat`. With
the module, `acpRuntimes` applies to the app, CLI, and server.

## T3 Code over SSH: `runtimeCompat`

When a T3 Code desktop app on another machine connects to this host over
SSH, it checks for `t3` on a login shell's `PATH`. If `t3 --version` matches
the app's version, it runs that `t3` directly with no download. That works
automatically when both machines run the same `t3code-nix` channel with
matching app and `t3` versions (the CLI can briefly differ from the app
right after a release even on the same revision) and this host has `t3`
installed via `server.enable`, `enable` + `cli.enable`, the overlay's
`pkgs.t3code`, or the Home Manager equivalents (`enable` alone does not
install `t3`), and that matching flake `t3` is first on the login shell's
`PATH` (an earlier mismatched `t3`, such as `~/.local/bin/t3`, falls back to
the download path).

Otherwise (different version, or no `t3` on `PATH`), the SSH launcher
downloads upstream's server into `~/.t3/runtime`, which requires `nix-ld` on
NixOS:

```nix
programs.t3code.runtimeCompat = true;
```

This enables `programs.nix-ld` with the required libraries and works on its
own without `enable` or `server.enable`. It is off by default (since
`nix-ld` affects every unpatched binary system-wide) and best-effort because
upstream's downloads aren't pinned by this flake. For a managed server on
this machine, use [`server`](server.md) instead.
