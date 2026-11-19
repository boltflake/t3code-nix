# t3code-nix-init (`nix run …#init`): turn a NixOS system that isn't a
# flake yet into one with T3 Code, keeping the nixpkgs release it's on now.
#
# It writes /etc/nixos/flake.nix (or --dir's) from the flake template
# (templates/default), with two lines filled in for this machine: the
# nixpkgs branch the system follows now, and its host name, so a plain
# `sudo nixos-rebuild switch` builds it. It imports the configuration.nix
# next to it and changes nothing else: it never overwrites a flake.nix,
# never rebuilds, and makes no network calls.
#
# The branch comes from, in order: --branch; the system's `nixos` channel
# (`nix-channel --list`, as root); the running system's version
# (`nixos-version`: a channel build of nixos-unstable is "26.11pre…", of a
# release "26.05.…"). Otherwise it stops and asks for --branch.
# @template@ is the template's flake.nix (filled in by package.nix).
# T3CODE_INIT_ROOT (tests only) is prefixed to /etc/nixos and /proc,
# T3CODE_INIT_UID (tests only) stands for `id -u` and T3CODE_INIT_ROOT_HOME
# (tests only) for root's home folder.
template=@template@
root=${T3CODE_INIT_ROOT:-}
default=$root/etc/nixos

usage() {
  cat <<'EOF'
usage: t3code-nix-init [--dir DIR] [--branch BRANCH] [--host NAME] [--dry-run]

Writes DIR/flake.nix (default /etc/nixos): your configuration.nix with
T3 Code, on the nixpkgs branch your system follows now. Never overwrites a
flake.nix. Run it as root: sudo nix run github:swsammy/t3code-nix#init

  --dir DIR        where configuration.nix is (default /etc/nixos)
  --branch BRANCH  the nixpkgs branch, e.g. nixos-26.05 or nixos-unstable
                   (default: the one your system follows now)
  --host NAME      the configuration's name (default: this host name)
  --dry-run        print the flake.nix instead of writing it
EOF
}

die() {
  printf 't3code-nix init: %s\n' "$1" >&2
  exit 1
}

