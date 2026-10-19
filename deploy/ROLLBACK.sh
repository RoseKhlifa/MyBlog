#!/usr/bin/env bash
# With no release ID, current and previous are exchanged after health validation.
set -Eeuo pipefail
umask 022

ROOT=/opt/rosekhlifa-blog
NO_SERVICE=0
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
    printf 'Usage: %s [--root ABSOLUTE_DIRECTORY] [--no-service] [RELEASE_ID]\n' "$0" >&2
    exit 2
}
while (($#)); do
    case "$1" in
        --root) (($# >= 2)) || usage; ROOT=$2; shift 2 ;;
        --no-service) NO_SERVICE=1; shift ;;
        --) shift; break ;;
        -*) usage ;;
        *) break ;;
    esac
done
(($# <= 1)) || usage
RELEASE_ID=${1:-}
[[ -z "$RELEASE_ID" || "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die 'Invalid release ID.'
[[ "$ROOT" == /* && "$ROOT" != / && -d "$ROOT" && ! -L "$ROOT" ]] || die 'Root must be an existing absolute directory, not a symlink or /.'
ROOT=$(cd -- "$ROOT" && pwd -P)
[[ -d "$ROOT/releases" && ! -L "$ROOT/releases" ]] || die 'Missing or invalid releases directory.'
LOCK="$ROOT/.deployment-lock"
mkdir -- "$LOCK" 2>/dev/null || die 'Another deployment holds .deployment-lock; inspect it before retrying.'
SWITCHED=0
COMMITTED=0
OLD_CURRENT=''
OLD_PREVIOUS=''

read_link() {
    local name=$1 target
    if [[ ! -L "$ROOT/$name" ]]; then
        [[ ! -e "$ROOT/$name" ]] || die "$name must be a symlink."
        printf '%s' ''
        return 0
    fi
    target=$(readlink -- "$ROOT/$name")
    [[ "$target" =~ ^releases/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "Invalid $name target."
    [[ -d "$ROOT/$target" && ! -L "$ROOT/$target" && -s "$ROOT/$target/index.html" && ! -L "$ROOT/$target/index.html" ]] || die "Invalid $name release directory."
    printf '%s' "$target"
}

set_link() {
    local name=$1 target=$2 temporary="$ROOT/.$1.new.$$"
    if [[ -z "$target" ]]; then
        [[ ! -e "$ROOT/$name" || -L "$ROOT/$name" ]] || return 1
        if [[ -L "$ROOT/$name" ]]; then rm -- "$ROOT/$name"; fi
        return 0
    fi
    ln -s -- "$target" "$temporary"
    mv -Tf -- "$temporary" "$ROOT/$name"
}

compose() {
    docker compose --project-directory "$ROOT" --file "$SCRIPT_DIR/compose.yaml" -p rosekhlifa-blog "$@"
}

wait_health() {
    local container state health deadline=$((SECONDS + 90))
    container=$(compose ps --quiet blog) || return 1
    [[ -n "$container" ]] || return 1
    while ((SECONDS < deadline)); do
        state=$(docker inspect --format '{{.State.Status}}' "$container") || return 1
        health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container") || return 1
        if [[ "$state" == running && "$health" == healthy ]]; then return 0; fi
        [[ "$state" == running || "$state" == restarting ]] || return 1
        sleep 2
    done
    printf 'Health check exceeded 90 seconds.\n' >&2
    return 1
}

on_exit() {
    local status=$? restore_status=0
    trap - EXIT INT TERM
    set +e
    rm -f -- "$ROOT/.current.new.$$" "$ROOT/.previous.new.$$"
    if ((SWITCHED && !COMMITTED)); then
        set_link current "$OLD_CURRENT" || restore_status=1
        set_link previous "$OLD_PREVIOUS" || restore_status=1
        if ((!NO_SERVICE)); then
            compose up -d && compose restart blog && wait_health || restore_status=1
        fi
        printf 'Rollback failed; restored current=%s previous=%s restoration_status=%s\n' "$OLD_CURRENT" "${OLD_PREVIOUS:-absent}" "$restore_status" >&2
        ((status != 0)) || status=1
    fi
    rm -f -- "$ROOT/.current.new.$$" "$ROOT/.previous.new.$$"
    rmdir -- "$LOCK"
    exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

OLD_CURRENT=$(read_link current)
OLD_PREVIOUS=$(read_link previous)
[[ -n "$OLD_CURRENT" ]] || die 'No current release exists.'
if [[ -n "$RELEASE_ID" ]]; then
    TARGET="releases/$RELEASE_ID"
else
    TARGET=$OLD_PREVIOUS
fi
[[ -n "$TARGET" ]] || die 'No previous release exists; pass an explicit release ID.'
[[ -d "$ROOT/$TARGET" && ! -L "$ROOT/$TARGET" && -s "$ROOT/$TARGET/index.html" && ! -L "$ROOT/$TARGET/index.html" ]] || die 'Rollback target must contain a nonempty regular index.html.'
if [[ "$TARGET" == "$OLD_CURRENT" ]]; then
    printf 'Already current=%s; no change required.\n' "$TARGET"
    COMMITTED=1
    exit 0
fi
if ((!NO_SERVICE)); then compose config --quiet; fi
SWITCHED=1
set_link current "$TARGET"
set_link previous "$OLD_CURRENT"
if ((!NO_SERVICE)); then
    compose up -d
    compose restart blog
    wait_health || die 'Rollback target did not become healthy.'
fi
COMMITTED=1
printf 'Rolled back current=%s previous=%s service=%s\n' "$TARGET" "$OLD_CURRENT" "$([[ "$NO_SERVICE" == 1 ]] && printf skipped || printf healthy)"
