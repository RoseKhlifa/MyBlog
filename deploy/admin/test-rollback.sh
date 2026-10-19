#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(mktemp -d /tmp/rosekhlifa-online-rollback.XXXXXX)
mkdir -p "$ROOT/source" "$ROOT/releases/original"
printf 'saved article\n' > "$ROOT/source/keep.md"
printf 'public blog\n' > "$ROOT/releases/original/index.html"
ln -s releases/original "$ROOT/current"
touch "$ROOT/.online-authoring"
BEFORE=$(sha256sum "$ROOT/source/keep.md" "$ROOT/current/index.html")
bash "$SCRIPT_DIR/ROLLBACK.sh" --root "$ROOT" --no-service
[[ ! -e "$ROOT/.online-authoring" && -f "$ROOT/.online-authoring.disabled" ]]
[[ "$BEFORE" == "$(sha256sum "$ROOT/source/keep.md" "$ROOT/current/index.html")" ]]
[[ $(readlink "$ROOT/current") == releases/original ]]
printf 'ROLLBACK COPY PASS: online marker disabled; source/current bytes and symlink preserved\n'
printf 'Test copy retained at %s\n' "$ROOT"
