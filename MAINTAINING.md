# Maintaining t3code-nix

Notes for whoever runs this flake: setting it up, the issues it opens, and the rules for changing it. For using it, see the [README](README.md).

## Setting up, once

**The release watcher.** It runs on Cloudflare (`watcher/`), and
`deploy-watcher.yml` deploys it on every change to `watcher/` or `shared/`
on `main`. When a deploy never reports healthy, that workflow rolls back to
the previous version, but only if the live version is still the one it
deployed; otherwise it leaves the check to you. So the first deploy is by
hand, from a checkout of `main`. The workflow's API token can edit only this
Worker and so can't create it: the first deploy signs in with
`wrangler login` (in a browser) instead. Create the Worker's KV namespace
first (in the Cloudflare dashboard, or with `wrangler kv namespace create`),
and put its ID and your account ID in place of the placeholders:

```sh
cd watcher
sed -i "s/KV_NAMESPACE_ID/your-kv-namespace-id/" wrangler.jsonc  # don't commit this
export CLOUDFLARE_ACCOUNT_ID=your-account-id
nix shell --inputs-from .. nixpkgs#wrangler -c sh -c '
  wrangler login
  wrangler deploy
  wrangler secret put GITHUB_TOKEN
  wrangler secret put HEALTH_TOKEN'
git checkout wrangler.jsonc
```

`GITHUB_TOKEN` is a fine-grained token for this repository only, with
Actions read and write (for `workflow_dispatch`: the update run on each
new version, and `pages.yml` and `health.yml` about hourly, since GitHub's
own schedule drops runs; those ride on the watcher's existing KV writes and
add none) and a one-year expiry;
`HEALTH_TOKEN` is any long random string. Then set, in the repository:

- the secret `WATCHER_HEALTH_TOKEN` to the same `HEALTH_TOKEN`;
- the variable `WATCHER_URL` to the `workers.dev` address `wrangler deploy`
  printed;
- the variables `CLOUDFLARE_ACCOUNT_ID` and `WATCHER_KV_ID` (the KV
  namespace ID), and the secret `CLOUDFLARE_API_TOKEN`, a token that can
  edit only this Worker.

Check it with
`curl -H "Authorization: Bearer <HEALTH_TOKEN>" <WATCHER_URL>/health`. From
then on the workflow deploys; it skips until all three variables are set.

