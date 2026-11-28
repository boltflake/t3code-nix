# Running the server

`programs.t3code.server` runs this flake's `t3 serve` as a systemd user
service (`t3code-server`) so your other devices can reach this machine. Home
Manager's `programs.t3code-nix.server` runs the same as your own user
service (see [The server under Home Manager](home-manager.md#the-server-under-home-manager)).

- Uses the same channel and providers as the app, needs no `nix-ld`, and
  works without `enable = true` (so a headless machine gets the server and
  `t3` without the desktop app).

Example:

```nix
programs.t3code.server = {
  enable = true;
  users = [ "amber" ];
  lan = true;
  openFirewall = true;
};
# Start at boot and keep running after logout:
users.users.amber.linger = true;
```

Without `users.users.<name>.linger = true`, the server runs only while the
user is logged in.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `server.enable` | `false` | enables the `t3code-server` user service and puts `t3` on `PATH` |
| `server.users` | `[ ]` (every non-system user) | whose session runs it; name one user on multi-user machines since each listens on `port` |
| `server.home` | `null` (`~/.t3`) | `T3CODE_HOME` (`%h` expands to the home folder; no other `%` specifier) |
| `server.port` | `3773` | `T3CODE_PORT` |
| `server.host` | `null` (`127.0.0.1`) | `T3CODE_HOST`: listen address for any client (mutually exclusive with `lan`) |
| `server.lan` | `false` | `T3CODE_LAN`: accept local network and tailnet private addresses (mutually exclusive with `host`) |
| `server.openFirewall` | `false` | opens `port` in the firewall, for `lan` or `host` (Tailscale Serve and T3 Connect need no open port) |
| `server.tailscaleServe.enable`, `.port` | `false`, `443` | serve over HTTPS on your tailnet via Tailscale Serve (needs `services.tailscale` and `tailscale set --operator=<user>`) |
| `server.logLevel` | `null` (`Info`) | `T3CODE_LOG_LEVEL`: `All`, `Trace`, `Debug`, `Info`, `Warn`, `Error`, `Fatal`, or `None` |
| `server.environmentFile` | `null` | `NAME=value` file read at start and kept out of the Nix store (absolute path or under `%h/`). Values win over module options; use `server.home` rather than `T3CODE_HOME` here so `t3code-nix doctor` knows it |

## Pairing and remote access

By default the server listens only on `127.0.0.1`. Make it reachable first
in one of four ways:

- `server.lan = true`: devices on your local network and tailnet
- `server.host`: a specific listen address
- `server.tailscaleServe.enable = true`: HTTPS on your tailnet
- **T3 Connect** (below): from anywhere through T3's relay, with no open port

Then run `t3 pair` on the server and open the code or link on your other
device. (Until it's reachable, `t3 pair` and `t3 status` suggest `t3 up` or
`t3 connect`, which this flake's `t3` refuses—see
[Upstream's own service](#upstreams-own-service).)

### T3 Connect

Once per T3 home:

```sh
t3 connect link                           # sign in via the printed link
systemctl --user restart t3code-server    # connects on start
t3 connect status                         # "Other devices can reach this machine"
```

With `server.home` set, pass `--base-dir <home>` (expanding `%h`, e.g.
`--base-dir ~/.t3-server`) to both `t3` commands. Through the overlay, T3
Connect uses your nixpkgs' `cloudflared` (must be `2025.6.1` or newer). Use
`t3 connect unlink` (then restart) to close the tunnel, and
`t3 connect logout` to sign out.

## Logs and upgrades

- **Logs:** `journalctl --user -u t3code-server` (includes pairing details,
  so anyone who can read your journal can read them).
- **Upgrades:** a rebuild or Home Manager switch doesn't restart a running
  server, so active agent turns aren't interrupted. The new version takes
  effect on the next start (reboot, fresh user-manager login without linger,
  or `systemctl --user restart t3code-server`).

## Database copies

Before a new version of the server first starts, the service backs up
`~/.t3/userdata/statev2.sqlite` (via SQLite's online backup) to
`~/.t3/t3code-nix-backups/statev2-<previous version>-<time>.sqlite` and
keeps the newest three (under `server.home` if set; `<previous version>` is
`unknown` on first start against an existing database).

- Each backup is the full size of the database, which can be several GB
  (`du -h ~/.t3/userdata/statev2.sqlite`).
- If a rollback leaves the server unable to open a migrated database,
  quit the desktop app (and stop anything else using that T3 home) before
  restoring the matching backup (losing changes since then):

  ```sh
  home="$HOME/.t3"  # or your server.home
  systemctl --user stop t3code-server &&
    cp "$home/t3code-nix-backups/statev2-<version>-<time>.sqlite" "$home/userdata/statev2.sqlite.restore" &&
    mv -f "$home/userdata/statev2.sqlite.restore" "$home/userdata/statev2.sqlite" &&
    rm -f "$home/userdata/statev2.sqlite-wal" "$home/userdata/statev2.sqlite-shm" &&
    systemctl --user start t3code-server
  ```

- If a backup fails, the server refuses to start (`systemctl --user status
  t3code-server` shows why) and retries on the next start.

## One server per T3 home

The desktop app runs its own server on `~/.t3`. While `t3code-server` uses
that home, launching the desktop app fails with `"This T3 home is
unavailable"`. To run both on one machine, either:

- launch the desktop app with a different `T3CODE_HOME` and pair it with
  the server like any other device, or
- give the server its own `server.home` and pass `--base-dir` (e.g.
  `--base-dir ~/.t3-server`) to `t3` commands targeting it.

## Upstream's own service

T3 Code's `t3 service install`, `t3 up`, and plain `t3 connect` set up
`~/.config/systemd/user/t3code.service` running T3 Code's own download from
`~/.t3/runtime` (no bundled providers, self-updating outside Nix, needs
[`runtimeCompat`](details.md#t3-code-over-ssh-runtimecompat) on NixOS). This
flake's `t3` refuses those commands and `t3 update`, while keeping
`t3 connect` subcommands (`link`, `login`, `status`, `unlink`, `logout`,
`publish`) working for `t3code-server`.

If upstream's service is already installed, remove it with
`t3 service uninstall` before enabling `t3code-server`. `t3 service protect`
doesn't work on NixOS (`/etc/systemd` is read-only); configure protection
in NixOS with `systemd.slices`, `systemd.services."user@"`, and
`systemd.user.services.t3code-server.serviceConfig`.

**Using upstream's service on purpose:** set `enable`, `cli.enable`,
`cli.allowUpstreamService`, and `runtimeCompat` (without the module:
`t3.override { allowUpstreamService = true; }` plus `programs.nix-ld` with
the libraries listed for `runtimeCompat` in `nixos/module.nix`). Leave
`server.enable` off, or give the two servers separate homes and ports.
