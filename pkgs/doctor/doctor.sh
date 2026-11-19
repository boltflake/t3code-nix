# t3code-nix doctor: why isn't T3 Code working? Read-only: it never writes
# outside a throwaway folder and never needs sudo. It runs no provider or
# t3 except claude's own `doctor`, in a throwaway HOME, to ask whether a
# machine policy keeps claude's updates off (claude may contact its servers
# there); versions come from store paths. Exit status 1 if there's a problem.
#
# What this build knows comes from its data file (sourced below): CHANNEL,
# NIXPKGS (unstable, or stable for the NixOS-stable set), ELECTRON (the
# desktop app's Electron and why, empty without one),
# VERSION, CLI (this build's t3), SERVER (on, off or unknown), SERVER_HOME
# (the server's T3CODE_HOME, empty for ~/.t3), SERVER_USERS (whose session
# runs it, space-separated; empty: every user that isn't a system one),
# CACHE_URL, CACHE_KEY (empty: no cache configured) and PROVIDERS (lines "driver
# name version storepath command", storepath and command `-` when there's
# none).
# T3CODE_DOCTOR_ROOT (tests only) is prefixed to the system paths it reads;
# T3CODE_DOCTOR_USER and T3CODE_DOCTOR_UID (tests only) stand for `id -un`
# and `id -u`.
# shellcheck source=/dev/null
. @data@
root=${T3CODE_DOCTOR_ROOT:-}
home=${HOME:-}
# This CPU in T3 Code's download folders, and its dynamic loader.
if [ "$(uname -m)" = aarch64 ]; then
  arch=arm64 ld=$root/lib/ld-linux-aarch64.so.1
else
  arch=x64 ld=$root/lib64/ld-linux-x86-64.so.2