**Turning updates on.** Update runs are real only once the repository
variable `UPDATES` is `true`; until then the hourly backstop dispatches
nothing and opens no issues, and a dispatched run (the watcher's, say) stops
before reading upstream. A dry run (`dry_run`) works either way. The status
page deploys only once the variable `PAGES` is `true`, with the repository's
Pages source set to "GitHub Actions".

**The binary cache.** The update run's cache job runs only once the
variable `CACHIX_CACHE` (the cache's name) is set, and needs the secret
`CACHIX_AUTH_TOKEN` to push.

## When an issue opens

The update runs, the hourly health check and the weekly tooling check
(`tooling.yml`) open issues and close them by themselves; every kind is
listed in `PROBLEMS` in `scripts/ci/issues.ts`. These seven need explaining:

| Issue | What it means | What to do | It closes when |
| --- | --- | --- | --- |
| `bump-waiting` | nixpkgs, the NixOS stable pin or a browser pin hasn't moved on `main` for 14 days | Read what it names | The pin moves on `main` |
| `downgrade` | Upstream pulled a release, and `main` followed it back | Nothing; it blocks no update | That pin is back at the pulled version or higher |
| `integrity` | A pin's file changed without a new version | Nothing when the vendor's checksum vouches for the new file, which is then pinned; for grok, which publishes none, check the file, then re-pin it | `main` pins the new file |
| `guard-review` | A release's help doesn't match the lists in `lib/guard.nix` | Update the lists | A later published run matches |
| `watcher-auth` | The watcher's GitHub token was refused: reading GitHub, dispatching the update run, or starting `pages.yml` or `health.yml` (opened by the hourly health check) | Rotate the token | Three health checks in a row find the watcher healthy |
| `watcher-stalled` | `/health` didn't answer, either cron key's state wasn't saved in the last 30 minutes, or a source, the update dispatch, or the hourly start of `pages.yml` or `health.yml` has failed for over 6 hours (a disabled `pages.yml` shows here after 6 hours; a disabled `health.yml` can't report itself, and once the update run re-enables it, the next successful send can clear the error before health reads it. After a rollback to a watcher version without the hourly starts, a start error saved before it stays in `/health` until the next deploy) | Look at the watcher (`/health`, the Worker's logs) | Three health checks in a row find the watcher healthy |
| `tooling-outdated` | The CI's own tooling has a newer version that nothing else updates (weekly): a GitHub Ubuntu runner image, a Node LTS line, or the pinned actionlint knowing the labels `.github/actionlint.yaml` names | Do what it says, as an ordinary change | The weekly check finds it current |

**`bump-waiting`.** The nixpkgs bump, the NixOS stable pin
(`versions/nixpkgs-stable.json`) and the browser pins each wait while
cache.nixos.org doesn't have their builds yet. The nixpkgs bump also waits
while the packages don't evaluate at the new revision. The nixpkgs and
browser-pin issues name the builds that aren't on cache.nixos.org yet (held
up by a Hydra failure, say, or an aarch64 build that's behind), or say the
cache couldn't be checked; the NixOS stable pin's gives only the first line
of its reason (that the move waits for the cache, or why it couldn't look).
Each run's summary has the details.

**`downgrade`.** When upstream pulls a release (deletes it, or marks it a
draft or prerelease again), `main` follows its pointer back to the earlier
version, after the usual tests. Each pin that moved back gets its own
issue, titled with the pulled version, so a pull on T3 Code's latest
channel opens two (the app and the CLI). A move between two versions with
the same numbers and different suffixes (two nightlies of one version,
say) can't be ordered, so it opens no issue.

**`integrity`.** grok publishes no checksum, so when its file changes
without a new version, the updater keeps the old pin. After checking the
new file, re-pin it on a branch with `node scripts/pin.ts vendor grok` and
land it like any change.

**`guard-review`.** See [A new command or option in a
provider](#a-new-command-or-option-in-a-provider) below.

**`watcher-auth`.** Make a new GitHub token the same way as the first one.
Then, in `watcher/` with `CLOUDFLARE_ACCOUNT_ID` set, run
`nix shell --inputs-from .. nixpkgs#wrangler -c wrangler secret put GITHUB_TOKEN`
(after `wrangler login`, or with `CLOUDFLARE_API_TOKEN` set to the
workflow's token).

**GitHub's Latest marker on the wrong release.** A release made by hand on
a tag that isn't `t3code-v*` takes GitHub's Latest marker unless "Set as
the latest release" is unticked, and the update runs leave it there. To
hand the marker back, tick "Set as the latest release" on any `t3code-v*`
release; the next update run moves it to the version `main` pins.
Unticking it on the wrong release doesn't work: GitHub keeps the marker
there.

## Making changes

### Rules for providers

Every provider is packaged the same way. A new one follows these rules, so
the checks, the updater and the docs treat it like the others.

1. **Only T3 Code's own providers.** A provider is added when a T3 Code
   release adds a built-in driver for it, never otherwise.
   `pkgs/t3code/providers.nix` lists exactly those drivers, and the t3
   smoke test fails when T3 Code has one that isn't there. The package is
   named after the vendor's program (`claude-code`, `kiro-cli`), and
   `providers.nix` maps T3 Code's driver name to it.
2. **The vendor's prebuilt release, as shipped.** No package is built
   from source or from npm (the one build tool compiled is wrap-buddy, for
   opencode). The package installs the vendor's own Linux build
   for x86_64 and aarch64. A system the vendor doesn't ship is left out of
   `meta.platforms`, never built some other way. `meta.sourceProvenance`
   is `binaryNativeCode`.
3. **One pin, written by the updater.** The version, URLs and hashes live
   in `versions/<name>.json` and nowhere else, and nobody edits that file by
   hand: the updater writes it, and `node scripts/pin.ts` writes the first
   one. Every URL names its version, so an old pin keeps pointing at the
   same file (fetching it still needs the vendor to keep it). Each
   hash comes from a checksum the vendor publishes (a GitHub asset digest,
   a manifest, a `.sha256` file), and the pin records it (the asset's
   `digest`, or where it came from in `checksumSource`). grok is the only
   exception, because its vendor publishes no checksum.
4. **One source, shared by the watcher and the updater.** Where releases
   come from is defined once, in `shared/sources.ts`: an entry in `GITHUB`
   for a GitHub release, or a URL in `VENDOR_URLS` for anything else.
5. **Changed for NixOS only where it has to be.** With a wrapper, the
   vendor's files go in `$out/libexec/<name>/` as shipped, and `$out/bin/`
   holds the wrapper. A
   static binary is installed byte for byte (`dontStrip`,
   `dontPatchELF`); a dynamic one is patched with `autoPatchelfHook`
   against nixpkgs' libraries (opencode with wrap-buddy instead, which
   aarch64 needs; see `docs/acceptance-matrix.md`). Programs the provider runs come from nixpkgs,
   on the wrapper's `PATH` (claude's bubblewrap and socat, codex's
   bubblewrap) or in place of a bundled copy (codex's ripgrep). The package's opening comment says what it is and every
   change made for NixOS.
6. **It never updates itself.** If it can update or reinstall itself,
   the wrapper's first arguments are `guard.refuse` (or the provider's own
   guard in `lib/guard.nix`), followed by the vendor's own switch that turns
   its auto-updater off. `updater-switches` checks that switch. A provider
   with no self-update (muse) needs no wrapper, and is installed as the
   command itself.
7. **The shared helpers, not copies of them.** `versions.load`,
   `versions.asset` and `versions.platforms` read the pin;
   `versions.installCheck { }` checks that `<command> --version` reports
   the pinned version; `versions.installLicenses` installs the vendor's
   licence files. Shell completions are generated only when the build
   machine can run the program (`stdenv.buildPlatform.canExecute`).
8. **`meta` in full.** `description`, `homepage`, `license`,
   `sourceProvenance`, `platforms` (from the pin) and `mainProgram`. An
   unfree provider is also listed in `pkgs/unfree.nix` and in `UNFREE` in
   `scripts/lib/packages.ts`.
9. **Documented like the others.** It gets an entry in
   `docs/acceptance-matrix.md` in the same form (version source, asset,
   checksum, version probe) and a row in the [README](README.md)'s provider table. The
   README's provider counts change too: "all ten", "the other eight" and
   the free and unfree counts, also in `templates/default/flake.nix` and
   `nixos/module.nix`.

### Adding a provider

A version bump needs no code: the updater writes the pin, and a package
changes only when the vendor's archive or runtime does. The t3code pins
(`t3code`, `t3`, and their `-nightly` twins) are only ever written by the
updater (`node scripts/update.ts --write --only <name>`). A new provider
touches these places (the ones marked "fails" stop the build until they are
done):

1. Its pin. For a GitHub release, an entry in `GITHUB` in
   `shared/sources.ts`, which the watcher also reads, and the first pin
   from `node scripts/pin.ts github`. For any other vendor, its URL in
   `VENDOR_URLS` in `shared/sources.ts`, a resolver in
   `scripts/lib/vendors.ts`, a watcher source in `CRONS` in
   `watcher/src/watcher.ts`, and the first pin from
   `node scripts/pin.ts vendor <name>`. If T3 Code's update notice checks an
   npm package for it, also its entry in `NPM` in `scripts/update.ts`.
2. `pkgs/<name>/package.nix`, modelled on a provider of the same kind
   (grok: one static binary; claude-code: one patched binary; pi: a whole
   tree; muse: one static binary with no wrapper): `versions.asset` and
   `versions.platforms` for the pin, `versions.installCheck` for the
   install check, `versions.installLicenses`, and, if it can update itself,
   a wrapper with `guard.refuse { name = "<name>"; }` first, then its
   updater switches. Its update commands, help forms and reviewed commands
   go in `lib/guard.nix` (`providerRefused`, `providerHelp`,
   `providerCommands`; a wrapper using `guard.refuse` fails without the
   first two).
3. `pkgs/default.nix`, `pkgs/unfree.nix` if it's unfree, and its T3 Code
   driver in `pkgs/t3code/providers.nix`.
4. In `lib/checks.nix`: `provider-wrappers`' `bins` (fails without it),
   its switch in `updater-switches`, its help anchors in
   `provider-commands`, `licences`, and `as-shipped` or `completions` when
   they apply.
5. The command T3 Code looks for, in `commands` in
   `pkgs/doctor/package.nix`, and its name in `lib/overlay.nix`
   (`candidates`, or `notTopLevel`) and `lib/stable-suite.nix` (all three
   fail until they list it).
6. Its name on the status page (`scripts/lib/packages.ts`), in
   `nixos/module.nix`'s provider option, the README's provider list and
   `docs/acceptance-matrix.md`.

### A new command or option in a provider

The update guards depend on lists in `lib/guard.nix`, and three checks
compare those lists with each release's help. None of them holds a
release: a mismatch opens a `guard-review` issue for that package once the
release is published. Branch CI fails on a mismatch only when the commit
changes `lib/guard.nix`. That way a wrong edit to the lists can't land, and
an issue already open on `main` doesn't block other changes. (A change to
the checks themselves in `lib/checks.nix` is covered by their self-tests.)

If the two t3 channels disagree about an option (one has turned a value
option into a flag, say), the list can't be right for both. Leave the
issue open until they agree.

- `t3-guard-flags`: every command `t3` lists at any depth
  (`auth pairing create`), the options that take a value, and the words a
  boolean option takes (a name only one channel lists is fine). For a new
  command, read what it does in the bundle: if it installs upstream's own
  `t3` or service, refuse it in `refuseT3` (a `connect` one: list it in
  `t3ConnectRefused`); then add it to `t3Commands`.
- `codex-guard-flags`: codex's top-level commands, its hidden ones, and the
  options that take one value or several, at the top level and under
  `app-server`, `app-server daemon` and `remote-control`, and its short
  flags there and on every installer command (`codexShortFlags`). A new
  command under `app-server daemon` or `remote-control` is refused until it
  is reviewed: list it in `codexAllowed` if it's safe, or in
  `codexInstallers` if it installs codex (it stays refused).
- `provider-commands`: the other providers' top-level commands
  (`providerCommands`). The guard lets a line that starts with a listed
  command through whatever follows (`claude plugin install x`), so read
  what a new one does first: if it installs or updates the provider,
  refuse it in its package; otherwise add it.

Commands left out of a help aren't compared; read the bundle for those.

**codex's daemon records.** The doctor's check for codex's background
server and update loop follows how codex records them
(`app-server-daemon/*.pid`, upstream's `pid.rs`) and the arguments they run
with. `doctor-scenarios` feeds it records it writes itself, so no check
notices if codex changes that format. On a codex update whose release
touches `pid.rs` or the daemon's arguments, recheck the doctor by hand
against a real codex daemon started outside Nix.

**agent-browser's browser pins.** `versions/browser-unstable.json` and
`versions/browser-stable.json` don't move with the flake's nixpkgs bump.
A pin moves when its channel's version of any of the three browsers
changes, and at least weekly, but only once ungoogled-chromium's builds for
both systems are on cache.nixos.org. The stable pin moves to the next NixOS
release once that release is out of beta.

Only ungoogled-chromium's tests can hold a pin back. If Chromium or Chrome
isn't available yet, the pin waits for it at most three days, then moves
without it. A problem with either opens an issue of its own.

**The Electron record.** `ci/electron-runtime.json` says which Electron
`"auto"` picks for the flake's own Desktop app packages on each system,
before the test fallback (nixpkgs' or the bundled one, and its version).
The status page and the release notes show it, and say when the fallback
applies.
Each update run that changes a Desktop app pin or `flake.lock` tries to
write it again. After a hand commit that changes `flake.lock`, a Desktop
app pin's `electron`, `flake.nix` or the Electron code, run
`node scripts/ci/electron-runtime.ts write` (it needs Nix) and commit the
result. An entry left behind by a new bundled Electron version or nixpkgs
revision is ignored, and the page and the notes say a general sentence
until a later run writes it again. An entry that still matches its bundled
version and revision but is wrong after a code change fails the
`electron-runtime` check.

**The server's VM test.** `programs.t3code.server` is checked in the
sandbox by `module-eval` and `server-unit`. Booting it in a NixOS VM needs
KVM, so it isn't among the checks:
`nix build .#legacyPackages.x86_64-linux.vmTests.server -L`. First check
that `/dev/kvm` exists and that `nix config show system-features` lists
`kvm` (on a script-installed Nix, the build users must be able to open
`/dev/kvm`). Without it the test falls back to emulated QEMU.
