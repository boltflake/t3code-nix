#!/usr/bin/env bash
# Renders docs/social-card.svg to docs/social-card.png, the status page's
# link preview (status.ts copies it into the site). Run it after changing the
# SVG and commit both: CI doesn't render it. resvg and the fonts come from
# the flake's nixpkgs, and no system font is used.
set -euo pipefail
cd "$(dirname "$0")/.."
fonts=$(nix build --no-link --print-out-paths --inputs-from . nixpkgs#ibm-plex)/share/fonts
resvg=$(nix build --no-link --print-out-paths --inputs-from . nixpkgs#resvg)/bin/resvg
tmp=$(mktemp docs/social-card.XXXXXX.png)
trap 'rm -f "$tmp"' EXIT
log=$("$resvg" --skip-system-fonts --use-fonts-dir "$fonts" docs/social-card.svg "$tmp" 2>&1) \
  || { rc=$?; printf '%s\n' "$log" >&2; exit "$rc"; }
# The font bundle ships macOS "._" sidecar files that resvg can't read; any
# other warning (a font it didn't find renders the card without its text)
# fails the render.
left=$(grep -v "Failed to load a font face 0 from '.*/\._" <<< "$log" || true)
if [ -n "$left" ]; then printf '%s\n' "$left" >&2; exit 1; fi
chmod 644 "$tmp"
mv "$tmp" docs/social-card.png
