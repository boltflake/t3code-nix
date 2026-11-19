# Sourced by the t3/t3code wrappers before t3code starts (makeWrapper --run).
# t3code runs its HTML-preview browser from
#   <base>/tools/chrome-headless-shell/<platform>/<version>/chrome-headless-shell
# and downloads it there when it's missing; the download can't run on NixOS
# without nix-ld. This links that version folder to our patched copy, so
# t3code finds it and never downloads. There's no setting for the path.
#
# <base> is what t3code uses (resolveBaseDir): the CLI's --base-dir (last
# one wins, before `--`), else T3CODE_HOME; trimmed; empty means ~/.t3;
# "~", "~/" and "~\" expand to the home folder. A relative path is taken
# from the current folder for the CLI, and from the home folder for the
# desktop app (cli=0: its backend runs there, and it has no --base-dir).
# The home folder is $HOME, else the account's.
#
# A correct link is left alone (the common case runs no command). Otherwise
# the tools folder is created, even for `t3 --version`. A folder t3code
# downloaded earlier for this same version is moved aside, replaced by the
# link in one rename, then removed (t3code treats it as a cache and deletes
# it itself on reinstall); if the link fails it is put back. A kill during
# that removal can leave a <version>.old-<pid> folder behind. Failures only
# warn: t3code then reports its own browser error.
#
# Hosts that restrict unprivileged user namespaces (Ubuntu 23.10+) are left
# alone: there `t3 browser setup` installs an AppArmor profile that matches
# the browser's path under the tools folder, which a link into /nix/store
# would no longer match. t3code's own download works on those hosts.
# shellcheck shell=bash
t3codeLinkPreviewBrowser() {
  local cli=$1 target=$2 platform=$3 version=$4
  shift 4
  local restricted=
  read -r restricted 2>/dev/null </proc/sys/kernel/apparmor_restrict_unprivileged_userns || true
  [ "$restricted" = 1 ] && return 0
  local base=${T3CODE_HOME-} arg next=0
  if [ "$cli" = 1 ]; then
    for arg in "$@"; do
      if [ $next = 1 ]; then base=$arg; next=0; continue; fi
      case $arg in
        --) break ;;
        --base-dir) next=1 ;;
        --base-dir=*) base=${arg#--base-dir=} ;;
      esac
    done
  fi
  base=${base#"${base%%[![:space:]]*}"}
  base=${base%"${base##*[![:space:]]}"}
  local home=${HOME-}
  # Bash's own ~ is the account's home folder when HOME is unset.
  [ -n "$home" ] || home=$(unset HOME; echo ~)
  # Paths taken from the home folder need one.
  case $cli:$base in ?: | ?:"~" | ?:"~/"* | ?:"~\\"* | 0:[!/]*) [ -n "$home" ] && [ "$home" != "~" ] || return 1 ;; esac
  case $base in
    "") base=$home/.t3 ;;
    "~") base=$home ;;
    "~/"* | "~\\"*) base=$home/${base:2} ;;
    /*) ;;
    *) if [ "$cli" = 1 ]; then base=$PWD/$base; else base=$home/$base; fi ;;
  esac
  local dir=$base/tools/chrome-headless-shell/$platform/$version
  [ -L "$dir" ] && [ "$dir" -ef "$target" ] && return 0
  local tmp=$dir.link-$$ old=$dir.old-$$
  @mkdir@ -p -- "${dir%/*}" 2>/dev/null && @ln@ -sfn -- "$target" "$tmp" 2>/dev/null || return 1
  if [ -d "$dir" ] && [ ! -L "$dir" ]; then
    @mv@ -T -- "$dir" "$old" || { @rm@ -f -- "$tmp"; return 1; }
  fi
  if @mv@ -Tf -- "$tmp" "$dir"; then
    @rm@ -rf -- "$old"
  else
    @rm@ -f -- "$tmp"
    [ -e "$old" ] && @mv@ -T -- "$old" "$dir"
    return 1
  fi
}
