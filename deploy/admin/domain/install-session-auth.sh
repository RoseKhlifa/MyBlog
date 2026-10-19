#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/opt/rosekhlifa-blog
[[ $(id -u) == 0 ]] || exit 2
if ! id rosekhlifa-blog-auth >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin rosekhlifa-blog-auth
fi
install -d -o root -g rosekhlifa-blog-auth -m 0750 "$ROOT/session-auth"
python3 - <<'PY'
import hashlib
import json
from pathlib import Path
import re
import secrets

root = Path('/opt/rosekhlifa-blog')
target = root / 'session-auth/credentials.json'
if not target.exists():
    login = (root / 'admin-secrets/login.txt').read_text()
    username = re.search(r'^Username: (.+)$', login, re.M)[1].strip()
    password = re.search(r'^Password: (.+)$', login, re.M)[1].strip()
    salt = secrets.token_bytes(24)
    config = {'username': username, 'passwordSalt': salt.hex(), 'passwordHash': hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 240000).hex(), 'sessionKey': secrets.token_hex(32), 'iterations': 240000}
    target.write_text(json.dumps(config) + '\n')
PY
chown root:rosekhlifa-blog-auth "$ROOT/session-auth/credentials.json"
chmod 0640 "$ROOT/session-auth/credentials.json"
install -m 0644 "$ROOT/deploy/admin/session-auth.service" /etc/systemd/system/rosekhlifa-blog-auth.service
systemctl daemon-reload
systemctl enable --now rosekhlifa-blog-auth.service
docker compose --project-directory "$ROOT" --file "$ROOT/deploy/admin/compose.yaml" -p rosekhlifa-blog-admin up -d --force-recreate admin
docker exec rosekhlifa-blog-admin nginx -t
printf 'SESSION LOGIN PASS: https://blog.rosekhlifa.com/admin/login/; existing account retained\n'