fi
# T3 Code's base folder, resolved as it does (resolveBaseDir): trimmed,
# blank is ~/.t3, and `~` or `~/…` is the home folder; trailing slashes
# dropped so one folder compares equal to itself.
base() {
  local b
  b=$(printf '%s' "$1" | sed -z -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$b" ] || b=$home/.t3
  case $b in \~) b=$home ;; \~/* | \~\\*) b=$home/${b:2} ;; esac
  while [ "${b%/}" != "$b" ] && [ "$b" != / ]; do b=${b%/}; done
  printf '%s' "$b"
}
t3home=$(base "${T3CODE_HOME-}")
homes=("$t3home")
labels=("the app and CLI's")
if [ "$SERVER" = on ]; then
  # The server's (programs.t3code.server.home), where systemd expands %h
  # to the home folder and the server runs in it (WorkingDirectory=%h).
  # (The replacement is quoted, so an & in the home folder stays itself.)
  serverhome=$(base "${SERVER_HOME//%h/"$home"}")
  [ "${serverhome#/}" != "$serverhome" ] || serverhome=$home/$serverhome
  if [ "$serverhome" = "$t3home" ]; then
    labels=("the app's, CLI's and server's")
  else
    homes+=("$serverhome")
    labels+=("the server's")
  fi
fi
# $1/$2 as node's path.join makes it, into REPLY: "." and empty parts
# dropped and ".." taken back by text, before any link is followed.
joined() {
  local - IFS=/ p abs='' whole="$1/$2"
  local -a out=()
  set -f
  [ "${1#/}" = "$1" ] || abs=/
  for p in $whole; do
    case $p in
      '' | .) ;;
      ..)
        if [ ${#out[@]} -gt 0 ] && [ "${out[-1]}" != .. ]; then
          unset 'out[-1]'
        elif [ -z "$abs" ]; then out+=(..); fi
        ;;
      *) out+=("$p") ;;
    esac
  done
  REPLY="$abs${out[*]}"
  REPLY=${REPLY:-.}
}
# Every executable file called $1 on PATH, in order, as T3 Code searches it
# (resolveCommandPathForPlatform): each entry trimmed, then any double quotes
# at either end dropped (stripWrappingQuotes; single quotes stay), empty and
# repeated entries skipped, nothing glob-expanded.
on_path() {
  local rest="$PATH:" d f seen=:
  while [ -n "$rest" ]; do
    d=${rest%%:*}
    rest=${rest#*:}
    d=${d#"${d%%[![:space:]]*}"}
    d=${d%"${d##*[![:space:]]}"}
    while [ "${d#\"}" != "$d" ]; do d=${d#\"}; done
    while [ "${d%\"}" != "$d" ]; do d=${d%\"}; done
    [ -n "$d" ] || continue
    case $seen in *":$d:"*) continue ;; esac
    seen="$seen$d:"
    joined "$d" "$1"
    f=$REPLY
    if [ -f "$f" ] && [ -x "$f" ]; then printf '%s\n' "$f"; fi
  done
}
problems=0

say() { printf '  %-8s %s\n' "$1" "$2"; [ -z "${3:-}" ] || printf '  %-8s → %s\n' "" "$3"; }
ok() { say OK "$1" "${2:-}"; }
warn() { say WARN "$1" "$2"; }
problem() { say PROBLEM "$1" "$2"; problems=$((problems + 1)); }
# "name-1.2.3" from a store path's base name, without the hash.
store_name() { local b=${1#/nix/store/}; b=${b%%/*}; printf '%s' "${b#*-}"; }

if [ "${NIXPKGS:-unstable}" = stable ]; then
  echo "t3code-nix doctor (T3 Code $VERSION, $CHANNEL channel, on NixOS stable)"
else
  echo "t3code-nix doctor (T3 Code $VERSION, $CHANNEL channel)"
fi
[ -z "${ELECTRON:-}" ] || echo "$ELECTRON"
echo
echo "Providers (looked up on this terminal's PATH; T3 Code takes yours from your login"
echo "shell, which is usually the same, and falls back to the ones it bundles):"
while read -r driver name pver path command; do
  [ -n "$driver" ] || continue
  if [ "$command" = - ]; then
    # Cursor: T3 Code drives it through its own SDK; no command is looked up.
    ok "$name: built into T3 Code (its SDK); nothing to find on PATH"
    continue
  fi
  # Antigravity: a runtime T3 Code downloaded itself (in a T3 home) comes
  # before PATH, for whatever uses that home.
  if [ "$driver" = antigravity ]; then
    left=0
    for i in "${!homes[@]}"; do
      if [ -e "${homes[$i]}/tools/antigravity-acp/linux-$arch/active.json" ]; then
        warn "$name: ${labels[$i]} T3 Code uses the runtime it downloaded into ${homes[$i]}/tools/antigravity-acp, not PATH or the bundled one" \
          "remove that download in T3 Code's provider settings (or delete the folder while T3 Code is stopped) to use the bundled one"
      else
        left=1
      fi
    done
    # Every home has its own: PATH doesn't matter to any of them.
    [ "$left" = 1 ] || continue
  fi
  # On PATH, the first candidate T3 Code accepts: for antigravity, only the
  # `agy` CLI itself (isAntigravityCli: the real file's name, in any case)
  # or a server with its localharness_external beside it.
  found=''
  while read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ "$driver" = antigravity ]; then
      r=$(readlink -f -- "$candidate")
      h=$(dirname -- "$r")/localharness_external
      n=$(basename -- "$r")
      case ${n,,} in
        agy | antigravity | agy.exe | agy.cmd | agy.bat | antigravity.exe | antigravity.cmd | antigravity.bat) ;;
        *) [ -f "$h" ] && [ -x "$h" ] || continue ;;
      esac
    fi
    found=$candidate
    break
  done < <(on_path "$command")
  if [ -n "$found" ]; then
    real=$(readlink -f -- "$found")
    if [ "$path" != - ] && [ "${real#"$path"/}" != "$real" ]; then
      ok "$name $pver (bundled)"
      continue
    fi
    case $real in
      /nix/store/*)
        other=$(store_name "$real")
        what="from another Nix package ($other, $found)"
        [ "$other" != "$name-$pver" ] || what="from another build of the same version ($found)"
        fix="fine if you want that one; otherwise take it out of your packages so the bundled one is used" ;;
      *)
        what="installed outside Nix ($found; version not checked)"
        fix="if it's an old self-installed copy (a provider's own updater puts them in your home, for example in ~/.local/bin, ~/.grok/bin or ~/.opencode/bin), delete it so the bundled one is used" ;;
    esac
    if [ "$path" != - ]; then
      warn "$name: T3 Code uses your $command, $what, not the bundled $pver" "$fix"
    else
      ok "$name: your own $command, $what (not bundled in this build)"
    fi
  elif [ "$path" = - ]; then
    ok "$name: not bundled in this build, and no $command on PATH (T3 Code lists it as not installed)"
  elif [ -e "$path" ]; then
    ok "$name $pver (bundled)"
  else
    warn "$name $pver is bundled, but isn't installed here" \
      "install T3 Code (programs.t3code.enable, or this flake's t3code package) and run the doctor that comes with it"
  fi
done <<< "$PROVIDERS"
for h in "${homes[@]}"; do
  [ ! -e "$h/tools/codex/active.json" ] ||
    echo "  (T3 Code also has its own Codex download in $h/tools/codex, used when the codex above doesn't fit it.)"
done
# A daemon package an unwrapped codex (0.157 or later, daemon auto-start on)
# set up, perhaps on another machine with this ~/.codex copied across. The
# TUI's /daemon menu can update it outside Nix (openai/codex#41188).
codexhome=${CODEX_HOME:-$home/.codex}
daemonpkg=$codexhome/packages/app-server-daemon
jstr() { grep -o "\"$2\":\"[^\"]*\"" <<< "$1" | head -1 | cut -d'"' -f4; } # json, key
jnum() { grep -o "\"$2\":[0-9]*" <<< "$1" | head -1 | cut -d: -f2; }        # json, key
# Such a package runs two processes, each recorded in app-server-daemon/:
# the daemon (daemon.pid) and its update loop (daemon-updater.pid, which
# outlives `codex app-server daemon stop`). codexproc prints the PID a record
# names when that PID is still the recorded process, checked as codex checks
# it, and is a codex from outside the Nix store running KIND. So a reused
# PID, even another codex home's daemon, or a record copied from another
# machine is never named.
codexproc() { # record file, daemon|loop
  local -a a f
  local rec pid boot ticks st legacy state started exe arg
  rec=$(< "$codexhome/app-server-daemon/$1") || return 1
  pid=$(jnum "$rec" pid)
  [ -n "$pid" ] || return 1
  boot=$(jstr "$rec" bootId)
  ticks=$(jnum "$rec" startTicks)
  if [ -n "$boot$ticks" ]; then
    # codex 0.156 and later: this boot's ID, and the start time in clock
    # ticks (field 22 of /proc/PID/stat).
    [ "$boot" = "$(< /proc/sys/kernel/random/boot_id)" ] || return 1
    st=$(< "/proc/$pid/stat") || return 1
    read -ra f <<< "${st##*) }"
    [ "${f[19]-}" = "$ticks" ] || return 1
  else
    # Older records: the start time as `ps -o lstart=` prints it, and not a
    # zombie. Only a process a codex before 0.156 started, still running,
    # has one; once none can be left, this branch (and procps) can go.
    legacy=$(jstr "$rec" processStartTime)
    [ -n "$legacy" ] || return 1
    read -r state started < <(ps -p "$pid" -o stat= -o lstart=) || return 1
    [ "${state#Z}" = "$state" ] && [ "$started" = "$legacy" ] || return 1
  fi
  # A codex executable outside the store (even once deleted), run with that
  # process's own arguments.
  exe=$(readlink "/proc/$pid/exe") || return 1
  exe=${exe% (deleted)}
  [ "${exe##*/}" = codex ] && [ "${exe#/nix/store/}" = "$exe" ] || return 1
  mapfile -d '' a < "/proc/$pid/cmdline" || return 1
  [ "${a[1]-}" = app-server ] || return 1
  if [ "$2" = loop ]; then
    [ "${a[2]-}" = daemon ] && [ "${a[3]-}" = pid-update-loop ] || return 1
  else
    for arg in "${a[@]:2}"; do [ "$arg" != --managed-daemon ] || break; done
    [ "${arg-}" = --managed-daemon ] || return 1
  fi
  echo "$pid"
}
# 2>/dev/null: a missing record, or a PID gone since it was recorded, is no
# error.
daemonpid=$(codexproc daemon.pid daemon 2>/dev/null)
loop=$(codexproc daemon-updater.pid loop 2>/dev/null)
if [ -n "$daemonpid" ]; then
  warn "codex: Codex's background server from outside Nix is running (PID $daemonpid, from $codexhome/app-server-daemon/daemon.pid)" \
    "\`codex app-server daemon stop\` (or \`kill $daemonpid\`)"
