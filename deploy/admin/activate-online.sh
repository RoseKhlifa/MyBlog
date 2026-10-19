#!/bin/bash
# This root-owned, non-writable wrapper is the only sudoers entry for the publisher.
set -Eeuo pipefail
umask 022
if (($# != 2)); then
    printf 'Usage: activate-online.sh ONLINE_RELEASE_ID SHA256\n' >&2
    exit 2
fi
if [[ ! "$1" =~ ^online-[A-Za-z0-9._-]+$ || ${#1} -gt 128 ]]; then
    printf 'ERROR: Invalid online release ID.\n' >&2
    exit 2
fi
if [[ ! "$2" =~ ^[a-f0-9]{64}$ ]]; then
    printf 'ERROR: SHA256 must be 64 lowercase hexadecimal characters.\n' >&2
    exit 2
fi
/usr/bin/python3 - "$1" "$2" <<'PY'
import hashlib
import os
from pathlib import Path
import stat
import sys

ROOT = Path("/opt/rosekhlifa-blog")
release_id, expected = sys.argv[1:]
source = ROOT / "online-incoming" / (release_id + ".tar.gz")
incoming = ROOT / "incoming"
target = incoming / (release_id + ".tar.gz")
created = False

def digest_file(descriptor):
    digest = hashlib.sha256()
    while True:
        chunk = os.read(descriptor, 128 * 1024)
        if not chunk:
            return digest.hexdigest()
        digest.update(chunk)

try:
    directory_status = incoming.lstat()
    if (not stat.S_ISDIR(directory_status.st_mode) or directory_status.st_uid != 0 or
            stat.S_IMODE(directory_status.st_mode) & 0o022):
        raise ValueError("Root incoming directory must be root-owned and not writable by other accounts.")
    # O_NONBLOCK avoids blocking on a FIFO before its file type can be checked.
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        source_status = os.fstat(source_fd)
        if not stat.S_ISREG(source_status.st_mode):
            raise ValueError("Online archive must be a regular file, without symlinks.")
        try:
            target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            created = True
        except FileExistsError:
            target_fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                target_status = os.fstat(target_fd)
                if (not stat.S_ISREG(target_status.st_mode) or target_status.st_uid != 0 or
                        stat.S_IMODE(target_status.st_mode) & 0o022):
                    raise ValueError("Existing root archive must be a root-owned regular file without other writers.")
                if digest_file(target_fd) != expected:
                    raise ValueError("Existing root archive SHA256 does not match; refusing to replace it.")
            finally:
                os.close(target_fd)
        else:
            digest = hashlib.sha256()
            remaining = source_status.st_size
            try:
                while remaining:
                    chunk = os.read(source_fd, min(128 * 1024, remaining))
                    if not chunk:
                        raise ValueError("Online archive changed or was truncated while copying.")
                    remaining -= len(chunk)
                    digest.update(chunk)
                    view = memoryview(chunk)
                    while view:
                        written = os.write(target_fd, view)
                        if not written:
                            raise OSError("Root archive copy made no progress.")
                        view = view[written:]
                os.fsync(target_fd)
                if digest.hexdigest() != expected:
                    raise ValueError("Online archive SHA256 mismatch; copied archive was removed.")
                os.fchmod(target_fd, 0o644)
            finally:
                os.close(target_fd)
    finally:
        os.close(source_fd)
except Exception as error:
    if created:
        target.unlink(missing_ok=True)
    print("ERROR: " + str(error), file=sys.stderr)
    sys.exit(1)
print("Staged verified root-owned archive: " + release_id)
PY
exec /bin/bash /opt/rosekhlifa-blog/deploy/activate.sh "$1" "$2"
