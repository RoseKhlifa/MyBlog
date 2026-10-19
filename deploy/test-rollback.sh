#!/usr/bin/env bash
# Exercise the real rollback script on independent release copies, without Docker.
set -Eeuo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(mktemp -d /tmp/rosekhlifa-blog-rollback.XXXXXX)
mkdir -p "$ROOT/releases/baseline" "$ROOT/releases/modified"
cp "$SCRIPT_DIR/evidence/site.original.env" "$ROOT/releases/baseline/site.env"
cp "$SCRIPT_DIR/site.env" "$ROOT/releases/modified/site.env"
printf '<html><body>baseline</body></html>\n' > "$ROOT/releases/baseline/index.html"
printf '<html><body>modified</body></html>\n' > "$ROOT/releases/modified/index.html"
ln -s releases/modified "$ROOT/current"
ln -s releases/baseline "$ROOT/previous"
BASELINE_HASH=$(sha256sum "$ROOT/releases/baseline/site.env")
BASELINE_HASH=${BASELINE_HASH%% *}
MODIFIED_HASH=$(sha256sum "$SCRIPT_DIR/site.env")
MODIFIED_HASH=${MODIFIED_HASH%% *}
bash "$SCRIPT_DIR/ROLLBACK.sh" --root "$ROOT" --no-service
RESTORED_HASH=$(sha256sum "$ROOT/current/site.env")
RESTORED_HASH=${RESTORED_HASH%% *}
[[ "$BASELINE_HASH" == "$RESTORED_HASH" ]]
[[ $(readlink "$ROOT/current") == releases/baseline ]]
[[ $(readlink "$ROOT/previous") == releases/modified ]]
[[ $(cat "$ROOT/current/index.html") == '<html><body>baseline</body></html>' ]]
[[ $(sha256sum "$SCRIPT_DIR/site.env") == "$MODIFIED_HASH  $SCRIPT_DIR/site.env" ]]
node "$SCRIPT_DIR/check-site.mjs" "$ROOT/current/site.env" "$SCRIPT_DIR/evidence/site.config.original.mjs"
printf 'ROLLBACK PASS: original SITE_URL= restored; sha256=%s; production SITE_URL=https://blog.rosekhlifa.com unchanged\n' "$RESTORED_HASH"
printf 'ROLLBACK COPY: current=releases/baseline previous=releases/modified; original baseline index.html restored; service=skipped\n'
printf 'Test copy retained at %s\n' "$ROOT"