fi
if [ -n "$loop" ]; then
  updates=''
  [ ! -e "$daemonpkg" ] || updates="; it keeps updating the copy in $daemonpkg"
  warn "codex: a Codex update loop from outside Nix is running (PID $loop, from $codexhome/app-server-daemon/daemon-updater.pid)$updates" \
    "\`kill $loop\` (\`codex app-server daemon stop\` leaves it running)"
fi
if [ -e "$daemonpkg" ] || [ -L "$daemonpkg" ]; then
  warn "codex: $daemonpkg is a Codex daemon package folder made outside this flake's wrapper (by another codex install, an app's own Codex download, or a ~/.codex copied from another machine); codex's /daemon menu can install a Codex into it" \
    "if nothing outside Nix uses it, end what runs from it first (above), then delete the folder"
fi
# claude reads its update switches from settings files too, so a project's
# .claude/settings.json can turn the wrapper's off; only its machine policy
# (under /etc/claude-code) holds them. claude itself says whether it does:
# its `doctor`, run without the wrapper's settings, reports DISABLE_UPDATES
# only when the policy sets it, and fails on a policy it can't read.
cpath=$(awk '$1 == "claudeAgent" && $4 != "-" { print $4 }' <<< "$PROVIDERS")
if [ -n "$cpath" ]; then
  exe=$(sed -n 's/^exec .*"\(\/nix\/store\/[^"]*\)".*/\1/p' "$cpath/bin/claude" 2> /dev/null | tail -1)
  [ -n "$exe" ] || exe=$cpath/bin/claude
  fixpolicy="on NixOS: programs.t3code.claudeCodePolicy = true (the default) and rebuild; elsewhere: put {\"env\":{\"DISABLE_UPDATES\":\"1\",\"DISABLE_AUTOUPDATER\":\"1\",\"DISABLE_INSTALLATION_CHECKS\":\"1\"}} in /etc/claude-code/managed-settings.d/10-t3code-nix.json"
  cantask="claude-code: couldn't ask claude whether a machine policy keeps its updates off"
  if [ ! -x "$exe" ]; then
    warn "$cantask: this doctor's claude ($exe) isn't on this machine" \
      "run the doctor of the build you use (t3code-nix doctor from your system, or nix run with the same revision)"
  elif ! tmp=$(mktemp -d 2> /dev/null); then
    warn "$cantask: no temporary folder for it" "check TMPDIR"
  else
    policyout=$(cd "$tmp" && env -i HOME="$tmp" PATH="$PATH" ${root:+T3CODE_DOCTOR_ROOT="$root"} timeout 30 "$exe" doctor < /dev/null 2>&1) || true
    rm -rf "$tmp"
    case $policyout in
      *"Auto-updates: disabled (set by env: DISABLE_UPDATES)"*)
        ok "claude-code: its machine policy keeps its updates off" ;;
      *"Auto-updates: "*)
        warn "claude-code: no machine policy turns its updates off, so a project's .claude/settings.json can turn the wrapper's update switches off and let claude update itself outside Nix" "$fixpolicy" ;;
      *"/etc/claude-code"* | *"anaged settings"* | *"anaged-settings"*)
        problem "claude-code: claude rejects its machine policy: $(grep -m1 -i 'managed\|/etc/claude-code' <<< "$policyout" | cut -c1-300)" \
          "fix or remove that file; $fixpolicy" ;;
      *)
        warn "$cantask: its doctor said $(grep -m1 -v '^[[:space:]]*$' <<< "$policyout" | cut -c1-200 || true)" \
          "run claude doctor yourself to see why" ;;
    esac
  fi
