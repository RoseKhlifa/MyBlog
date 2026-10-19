#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
ROOT=/opt/rosekhlifa-blog
SCRIPT_DIR="$ROOT/deploy/admin"
APP_USER=rosekhlifa-blog
[[ $(id -u) == 0 ]] || { echo 'Run this installer as root.' >&2; exit 1; }
[[ $# == 2 && $1 =~ ^online-source-[a-f0-9]{12}\.tar\.gz$ && $2 =~ ^[a-f0-9]{64}$ ]] || { echo 'Expected source archive name and SHA256.' >&2; exit 1; }
[[ -f "$ROOT/.managed-by-rosekhlifa-blog" ]] || { echo 'Expected managed blog deployment root.' >&2; exit 1; }
ARCHIVE="$ROOT/incoming/$1"
printf '%s  %s\n' "$2" "$ARCHIVE" | sha256sum --check --status
for command in node npm python3 rsync openssl sudo visudo runuser docker; do command -v "$command" >/dev/null; done
if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$ROOT/editor-home" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -m 0755 "$ROOT/deploy/admin" "$ROOT/publish-state" "$ROOT/online-incoming"
install -d -m 0755 -o root -g root "$ROOT/incoming"
install -d -m 0750 "$ROOT/source" "$ROOT/build" "$ROOT/source-backups" "$ROOT/editor-home"
chown "$APP_USER:$APP_USER" "$ROOT/source" "$ROOT/build" "$ROOT/source-backups" "$ROOT/editor-home" "$ROOT/publish-state" "$ROOT/online-incoming"
if [[ ! -f "$ROOT/source/package.json" ]]; then
    tar -xzf "$ARCHIVE" -C "$ROOT/source" --no-same-owner
    chown -R "$APP_USER:$APP_USER" "$ROOT/source"
fi
# Re-running the installer preserves existing server-authored articles and images.
if [[ ! -f "$ROOT/source/node_modules/astro/bin/astro.mjs" || ! -f "$ROOT/source/node_modules/.whono-installed" ]]; then
    printf 'Installing editor dependencies as %s...\n' "$APP_USER"
    runuser -u "$APP_USER" -- env HOME="$ROOT/editor-home" ASTRO_TELEMETRY_DISABLED=1 bash -c 'cd /opt/rosekhlifa-blog/source && npm ci --no-fund --no-audit'
    touch "$ROOT/source/node_modules/.whono-installed"
fi
if [[ ! -f "$ROOT/build/node_modules/astro/bin/astro.mjs" || ! -f "$ROOT/build/node_modules/.whono-installed" ]]; then
    rsync -a --exclude=node_modules --exclude=dist --exclude=.astro --exclude=.git --exclude=deploy --exclude=.trash "$ROOT/source/" "$ROOT/build/"
    chown -R "$APP_USER:$APP_USER" "$ROOT/build"
    printf 'Installing separate production-build dependencies...\n'
    runuser -u "$APP_USER" -- env HOME="$ROOT/editor-home" ASTRO_TELEMETRY_DISABLED=1 bash -c 'cd /opt/rosekhlifa-blog/build && npm ci --no-fund --no-audit'
    touch "$ROOT/build/node_modules/.whono-installed"
fi

install -d -m 0750 -o root -g 101 "$ROOT/admin-secrets"
if [[ ! -s "$ROOT/admin-secrets/server.key" ]]; then
    openssl req -x509 -nodes -newkey rsa:3072 -days 365 \
        -keyout "$ROOT/admin-secrets/server.key" -out "$ROOT/admin-secrets/server.crt" \
        -subj '/CN=51.83.101.143' \
        -addext 'subjectAltName=IP:51.83.101.143,DNS:blog.rosekhlifa.com' 2>/dev/null
fi
if [[ ! -s "$ROOT/admin-secrets/htpasswd" ]]; then
    python3 - "$ROOT/admin-secrets" <<'PY'
from pathlib import Path
import secrets
import subprocess
import sys
root = Path(sys.argv[1])
password = secrets.token_urlsafe(24)
username = 'rosekhlifa'
hashed = subprocess.run(['openssl', 'passwd', '-apr1', '-stdin'], input=password + '\n', text=True, capture_output=True, check=True).stdout.strip()
(root / 'htpasswd').write_text(username + ':' + hashed + '\n')
fingerprint = subprocess.run(['openssl', 'x509', '-in', str(root / 'server.crt'), '-noout', '-fingerprint', '-sha256'], text=True, capture_output=True, check=True).stdout.strip()
(root / 'login.txt').write_text('Online editor: https://51.83.101.143:18181/admin/content/\nUsername: ' + username + '\nPassword: ' + password + '\n\n' + fingerprint + '\n')
(root / 'login.txt').chmod(0o600)
PY
fi
chown root:101 "$ROOT/admin-secrets/server.key" "$ROOT/admin-secrets/htpasswd"
chmod 0640 "$ROOT/admin-secrets/server.key" "$ROOT/admin-secrets/htpasswd"
chmod 0644 "$ROOT/admin-secrets/server.crt"
chmod 0755 "$SCRIPT_DIR/activate-online.sh" "$SCRIPT_DIR/ROLLBACK.sh" "$ROOT/deploy/activate.sh" "$ROOT/deploy/ROLLBACK.sh"
chown root:root "$SCRIPT_DIR/activate-online.sh"
printf '%s\n' 'rosekhlifa-blog ALL=(root) NOPASSWD: /opt/rosekhlifa-blog/deploy/admin/activate-online.sh *' > "$SCRIPT_DIR/publish.sudoers"
chmod 0440 "$SCRIPT_DIR/publish.sudoers"
visudo -cf "$SCRIPT_DIR/publish.sudoers"
install -o root -g root -m 0440 "$SCRIPT_DIR/publish.sudoers" /etc/sudoers.d/rosekhlifa-blog-publish
install -m 0644 "$SCRIPT_DIR/editor.service" /etc/systemd/system/rosekhlifa-blog-editor.service
install -m 0644 "$SCRIPT_DIR/publisher.service" /etc/systemd/system/rosekhlifa-blog-publisher.service
systemctl daemon-reload
systemctl enable --now rosekhlifa-blog-editor.service rosekhlifa-blog-publisher.service
bash "$SCRIPT_DIR/install-session-auth.sh"
docker compose --project-directory "$ROOT" --file "$SCRIPT_DIR/compose.yaml" -p rosekhlifa-blog-admin up -d
touch "$ROOT/.online-authoring"
printf 'ONLINE ADMIN INSTALLED: https://51.83.101.143:18181/admin/content/\n'
printf 'Credentials stored at %s/admin-secrets/login.txt (root only)\n' "$ROOT"
