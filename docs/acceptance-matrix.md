# Acceptance matrix

What each package is built from, on each system, and how a new version is
found and checked. Every download URL names its version, so a pin stays
fetchable for as long as the vendor keeps the file. Nothing is compiled
from source: a package whose vendor ships no build for a system is marked
unsupported there (`meta.platforms`), never built from source instead.
Today every vendor ships both x86_64 and aarch64 Linux builds.

Status: ✅ built and version-checked here · ⏳ not yet packaged · 🔲 not yet
checked on that system (aarch64 is checked in CI).

Checked against upstream on 2026-11-12.

## Providers

`{v}` is the version without any leading `v` or `rust-v`.

### codex: ✅ x86_64 · 🔲 aarch64 · pin [versions/codex.json](../versions/codex.json)

- **Version source:** GitHub `openai/codex`, GitHub's latest release (stable `rust-v*` tags; alphas are marked prerelease, so they never appear)
- **Asset:** `https://github.com/openai/codex/releases/download/rust-v{v}/codex-package-{x86_64,aarch64}-unknown-linux-musl.tar.zst`
- **Checksum:** GitHub asset digest (sigstore bundles also published)
- **Version probe:** `codex --version`

### fx: ✅ x86_64 · 🔲 aarch64 · pin [versions/fx.json](../versions/fx.json)

- **Version source:** GitHub `vercel-labs/fx`, GitHub's latest release
- **Asset:** `https://github.com/vercel-labs/fx/releases/download/v{v}/fx-linux-{x86_64,aarch64}.tar.gz`
- **Checksum:** GitHub asset digest; must agree with the published `<asset>.sha256`
- **Version probe:** `fx --version`

### opencode: ✅ x86_64 · 🔲 aarch64 · pin [versions/opencode.json](../versions/opencode.json)

