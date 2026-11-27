# t3code-nix doctor: why isn't T3 Code working? Read-only: it never writes
# outside a throwaway folder and never needs sudo. It runs no provider or
# t3 except claude's own `doctor`, in a throwaway HOME, to ask whether a
# machine policy keeps claude's updates off (claude may contact its servers
# there); versions come from store paths. Exit status 1 if there's a problem.
#
# What this build knows comes from its data file (sourced below): CHANNEL,
# NIXPKGS (unstable, or stable for the NixOS-stable set), ELECTRON (the
# desktop app's Electron and why, empty without one), VERSION, CLI (this
# build's t3), APP (the app as installed) and APP_INNER (the app Home
# Manager's nixGL wraps, empty without nixGL; both empty when the module
# installs no app, or the package has no store path), CLI_INSTALLED (yes, no
# or unknown: whether the module installs CLI), SERVER (on, off or unknown),
# SERVER_HOME (the server's T3CODE_HOME, empty for ~/.t3), SERVER_USERS
# (whose session runs it, space-separated; empty: every user that isn't a
# system one),
# CACHE_URL, CACHE_KEY (empty: no cache configured), PROVIDERS (lines "driver
# name version storepath command", storepath and command `-` when there's
# none), MODULE (nixos, home-manager, or empty for the flake's package),
# UNIT_DESCRIPTION (the Description= this flake's t3code-server units
# carry), and for Home Manager's doctor, USER_UNITS (the folder it writes
# units to), AS_NIXOS_MODULE (yes for Home Manager as a NixOS module) and
# NIXOS_MODULE (yes when this flake's NixOS module is in that system config
# too), and TELEMETRY_APP and TELEMETRY_CLI (on, off or unknown: whether the
# app's and the CLI's wrappers leave usage data on; the app's is none when the
# module installs no app), and CLI_UNWRAPPED (the CLI's unwrapped package:
# a server running from it honours DO_NOT_TRACK, which T3 Code before 0.1.12
# ignored).
# T3CODE_DOCTOR_ROOT (tests only) is prefixed to the system paths it reads;
# T3CODE_DOCTOR_USER and T3CODE_DOCTOR_UID (tests only) stand for `id -un`
# and `id -u`.
# shellcheck source=/dev/null
. @data@
root=${T3CODE_DOCTOR_ROOT:-}
home=${HOME:-}
# Who runs this, from `id`, not $USER, which the environment can change.
me=${T3CODE_DOCTOR_USER:-$(id -un 2>/dev/null || true)}
uid=${T3CODE_DOCTOR_UID:-$(id -u 2>/dev/null || true)}
MODULE=${MODULE:-}
NIXOS_MODULE=${NIXOS_MODULE:-no}
AS_NIXOS_MODULE=${AS_NIXOS_MODULE:-no}
# The options the fixes name: Home Manager's programs.t3code-nix, or the
# NixOS module's programs.t3code (also for the flake's package). The
# machine-wide ones are the NixOS module's either way.
if [ "$MODULE" = home-manager ]; then
  ns=programs.t3code-nix
  switched="a switch didn't stop it"
else
  ns=programs.t3code
  switched="a rebuild doesn't stop it"
