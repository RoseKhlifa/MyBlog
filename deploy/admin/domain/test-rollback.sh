#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(mktemp -d /tmp/rosekhlifa-domain-rollback.XXXXXX)
BACKUP="$ROOT/deploy/admin/domain/backups/original"
mkdir -p "$BACKUP" "$ROOT/test-proxy" "$ROOT/source"
cp "$SCRIPT_DIR/evidence/admin-nginx.before.conf" "$BACKUP/admin-nginx.conf"
cp "$SCRIPT_DIR/evidence/editor.before.service" "$BACKUP/editor-source.service"
touch "$BACKUP/online-admin.conf.absent" "$BACKUP/online-admin-upstream.inc.absent"
printf '%s\n' "$BACKUP" > "$ROOT/deploy/admin/domain/last-backup"
printf 'changed config\n' > "$ROOT/deploy/admin/nginx.conf"
printf 'changed unit\n' > "$ROOT/deploy/admin/editor.service"
cp "$SCRIPT_DIR/online-admin.conf" "$ROOT/test-proxy/online-admin.conf"
cp "$SCRIPT_DIR/upstream.inc" "$ROOT/test-proxy/online-admin-upstream.inc"
printf 'keep article\n' > "$ROOT/source/article.md"
bash "$SCRIPT_DIR/ROLLBACK.sh" --root "$ROOT" --no-service
cmp "$ROOT/deploy/admin/nginx.conf" "$SCRIPT_DIR/evidence/admin-nginx.before.conf"
cmp "$ROOT/deploy/admin/editor.service" "$SCRIPT_DIR/evidence/editor.before.service"
[[ ! -e "$ROOT/test-proxy/online-admin.conf" && ! -e "$ROOT/test-proxy/online-admin-upstream.inc" ]]
[[ $(cat "$ROOT/source/article.md") == 'keep article' ]]
printf 'ROLLBACK COPY PASS: original configuration SHA256 restored; extra domain routes removed; article preserved\n'
printf 'Test copy retained at %s\n' "$ROOT"
