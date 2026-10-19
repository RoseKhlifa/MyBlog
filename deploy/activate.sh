#!/usr/bin/env bash
# The archive must contain the contents of dist/, including index.html, at its root.
set -Eeuo pipefail
umask 022

ROOT=/opt/rosekhlifa-blog
NO_SERVICE=0
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
    printf 'Usage: %s [--root ABSOLUTE_DIRECTORY] [--no-service] RELEASE_ID SHA256\n' "$0" >&2
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
(($# == 2)) || usage
RELEASE_ID=$1
EXPECTED_SHA=${2,,}
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die 'Invalid release ID.'
[[ "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ ]] || die 'SHA256 must be exactly 64 hexadecimal characters.'
[[ "$ROOT" == /* && "$ROOT" != / && -d "$ROOT" && ! -L "$ROOT" ]] || die 'Root must be an existing absolute directory, not a symlink or /.'
ROOT=$(cd -- "$ROOT" && pwd -P)
for directory in incoming releases; do
    [[ ! -L "$ROOT/$directory" ]] || die "$directory must not be a symlink."
    mkdir -p -- "$ROOT/$directory"
    [[ -d "$ROOT/$directory" ]] || die "$directory must be a directory."
done
ARCHIVE="$ROOT/incoming/$RELEASE_ID.tar.gz"
DESTINATION="$ROOT/releases/$RELEASE_ID"
[[ -f "$ARCHIVE" && ! -L "$ARCHIVE" ]] || die "Archive is missing or is a symlink: $ARCHIVE"
[[ ! -e "$DESTINATION" && ! -L "$DESTINATION" ]] || die "Release already exists: $RELEASE_ID"
ACTUAL_SHA=$(sha256sum -- "$ARCHIVE")
ACTUAL_SHA=${ACTUAL_SHA%% *}
[[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || die "Archive SHA256 mismatch: $ACTUAL_SHA"

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
            if [[ -n "$OLD_CURRENT" ]]; then
                compose up -d && compose restart blog && wait_health || restore_status=1
            else
                compose stop blog || restore_status=1
            fi
        fi
        printf 'Activation failed; restored current=%s previous=%s restoration_status=%s\n' "${OLD_CURRENT:-absent}" "${OLD_PREVIOUS:-absent}" "$restore_status" >&2
        ((status != 0)) || status=1
    fi
    rm -f -- "$LOCK/names" "$LOCK/types" "$ROOT/.current.new.$$" "$ROOT/.previous.new.$$"
    rmdir -- "$LOCK"
    exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

OLD_CURRENT=$(read_link current)
OLD_PREVIOUS=$(read_link previous)

# Disallow links, devices, absolute names, traversal, and escaped control characters.
# GNU tar's escaped listing also rejects ambiguous backslash-containing names.
tar --quoting-style=escape -tzf "$ARCHIVE" > "$LOCK/names"
tar --quoting-style=escape -tvzf "$ARCHIVE" > "$LOCK/types"
[[ -s "$LOCK/names" ]] || die 'Archive is empty.'
while IFS= read -r entry; do
    [[ "$entry" != /* && "$entry" != *\\* ]] || die "Unsafe archive entry: $entry"
    [[ "/$entry/" != */../* ]] || die "Archive contains parent-directory traversal: $entry"
done < "$LOCK/names"
while IFS= read -r entry; do
    [[ "$entry" == -* || "$entry" == d* ]] || die 'Archive may contain only regular files and directories.'
done < "$LOCK/types"

STAGE="$ROOT/releases/.unpack-$RELEASE_ID-$$"
mkdir -- "$STAGE"
tar -xzf "$ARCHIVE" --directory "$STAGE" --no-same-owner --no-same-permissions --delay-directory-restore
[[ -f "$STAGE/index.html" && -s "$STAGE/index.html" && ! -L "$STAGE/index.html" ]] || die 'Release must contain a nonempty regular index.html at its root.'
chmod -R u=rwX,go=rX -- "$STAGE"
mv -T -- "$STAGE" "$DESTINATION"

if ((!NO_SERVICE)); then compose config --quiet; fi
SWITCHED=1
set_link current "releases/$RELEASE_ID"
set_link previous "$OLD_CURRENT"
if ((!NO_SERVICE)); then
    compose up -d
    # Reopen all paths after replacing current, including nginx's cached root path.
    compose restart blog
    wait_health || die 'New release did not become healthy.'
fi
COMMITTED=1
printf 'Activated release=%s current=releases/%s previous=%s service=%s\n' "$RELEASE_ID" "$RELEASE_ID" "${OLD_CURRENT:-absent}" "$([[ "$NO_SERVICE" == 1 ]] && printf skipped || printf healthy)"
