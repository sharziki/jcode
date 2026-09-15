#!/usr/bin/env bash
#
# Install this checkout's release binary into the shared-server channel and
# reload the running daemon onto it.
#
# Why this exists: `jcode server reload` on its own is a no-op against a repo
# build. The running server decides whether to reload via
# `server_has_newer_binary()`, which only looks at installed channels
# (~/.jcode/builds/shared-server, then stable) and never at a repo
# target/release. Against an older daemon it prints "already running the newest
# binary; no reload needed" and changes nothing.
#
# Usage:  scripts/install_and_reload.sh [--no-build]
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JCODE_HOME_DIR="${JCODE_HOME:-$HOME/.jcode}"
BUILDS="$JCODE_HOME_DIR/builds"
BIN="$REPO_DIR/target/release/jcode"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "==> Building release binary"
  (cd "$REPO_DIR" && cargo build --release --bin jcode)
fi

[[ -x "$BIN" ]] || { echo "error: $BIN not found; run without --no-build" >&2; exit 1; }

VERSION="$(cd "$REPO_DIR" && git rev-parse --short HEAD)"
TARGET_DIR="$BUILDS/versions/$VERSION"

echo "==> Installing $($BIN --version) as version $VERSION"
mkdir -p "$TARGET_DIR" "$BUILDS/shared-server"
# Write to a temp path and move into place: a daemon may be executing the old
# inode, and cp-in-place onto a running binary fails with ETXTBSY.
cp "$BIN" "$TARGET_DIR/jcode.tmp"
mv -f "$TARGET_DIR/jcode.tmp" "$TARGET_DIR/jcode"
ln -sfn "../versions/$VERSION/jcode" "$BUILDS/shared-server/jcode"
echo "$VERSION" > "$BUILDS/shared-server-version"

echo "==> Reloading the daemon (live sessions are handed to the new process)"

# Report what is genuinely live first. `active_pids` keeps a marker per session,
# but markers outlive the process that wrote them, so a raw count overstates how
# much work a reload actually has to carry.
if [[ -d "$JCODE_HOME_DIR/active_pids" ]]; then
  live=0
  for marker in "$JCODE_HOME_DIR"/active_pids/*; do
    [[ -e "$marker" ]] || continue
    pid="$(cat "$marker" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      live=$((live + 1))
      echo "    live: $(basename "$marker")"
    fi
  done
  echo "    $live session(s) genuinely live"
fi

"$BIN" server reload

# Verify against the real gateway rather than trusting the reload message.
PORT="$(awk '/^\[gateway\]/{g=1;next} /^\[/{g=0} g && /^port/{print $3}' \
  "$JCODE_HOME_DIR/config.toml" 2>/dev/null | head -1)"
PORT="${PORT:-7643}"

sleep 3
echo "==> Verifying gateway on port $PORT"
HEALTH="$(curl -s -m5 "http://127.0.0.1:$PORT/health" || true)"
APP="$(curl -s -o /dev/null -w '%{http_code}' -m5 "http://127.0.0.1:$PORT/" || true)"
SESSIONS="$(curl -s -o /dev/null -w '%{http_code}' -m5 "http://127.0.0.1:$PORT/sessions" || true)"

echo "    health:    ${HEALTH:-<no response>}"
echo "    GET /:     $APP   (want 200)"
echo "    /sessions: $SESSIONS   (want 401 without a token)"

if [[ "$APP" == "200" && "$SESSIONS" == "401" ]]; then
  echo
  echo "Web app is live. Next: run 'jcode pair' and open the printed URL."
else
  echo
  echo "error: gateway is not serving the web app." >&2
  echo "Check that [gateway] enabled = true in $JCODE_HOME_DIR/config.toml." >&2
  exit 1
fi
