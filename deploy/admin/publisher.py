#!/usr/bin/env python3
"""Publish a stable Content Console source tree without sharing Vite's build cache.

Only the fixed, root-owned activate-online.sh needs sudo.  All watching, copying,
building, snapshots and status updates run as the rosekhlifa-blog account.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Sequence
import uuid


WATCHED = ("src/content", "src/data/settings", "src/assets", "public",
           "site.config.mjs", "astro.config.mjs", "package.json", "package-lock.json")
IGNORED_DIRS = {"node_modules", "dist", ".astro", ".git", "deploy", ".trash",
                ".cache", "__pycache__", ".ssh", ".aws", ".gnupg", ".docker"}
SECRET_FILES = {"credentials", "credentials.json", "id_rsa", "id_ed25519",
                ".npmrc", ".netrc", ".htpasswd", ".git-credentials", ".dockercfg"}
SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".crt", ".cer")
MAX_LOG_BYTES = 256 * 1024


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def ignored(path: Path) -> bool:
    name = path.name.lower()
    return (name in IGNORED_DIRS or name.startswith(".env") or
            name in SECRET_FILES or
            name.endswith((".tmp", ".bak", ".swp", ".swo", "~") + SECRET_SUFFIXES))


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def walk_files(directory: Path):
    """Yield only regular, non-secret files; never follow source symlinks."""
    for parent, directories, names in os.walk(directory, followlinks=False):
        parent_path = Path(parent)
        directories[:] = sorted(name for name in directories
                                if not ignored(Path(name)) and not (parent_path / name).is_symlink())
        for name in sorted(names):
            path = parent_path / name
            if not ignored(path) and not path.is_symlink() and path.is_file():
                yield path


def fingerprint(source: Path) -> str:
    digest = hashlib.sha256()
    for name in WATCHED:
        target = source / name
        digest.update(name.encode("utf-8") + b"\0")
        if not target.exists() or target.is_symlink():
            digest.update(b"missing\0")
            continue
        files = walk_files(target) if target.is_dir() else (target,)
        for path in files:
            relative = path.relative_to(source).as_posix().encode("utf-8")
            digest.update(relative + b"\0")
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(128 * 1024), b""):
                    digest.update(chunk)
            digest.update(b"\0")
    return digest.hexdigest()


class PublishError(RuntimeError):
    pass


class ChangedDuringBuild(PublishError):
    pass


@dataclass
class Config:
    root: Path = Path("/opt/rosekhlifa-blog")
    npm: Sequence[str] = ("/usr/bin/npm",)
    rsync: Sequence[str] = ("/usr/bin/rsync",)
    sudo: Sequence[str] = ("/usr/bin/sudo", "-n")
    activate: Path | None = None
    debounce: float = 4.0
    poll: float = 1.0
    timeout: float = 180.0
    retry: float = 30.0
    keep_backups: int = 8
    environment: dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        self.root = Path(self.root).resolve()
        self.activate = self.activate or self.root / "deploy/admin/activate-online.sh"


class Publisher:
    def __init__(self, config: Config):
        self.config = config
        self.source = config.root / "source"
        self.build = config.root / "build"
        self.state_dir = config.root / "publish-state"
        self.backups = config.root / "source-backups"
        self.incoming = config.root / "online-incoming"
        for directory in (self.source, self.build, self.state_dir, self.backups, self.incoming):
            if directory.is_symlink():
                raise PublishError(f"Publisher directory must not be a symlink: {directory}")
            directory.mkdir(parents=True, exist_ok=True)
        self.stop = threading.Event()
        self.observed: str | None = None
        self.stable_since = 0.0
        self.retry_at = 0.0
        self.last_fingerprint: str | None = None
        self.last_published_at: str | None = None
        self.release_id: str | None = None
        self.state: str | None = None
        self.latest = b""
        self.log = logging.getLogger(f"publisher.{id(self)}")
        self.log.setLevel(logging.INFO)
        self.log.propagate = False
        handler = RotatingFileHandler(self.state_dir / "publisher.log", maxBytes=1024 * 1024,
                                      backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        self.log.addHandler(handler)
        try:
            saved = json.loads((self.state_dir / "last-published.json").read_text(encoding="utf-8"))
            if re.fullmatch(r"[a-f0-9]{64}", saved.get("fingerprint", "")):
                self.last_fingerprint = saved["fingerprint"]
                self.last_published_at = saved.get("lastPublishedAt")
                self.release_id = saved.get("releaseId")
        except (OSError, ValueError, TypeError):
            pass
        self.set_status("idle", "Online publisher is watching saved content.")

    def close(self) -> None:
        for handler in list(self.log.handlers):
            handler.close()
            self.log.removeHandler(handler)

    def set_status(self, state: str, message: str, error: str | None = None) -> None:
        payload = {"state": state, "status": state, "message": message,
                   "updatedAt": utc_now(), "lastPublishedAt": self.last_published_at,
                   "releaseId": self.release_id}
        if error is not None:
            payload["error"] = error[-4000:]
        atomic_json(self.state_dir / "status.json", payload)
        self.state = state
        self.log.info("%s: %s%s", state, message, (" " + error[-4000:]) if error else "")

    def latest_output(self, value: bytes) -> None:
        self.latest = (self.latest + value)[-MAX_LOG_BYTES:]
        temporary = self.state_dir / "latest.log.tmp"
        temporary.write_bytes(self.latest)
        os.chmod(temporary, 0o644)
        os.replace(temporary, self.state_dir / "latest.log")

    def run_command(self, command: Sequence[str], label: str, timeout: float | None = None) -> None:
        self.latest_output(f"\n[{utc_now()}] {label}\n".encode())
        environment = os.environ.copy()
        environment.update(self.config.environment)
        environment.update({"NODE_ENV": "production", "SITE_URL": "https://blog.rosekhlifa.com",
                            "ASTRO_WHONO_BASE_PATH": "/"})
        kwargs = {"start_new_session": True} if os.name != "nt" else {}
        process = subprocess.Popen(list(command), cwd=self.build, env=environment,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
        output = bytearray()
        reader_errors: list[Exception] = []

        def read_output():
            try:
                assert process.stdout is not None
                while True:
                    chunk = process.stdout.read1(4096)
                    if not chunk:
                        break
                    output.extend(chunk)
                    if len(output) > MAX_LOG_BYTES:
                        del output[:-MAX_LOG_BYTES]
                    self.latest_output(chunk)
            except Exception as error:
                reader_errors.append(error)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()
        deadline = time.monotonic() + (timeout or self.config.timeout)
        failure = None
        try:
            while process.poll() is None:
                if self.stop.wait(0.1):
                    failure = f"{label} interrupted because publisher is stopping."
                    break
                if time.monotonic() >= deadline:
                    failure = f"{label} exceeded {timeout or self.config.timeout:g} seconds."
                    break
            if failure is not None and process.poll() is None:
                if os.name == "nt":
                    process.kill()
                else:
                    os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
            reader.join(timeout=10)
        finally:
            if process.stdout is not None:
                process.stdout.close()
        result = bytes(output).decode("utf-8", errors="replace")
        self.log.info("%s exit=%s\n%s", label, process.returncode, result[-MAX_LOG_BYTES:])
        if failure or process.returncode or reader_errors:
            reason = failure or f"{label} exited with status {process.returncode}."
            if reader_errors:
                reason += f" Output capture failed: {reader_errors[0]}"
            raise PublishError(reason + ("\n" + result[-4000:] if result else ""))

    def copy_source(self) -> None:
        excludes = ["--exclude=" + name + "/" for name in sorted(IGNORED_DIRS)]
        excludes += ["--exclude=" + pattern for pattern in
                     (".env*", "*.tmp", "*.bak", "*.swp", "*.swo", "*~",
                      "*.pem", "*.key", "*.p12", "*.pfx", "*.crt", "*.cer")]
        excludes += ["--exclude=" + name for name in sorted(SECRET_FILES)]
        command = [*self.config.rsync, "--recursive", "--times", "--perms", "--delete",
                   "--no-links", "--safe-links", *excludes, str(self.source) + "/", str(self.build) + "/"]
        self.run_command(command, "Copy saved source into independent build directory")
        for name in ("dist", ".astro"):
            target = self.build / name
            if target.is_symlink():
                target.unlink()
            elif target.exists():
                shutil.rmtree(target)

    def make_archive(self, directory: Path, archive: Path, snapshot: bool = False) -> None:
        temporary = archive.with_suffix(archive.suffix + ".tmp")
        try:
            with tarfile.open(temporary, "w:gz", dereference=False) as output:
                for parent, directories, names in os.walk(directory, followlinks=False):
                    parent_path = Path(parent)
                    directories[:] = sorted(name for name in directories
                                            if not (parent_path / name).is_symlink() and
                                            (not snapshot or not ignored(Path(name))))
                    for name in sorted(names):
                        path = parent_path / name
                        if snapshot and ignored(path):
                            continue
                        if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
                            raise PublishError(f"Archive contains a non-regular file: {path}")
                        output.add(path, arcname=path.relative_to(directory).as_posix(), recursive=False)
            os.chmod(temporary, 0o644)
            os.replace(temporary, archive)
        finally:
            temporary.unlink(missing_ok=True)

    def prune(self, directory: Path, prefix: str, keep: int) -> None:
        archives = sorted((path for path in directory.glob(prefix + "*.tar.gz")
                           if path.is_file() and not path.is_symlink()),
                          key=lambda path: path.stat().st_mtime, reverse=True)
        for path in archives[keep:]:
            path.unlink(missing_ok=True)

    def publish(self, expected: str) -> None:
        self.latest = b""
        self.latest_output(f"[{utc_now()}] Publish source fingerprint {expected}\n".encode())
        self.set_status("building", "Building saved articles and checking the production output.")
        self.copy_source()
        if fingerprint(self.source) != expected or fingerprint(self.build) != expected:
            raise ChangedDuringBuild("Saved content changed while copying; waiting for the latest version.")
        release = "online-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12]
        self.make_archive(self.build, self.backups / (release + ".tar.gz"), snapshot=True)
        self.prune(self.backups, "online-", self.config.keep_backups)
        self.run_command([*self.config.npm, "run", "build"], "Build static blog")
        self.run_command([*self.config.npm, "run", "check:prod-artifacts"], "Check production artifacts")
        if fingerprint(self.source) != expected:
            raise ChangedDuringBuild("Saved content changed while building; queuing the latest version.")
        index = self.build / "dist/index.html"
        if not index.is_file() or index.is_symlink() or index.stat().st_size == 0:
            raise PublishError("Build did not create a nonempty regular dist/index.html.")
        archive = self.incoming / (release + ".tar.gz")
        self.make_archive(self.build / "dist", archive)
        digest = hashlib.sha256()
        with archive.open("rb") as stream:
            for chunk in iter(lambda: stream.read(128 * 1024), b""):
                digest.update(chunk)
        if fingerprint(self.source) != expected:
            archive.unlink(missing_ok=True)
            raise ChangedDuringBuild("Saved content changed while packaging; queuing the latest version.")
        self.set_status("publishing", "Activating the checked release and waiting for its health check.")
        self.run_command([*self.config.sudo, str(self.config.activate), release, digest.hexdigest()],
                         "Activate checked release", timeout=180)
        self.last_fingerprint = expected
        self.last_published_at = utc_now()
        self.release_id = release
        atomic_json(self.state_dir / "last-published.json", {
            "fingerprint": expected, "lastPublishedAt": self.last_published_at, "releaseId": release})
        self.prune(self.incoming, "online-", self.config.keep_backups)
        self.set_status("published", "Saved articles are live. The production health check passed.")

    def tick(self) -> None:
        now = time.monotonic()
        current = fingerprint(self.source)
        if current != self.observed:
            self.observed = current
            self.stable_since = now
            self.retry_at = 0.0
            if current != self.last_fingerprint:
                self.set_status("queued", "Saved changes detected; waiting for writing to finish.")
            elif self.last_published_at:
                self.set_status("published", "Saved content matches the last successfully published version.")
            else:
                self.set_status("idle", "Saved content matches the last successfully published version.")
        if (current == self.last_fingerprint or now - self.stable_since < self.config.debounce
                or now < self.retry_at or self.stop.is_set()):
            return
        try:
            self.publish(current)
        except ChangedDuringBuild as error:
            self.observed = None
            self.set_status("queued", str(error))
        except Exception as error:
            self.retry_at = time.monotonic() + self.config.retry
            self.set_status("error", "Publishing failed. The previous live release remains active; retrying shortly.",
                            str(error))
            self.log.exception("Publish attempt failed")

    def run(self) -> None:
        while not self.stop.is_set():
            try:
                self.tick()
            except Exception as error:
                self.log.exception("Watcher iteration failed")
                try:
                    self.set_status("error", "Content watch failed; the watcher will retry.", str(error))
                except OSError:
                    self.log.exception("Could not update publisher status")
            self.stop.wait(self.config.poll)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(os.environ.get("PUBLISHER_ROOT", "/opt/rosekhlifa-blog")))
    parser.add_argument("--npm", default=os.environ.get("PUBLISHER_NPM", "/usr/bin/npm"))
    parser.add_argument("--rsync", default=os.environ.get("PUBLISHER_RSYNC", "/usr/bin/rsync"))
    parser.add_argument("--sudo", default=os.environ.get("PUBLISHER_SUDO", "/usr/bin/sudo"))
    parser.add_argument("--debounce", type=float, default=float(os.environ.get("PUBLISHER_DEBOUNCE", "4")))
    parser.add_argument("--poll", type=float, default=float(os.environ.get("PUBLISHER_POLL", "1")))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("PUBLISHER_TIMEOUT", "180")))
    parser.add_argument("--retry", type=float, default=float(os.environ.get("PUBLISHER_RETRY", "30")))
    arguments = parser.parse_args()
    if min(arguments.debounce, arguments.poll, arguments.timeout, arguments.retry) <= 0:
        parser.error("Timing arguments must be positive.")
    publisher = Publisher(Config(root=arguments.root, npm=(arguments.npm,), rsync=(arguments.rsync,),
                                 sudo=(arguments.sudo, "-n"), debounce=arguments.debounce,
                                 poll=arguments.poll, timeout=arguments.timeout, retry=arguments.retry))
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda _signum, _frame: publisher.stop.set())
    try:
        publisher.run()
    finally:
        publisher.close()


if __name__ == "__main__":
    main()