fi
# This system is NixOS (its marker file).
nixos=''
[ ! -e "$root/etc/NIXOS" ] || nixos=1
# A fix for a machine setting the NixOS module makes (claudeCodePolicy,
# binaryCache): $1 the option, $2 what to do elsewhere. Home Manager can't
# make them. With Home Manager as a NixOS module, this flake's NixOS module
# does (it reads this user's config); standalone Home Manager on NixOS needs
# the README's lines in the NixOS config, as the NixOS module can't see it.
machinefix() {
  if [ "$MODULE" != home-manager ]; then
    printf 'on NixOS: programs.t3code.%s = true (the default) and rebuild; elsewhere: %s' "$1" "$2"
  elif [ "$NIXOS_MODULE" = yes ]; then
    printf "this flake's NixOS module does it for you: programs.t3code.%s = true (the default) in the NixOS config, and rebuild" "$1"
  elif [ "$AS_NIXOS_MODULE" = yes ]; then
    printf "Home Manager can't: import this flake's NixOS module in the NixOS config (it covers Home Manager users), and rebuild"
  elif [ -n "$nixos" ]; then
    printf "Home Manager can't, and the NixOS module can't see a standalone Home Manager: add the README's lines for the NixOS config (\"Home Manager on NixOS\") and rebuild"
  else
    printf "Home Manager can't (it's a machine setting): %s" "$2"
  fi
}
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
# A value of T3CODE_TELEMETRY_ENABLED or DO_NOT_TRACK as a state, into REPLY,
# so a value itself is never printed: unset (also empty, as T3 Code takes
# it), blank (whitespace only, as the shell's locale reads [:space:]), true,
# false, or rejected (anything else).
# $2 says how it's read: exact (T3 Code's analytics: the ten lowercase
# literals only) or loose (DO_NOT_TRACK as T3 Code reads it: its ends
# trimmed, any case; true, or other).
tstate() { # value, exact|loose
  local v=$1
  if [ -z "$v" ]; then REPLY='unset'; return; fi
  case $v in *[![:space:]]*) ;; *) REPLY=blank; return ;; esac
  if [ "$2" = loose ]; then
    v=${v#"${v%%[![:space:]]*}"}
    v=${v%"${v##*[![:space:]]}"}
    case ${v,,} in 1 | true | yes | on | y) REPLY=true ;; *) REPLY=other ;; esac
    return
  fi
  case $v in
    true | yes | on | 1 | y) REPLY=true ;;
    false | no | off | 0 | n) REPLY=false ;;
    *) REPLY=rejected ;;
  esac
}
# The fix that turns usage data off, in the installing module's terms.
if [ -n "$MODULE" ]; then
  telemetryfix="set $ns.telemetry.enable = false"
else
  telemetryfix="use the package with .override { telemetry = false; }, or set T3CODE_TELEMETRY_ENABLED=false"