fi
echo "  (A binary path set in T3 Code's own provider settings comes before all of this.)"
echo
echo "This system:"

# The binary cache. An untrusted user's own nix.conf and NIX_CONFIG don't
# reach the daemon, so for them only the system's settings count.
if [ "${NIXPKGS:-unstable}" = stable ]; then
  # Informational: the cache holds only the default (unstable) packages.
  ok "binary cache: NixOS stable isn't in it, so it's built locally (nothing to do)"
elif [ -z "$CACHE_KEY" ]; then
  ok "binary cache: this build has none configured (nothing to do)"
elif ! command -v nix >/dev/null; then
  warn "binary cache: can't check, nix isn't on PATH" "run this from a shell where nix works"
else
  nixc() { nix --extra-experimental-features nix-command "$@" 2>/dev/null; }
  trusted=unknown
  if info=$(nixc store info --json); then
    if grep -q '"trusted": *\(true\|1\)' <<< "$info"; then trusted=yes; else trusted=no; fi
  fi
  system() { NIX_USER_CONF_FILES=/dev/null NIX_CONFIG='' nixc config show "$1"; }
  # $2 among the words of $1, ignoring a trailing slash and a ?query
  # (substituters are often written with ?priority=N).
  has() {
    local - x
    set -f
    for x in $1; do x=${x%%\?*}; [ "${x%/}" != "${2%/}" ] || return 0; done
    return 1
  }
  allowed='' mine=''
  read_conf() {
    if [ "$trusted" = yes ]; then
      subs=$(nixc config show substituters) && keys=$(nixc config show trusted-public-keys)
    else
      # The daemon takes an untrusted user's own substituters only when the
      # system lists them in trusted-substituters, and only the system's keys.
      subs=$(system substituters) && keys=$(system trusted-public-keys) \
        && allowed=$(system trusted-substituters) && mine=$(nixc config show substituters)
    fi
  }
  if ! read_conf; then
    warn "binary cache: can't check (\`nix config show\` failed)" "run \`nix config show substituters\` to see why"
  else
    has_url='' has_key='' allowed_url=''
    ! has "$subs" "$CACHE_URL" || has_url=1
    [ "$trusted" = yes ] || ! has "$allowed" "$CACHE_URL" || allowed_url=1
    [ -z "$allowed_url" ] || ! has "$mine" "$CACHE_URL" || has_url=1
    ! has "$keys" "$CACHE_KEY" || has_key=1
    fix="on NixOS: programs.t3code.binaryCache = true (the default) and rebuild; elsewhere: add $CACHE_URL and its key to /etc/nix/nix.conf"
    if [ -n "$has_url" ] && [ -n "$has_key" ]; then
      ok "binary cache: $CACHE_URL is set up"
    elif [ -n "$allowed_url" ] && [ -n "$has_key" ]; then
      warn "binary cache: the system allows $CACHE_URL (trusted-substituters) and has its key, but you don't use it" \
        "accept the flake's own settings when Nix asks, or add it to extra-substituters in ~/.config/nix/nix.conf"
    elif [ "$trusted" = yes ]; then
      warn "binary cache: not set up; you're a trusted user, so the flake's own settings work when you accept them" "$fix"
    elif [ "$trusted" = no ]; then
      problem "binary cache: not set up for the system, and you aren't a trusted user, so the flake's own settings are ignored and everything builds locally" "$fix"
    else
      warn "binary cache: not set up for the system, and the Nix daemon couldn't be asked whether you're a trusted user" "$fix"
    fi
  fi
