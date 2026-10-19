#!/usr/bin/env python3
"""Loopback-only, standard-library login gateway for the blog writing console."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import html
import json
import secrets
import threading
import time
from collections import deque
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit


COOKIE_NAME = "rosekhlifa_admin"
SESSION_SECONDS = 43200
MAX_BODY = 8192
ALLOWED_ORIGINS = frozenset((
    "https://blog.rosekhlifa.com",
    "https://51.83.101.143:18181",
))
DEFAULT_NEXT = "/admin/content/"


def b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def b64decode(value: str) -> bytes:
    return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)


def local_next(value: str) -> str:
    """Keep redirects within the console and preview routes, including queries."""
    if not isinstance(value, str) or len(value) > 2048:
        return DEFAULT_NEXT
    decoded = unquote(value)
    if any(ord(char) < 32 or ord(char) == 127 for char in decoded) or "\\" in decoded:
        return DEFAULT_NEXT
    try:
        parts = urlsplit(value)
    except ValueError:
        return DEFAULT_NEXT
    if parts.scheme or parts.netloc or parts.fragment or not value.startswith("/") or value.startswith("//"):
        return DEFAULT_NEXT
    if not (parts.path in ("/admin", "/preview") or parts.path.startswith(("/admin/", "/preview/"))):
        return DEFAULT_NEXT
    if any(segment in (".", "..") for segment in unquote(parts.path).split("/")):
        return DEFAULT_NEXT
    if parts.path.rstrip("/") in ("/admin/login", "/admin/logout"):
        return DEFAULT_NEXT
    return quote(value, safe="/?&=;:+,%@-._~!$'()*[]")


class AuthState:
    def __init__(self, config: dict):
        self.username = config["username"]
        self.salt = bytes.fromhex(config["passwordSalt"])
        self.password_hash = bytes.fromhex(config["passwordHash"])
        self.session_key = bytes.fromhex(config["sessionKey"])
        self.iterations = config["iterations"]
        if (not isinstance(self.username, str) or not self.username or ":" in self.username
                or len(self.salt) < 16 or len(self.password_hash) != 32
                or len(self.session_key) < 32 or not isinstance(self.iterations, int)
                or self.iterations < 240000):
            raise ValueError("Invalid authentication configuration")
        self.failures: dict[str, deque[float]] = {}
        self.lock = threading.Lock()

    def password_valid(self, username: str, password: str) -> bool:
        calculated = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), self.salt, self.iterations)
        return hmac.compare_digest(calculated, self.password_hash) & hmac.compare_digest(
            username.encode("utf-8"), self.username.encode("utf-8"))

    def issue_cookie(self) -> str:
        payload = json.dumps({"username": self.username, "expiry": int(time.time()) + SESSION_SECONDS,
                              "nonce": secrets.token_urlsafe(18)}, separators=(",", ":")).encode("utf-8")
        encoded = b64encode(payload)
        signature = b64encode(hmac.digest(self.session_key, encoded.encode("ascii"), "sha256"))
        return encoded + "." + signature

    def cookie_valid(self, cookie_header: str) -> bool:
        if not cookie_header or len(cookie_header) > 8192:
            return False
        try:
            cookies = SimpleCookie()
            cookies.load(cookie_header)
            token = cookies[COOKIE_NAME].value
            encoded, signature = token.split(".")
            expected = hmac.digest(self.session_key, encoded.encode("ascii"), "sha256")
            if not hmac.compare_digest(b64decode(signature), expected):
                return False
            payload = json.loads(b64decode(encoded))
            expiry = payload["expiry"]
            return (isinstance(expiry, int) and not isinstance(expiry, bool)
                    and time.time() < expiry <= time.time() + SESSION_SECONDS + 60
                    and isinstance(payload.get("nonce"), str) and len(payload["nonce"]) >= 16
                    and isinstance(payload.get("username"), str)
                    and hmac.compare_digest(payload["username"].encode("utf-8"), self.username.encode("utf-8")))
        except (ValueError, KeyError, TypeError, UnicodeError, CookieError):
            return False

    def failure_count(self, client: str) -> int:
        now = time.monotonic()
        with self.lock:
            expired = [ip for ip, events in self.failures.items() if not events or events[-1] <= now - 120]
            for ip in expired:
                del self.failures[ip]
            events = self.failures.get(client)
            if events is None:
                return 0
            while events and events[0] <= now - 120:
                events.popleft()
            return len(events)

    def reserve_attempt(self, client: str) -> int | None:
        """Reserve before PBKDF2 so simultaneous requests cannot bypass the limit."""
        now = time.monotonic()
        with self.lock:
            events = self.failures.setdefault(client, deque())
            while events and events[0] <= now - 120:
                events.popleft()
            if len(events) >= 20:
                return None
            count = len(events)
            events.append(now)
            return count

    def clear_failures(self, client: str) -> None:
        with self.lock:
            self.failures.pop(client, None)


class AuthHandler(BaseHTTPRequestHandler):
    server_version = "BlogAuth"
    sys_version = ""

    @property
    def auth(self) -> AuthState:
        return self.server.auth_state

    @property
    def client(self) -> str:
        # Nginx overwrites this header; this service only accepts loopback traffic.
        return self.headers.get("X-Real-IP", self.client_address[0])[:128]

    def log_message(self, format: str, *args) -> None:
        # Keep URLs, cookies, credentials and form data out of journal logs.
        return

    def send_result(self, status: int, body: bytes = b"", **headers: str) -> None:
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers.items():
            self.send_header(key.replace("_", "-"), value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def login_page(self, next_path: str, error: bool = False, limited: bool = False) -> None:
        message = "登录信息有误，请稍后重试。" if error else "登录后即可写作、编辑和上传图片。"
        body = f'''<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>博客管理登录</title><style>
*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f6f4f0;color:#252525;font:16px/1.6 system-ui,sans-serif}}
main{{width:min(100%,400px);background:white;padding:32px;border:1px solid #e5e1da;border-radius:14px}}h1{{font-size:24px;margin:0 0 8px}}p{{color:#666;margin:0 0 24px;font-size:14px}}
label{{display:block;margin-top:16px;font-size:14px}}input{{display:block;width:100%;padding:11px 12px;margin-top:6px;border:1px solid #ccc;border-radius:6px;font:inherit}}button{{width:100%;margin-top:24px;padding:12px;border:0;border-radius:6px;background:#272727;color:white;font:inherit;cursor:pointer}}a{{color:inherit;font-size:14px}}footer{{margin-top:18px}}
</style><main><h1>博客管理</h1><p role="status">{message}</p>
<form method="post" action="/admin/login/" accept-charset="utf-8">
<input type="hidden" name="next" value="{html.escape(next_path, quote=True)}">
<label>用户名<input name="username" value="{html.escape(self.auth.username, quote=True)}" autocomplete="username" required maxlength="256" autofocus></label>
<label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
<button type="submit">登录</button></form><footer><a href="/">返回博客</a></footer></main></html>'''.encode("utf-8")
        self.send_result(401 if error else 200, body, **({"Retry_After": "120"} if limited else {}))

    def credentials_valid(self, username: str, password: str) -> bool:
        self.auth.failure_count(self.client)
        count = self.auth.reserve_attempt(self.client)
        if count is None:
            return False
        if count:
            time.sleep(min(0.05 * (2 ** min(count - 1, 5)), 1.0))
        if len(username) <= 256 and len(password) <= 1024 and self.auth.password_valid(username, password):
            self.auth.clear_failures(self.client)
            return True
        return False

    def authenticated(self, allow_basic: bool = True) -> bool:
        if self.auth.cookie_valid(self.headers.get("Cookie", "")):
            return True
        authorization = self.headers.get("Authorization", "")
        if allow_basic and authorization.startswith("Basic ") and len(authorization) < 8192:
            try:
                username, password = base64.b64decode(authorization[6:], validate=True).decode("utf-8").split(":", 1)
                return self.credentials_valid(username, password)
            except (ValueError, UnicodeError):
                return False
        return False

    def do_GET(self) -> None:
        parts = urlsplit(self.path)
        if parts.path == "/check":
            self.send_result(204 if self.authenticated() else 401)
        elif parts.path == "/login":
            try:
                next_path = local_next(parse_qs(parts.query, max_num_fields=20).get("next", [DEFAULT_NEXT])[0])
            except ValueError:
                next_path = DEFAULT_NEXT
            if self.authenticated(allow_basic=False):
                self.send_result(303, Location=next_path)
            else:
                self.login_page(next_path)
        elif parts.path == "/logout":
            # Clearing a session requires a same-origin POST.
            self.send_result(303, Location="/admin/login/")
        else:
            self.send_result(404)

    def do_POST(self) -> None:
        if self.headers.get("Origin", "") not in ALLOWED_ORIGINS:
            self.send_result(403)
            return
        if self.headers.get("Transfer-Encoding"):
            self.send_result(400)
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/x-www-form-urlencoded":
            self.send_result(415)
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            self.send_result(400)
            return
        if length < 0:
            self.send_result(411)
            return
        if length > MAX_BODY:
            self.send_result(413)
            return
        parts = urlsplit(self.path)
        if parts.path == "/logout":
            self.send_result(303, Location="/admin/login/", Set_Cookie=f"{COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict")
            return
        if parts.path != "/login":
            self.send_result(404)
            return
        try:
            fields = parse_qs(self.rfile.read(length).decode("utf-8"), keep_blank_values=True, max_num_fields=20)
            username = fields.get("username", [""])[0]
            password = fields.get("password", [""])[0]
            next_path = local_next(fields.get("next", [DEFAULT_NEXT])[0])
        except (ValueError, UnicodeError):
            self.send_result(400)
            return
        if self.credentials_valid(username, password):
            self.send_result(303, Location=next_path,
                             Set_Cookie=f"{COOKIE_NAME}={self.auth.issue_cookie()}; Path=/; Max-Age={SESSION_SECONDS}; Secure; HttpOnly; SameSite=Strict")
        else:
            self.login_page(next_path, error=True, limited=self.auth.failure_count(self.client) >= 20)


class AuthServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(15)
        return connection, address

    def handle_error(self, request, client_address):
        # Invalid requests may be dropped without echoing request details.
        return


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/opt/rosekhlifa-blog/session-auth/credentials.json")
    parser.add_argument("--port", type=int, default=14322)
    args = parser.parse_args()
    with open(args.config, encoding="utf-8") as source:
        state = AuthState(json.load(source))
    server = AuthServer(("127.0.0.1", args.port), AuthHandler)
    server.auth_state = state
    print(f"Blog authentication listening on 127.0.0.1:{server.server_port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