fi
# Whether this configuration turns usage data off (the app's or the CLI's),
# and what a t3code.service it doesn't configure is told.
telemetryoff=''
[ "${TELEMETRY_APP:-unknown}" != off ] && [ "${TELEMETRY_CLI:-unknown}" != off ] || telemetryoff=1
tsvc=''
switchname="$ns.telemetry.enable"
[ -n "$MODULE" ] || switchname="this build's telemetry setting"
[ -z "$telemetryoff" ] || tsvc="; $switchname doesn't configure that service, so it may send usage data"
tcli=''
[ -z "$telemetryoff" ] || tcli="; this build's telemetry setting may not apply to it"
# Whether $1 (a store path) is this configuration's app: as installed, or
# the app inside Home Manager's nixGL wrapper.
ourapp() { [ -n "${APP:-}" ] && { [ "$1" = "$APP" ] || { [ -n "${APP_INNER:-}" ] && [ "$1" = "$APP_INNER" ]; }; }; }
# DO_NOT_TRACK's state for a line: set (an opt-out), unset, or other.
dntname() { case $1 in true) REPLY='set' ;; unset) REPLY='unset' ;; *) REPLY="set, but not to an opt-out" ;; esac; }
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
      "install T3 Code ($ns.enable, or this flake's t3code package) and run the doctor that comes with it"
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
  fixpolicy=$(machinefix claudeCodePolicy "put {\"env\":{\"DISABLE_UPDATES\":\"1\",\"DISABLE_AUTOUPDATER\":\"1\",\"DISABLE_INSTALLATION_CHECKS\":\"1\"}} in /etc/claude-code/managed-settings.d/10-t3code-nix.json")
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
    fix=$(machinefix binaryCache "add $CACHE_URL and its key to /etc/nix/nix.conf")
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
userunits=${XDG_CONFIG_HOME:-$home/.config}/systemd/user
# The folder Home Manager writes units to (USER_UNITS, its xdg.configHome;
# `~/` is the home folder), which can differ from this shell's.
ownunits=${USER_UNITS:-$userunits}
case $ownunits in \~/*) ownunits=$home/${ownunits:2} ;; esac
# One value a line, in systemd's order (LoadState, ActiveState, FragmentPath,
# whatever order they're asked in).
mapfile -t unitstate < <(systemctl --user show t3code-server.service -p LoadState -p ActiveState -p FragmentPath --value 2>/dev/null || true)
state="${unitstate[0]-} ${unitstate[1]-}"
fragment=${unitstate[2]-}
running=''
case "$state" in *" active" | *" activating") running=1 ;; esac
# t3code.service: upstream's, or a Nix module's. What counts is the unit
# systemd loaded (a copy elsewhere doesn't run): systemd is asked first, and
# only without an answer (no user bus) are the files in this shell's config
# folder and Home Manager's looked at (each file once, however its folder is
# spelt).
mapfile -t upstate < <(systemctl --user show t3code.service -p LoadState -p ActiveState -p FragmentPath --value 2>/dev/null || true)
upload=${upstate[0]-} upactive=${upstate[1]-} upfragment=${upstate[2]-}
upnotloaded=''
if [ "$upload" = masked ]; then
  units=()
  # A mask without --now leaves it running.
  case $upactive in
    active | activating) warn "t3code.service is masked, but still running" \
      "stop it with \`systemctl --user stop t3code.service\`" ;;
    *) ok "t3code.service is masked (not in use)" ;;
  esac
elif [ -n "$upfragment" ]; then
  # (A system path under the tests' root, as for t3code-server.)
  case $upfragment in /etc/*) upfragment=$root$upfragment ;; esac
  units=("$upfragment")
else
  units=("$userunits/t3code.service")
  [ "$userunits/t3code.service" -ef "$ownunits/t3code.service" ] || units+=("$ownunits/t3code.service")
  # systemd answered and has none: a file there isn't loaded.
  [ "$upload" != not-found ] || upnotloaded=1
fi
found=''
[ "$upload" != masked ] || found=1
# Its file deleted and systemd reloaded while it ran: systemd has no unit by
# that name, and the process runs on.
if [ "$upload" = not-found ]; then
  case $upactive in
    active | activating)
      found=1
      warn "t3code.service is still running, though its unit file is gone$tsvc" \
        "stop it with \`systemctl --user stop t3code.service\`" ;;
  esac
fi
# Home Manager's own server beside this flake's: the Home Manager module
# allows only one of them; beside the NixOS module's, other ports and T3
# homes also do (a standalone doctor can't tell which: off only).
nixunitfix="turn one of them off (Home Manager's own programs.t3code.server, or the server.enable of the module whose t3code-server this is)"
[ "${MODULE:-}" != nixos ] || nixunitfix="$nixunitfix, or give them different ports and T3 homes"
for unit in "${units[@]}"; do
  if [ ! -e "$unit" ]; then
    # Loaded from a file removed since (no daemon-reload): still running.
    case "$unit $upactive" in
      "$upfragment active" | "$upfragment activating")
        found=1
        warn "t3code.service is still running, from a unit file that's gone ($unit)$tsvc" \
          "stop it with \`systemctl --user stop t3code.service\`, then \`systemctl --user daemon-reload\`" ;;
    esac
    continue
  fi
  found=1
  remove="\`t3 service uninstall\`, or \`systemctl --user disable --now t3code.service\` and delete $unit; $ns.server is the Nix-managed one"
  # One outside your home folder (/etc, /usr/lib, /run/systemd/user, the
  # system's profile) is installed for every user: not yours to delete. Your
  # own profile's (NixOS's per-user one) is a package in your NixOS or Home
  # Manager config, whoever put it there; one in
  # your runtime folder (systemd-run --user, edit --runtime) is yours, gone
  # at logout, or once disabled and deleted.
  everyone="it's installed for every user ($unit): have it removed from the system's configuration; $ns.server is the Nix-managed one"
  case $unit in
    "$home"/*) ;;
    "${XDG_RUNTIME_DIR:-/run/user/$uid}"/*)
      remove="it's a runtime unit of yours ($unit): \`systemctl --user disable --runtime --now t3code.service\`, delete it if it's still there, then \`systemctl --user daemon-reload\`; $ns.server is the Nix-managed one" ;;
    /etc/profiles/per-user/"$me"/* | "$root"/etc/profiles/per-user/"$me"/*)
      remove="it comes from a package in your NixOS per-user profile ($unit): remove that package (users.users.<you>.packages in the NixOS config, or Home Manager's home.packages with useUserPackages; then rebuild); $ns.server is the Nix-managed one" ;;
    # The system's folders, even as an XDG_CONFIG_HOME.
    /etc/* | /usr/* | /run/* | "$root"/etc/* | "$root"/usr/* | "$root"/run/*) remove=$everyone ;;
    # Your config folder's units, wherever XDG_CONFIG_HOME puts it: yours.
    "$userunits"/* | "$ownunits"/*) ;;
    *) remove=$everyone ;;
  esac
  if [ -n "$upnotloaded" ]; then
    # Of either kind: systemd has no t3code.service, so this one doesn't run.
    ok "t3code.service ($unit) is there, but systemd hasn't loaded it (a copy left over, or not yet reloaded)"
  # Upstream's runs its own download in ~/.t3; one that runs from the store
  # is a Nix module's (Home Manager's own programs.t3code.server, most
  # likely): no uninstall advice for it. (Spaces around `=`, systemd's
  # prefixes -@:+! and quotes allowed.)
  elif grep -qsE "^[[:space:]]*ExecStart[[:space:]]*=[[:space:]]*[-@:+!]*[\"']?/nix/store/" "$unit"; then
    if [ "$SERVER" = on ] || [ -n "$running" ]; then
      warn "t3code.service ($unit) runs a T3 Code from Nix (Home Manager's own programs.t3code.server, likely), beside t3code-server: on the same port or T3 home, the two contend$tsvc" \
        "$nixunitfix"
    else
      ok "t3code.service ($unit) runs a T3 Code from Nix (Home Manager's own programs.t3code.server, likely), not upstream's download$tsvc"
    fi
  else
    # Judged by the unit file: a drop-in can change what it runs.
    checkfirst="check what it runs first (\`systemctl --user cat t3code.service\`; this goes by its unit file, not drop-ins); $remove"
    if [ "$loader" = none ]; then
      problem "upstream's service is installed ($unit), and without nix-ld its downloaded T3 Code can't start$tsvc" "$checkfirst"
    else
      warn "upstream's service is installed ($unit): it runs T3 Code's own download, updated outside Nix, without the bundled providers$tsvc" \
        "fine if you set it up on purpose (cli.allowUpstreamService); otherwise $checkfirst"
    fi
  fi
done
[ -n "$found" ] || ok "upstream's own service: not installed"

case $loader in
  nix-ld) ok "runtimeCompat (nix-ld): on" ;;
  none) ok "runtimeCompat (nix-ld): off (needed only for upstream's own service, or when another machine's T3 Code connects here over SSH and finds no t3 of its own version here)" ;;
  *) ok "runtimeCompat: not needed (not NixOS: this system's own loader runs T3 Code's downloads)" ;;
esac

# The two t3code-server units this flake writes: the NixOS module's, in /etc
# (for every user), and Home Manager's, in the folder Home Manager writes
# units to (USER_UNITS; else the config folder), which systemd reads first.
# Whose a unit is comes from the file itself: this flake's carry its
# Description (only that line is read, nothing printed); a file in the same
# place without it is someone else's.
sysunit=$root/etc/systemd/user/t3code-server.service
ownunit=$ownunits/t3code-server.service
ours() { grep -qsxF -- "Description=$UNIT_DESCRIPTION" "$1"; }
if ours "$sysunit"; then
  systemwide="the NixOS module's" sysfix="programs.t3code.server in the NixOS config"
elif [ -n "$nixos" ]; then
  systemwide="a system-wide one, not t3code-nix's" sysfix="whatever in the NixOS config writes it"
else
  systemwide="a system-wide one, not t3code-nix's" sysfix="remove $sysunit"
fi
if ours "$ownunit"; then
  ownlabel="your own, from Home Manager" ownfix="programs.t3code-nix.server in Home Manager's"
else
  ownlabel="your own, not t3code-nix's" ownfix="remove $ownunit"
fi
# Whose unit systemd loaded, from its file: "nixos" or "home-manager" (this
# flake's, in /etc or your folder), "system" or "user" (someone else's
# there), "foreign" (someone else's anywhere else), or empty (no user bus,
# or this flake's somewhere else).
loadedby=''
case $fragment in
  '') ;;
  /etc/systemd/user/*)
    if ours "$root$fragment"; then loadedby=nixos; else loadedby=system; fi ;;
  "$ownunits"/* | "$userunits"/*)
    if ours "$fragment"; then loadedby="home-manager"; else loadedby=user; fi ;;
  *) ours "$fragment" || loadedby=foreign ;;
esac
# A unit whose file is gone (removed while it ran, with no switch to stop
# it) can't be read: whose it was is unknown, so the usual checks apply
# (it's still running from before).
[ -z "$fragment" ] || [ -e "$root$fragment" ] || [ -e "$fragment" ] || loadedby=''
# The unit is there for every user, and skipped (by ConditionUser) for one
# it isn't for: one not in server.users, or with none named, a system user
# (UID below 1000, systemd's @system). Worked out here, not from systemd,
# which keeps a skipped condition's result until the next start (a rebuild
# included). (Who you are, $me and $uid, is set at the top.)
notyours='' forwhom=''
if [ "$MODULE" = home-manager ]; then
  # Home Manager's unit is yours alone: no ConditionUser.
  forwhom="you"
elif [ -n "$SERVER_USERS" ]; then
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
linger="at boot it needs users.users.<you>.linger = true"
[ "$MODULE" != home-manager ] || linger="at boot it needs lingering: \`loginctl enable-linger\` (on NixOS, users.users.<you>.linger = true)"
notloaded="check that you rebuilt and logged in again"
[ "$MODULE" != home-manager ] || notloaded="check that you switched with Home Manager's systemd integration on, then \`systemctl --user daemon-reload\`"
# A mask, as systemd takes one: a link to /dev/null, or an empty file.
ismask() { [ "$1" -ef /dev/null ] || { [ -f "$1" ] && ! [ -s "$1" ]; }; }
# One of them a mask isn't a second unit: the masked advice below says so.
# A mask elsewhere (--runtime) leaves both real ones.
if [ -e "$sysunit" ] && [ -e "$ownunit" ] && ! ismask "$sysunit" && ! ismask "$ownunit"; then
  # Which file systemd loaded, as it reports it (a folder it doesn't read can
  # hold a unit that shadows nothing).
  if [ -z "$fragment" ] && [ "${unitstate[0]-}" = not-found ]; then
    which="systemd has loaded neither yet (\`systemctl --user daemon-reload\`)"
  elif [ -z "$fragment" ]; then
    which="which one systemd uses couldn't be read"
  # Masked as systemd reports it, whatever is on disk now (a mask replaced
  # before a daemon-reload is still the one loaded).
  elif [ "${unitstate[0]-}" = masked ]; then
    which="systemd loaded a mask over both ($fragment; after replacing one, \`systemctl --user daemon-reload\`)"
  # The exact paths first: one may be a link to the other.
  elif [ "$fragment" = "$ownunit" ]; then
    which="yours shadows the system one for you"
  elif [ "$root$fragment" = "$sysunit" ]; then
    which="systemd loaded the system one, so yours isn't used"
  elif [ "$fragment" -ef "$ownunit" ]; then
    which="yours shadows the system one for you"
  elif [ "$root$fragment" -ef "$sysunit" ]; then
    which="systemd loaded the system one, so yours isn't used"
  else
    which="systemd loaded neither, but $fragment"
  fi
  warn "server: there are two t3code-server units, $systemwide ($sysunit) and $ownlabel ($ownunit); $which" \
    "turn one of them off: $sysfix, or $ownfix"
fi
# The unit systemd loaded is the other module's: say whose, and make none of
# this configuration's claims about it.
# A masked unit is the mask (its file a link to /dev/null or empty,
# whoever's), not another owner's unit: the masked advice below applies.
other=''
if [ -n "$loadedby" ] && [ -n "$MODULE" ] && [ "$loadedby" != "$MODULE" ] && [ "${unitstate[0]-}" != masked ]; then
  case $loadedby in
    nixos) other="the NixOS module's" ;;
    system) other="a system-wide (not t3code-nix's)" ;;
    user) other="your own (not t3code-nix's)" ;;
    foreign) other="another (not t3code-nix's)" ;;
    *) other="Home Manager's" ;;
  esac
fi
if [ -n "$other" ]; then
  # The unit file systemd loaded; a process started from an earlier one
  # (before a daemon-reload) keeps running as it was.
  if [ -n "$running" ]; then what="active"; else what="not running"; fi
  if [ "$SERVER" = on ]; then
    warn "server: systemd loaded $other t3code-server unit ($fragment, $what), not this configuration's" \
      "turn one of them off; if this configuration's should run, switch, then \`systemctl --user daemon-reload\` and restart t3code-server"
  else
    ok "server: systemd loaded $other t3code-server unit ($fragment, $what); $ns.server is off"
  fi
# Not for this user, but running (from before server.users changed: a
# rebuild doesn't stop it, and it holds the port): say so. A failed one is
# reported as failed below.
elif [ "$SERVER" = off ] && [ -n "$running" ]; then
  warn "server: $ns.server is off, but t3code-server is still running from before ($switched), and holds its port" \
    "stop it with \`systemctl --user stop t3code-server\`"
elif [ "$SERVER" = on ] && [ -n "$notyours" ] && [ -n "$running" ]; then
  warn "server: t3code-server is still running for you ($me), from before; it runs for $forwhom now, and holds its port" \
    "stop it with \`systemctl --user stop t3code-server\`"
elif [ "$SERVER" = on ] && [ -n "$notyours" ] && [ "$state" != "loaded failed" ]; then
  ok "server: t3code-server runs for $forwhom, not for you ($me); name yourself in programs.t3code.server.users to run it too"
else
  case "$SERVER $state" in
    "off "*) ok "server ($ns.server): not enabled" ;;
    *" loaded active") ok "server: t3code-server is running" ;;
    *" loaded failed") problem "server: t3code-server has failed" "$logs" ;;
    *" loaded activating") warn "server: t3code-server is starting or restarting (several in a row mean it keeps failing)" "$logs" ;;
    *" masked active" | *" masked activating") warn "server: t3code-server is masked, but still running" "unmask it with \`systemctl --user unmask t3code-server\` (or stop it)" ;;
    *" masked "*) warn "server: t3code-server is masked, so it can't start" "unmask it with \`systemctl --user unmask t3code-server\`" ;;
    "on error "* | "on bad-setting "*) problem "server: t3code-server's unit couldn't be loaded" "$logs" ;;
    *" loaded "*) warn "server: t3code-server isn't running" "start it with \`systemctl --user start t3code-server\`; $linger" ;;
    "on "*) warn "server: enabled, but its unit isn't loaded for you (or systemd couldn't be asked)" "$notloaded" ;;
    *) ok "server: there's no t3code-server unit ($ns.server isn't in use)" ;;
  esac
fi

# Is `t3` on PATH ours? t3code-nix's wraps a t3-unwrapped build, itself or
# through one more wrapper (nixGL's, Home Manager) that runs another store
# build's bin/t3.
runs_unwrapped() {
  local inner
  grep -qs -- "-t3-unwrapped" "$1" && return 0
  inner=$(grep -aoE '/nix/store/[^/" ]+/bin/t3' "$1" 2>/dev/null | grep -vF "${1%/bin/t3}/" | head -1)
  [ -n "$inner" ] && grep -qs -- "-t3-unwrapped" "$inner"
}
if ! t3=$(command -v t3 2>/dev/null); then
  ok "t3: not on PATH ($ns.cli.enable or server.enable installs it)"
else
  real=$(readlink -f -- "$t3")
  if [ "${real%/bin/t3}" = "$CLI" ]; then
    ok "t3: this build's ($t3)"
  # A t3code-nix desktop app with its own t3 (withCli: the overlay's
  # pkgs.t3code), known by its shape: a t3code build whose t3 runs a
  # t3-unwrapped one.
  elif app_t3=$(store_name "$real") && case $app_t3 in t3code-*) true ;; *) false ;; esac \
    && runs_unwrapped "$real"; then
    if [ "$CLI_INSTALLED" = yes ]; then
      # This configuration's app's own carries the app's setting; another's
      # (or one the doctor can't place) may not.
      shadow=$tcli shadowfix="put the profile with $ns's t3 first on PATH, or remove the app with withCli from the other profile"
      if ourapp "${real%/bin/t3}"; then
        shadow='' shadowfix="put the profile with $ns's t3 first on PATH"
      fi
      warn "t3: $t3 is the app's own t3 (withCli, $app_t3), ahead of the t3 this configuration installs$shadow" \
        "$shadowfix"
    elif [ -n "$telemetryoff" ] && [ -n "${APP:-}" ] && ! ourapp "${real%/bin/t3}"; then
      # Another app's (its own wrapper's setting), not this configuration's.
      warn "t3: $t3 is another t3code-nix app's own t3 (withCli, $app_t3), not this configuration's app$tcli" \
        "remove the other app from your profile, or put this configuration's first on PATH"
    else
      ok "t3: the app's own ($t3, withCli)"
    fi
  elif [ "${real#/nix/store/}" = "$real" ]; then
    warn "t3: $t3 isn't from Nix (upstream's install script, or the desktop app's own t3 launcher, puts one in ~/.local/bin); it isn't this flake's wrapper (no bundled providers; upstream's updates itself)$tcli" \
      "delete it, or put t3code-nix's t3 first on PATH"
  elif runs_unwrapped "$real"; then
    warn "t3: $t3 is t3code-nix's, but another build ($(store_name "$real"))$tcli" \
      "fine if you meant it; otherwise remove the other one from your packages"
  else
    warn "t3: $t3 comes from another Nix package ($(store_name "$real")), not t3code-nix$tcli" \
      "remove that package, or set $ns.cli.enable so t3code-nix's t3 is installed instead"
  fi
fi

echo
echo "Usage data (product events and relay traces T3 Code sends; warnings only):"
# This build's setting, for the app and the CLI apart (they can differ).
# The flake's own doctor (no module) knows only its default packages.
standalone=''
[ -n "$MODULE" ] || standalone="; this doctor knows this flake's default packages, not one you overrode"
progs=()
[ "${TELEMETRY_APP:-unknown}" = none ] || progs+=(app)
# The CLI only when this configuration installs one (or may: the flake's
# doctor); without, a t3 is the app's own (withCli, the app's setting) or
# another's.
[ "${CLI_INSTALLED:-unknown}" = no ] || progs+=(cli)
for prog in "${progs[@]}"; do
  if [ "$prog" = app ]; then what="the app" b=${TELEMETRY_APP:-unknown}; else what="t3 (the CLI and server)" b=${TELEMETRY_CLI:-unknown}; fi
  case $b in
    off) ok "$what: off (this build's telemetry setting)" ;;
    on) ok "$what: on (T3 Code's default)$standalone" "to turn it off, $telemetryfix" ;;
    *) ok "$what: unknown (a package without t3code-nix's telemetry setting)" ;;
  esac
done
# This shell's environment, for programs started from it, judged per
# program: an off build's wrapper turns unset, empty and blank into false.
# The two values (whatever they hold) stay out of a trace (bash -x).
xtrace=''
case $- in *x*) xtrace=1; set +x ;; esac
tstate "${T3CODE_TELEMETRY_ENABLED-}" exact
envstate=$REPLY
tstate "${DO_NOT_TRACK-}" loose
dnt=$REPLY
if [ -n "$xtrace" ]; then set -x; fi
dntname "$dnt"
shellline="this shell: T3CODE_TELEMETRY_ENABLED $envstate, DO_NOT_TRACK $REPLY"
[ "$dnt" != true ] || shellline="$shellline (asks programs started from here to send no usage data, which T3 Code 0.1.12 and later honour)"
ok "$shellline"
rejects=() turnson=()
for prog in "${progs[@]}"; do
  if [ "$prog" = app ]; then what="the app" b=${TELEMETRY_APP:-unknown}; else what="t3" b=${TELEMETRY_CLI:-unknown}; fi
  eff=$envstate
  if [ "$b" = off ]; then
    case $envstate in unset | blank) eff=false ;; esac
  elif [ "$envstate" = blank ]; then
    eff=rejected
  fi
  if [ "$eff" = rejected ]; then
    rejects+=("$what")
  elif [ "$b" = off ] && [ "$eff" = true ] && [ "$dnt" != true ]; then
    turnson+=("$what")
  fi
done
# "a", "a and b".
names() { if [ "$#" -gt 1 ]; then printf '%s and %s' "$1" "$2"; else printf '%s' "$1"; fi; }
if [ "${#rejects[@]}" -gt 0 ]; then
  warn "this shell's T3CODE_TELEMETRY_ENABLED is a value T3 Code rejects ($envstate): $(names "${rejects[@]}") started from here won't start its server" \
    "unset it, or set it to false or true (lowercase)"
fi
if [ "${#turnson[@]}" -gt 0 ]; then
  warn "this shell sets T3CODE_TELEMETRY_ENABLED to true: $(names "${turnson[@]}") started from here can send usage data, though this build turns it off" \
    "unset it (look in your shell profile), or set DO_NOT_TRACK=1"
fi
# The running server, when it is this flake's t3code-server: its starting
# environment (only these two variables; nothing else is read out or
# printed, and its environmentFile never is), from a process still the same.
serverours=''
case $loadedby in nixos | home-manager) serverours=1 ;; esac
# Its environment may hold an environmentFile's secrets, and the two values
# read may be anything: none of it goes to a trace (bash -x).
xtrace=''
case $- in *x*) xtrace=1; set +x ;; esac
if [ -n "$running" ] && [ -n "$serverours" ]; then
  pid=$(systemctl --user show -p MainPID --value t3code-server.service 2>/dev/null || true)
  senv='' sdnt='' shas='' sread=''
  case $pid in
    '' | 0 | *[!0-9]*) ;;
    *)
      # Read once, whole or not at all (an unreadable one is unknown). A
      # process that is still the wrapper's shell, before its exec, hasn't
      # the server's environment yet: unknown too.
      environ=$root/proc/$pid/environ
      arg0=''
      if [ -r "$root/proc/$pid/cmdline" ]; then
        IFS= read -r -d '' arg0 < "$root/proc/$pid/cmdline" || true
      fi
      case ${arg0##*/} in
        bash | sh) ;;
        *)
          entries=()
          if mapfile -d '' -t entries < <(cat -- "$environ" 2> /dev/null) && wait $!; then
            sread=1
            for entry in "${entries[@]}"; do
              case $entry in
                T3CODE_TELEMETRY_ENABLED=*) senv=${entry#*=} shas=1 ;;
                DO_NOT_TRACK=*) sdnt=${entry#*=} ;;
              esac
            done
          fi
          entries=() entry=''
          [ "$(systemctl --user show -p MainPID --value t3code-server.service 2>/dev/null || true)" = "$pid" ] || sread=''
          ;;
      esac
      ;;
  esac
  # DO_NOT_TRACK keeps usage data off only for a server that honours it:
  # one running this build's t3 (T3 Code before 0.1.12 ignored it; another
  # build may be that old).
  dnthonoured() {
    [ "$sdntstate" = true ] && [ -n "${CLI_UNWRAPPED:-}" ] || return 1
    case ${arg0:-} in "$CLI_UNWRAPPED"/*) return 0 ;; *) return 1 ;; esac
  }
  if [ -z "$sread" ]; then
    ok "server: its usage data setting is unknown (its environment couldn't be read)"
  else
    tstate "$senv" exact
    sstate=$REPLY
    [ -n "$shas" ] || sstate=absent
    tstate "$sdnt" loose
    sdntstate=$REPLY
    dntname "$sdntstate"
    line="server: started with T3CODE_TELEMETRY_ENABLED $sstate, DO_NOT_TRACK $REPLY"
    # Only the doctor of the module that made the unit compares it with its
    # build; a standalone doctor, or the other module's, reports it.
    # Not for a server this configuration doesn't run for you (off, or not
    # in server.users): the server section above says to stop that one.
    if [ -n "$MODULE" ] && [ "$loadedby" = "$MODULE" ] && [ "$SERVER" = on ] && [ -z "$notyours" ] \
      && [ "${TELEMETRY_CLI:-unknown}" = off ] \
      && [ "$sstate" != false ] && ! dnthonoured; then
      case $sstate in
        absent | unset | blank)
          warn "$line, but this build turns usage data off: it started from an older build" \
            "\`systemctl --user daemon-reload\`, then \`systemctl --user restart t3code-server\`" ;;
        *)
          warn "$line, but this build turns usage data off: the server's environment sets it" \
            "remove T3CODE_TELEMETRY_ENABLED from its environmentFile, from the user manager's environment (\`systemctl --user show-environment\`), or from the unit or a drop-in for it (\`systemctl --user cat t3code-server\` shows both; after changing one, \`systemctl --user daemon-reload\`), then restart t3code-server" ;;
      esac
    else
      ok "$line"
    fi
  fi
fi
senv='' sdnt=''
if [ -n "$xtrace" ]; then set -x; fi

echo
if [ "$problems" -gt 0 ]; then
  echo "$problems problem(s) found."
  exit 1
fi
echo "No problems found."