fi

# The dynamic loader: nix-ld's (runtimeCompat), NixOS's stub, or another
# Linux's own, where upstream's downloads run anyway.
link=$(readlink "$ld" 2>/dev/null) || link=''
if [ "${link#*nix-ld}" != "$link" ]; then
  loader=nix-ld
elif [ -e "$root/etc/NIXOS" ]; then
  loader=none
else
  loader=system
fi

# Upstream's own service, and ours.
unit=${XDG_CONFIG_HOME:-$home/.config}/systemd/user/t3code.service
remove="\`t3 service uninstall\`, or \`systemctl --user disable --now t3code.service\` and delete $unit; programs.t3code.server is the Nix-managed one"
if [ ! -e "$unit" ]; then
  ok "upstream's own service: not installed"
elif [ "$loader" = none ]; then
  problem "upstream's service is installed ($unit), and without nix-ld its downloaded T3 Code can't start" "$remove"
else
  warn "upstream's service is installed ($unit): it runs T3 Code's own download, updated outside Nix, without the bundled providers" \
    "fine if you set it up on purpose (cli.allowUpstreamService); otherwise $remove"
fi

case $loader in
  nix-ld) ok "runtimeCompat (nix-ld): on" ;;
  none) ok "runtimeCompat (nix-ld): off (needed only when another machine's T3 Code connects here over SSH)" ;;
  *) ok "runtimeCompat: not needed (not NixOS: this system's own loader runs T3 Code's downloads)" ;;
esac

# One value a line, in systemd's order.
mapfile -t unitstate < <(systemctl --user show t3code-server.service -p LoadState -p ActiveState --value 2>/dev/null || true)
state="${unitstate[0]-} ${unitstate[1]-}"
# The unit is there for every user, and skipped (by ConditionUser) for one
# it isn't for: one not in server.users, or with none named, a system user
# (UID below 1000, systemd's @system). Worked out here, not from systemd,
# which keeps a skipped condition's result until the next start (a rebuild
# included); from `id`, not $USER, which the environment can change.
me=${T3CODE_DOCTOR_USER:-$(id -un 2>/dev/null || true)}
uid=${T3CODE_DOCTOR_UID:-$(id -u 2>/dev/null || true)}
notyours='' forwhom=''
if [ -n "$SERVER_USERS" ]; then
  forwhom="$SERVER_USERS (programs.t3code.server.users)"
  # By name, or as systemd does, by the UID a name stands for.
  notyours=1
  read -ra listed <<< "$SERVER_USERS"
  for u in "${listed[@]}"; do
    if [ "$u" = "$me" ] || { [ -n "$uid" ] && [ "$(id -u -- "$u" 2>/dev/null || true)" = "$uid" ]; }; then notyours=''; fi
  done
