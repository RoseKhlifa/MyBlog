#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/opt/rosekhlifa-blog
DOMAIN_DIR="$ROOT/deploy/admin/domain"
PROXY_DIR=/opt/1panel/www/sites/blog.rosekhlifa.com/proxy
EDITOR_UNIT=/etc/systemd/system/rosekhlifa-blog-editor.service
[[ $(id -u) == 0 && -f "$PROXY_DIR/root.conf" ]] || exit 2
BACKUP="$DOMAIN_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$BACKUP"
cp -a "$ROOT/deploy/admin/nginx.conf" "$BACKUP/admin-nginx.conf"
cp -a "$EDITOR_UNIT" "$BACKUP/editor.service"
cp -a "$ROOT/deploy/admin/editor.service" "$BACKUP/editor-source.service"
for name in online-admin.conf online-admin-upstream.inc; do
    if [[ -f "$PROXY_DIR/$name" ]]; then cp -a "$PROXY_DIR/$name" "$BACKUP/$name"; else touch "$BACKUP/$name.absent"; fi
done
cp -a "$PROXY_DIR/root.conf" "$BACKUP/root.untouched.conf"
cp -a /opt/1panel/www/conf.d/blog.rosekhlifa.com.conf "$BACKUP/site.untouched.conf"
printf '%s\n' "$BACKUP" > "$DOMAIN_DIR/last-backup"
SUCCESS=0
on_exit() {
    local status=$?
    trap - EXIT
    if ((SUCCESS == 0)); then
        printf 'Domain install failed; restoring previous configuration.\n' >&2
        bash "$DOMAIN_DIR/ROLLBACK.sh" || true
    fi
    exit "$status"
}
trap on_exit EXIT
install -m 0644 "$DOMAIN_DIR/admin-nginx.conf" "$ROOT/deploy/admin/nginx.conf"
install -m 0644 "$DOMAIN_DIR/editor.service" "$ROOT/deploy/admin/editor.service"
install -m 0644 "$DOMAIN_DIR/editor.service" "$EDITOR_UNIT"
install -m 0644 "$DOMAIN_DIR/astro-online.config.mjs" "$ROOT/deploy/admin/astro-online.config.mjs"
install -m 0644 "$DOMAIN_DIR/upstream.inc" "$PROXY_DIR/online-admin-upstream.inc"
install -m 0644 "$DOMAIN_DIR/online-admin.conf" "$PROXY_DIR/online-admin.conf"
docker compose --project-directory "$ROOT" --file "$ROOT/deploy/admin/compose.yaml" -p rosekhlifa-blog-admin up -d --force-recreate admin
docker exec rosekhlifa-blog-admin nginx -t
docker exec 1Panel-openresty-Y6Yd nginx -t
systemctl daemon-reload
systemctl restart rosekhlifa-blog-editor.service
READY=0
for ((attempt=0; attempt<40; attempt++)); do
    if curl -fsS http://127.0.0.1:14321/@vite/client -o "$DOMAIN_DIR/vite-client.js" 2>/dev/null && grep -q '/admin/_hmr/' "$DOMAIN_DIR/vite-client.js"; then READY=1; break; fi
    sleep 1
done
((READY)) || { echo 'Editor did not start with the dedicated admin WebSocket path.' >&2; exit 1; }
docker exec 1Panel-openresty-Y6Yd nginx -s reload
cmp -s "$PROXY_DIR/root.conf" "$BACKUP/root.untouched.conf"
cmp -s /opt/1panel/www/conf.d/blog.rosekhlifa.com.conf "$BACKUP/site.untouched.conf"
SUCCESS=1
printf 'DOMAIN INSTALL PASS: https://blog.rosekhlifa.com/admin/; original public proxy and certificate configuration unchanged\n'
printf 'ROLLBACK SNAPSHOT: %s\n' "$BACKUP"
