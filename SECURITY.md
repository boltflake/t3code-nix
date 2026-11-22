# Security

## Reporting a vulnerability

Please report security problems privately, never in a public issue:
[report a vulnerability](https://github.com/boltflake/t3code-nix/security/advisories/new)
(the repository's Security tab, "Report a vulnerability"). Include:

- what you found, its impact, and how to reproduce it
- what's affected, if you know: the package, the channel (latest or
  nightly), and whether it's the [NixOS stable](README.md#nixos-stable) set
- the t3code-nix commit you're on: `nix flake metadata /etc/nixos` (or your
  flake's folder) lists it. If you can't find it, give the flake ref or
  tarball URL you used, and the T3 Code version `t3code-nix doctor`
  reports

For a confirmed vulnerability, when and how the advisory is published is
agreed with you, with credit to you unless you'd rather stay anonymous.

## What belongs here

Anything this repository makes, for example:

- the packaging: wrappers, packaging changes to upstream builds, pins and
  the hashes they check, the agent tools, the NixOS module, the doctor
- the update workflows, the release watcher and its deployment: anything
  that could get unchecked code onto `main`, into a release or into the
  binary cache

A vulnerability in T3 Code itself, one that also happens without Nix, goes
to T3 Code ([its security policy](https://github.com/pingdotgg/t3code/security));
one in a provider goes to its vendor. Their fixed releases reach this flake
through the same update runs and tests as any release. If upstream has
fixed it but this flake still ships the vulnerable version (the
[NixOS stable](README.md#nixos-stable) set can lag, for example), that
belongs here, as a private report too. An advisory here names the affected
set and the commit that fixes it.

## Supported versions

Only `main`. Fixes aren't backported to older commits or `t3code-v*` tags.
To get one:

- if you follow `main`, update the input (`nix flake update t3code-nix`)
  and rebuild
- if you pinned a `t3code-v*` tag or a commit, move the pin to a release
  or commit that has the fix first
- if your `nix run` follows `main`, run it again with `--refresh` before
  the flake ref (`nix run --refresh github:boltflake/t3code-nix`); with a
  pinned tag or commit, run it from one that has the fix. Stop a server
  started that way first
- without flakes, rebuild from a tarball that has it
- restart a running `t3code-server` afterwards