else
  forwhom="every user that isn't a system user (programs.t3code.server.users is empty)"
  case "$uid" in '' | *[!0-9]*) ;; *) [ "$uid" -ge 1000 ] || notyours=1 ;; esac
fi
[ -n "$me" ] || notyours=
logs="see \`journalctl --user -u t3code-server\` and \`systemctl --user status t3code-server\`"
# Not for this user, but running (from before server.users changed: a
# rebuild doesn't stop it, and it holds the port): say so. A failed one is
# reported as failed below.
running=''
case "$state" in *" active" | *" activating") running=1 ;; esac
if [ "$SERVER" = off ] && [ -n "$running" ]; then
  warn "server: programs.t3code.server is off, but t3code-server is still running from before (a rebuild doesn't stop it), and holds its port" \
    "stop it with \`systemctl --user stop t3code-server\`"
elif [ "$SERVER" = on ] && [ -n "$notyours" ] && [ -n "$running" ]; then
  warn "server: t3code-server is still running for you ($me), from before; it runs for $forwhom now, and holds its port" \
    "stop it with \`systemctl --user stop t3code-server\`"
elif [ "$SERVER" = on ] && [ -n "$notyours" ] && [ "$state" != "loaded failed" ]; then
  ok "server: t3code-server runs for $forwhom, not for you ($me); name yourself in programs.t3code.server.users to run it too"
else
  case "$SERVER $state" in
    "off "*) ok "server (programs.t3code.server): not enabled" ;;
    *" loaded active") ok "server: t3code-server is running" ;;
    *" loaded failed") problem "server: t3code-server has failed" "$logs" ;;
    *" loaded activating") warn "server: t3code-server is starting or restarting (several in a row mean it keeps failing)" "$logs" ;;
    *" masked active" | *" masked activating") warn "server: t3code-server is masked, but still running" "unmask it with \`systemctl --user unmask t3code-server\` (or stop it)" ;;
    *" masked "*) warn "server: t3code-server is masked, so it can't start" "unmask it with \`systemctl --user unmask t3code-server\`" ;;
    "on error "* | "on bad-setting "*) problem "server: t3code-server's unit couldn't be loaded" "$logs" ;;
    *" loaded "*) warn "server: t3code-server isn't running" "start it with \`systemctl --user start t3code-server\`; at boot it needs users.users.<you>.linger = true" ;;
    "on "*) warn "server: enabled, but its unit isn't loaded for you (or systemd couldn't be asked)" "check that you rebuilt and logged in again" ;;
    *) ok "server: there's no t3code-server unit (programs.t3code.server isn't in use)" ;;
  esac
fi

# Is `t3` on PATH ours? t3code-nix's wraps a t3-unwrapped build.
if ! t3=$(command -v t3 2>/dev/null); then
  ok "t3: not on PATH (programs.t3code.cli.enable or server.enable installs it)"
else
  real=$(readlink -f -- "$t3")
  if [ "${real%/bin/t3}" = "$CLI" ]; then
    ok "t3: this build's ($t3)"
  elif [ "${real#/nix/store/}" = "$real" ]; then
    warn "t3: $t3 isn't from Nix (upstream's install script puts one in ~/.local/bin); it updates itself and doesn't bundle the providers" \
      "delete it, or put t3code-nix's t3 first on PATH"
  elif grep -qs -- "-t3-unwrapped" "$real"; then
    warn "t3: $t3 is t3code-nix's, but another build ($(store_name "$real"))" \
      "fine if you meant it; otherwise remove the other one from your packages"
  else
    warn "t3: $t3 comes from another Nix package ($(store_name "$real")), not t3code-nix" \
      "remove that package, or set programs.t3code.cli.enable so t3code-nix's t3 is installed instead"
  fi
fi

echo
if [ "$problems" -gt 0 ]; then
  echo "$problems problem(s) found."
  exit 1
fi
echo "No problems found."