dir=$default branch='' host='' dry=0
while [ $# -gt 0 ]; do
  case $1 in
    --dir) [ $# -ge 2 ] || die "--dir needs a folder"; dir=$2; shift 2 ;;
    --branch) [ $# -ge 2 ] || die "--branch needs a branch"; branch=$2; shift 2 ;;
    --host) [ $# -ge 2 ] || die "--host needs a name"; host=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
# Absolute, so the printed `--flake <dir>#<host>` is a path (a relative
# one would be read as a flake registry name); no # or ?, which end a
# flake reference's path.
[ -d "$dir" ] || die "no folder $dir"
# (No CDPATH: cd would look for a relative folder there first.)
dir=$(CDPATH='' cd -- "$dir" && pwd) || die "can't open $dir"
[[ $dir != *[#?]* ]] || die "$dir has a # or ? in it, which a flake reference can't take: move it, or rename it"
me=${T3CODE_INIT_UID:-$(id -u)}

# A branch of github:NixOS/nixpkgs that systems follow: nixos-unstable or a
# release, each maybe -small, or nixpkgs-unstable.
isBranch() {
  [[ $1 =~ ^nixos-(unstable|[0-9][0-9]\.[0-9][0-9])(-small)?$ || $1 == nixpkgs-unstable ]]
}
# For commands printed to be pasted.
q() {
  printf '%q' "$1"
}

if [ -e "$dir/flake.nix" ] || [ -L "$dir/flake.nix" ]; then
  cat <<EOF
$dir/flake.nix exists already, so your system is a flake: init changes nothing.
Add T3 Code to it by hand, two additions:

  inputs.t3code-nix.url = "github:swsammy/t3code-nix";

and, in your nixosSystem's modules:

  t3code-nix.nixosModules.default
  { programs.t3code.enable = true; }

(with t3code-nix in your outputs' arguments). Then rebuild as you do now.
EOF
  exit 0
fi
[ -f "$dir/configuration.nix" ] || die "no configuration.nix in $dir (use --dir for another folder)"

# The branch.
source=''
if [ -n "$branch" ]; then
  isBranch "$branch" || die "--branch $branch: expected nixos-unstable, nixos-YY.MM (maybe with -small) or nixpkgs-unstable"
  source="--branch"
else
  tried=()
  # Root's channels are the system's; another user's aren't. Read with
  # root's own home, whatever HOME sudo passed on.
  if [ "$me" = 0 ] && command -v nix-channel > /dev/null; then
    rootHome=${T3CODE_INIT_ROOT_HOME:-~root}
    url=$( (HOME=$rootHome nix-channel --list 2> /dev/null || true) | sed -n 's/^nixos[[:space:]]\{1,\}//p' | head -n 1)
    url=${url%/}
    if [ -n "$url" ]; then
      # Only NixOS's own channels are branches of github:NixOS/nixpkgs.
      name=''
      [[ ! $url =~ ^https?://(nixos\.org/channels|channels\.nixos\.org)/([^/]+)$ ]] || name=${BASH_REMATCH[2]}
      if [ -n "$name" ] && isBranch "$name"; then
        branch=$name
        source="the system's nixos channel ($url)"
      else
        example=${url##*/}
        isBranch "$example" || example=nixos-26.05
        die "your system's nixos channel is $url, which isn't one of NixOS's own branches. Pass the branch of github:NixOS/nixpkgs to use with --branch, e.g. --branch $example."
      fi
    else
      tried+=("root has no nixos channel")
    fi
  fi
  if [ -z "$branch" ] && command -v nixos-version > /dev/null; then
    version=$( (nixos-version 2> /dev/null || true) | sed -n '1s/[[:space:]].*//p')
    # Only a channel build's version says which branch: Hydra's suffix is
    # "pre<count>.<12-digit revision>" on nixos-unstable and ".<count>.<…>"
    # on a release. A flake build's (".<date>.<7-digit revision>") or a git
    # checkout's ("pre-git") doesn't tell them apart.
    if [[ $version =~ ^[0-9][0-9]\.[0-9][0-9]pre[0-9]+\.[0-9a-f]{12}$ ]]; then
      branch=nixos-unstable
    elif [[ $version =~ ^([0-9][0-9]\.[0-9][0-9])\.[0-9]+\.[0-9a-f]{12}$ ]]; then
      branch=nixos-${BASH_REMATCH[1]}
    fi
    if [ -n "$branch" ]; then
      source="the running system's version ($version)"
    else
      tried+=("nixos-version says ${version:-nothing}, which doesn't name a branch")
    fi
  fi
  if [ -z "$branch" ]; then
    why=''
    if [ ${#tried[@]} -gt 0 ]; then
      why=" (${tried[0]}"
      for x in "${tried[@]:1}"; do why+="; $x"; done
      why+=")"
    fi
    die "can't tell which nixpkgs branch your system follows$why. Pass it with --branch, e.g. --branch nixos-26.05."
  fi
fi

# The host name: nixos-rebuild builds nixosConfigurations."<host name>" by
# default. The attribute is quoted, so dots are fine; nothing that could
# end the string gets in.
current=$(cat "$root/proc/sys/kernel/hostname" 2> /dev/null || true)
validHost() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}
fellBack=0
if [ -z "$host" ]; then
  host=$current
  validHost "$host" || { host=nixos; fellBack=1; }
elif ! validHost "$host"; then
  die "--host $host: letters, digits, '.', '-' and '_' only"
fi
# The command that builds it: a plain one when it's this host's name in
# /etc/nixos.
if [ "$host" = "$current" ] && [ "$dir" = "$default" ]; then
  rebuild="sudo nixos-rebuild switch"
else
  rebuild="sudo nixos-rebuild switch --flake $(q "$dir#$host")"
fi

# The template with this machine's two lines. Each replacement must match
# exactly once, so a changed template fails here instead of writing
# something half-done.
header="# A NixOS system with T3 Code, from t3code-nix (written by t3code-nix init)."
if [ "$source" = --branch ]; then
  said="    # The branch given with --branch when init ran."
else
  said="    # The branch your system followed when init ran, from
    #   $source."
fi
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
# (Values through the environment: awk -v would read backslashes as
# escapes.)
BRANCH=$branch HOST=$host SAID=$said HEADER=$header REBUILD=$rebuild awk '
  BEGIN {
    branch = ENVIRON["BRANCH"]; host = ENVIRON["HOST"]; said = ENVIRON["SAID"]
    header = ENVIRON["HEADER"]; rebuild = ENVIRON["REBUILD"]
  }
  # The template'"'"'s opening comment and the comment over the nixpkgs line
  # are about choosing these values by hand: replaced.
  NR == 1 { print header; skiphead = 1; next }
  skiphead && /^#/ { next }
  { skiphead = 0 }
  /^    # Check this line\./ { skipping = 1; next }
  skipping && /^    #/ { next }
  { skipping = 0 }
  /^    nixpkgs\.url = "github:NixOS\/nixpkgs\/nixos-unstable";$/ {
    print said
    print "    # (This flake'"'"'s packages bring their own nixpkgs either way.)"
    print "    nixpkgs.url = \"github:NixOS/nixpkgs/" branch "\";"
    url++; next
  }
  /^      # `nixos` is NixOS'"'"'s default host name/ { next }
  /^      # builds it whatever yours is\.$/ { next }
  /^      nixosConfigurations\.nixos = nixpkgs\.lib\.nixosSystem \{$/ {
    print "      # Build it with `" rebuild "`."
    print "      nixosConfigurations.\"" host "\" = nixpkgs.lib.nixosSystem {"
    conf++; next
  }
  { print }
  END { if (url != 1 || conf != 1) exit 3 }
' "$template" > "$tmp" || die "the template changed shape; please report this"

if [ "$dry" = 1 ]; then
  cat "$tmp"
  exit 0
fi

[ -w "$dir" ] || die "can't write to $dir: run it as root (sudo nix run github:swsammy/t3code-nix#init)"
# Written whole to a new file next to it (mode 0644 from the umask, no
# chmod through a path afterwards), then linked into place: `ln` never
# replaces an existing flake.nix, and a failed write leaves no flake.nix.
# In a folder someone else owns (a user's checkout), the file is theirs,
# so they can edit it. (Like nixos-rebuild, this trusts whoever can write
# to $dir.)
new="$dir/.flake.nix.t3code-init-$$-$RANDOM"
trap 'rm -f "$tmp" "$new"' EXIT
(
  umask 022
  set -o noclobber
  cat "$tmp" > "$new"
) || die "couldn't write $new"
owner=$(stat -c %u:%g "$dir/")
if [ "$me" = 0 ] && [ "${owner%%:*}" != 0 ]; then
  chown -h "$owner" "$new" || die "couldn't give $new to the folder's owner"
fi
err=$(ln -T -- "$new" "$dir/flake.nix" 2>&1) || die "couldn't create $dir/flake.nix: $err"
rm -f "$new"

echo "Wrote $dir/flake.nix: your configuration.nix with T3 Code enabled."
echo "nixpkgs: $branch, from $source."

# configuration.nix resolved one path part at a time, as the kernel does,
# from the folder's real path: every link met on the way (a file's or a
# folder's), as "<where it is> <what it says>", every folder it passes
# through after the first link, and the file it ends at.
dirReal=$(readlink -f "$dir" || true)
links=() says=() visited=() target=''
walk() {
  local resolved='' rest=$1 part to n=0
  while :; do
    while [[ $rest == /* ]]; do rest=${rest#/}; done
    [ -n "$rest" ] || break
    part=${rest%%/*}
    if [[ $rest == */* ]]; then rest=${rest#*/}; else rest=''; fi
    case $part in
      .) continue ;;
      ..)
        resolved=${resolved%/*}
        [ "$n" = 0 ] || visited+=("${resolved:-/}")
        continue
        ;;
    esac
    if [ -L "$resolved/$part" ]; then
      n=$((n + 1))
      [ "$n" -le 40 ] || return 0
      to=$(readlink "$resolved/$part" || true)
      links+=("$resolved/$part")
      says+=("$to")
      [[ $to != /* ]] || resolved=''
      rest=$to${rest:+/$rest}
    else
      resolved=$resolved/$part
      [ "$n" = 0 ] || visited+=("$resolved")
    fi
  done
  target=${resolved:-/}
}
[ ! -L "$dir/configuration.nix" ] || walk "$dirReal/configuration.nix"

# A flake in a git repository sees only files git knows about. The
# repository may be above $dir.
gitAdd="git -C $(q "$dir") add flake.nix"
# The repository's top folder, if $dir is in one: the flake's source.
gitTop=''
if command -v git > /dev/null; then
  # (LC_ALL=C: git's message is matched below.)
  if top=$(LC_ALL=C git -C "$dir" rev-parse --show-toplevel 2>&1); then
    gitTop=$top
    if [ "$me" != "$(stat -c %u "$top/")" ]; then
      # Root adding to a user's repository would leave root-owned files in
      # its .git, breaking the owner's next commit.
      echo
      echo "$dir is in a git repository ($top), and the flake only sees files"
      echo "git tracks. As the repository's owner, run:"
      echo "  $gitAdd"
    elif err=$(git -C "$dir" add -- flake.nix 2>&1); then
      echo "Added flake.nix to the git repository in $top."
      untracked=$(git -C "$dir" ls-files --others --exclude-standard -- . 2> /dev/null || true)
      if [ -n "$untracked" ]; then
        echo
        echo "The flake can't see files git doesn't track. These aren't tracked yet:"
        printf '%s\n' "$untracked" | sed 's/^/  /'
        echo "Add the ones your configuration uses: git -C $(q "$dir") add <file>"
      fi
      ignored=$(git -C "$dir" ls-files --others --ignored --exclude-standard -- '*.nix' 2> /dev/null || true)
      if [ -n "$ignored" ]; then
        echo
        echo "Nor files git ignores. These .nix files are ignored:"
        printf '%s\n' "$ignored" | sed 's/^/  /'
        echo "Add the ones your configuration uses: git -C $(q "$dir") add -f <file>"
      fi
      # A linked configuration.nix: each link met on the way (files' and
      # folders') and its file: the lists above miss them when they're
      # elsewhere in the repository, or ignored and not named .nix.
      if [ -n "$target" ]; then
        topReal=$(readlink -f "$top" || true)
        missing=()
        for f in "${links[@]}" "$target"; do
          [[ $f == "$topReal"/* ]] || continue
          ! git -C "$top" ls-files --error-unmatch -- "$f" > /dev/null 2>&1 || continue
          ignored=0
          git -C "$top" check-ignore -q -- "$f" 2> /dev/null && ignored=1
          # In the folder, the lists above have all but the ignored ones
          # not named .nix.
          if [[ $f == "$dirReal"/* ]] && { [ "$ignored" = 0 ] || [[ $f == *.nix ]]; }; then
            continue
          fi
          if [ "$ignored" = 1 ]; then
            missing+=("git -C $(q "$top") add -f $(q "$f")")
          else
            missing+=("git -C $(q "$top") add $(q "$f")")
          fi
        done
        if [ ${#missing[@]} -gt 0 ]; then
          echo
          echo "configuration.nix links through files git doesn't track yet. Run:"
          printf '  %s\n' "${missing[@]}"
        fi
      fi
    else
      echo
      echo "$dir is in a git repository ($top), and the flake only sees files git"
      echo "tracks, but adding flake.nix failed:"
      printf '%s\n' "$err" | sed 's/^/  /'
      echo "Add it yourself (as the repository's owner): $gitAdd"
    fi
  elif ! [[ $top == *"not a git repository"* ]]; then
    # Say, a repository owned by another user (git's safe.directory).
    echo
    echo "git couldn't check whether $dir is in a git repository:"
    printf '%s\n' "$top" | sed 's/^/  /'
    echo "If it is, the flake only sees files git tracks: $gitAdd"
  fi
elif [ -e "$dir/.git" ]; then
  echo
  echo "$dir is a git repository, and the flake only sees files git tracks. Run:"
  echo "  $gitAdd"
fi

# A flake is evaluated purely: no <nixpkgs>-style paths (channels). Nix's
# own parser finds them (it turns <x> into __findFile __nixPath "x"), so
# text like "<uuid>" in strings and comments doesn't count. Every .nix file
# in the folder (not through links), and a linked configuration.nix's file
# when it's elsewhere.
# Nix's printed expression as tokens (an escape, "${", a quote, a brace,
# a run of anything else), one per line, with string text dropped: a state
# stack, "s" in a string and "e" in an expression (in ${…} or at the top).
# The state carries from token to token. Tokens keep it linear on big
# files; LC_ALL=C because every character that matters is ASCII.
# shellcheck disable=SC2016 # an awk program, not shell
stripStrings='
{
  if (top == "s") {
    if ($0 == "\"") { top = stack[--sp]; printf "\""; next }
    if ($0 == "${") { stack[sp++] = "s"; top = "e"; depth[sp] = 0; printf "${"; next }
    next
  }
  if ($0 == "\"") { stack[sp++] = top; top = "s"; printf "\""; next }
  if ($0 == "{") depth[sp]++
  if ($0 == "}") {
    if (sp > 0 && depth[sp] == 0 && stack[sp - 1] == "s") { sp--; top = "s"; printf "}"; next }
    depth[sp]--
  }
  printf "%s", $0
}
'
usesChannels() {
  local parsed
  # Parsed from stdin in / so the folder's path (which may hold a quote or
  # a brace) never appears: relative paths print as /…. $1 is absolute.
  # (pipefail: a parse failure still returns 1.)
  # shellcheck disable=SC2016 # a regex, not shell
  parsed=$( (cd / && nix-instantiate --parse - < "$1") 2> /dev/null \
    | LC_ALL=C grep -oE '\\.|\$\{|["{}]|[^"\\${}]+|.' \
    | LC_ALL=C awk "$stripStrings") || return 1
  [[ $parsed == *'(__findFile __nixPath "")'* ]]
}
channelPaths=()
if command -v nix-instantiate > /dev/null; then
  while IFS= read -r -d '' f; do
    rel=${f#"$dir"/}
    [ "$rel" != flake.nix ] || continue
    ! usesChannels "$f" || channelPaths+=("$rel")
  # (-H: --dir itself may be a link; links inside it aren't followed.)
  done < <(find -H "$dir" -name .git -prune -o -type f -name '*.nix' -print0 2> /dev/null | sort -z)
  # (Unless the scan read it already: a .nix file in the folder.)
  if [ -n "$target" ] && ! [[ $target == "$dirReal"/* && $target == *.nix ]] && usesChannels "$target"; then
    channelPaths=("configuration.nix (that is, $target)" "${channelPaths[@]}")
  fi
fi
if [ ${#channelPaths[@]} -gt 0 ]; then
  echo
  echo "These files use <…> paths (channels, such as <home-manager/nixos>):"
  printf '  %s\n' "${channelPaths[@]}"
  echo "A flake can't: make them flake inputs before you rebuild."
fi
# The flake's source is its folder, or the whole repository when it's in
# one, copied to the store: a link out of that, or an absolute one inside
# it (it points outside the copy), can't be followed.
if [ -n "$target" ]; then
  bound=$(readlink -f "${gitTop:-$dir}" || true)
  absolute='' outside=''
  for i in "${!links[@]}"; do
    if [[ ${links[$i]} == "$bound"/* && ${says[$i]} == /* ]]; then
      absolute="${links[$i]} -> ${says[$i]}"
      break
    fi
  done
  # Leaving the source on the way, even to come back, breaks it too.
  for v in "${visited[@]}"; do
    if [[ $v != "$bound" && $v != "$bound"/* ]]; then
      outside=$v
      break
    fi
  done
  if [ -n "$absolute" ]; then
    echo
    echo "configuration.nix goes through an absolute link ($absolute),"
    echo "which a flake can't follow: make it a relative link, or put the real file in $dir."
  elif [[ $target != "$bound"/* ]]; then
    echo
    echo "configuration.nix is a link to $target, outside $bound, which a flake"
    echo "can't follow: put the real file in $dir, or run init with --dir on its folder."
  elif [ -n "$outside" ]; then
    echo
    echo "configuration.nix's links go through $outside, outside $bound, which a"
    echo "flake can't follow: point the link at $target by a path that stays inside."
  fi
fi

# nixos-rebuild turns flakes on for itself; `nix flake` commands don't.
if features=$(nix --extra-experimental-features nix-command config show experimental-features 2>&1); then
  if ! [[ " $features " =~ [[:space:]]flakes[[:space:]] ]]; then
    echo
    echo "Flakes aren't turned on. The rebuild works anyway, but to update the"
    echo "flake (nix flake update) add this line to configuration.nix:"
    echo '  nix.settings.experimental-features = [ "nix-command" "flakes" ];'
  fi
else
  echo
  echo "Couldn't check whether flakes are turned on (nix said: $features)."
fi

echo
echo "Next, build your system with it:"
echo "  $rebuild"
[ "$fellBack" = 0 ] || echo "(Your host name, ${current:-unknown}, can't be a configuration's name, so it's \`nixos\`.)"
echo "Options for T3 Code (providers, the server, agent tools) are in flake.nix's comments."
echo "To go back before rebuilding, delete $dir/flake.nix. After rebuilding, delete it"
echo "(and flake.lock) and rebuild again, or boot the previous generation."
