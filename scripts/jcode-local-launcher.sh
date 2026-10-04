#!/usr/bin/env bash
# One local entrypoint. Explicit --ssh remains available in Jcode itself.
set -euo pipefail
export JCODE_HOME="${JCODE_HOME:-$HOME/.jcode-local}"
if [[ $# -eq 0 ]]; then
  set -- --resume session_t-rex_1791077425325_df475c475c9ace0e --no-update
fi
exec "$JCODE_HOME/builds/current/jcode" "$@"