- **Version source:** GitHub `anomalyco/opencode`, the highest `vX.Y.Z` with X ≥ 2 among its last 30 releases (upstream puts GitHub's Latest marker on its 1.x line while 2.x moves ahead; t3code drives every major from 2 on as 2.x; the repo also releases `process-daemon-v*`)
- **Asset:** `https://github.com/anomalyco/opencode/releases/download/v{v}/opencode-linux-{x64,arm64}.tar.gz`
- **Checksum:** GitHub asset digest; must agree with the published `SHA256SUMS`
- **Version probe:** `opencode --version`

### pi: ✅ x86_64 · 🔲 aarch64 · pin [versions/pi.json](../versions/pi.json)

- **Version source:** GitHub `earendil-works/pi`, GitHub's latest release
- **Asset:** `https://github.com/earendil-works/pi/releases/download/v{v}/pi-linux-{x64,arm64}.tar.gz`
- **Checksum:** GitHub asset digest; must agree with the published `SHA256SUMS`
- **Version probe:** `pi --version`

### claude-code: ✅ x86_64 · 🔲 aarch64 · unfree · pin [versions/claude-code.json](../versions/claude-code.json)

- **Version source:** `https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest` (plain text)
- **Asset:** `…/claude-code-releases/{v}/linux-{x64,arm64}/claude` (musl builds `linux-{x64,arm64}-musl` also exist)
- **Checksum:** `…/claude-code-releases/{v}/manifest.json`, `platforms.<platform>.checksum` (SHA-256)
- **Version probe:** `claude --version`

### grok: ✅ x86_64 · 🔲 aarch64 · unfree · pin [versions/grok.json](../versions/grok.json)

- **Version source:** `https://storage.googleapis.com/grok-build-public-artifacts/cli/stable` (plain text)
- **Asset:** `https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-{v}-linux-{x86_64,aarch64}`
- **Checksum:** **none published**, so the updater pins the bytes it downloads
- **Version probe:** `grok --version`

### cursor-agent: ✅ x86_64 · 🔲 aarch64 · unfree · pin [versions/cursor-agent.json](../versions/cursor-agent.json)

- **Version source:** the `lab/<version>` path in `https://cursor.com/install`, polled every 5 minutes
- **Asset:** `https://downloads.cursor.com/lab/{v}/linux/{x64,arm64}/agent-cli-package.tar.gz`
- **Checksum:** `<asset>.sha256`, next to the asset
- **Version probe:** `agent --version`

### antigravity: ✅ x86_64 · 🔲 aarch64 · unfree · pin [versions/antigravity.json](../versions/antigravity.json)

- **Version source:** `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_{amd64,arm64}.json`
- **Asset:** the manifest's `url`, which names the version, for example `https://storage.googleapis.com/antigravity-public/antigravity-cli/{v}-{build}/linux-{x64,arm}/cli_linux_{x64,arm64}.tar.gz`
- **Checksum:** the manifest's `sha512`
- **Version probe:** `agy --version`

### kiro-cli: ✅ x86_64 · 🔲 aarch64 · unfree · pin [versions/kiro-cli.json](../versions/kiro-cli.json)

- **Version source:** `https://desktop-release.q.us-east-1.amazonaws.com/latest/manifest.json`
- **Asset:** `https://desktop-release.q.us-east-1.amazonaws.com/{v}/kirocli-{x86_64,aarch64}-linux.tar.gz` (also `.zip`, `.tar.zst`, musl and `.deb` variants)
- **Checksum:** the manifest's `packages[].sha256`
- **Version probe:** `kiro-cli --version`

### muse: ✅ x86_64 · 🔲 aarch64 · unfree · pin [versions/muse.json](../versions/muse.json)

- **Version source:** `https://api.meta.ai/muse-code/channels/muse-stable`
- **Asset:** `https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version={v}&file=muse-{x86,aarch64}-linux`
- **Checksum:** `…&version={v}&file=manifest.json`, `artifacts.{x86,aarch64}_linux.checksum` (SHA-256)
- **Version probe:** `muse --version`

## T3 Code: ✅ x86_64 · 🔲 aarch64 · pins [versions/t3code.json](../versions/t3code.json), [t3.json](../versions/t3.json) and their `-nightly` twins

- **Latest:** the GitHub GraphQL `latestRelease` of `pingdotgg/t3code` (the latest channel, named after upstream's desktop update channel).
- **Nightly:** whichever is newer of the newest `vX.Y.Z-nightly.<date>.<n>` prerelease and the latest channel's version. Previews (`-preview.`), `android-*` and drafts are skipped on purpose. A nightly sorts below its own `vX.Y.Z` version.
- **Completeness:** a release counts only once all five assets below are listed.
- **Electron:** the desktop pins record the exact Electron upstream bundles (`apps/desktop/package.json` at the release's commit; `null` when it isn't a plain X.Y.Z), which the build checks against the `.deb`'s program. `electron = "auto"` (the default) runs the app on nixpkgs' `electron_N-bin` of that major when it's usable and at least as new, copied and renamed so the app runs packaged; both runtimes are built and smoke-tested, and a release whose nixpkgs runtime alone fails ships on bundled (`ci/electron-fallback.json`, `lib/electron.nix`). Which one each Desktop app package runs is recorded in `ci/electron-runtime.json` (evaluated from the package in the update run's resolve job, best effort), which the status page and the release notes name; the `electron-runtime` check fails an entry that describes its tree and isn't what the package evaluates to.

| Package | Asset | Checksum | Version probe |
| --- | --- | --- | --- |
| t3code (desktop) | `https://github.com/pingdotgg/t3code/releases/download/v{v}/T3-Code-{v}-{amd64,arm64}.deb` | GitHub asset digest (upstream's `SHA256SUMS` covers only the CLI archives; an entry there would have to agree) | desktop smoke test |
| t3 (CLI) | `…/v{v}/t3-{v}-linux-{x64,arm64}.tar.gz` | GitHub asset digest; must agree with `SHA256SUMS` | `t3 --version` |
| chrome-headless-shell (preview browser, unfree) | `https://storage.googleapis.com/chrome-for-testing-public/{browser}/{linux64,linux-arm64}/chrome-headless-shell-{…}.zip` | the SHA-256 t3code's own `apps/server/src/preview/PreviewBrowser.ts` pins, read at the release's commit; the `preview-browser-pin` check confirms the bundled server pins the same | t3 smoke: screenshot through t3code's path, `t3 browser setup` ready |

## Agent tools

Tools the agents use themselves; never in T3 Code's closure.

### boat: ✅ x86_64 · 🔲 aarch64 · pin [versions/boat.json](../versions/boat.json)

- **Version source:** boat's own update endpoint, `https://boat.dev/api/boat/cli/version?platform={linux-x64,linux-arm64}&channel=prod`: both platforms must name the same plain `X.Y.Z`, the tag `boat-cli-v{v}` and boat's own download URL (the tag list mixes staging and region builds, so it's never used)
- **Asset:** `https://github.com/ariana-dot-dev/agent-server/releases/download/boat-cli-v{v}/boat-linux-{x64,arm64}` (static-pie, installed as it is)
- **Checksum:** GitHub asset digest; must agree with the release's `SHA256SUMS`, which must be there
- **Version probe:** `boat --version`

### agent-browser: ✅ x86_64 · 🔲 aarch64 · pin [versions/agent-browser.json](../versions/agent-browser.json)

- **Version source:** GitHub `vercel-labs/agent-browser`, GitHub's latest release
- **Asset:** `https://github.com/vercel-labs/agent-browser/releases/download/v{v}/agent-browser-linux-musl-{x64,arm64}` (static, installed as it is)
- **Checksum:** GitHub asset digest (the release publishes no checksum file)
- **Version probe:** `agent-browser --version`; the runner's `agent-browser-smoke` drives a page with each browser pin's Chromium
- **Browser:** ungoogled-chromium from nixpkgs at the revisions in [versions/browser-unstable.json](../versions/browser-unstable.json) and [versions/browser-stable.json](../versions/browser-stable.json) (cache.nixos.org's builds, never built here)

## NixOS stable: pin [versions/nixpkgs-stable.json](../versions/nixpkgs-stable.json), snapshot [versions/stable/](../versions/stable/)

- **What:** every package above but the nightlies, built on the newest released NixOS (`legacyPackages.<system>.stable`), from the snapshot's copy of the pins
- **Version source:** the newest released `nixos-YY.MM` channel's revision (prefetched; a move waits until the stable set needs nothing cache.nixos.org lacks), checked with each new T3 Code on the latest channel and at least weekly
- **Checks:** the stable acceptance suite (`lib/stable-suite.nix`) on both systems, as `stable-<check>` (the snapshot) and `stable-next-<check>` (the current pins), plus the desktop and agent-browser smokes; the snapshot moves at publish only to a set whose stable-next checks all passed
- **Downloads:** the resolve job asks for every file the snapshot pins on each run (`stable-unfetchable` when one is gone)

## Vendors with no checksum source

**grok** is the only one. It's the only package that can ever need a
manual re-pin: `node scripts/pin.ts vendor grok` on a branch, after checking
the new file (see the README's maintainer notes).

## Notes per package

- **codex:** upstream's main binaries, `rg` and `bwrap` are static musl.
  Only the voice runtime (`codex-resources/voice/`) is dynamically
  linked, and it is patched. The package swaps the bundled `rg` for
  nixpkgs' ripgrep on both systems. A static `rg` for aarch64 was only
  needed while the daemon copied codex out of the store, and
  the daemon is off.

  The wrapper turns off:
  - the daemon's auto-start (`-c features.daemon_auto_start=false`;
    `codex features list` shows it off)
  - the online update check at startup
    (`-c check_for_update_on_startup=false`; `codex doctor` shows it off).
    `DISABLE_AUTOUPDATER` does nothing for codex, so it isn't set.

  It also puts nixpkgs' bubblewrap first on `PATH`. `codex-layout` checks
  the package against the vendor's archive: every file as shipped except
  `rg` (nixpkgs') and the patched voice runtime (see the check in
  `lib/checks.nix`).

  Known gap ([openai/codex#41188](https://github.com/openai/codex/issues/41188)):
  the TUI's `/daemon` menu runs the vendor binary's own `app-server daemon
  update` (or `… --from-cli --yes`) from its own executable, past the
  guard; neither `--no-daemon` nor any config key hides it. It installs
  only when a daemon package is already selected in
  `$CODEX_HOME/packages/app-server-daemon` (by default `~/.codex`), left
  by a codex with auto-start on or a copied `~/.codex`.
  - `update-guards`: both commands install nothing in a fresh home.
  - `doctor-scenarios`: the doctor warns about that folder, and about its
    server (`daemon.pid`; `daemon stop` ends it) and update loop
    (`daemon-updater.pid`; `daemon stop` leaves it, a kill ends it) when
    each is live, still the recorded process (as codex checks it: boot ID
    and start ticks, or a pre-0.156 record's `ps` start time), and run
    from a codex outside the store.

  Known gap ([openai/codex#61732](https://github.com/openai/codex/issues/61732),
  which has the investigation): codex's `/voice` doesn't work on
  NixOS ("voice audio devices could not open"; tested by hand on 0.167.2).
  `codex-voice-host` links alsa-lib in statically, and codex starts it with
  a fixed environment, so no wrapper variable reaches it. Two things fail:
  1. Its alsa-lib reads `/usr/share/alsa/alsa.conf`, which NixOS doesn't
     have.
  2. It rejects the `libs.native` field (from a nixpkgs-only alsa-lib
     patch) in NixOS's PipeWire ALSA config.
  With both worked around by hand, `/voice` connects. A hand-written
  `~/.asoundrc` naming raw `plughw` devices also worked, bypassing PipeWire;
  the bundled GStreamer has no audio source or sink. A package-side fix
  would need a wrapper around the helper, outside `codex-layout`'s
  byte-for-byte rule; the owner decided against it (2026-11-16), so this
  stays a known gap until codex fixes it upstream. `codex-layout` checks
  only that the helper's libraries resolve, not that it reaches the sound
  system.
- **fx:** one static binary; nothing to patch.
- **opencode:** a Bun-compiled executable.
  - Plain autoPatchelf keeps Bun's embedded code intact (tested).
  - `libstdc++` is added as a needed library for the file watcher's
    add-on.
  - It writes `$TMPDIR/opencode` on start.
  - 2.x embeds an `opencode-pty` helper that it writes to its own bin
    folder and runs, unpatched, so it needs nix-ld on NixOS. It serves only
    an experimental API t3code doesn't use (`OPENCODE_PTY_BIN` overrides
    the path).
- **pi:** a Bun-compiled executable that reads its themes, docs and native
  add-ons from its own directory, so the whole tree is installed together.
  The X11 clipboard add-on needs `libxcb`.
- **kiro-cli:** nixpkgs packages 2.35.1 inside an FHS environment, because
  2.x unpacked a separate Bun runtime at run time. 3.x is one binary that
  needs only glibc and libgcc. `--help` and `chat --help` write nothing,
  so it's patched directly. The t3 smoke test finds it at its pinned
  version; a signed-in session isn't tested here (it needs an account).
- **claude-code:** a Bun-compiled executable, patched with plain
  autoPatchelf. Its wrapper sets `DISABLE_AUTOUPDATER`,
  `DISABLE_INSTALLATION_CHECKS` and `DISABLE_UPDATES`, and
  `CLAUDE_CODE_CERT_STORE=system` unless the user set it.
- **grok, muse:** static binaries; nothing to patch. Only `grok` goes on
  `PATH`. The binary also answers to `agent`, which belongs to cursor.
- **cursor-agent:** a bash launcher runs the bundled `node` on `index.js`.
  The folder also holds Node single-file executables, `rg`, a sandbox
  helper and native add-ons. The dynamically linked files are patched; the
  static helpers (`rg` and `crepectl`, and `cursorsandbox` on x86_64) are
  left as shipped. Both `agent` and `cursor-agent` go on `PATH`; T3 Code
  runs cursor through its SDK and looks up neither.
- **antigravity:** one dynamically linked binary, patched with plain
  autoPatchelf. `agy acp` (what t3code starts) runs. On start it writes a
  `webm_encoder` helper to `~/.gemini/antigravity-cli/bin` whose
  interpreter (`/usr/grte/v5/lib64/ld-linux-x86-64.so.2`) NixOS doesn't
  have, so that helper can't run (upstream's; seen 2026-11-16).

## Self-update switches and guards

Background updaters are switched off where the binary has a switch
(checked by `updater-switches`). On top of that, every provider's own
update or self-install command is refused by its wrapper (`lib/guard.nix`,
checked by `update-guards`). t3code's "update provider" button runs some of
these, and `claude update` was seen to install a 327 MB unpatched copy into
`~/.local/share/claude` and link it as `~/.local/bin/claude`.

The guards for claude, cursor-agent, grok, agy, opencode, fx and kiro-cli
refuse a refused command wherever it appears on the command line, unless
`-h` or `--help` comes right after it (with no `--` before), or the
forms that only print help or the version there (cursor-agent's
`--version` and short clusters starting with `v`, grok's short clusters
starting with `h`, agy's `-help`). A line runs as usual when its first argument is help,
the version, or one of the provider's other reviewed commands
(`providerCommands`): `claude plugin install x`, `claude mcp get update`,
`opencode run update`, `grok sessions update`. Earlier versions parsed each
provider's command line from tables of its options, and testing kept
finding parser rules the tables couldn't express (hidden options,
values that look like options, boolean value words, a `cc://` argument
that turns claude's print mode off), several of which installed claude,
cursor-agent, grok or opencode outside Nix. So the rule is broad on
purpose, and it refuses some ordinary use, with the message: a one-word
prompt that is a refused name (`claude -p update`, `grok -p update`), a
prompt given as separate words, unquoted, that include one
(`cursor-agent please update the readme`; quoted, it runs), an
option's value equal to one (`claude --resume update`), an option before
another command (`claude --verbose plugin install x`). agent-browser and
boat, with no command list, take the word after an option as its value and
the next plain word as the command. opencode's `--wizard` (and
`--no-wizard`, which starts it too), which builds a command interactively
with `upgrade` first, is refused wherever it comes.
Every guard runs in a subshell, so its variables never reach the program's
environment (`guard-environment`). `update-guards` checks these forms, the
accepted over-refusals and forms that must run or print help.

| Package | Background updater | Refused commands |
| --- | --- | --- |
| codex | the startup update check off (`-c check_for_update_on_startup=false`), daemon auto-start off (so plain `remote-control` runs in the foreground and installs nothing; `update-guards` checks it) | `update`, wherever clap finds it; below `app-server daemon` and `remote-control`, every command but `stop`, `version`, `pair`, `enable-`/`disable-remote-control` and `help` (`update`, `bootstrap`, `start`, `restart`, the hidden `pid-update-loop` and `remote-control start` install its daemon package into `~/.codex`) |
| claude-code | `DISABLE_AUTOUPDATER=1`, `DISABLE_INSTALLATION_CHECKS=1`; `DISABLE_UPDATES=1` makes claude itself refuse its update commands too ("Updates are disabled by your administrator"), a second line behind the guard | `install`, `update`, `upgrade`, and `--update`/`--upgrade` (claude runs `update` for either alone) |
| grok | `GROK_DISABLE_AUTOUPDATER=1` | `update` |
| kiro-cli | `KIRO_NO_AUTO_UPDATE=1` | `update`, `upgrade` (a hidden alias); `crew --yes` installs Kiro Crew, a separate product, with its own script |
| cursor-agent | `--disable-auto-update`; `AGENT_CLI_UPDATE_CHECK_URL` points at a closed loopback port, so every update fails at its check ("Failed to fetch update info"), the TUI's `/update` menu entry too, which no command-line guard sees; and each start writes cursor's own opt-out marker (`grok-switch-opt-out.json`, into every folder cursor could use for its config: `CURSOR_CONFIG_DIR` and `XDG_CONFIG_HOME/cursor` when set and not empty, and `~/.cursor` whenever `HOME` is set, `./.cursor` for an empty one; a relative value is marked under the directory cursor is started in, and a value cursor's `trim()` treats as unset just gets a folder of that name it never reads) for the menu's switch to a downloaded "Grok agent host", which would skip that check when two account flags are on (off today); with `HOME` unset and neither `CURSOR_CONFIG_DIR` nor `XDG_CONFIG_HOME` set, no marker is written, though cursor then uses the passwd entry's home; and with a relative config folder (a relative `CURSOR_CONFIG_DIR` or `XDG_CONFIG_HOME`, or an empty `HOME`), `--workspace` (which moves cursor to another directory; `-w`/`--worktree` and `persist` may too, not traced) makes cursor look for the marker under that directory, where there is none (left so by the owner's decision: the wrapper doesn't parse cursor's options) (the switch also needs an interactive, signed-in session) | `update`; hidden: `upgrade` (its alias), `install <version>`, `set-channel` |
| antigravity | `AGY_CLI_DISABLE_AUTO_UPDATE=true` (its updater also skips a read-only folder) | `update`, `install` (also edits shell settings) |
| opencode | `OPENCODE_DISABLE_AUTOUPDATE=true` | `upgrade`, `update` (its alias) |
| fx | `FX_AUTO_UPGRADE=0` | `update`, `upgrade` |
| pi | none found | `update` of pi itself (`update`, `self`, `pi`, `--self`, `--all`, or with only options such as `--force`); `update --extensions`, `--models` or `--extension <source>` still works |
| muse | none found | no update command |
| boat | `BOAT_NO_UPDATE=1` (`boat-self-update-off` checks it on a loopback recorder) | `self-update` |
| agent-browser | none: no background updater | `upgrade` (installs a second copy with npm, pnpm, bun or brew), `install` and `doctor --fix` (download Chrome for Testing) |
| t3 (the CLI) | `T3CODE_DISABLE_AUTO_UPDATE` is the desktop app's; the CLI has no background updater | `update`, `service install`, `service update`, `up`, plain `connect` (they install upstream's own t3 and its service; `programs.t3code.server` replaces it, and `t3 connect link` gives it T3 Connect; `cli.allowUpstreamService` turns this off) |

Provider behaviour the guards don't cover (upstream's, seen 2026-11-16):

- opencode's TUI starts a background `opencode serve --service` on
  127.0.0.1:49374 that outlives the TUI and keeps the PATH and store path it
  started with, so after an upgrade the old one runs until it is stopped;
  one already on that port (from another HOME) stops the TUI starting.
  Through the wrapper it inherits the updater switch ("update check skipped
  reason=disabled").
- opencode's in-program "Update OpenCode" command (and its `upgrade`
  without `--method`, run past the guard) ignores
  `OPENCODE_DISABLE_AUTOUPDATE`; on a Nix install it fails with "Could not
  detect the installation method" and installs nothing. That, not the
  switch, is what makes it harmless here.
- `agy remote-control start` (reviewed as a let-through command) seems to
  register a systemd user unit, `antigravity-cli-daemon.service`, whose
  `ExecStart` may name the unwrapped store path; such a daemon would run
  without the wrapper's settings and stop working when that path is
  garbage-collected. Unconfirmed: it needs a signed-in account.
- grok's own guide (written to `~/.grok/docs/user-guide/`) describes an
  update key on its welcome screen (`Ctrl+U`), which would update it past
  any command-line guard; it lists `GROK_DISABLE_AUTOUPDATER=1`, which the
  wrapper sets, under update-check suppression, so the offer likely never
  appears here. Unconfirmed: the welcome screen needs a signed-in account.
- claude applies the `env` block of its settings files over its own
  environment, so a repository's `.claude/settings.json` (or the user's)
  can turn the wrapper's update switches off; with one set to "0", claude
  updated itself into `~/.local` in an ordinary session. Only its
  machine policy, under `/etc/claude-code`, ranks above those files
  (checked: it held against project, local and user files, `--settings`,
  `--setting-sources` and the managed-settings variables). The NixOS
  module writes it as a copied drop-in,
  `managed-settings.d/10-t3code-nix.json`, when the app, the server or the
  CLI bundles claude (`claudeCodePolicy`, `module-eval`); a drop-in sits
  beside an owner's own `managed-settings.json` (an owner's base file
  without the switches would otherwise reopen this), and a copy avoids
  `claude doctor`'s warning about a policy reached through a link. The
  doctor asks claude itself: it runs the bundled claude's own `doctor`
  without the wrapper's settings and reads its verdict (OK when it reports
  `DISABLE_UPDATES`, a warning when it doesn't, a problem with claude's
  message when claude rejects a policy file), so it agrees with claude
  however a policy is written (`doctor-scenarios`; checked by hand against
  the real claude).
  Unconfirmed: whether a signed-in organisation's remote managed settings
  replace or merge with the file's `env`. `CLAUDE_CODE_MANAGED_SETTINGS_PATH`
  isn't honoured by this claude, and a wrapper `--settings` would be
  replaced by a later one (T3 Code passes its own on one path).
- `claude doctor` in a fresh HOME warns that a native installation exists
  but `~/.local/bin` isn't on PATH, and suggests `/doctor` in a session can
  fix it; on Nix neither applies.

## t3code findings (build step 3)

- t3code's server puts the login-shell `PATH` ahead of the wrapper's, so a
  provider the user installed themselves wins over the bundled one (kept by
  the user's choice; see the README).
- t3code enables only codex and claude by default; the others are switched
  on in its settings.
- On a Nix install the update notice shows "behind latest" with
  `canUpdate: false` for codex; claude, grok and pi report `canUpdate: true`
  with their own update command, which the guards refuse.
- Antigravity is found through a link named `agy_acp_server.par` to `agy`,
  which lives only on t3code's `PATH` (`pkgs/t3code/wrap.nix`).
- The desktop app registers `t3code://` as `Exec=<bin> %U` (profile-stable).
  Its `~/.t3/bin/t3` runs the app's own Electron from the store, without the
  bundled providers, and after garbage collection says "Open the app once";
  the app rewrites it on each start. No `~/.local/bin/t3` link was created.
