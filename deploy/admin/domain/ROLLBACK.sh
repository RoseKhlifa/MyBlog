#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/opt/rosekhlifa-blog
NO_SERVICE=0
while (($#)); do
    case "$1" in
        --root) [[ $# -ge 2 ]] || exit 2; ROOT=$2; shift 2 ;;
        --no-service) NO_SERVICE=1; shift ;;
        *) exit 2 ;;
    esac
done
[[ "$ROOT" == /* && "$ROOT" != / && -d "$ROOT" && ! -L "$ROOT" ]] || exit 2
DOMAIN_DIR="$ROOT/deploy/admin/domain"
BACKUP=$(cat "$DOMAIN_DIR/last-backup")
[[ "$BACKUP" == "$DOMAIN_DIR/backups/"* && -d "$BACKUP" && ! -L "$BACKUP" ]] || exit 2
PROXY_DIR=/opt/1panel/www/sites/blog.rosekhlifa.com/proxy
if ((NO_SERVICE)); then PROXY_DIR="$ROOT/test-proxy"; else [[ $(id -u) == 0 && "$ROOT" == /opt/rosekhlifa-blog ]] || exit 2; fi
for name in online-admin.conf online-admin-upstream.inc; do
    if [[ -f "$BACKUP/$name.absent" ]]; then rm -f -- "$PROXY_DIR/$name"; else cp -a "$BACKUP/$name" "$PROXY_DIR/$name"; fi
done
cp -a "$BACKUP/admin-nginx.conf" "$ROOT/deploy/admin/nginx.conf"
cp -a "$BACKUP/editor-source.service" "$ROOT/deploy/admin/editor.service"
if ((!NO_SERVICE)); then
    if systemctl list-unit-files rosekhlifa-blog-auth.service --no-legend | grep -q rosekhlifa-blog-auth; then systemctl disable --now rosekhlifa-blog-auth.service; fi
    cp -a "$BACKUP/editor.service" /etc/systemd/system/rosekhlifa-blog-editor.service
    docker compose --project-directory "$ROOT" --file "$ROOT/deploy/admin/compose.yaml" -p rosekhlifa-blog-admin up -d --force-recreate admin
    docker exec rosekhlifa-blog-admin nginx -t
    docker exec 1Panel-openresty-Y6Yd nginx -t
    systemctl daemon-reload
    systemctl restart rosekhlifa-blog-editor.service
    docker exec rosekhlifa-blog-admin nginx -s reload
    docker exec 1Panel-openresty-Y6Yd nginx -s reload
fi
printf 'ROLLBACK PASS: previous admin proxy/editor configuration restored; public blog/source unchanged; service=%s\n' "$([[ "$NO_SERVICE" == 1 ]] && printf skipped || printf restored)"
