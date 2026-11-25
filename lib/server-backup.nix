# The server's ExecStartPre (lib/module-core.nix): before a new version of
# `t3` first starts, a copy of the database it may migrate, so an older
# generation can be rolled back to with its data. Built from the flake's own
# package set, so the NixOS and Home Manager units run the same script.
#
#   version: the `t3` the unit runs
{ pkgs }:
version:
let
  inherit (pkgs)
    lib
    coreutils
    gnused
    sqlite
    ;
  keepBackups = 3;
in
pkgs.writeShellScript "t3code-server-backup" ''
  set -eu
  # As t3 resolves it (resolveBaseDir): trimmed, blank is ~/.t3, `~/` (or
  # `~\`) is the home folder, and a relative path is under the unit's working
  # directory, %h.
  home=$(printf '%s' "''${T3CODE_HOME-}" | ${gnused}/bin/sed -z -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$home" ] || home=$HOME/.t3
  case $home in "~") home=$HOME ;; "~/"* | '~\'*) home=$HOME/''${home:2} ;; esac
  home=$(${coreutils}/bin/realpath -m -- "$home")
  db=$home/userdata/statev2.sqlite
  dir=$home/t3code-nix-backups
  version=${lib.escapeShellArg version}
  last=$(${coreutils}/bin/cat "$dir/last-version" 2>/dev/null || true)
  [ "$last" != "$version" ] || exit 0
  ${coreutils}/bin/mkdir -p -m 700 "$dir"
  # A copy cut short by a stop or a shutdown.
  ${coreutils}/bin/rm -f -- "$dir"/*.part
  if [ -f "$db" ]; then
    name=statev2-''${last:-unknown}-$(${coreutils}/bin/date -u +%Y%m%dT%H%M%SZ).sqlite
    # SQLite's online backup: a consistent copy, WAL included.
    (cd "$dir" && ${sqlite}/bin/sqlite3 -init /dev/null "$db" ".backup $name.part")
    ${coreutils}/bin/mv "$dir/$name.part" "$dir/$name"
    echo "t3code-server: copied the database used by ''${last:-an earlier version} to $dir/$name"
    # The newest ${toString keepBackups} only.
    ${coreutils}/bin/ls -1t "$dir"/statev2-*.sqlite | ${coreutils}/bin/tail -n +${toString (keepBackups + 1)} \
      | while read -r old; do ${coreutils}/bin/rm -f -- "$old"; done
  fi
  echo "$version" > "$dir/last-version"
''
