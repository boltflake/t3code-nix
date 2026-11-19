#!/usr/bin/env bash
# Where a CI job's time goes: prints the runner's CPU model and image, then,
# once a second until the job ends (the runner stops it), appends /proc's
# CPU counters and network bytes (all interfaces but lo) to FILE, with the
# time in epoch milliseconds. Reads /proc only; nothing in CI reads FILE.
#
#   scripts/ci/sample.sh FILE
set -eu
file=$1
# arm64's /proc/cpuinfo has no model name, only its implementer and part.
cpu=$(sed -n 's/^model name[[:space:]]*: //p' /proc/cpuinfo | head -1)
[ -n "$cpu" ] || cpu=$(sed -n 's/^CPU \(implementer\|part\)[[:space:]]*: /\1 /p' /proc/cpuinfo | head -2 | paste -sd ' ')
echo "CPU: $cpu; image: ${ImageOS:-} ${ImageVersion:-}"
mkdir -p "$(dirname "$file")"
sample() {
  while :; do
    echo "$(date +%s%3N) $(head -1 /proc/stat) $(awk 'NR > 2 && $1 != "lo:" { r += $2; t += $10 } END { print r, t }' /proc/net/dev)"
    sleep 1
  done
}
sample > "$file" 2>/dev/null &
