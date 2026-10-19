#!/usr/bin/env bash
# Disable online writing while retaining published pages, source, media and backups.
set -Eeuo pipefail
ROOT=/opt/rosekhlifa-blog
NO_SERVICE=0
while (($#)); do
    case "$1" in
        --root) [[ $# -ge 2 ]] || exit 2; ROOT=$2; shift 2 ;;
        --no-service) NO_SERVICE=1; shift ;;
        *) echo 'Usage: ROLLBACK.sh [--root ABSOLUTE_TEST_COPY --no-service]' >&2; exit 2 ;;
    esac
done
[[ "$ROOT" == /* && "$ROOT" != / && -d "$ROOT" && ! -L "$ROOT" ]] || exit 2
ROOT=$(cd -- "$ROOT" && pwd -P)
if ((NO_SERVICE == 0)); then
    [[ "$ROOT" == /opt/rosekhlifa-blog && $(id -u) == 0 ]] || exit 2
    systemctl disable --now rosekhlifa-blog-publisher.service rosekhlifa-blog-editor.service
    if systemctl list-unit-files rosekhlifa-blog-auth.service --no-legend | grep -q rosekhlifa-blog-auth; then systemctl disable --now rosekhlifa-blog-auth.service; fi
    docker compose --project-directory "$ROOT" --file "$ROOT/deploy/admin/compose.yaml" -p rosekhlifa-blog-admin stop admin
fi
if [[ -f "$ROOT/.online-authoring" ]]; then
    mv -f -- "$ROOT/.online-authoring" "$ROOT/.online-authoring.disabled"
fi
printf 'ROLLBACK PASS: online writing disabled; public site/source/media/backups preserved; service=%s\n' "$([[ "$NO_SERVICE" == 1 ]] && printf skipped || printf stopped)"
