#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
task_tmp="$(mktemp -d)"
trap 'rm -rf "$task_tmp"' EXIT
cat > "$task_tmp/mock-exec.sh" <<'MOCK'
exec() {
  /usr/bin/python3 - "$@" <<'PY'
import json, os, sys
print(json.dumps({'args': sys.argv[1:], 'cache': os.environ.get('MCP_REMOTE_CONFIG_DIR')}))
PY
}
MOCK
BASH_ENV="$task_tmp/mock-exec.sh" bash "$repo_dir/ops/jcode-operator/21st-mcp" > "$task_tmp/result.json"
python3 - "$task_tmp/result.json" <<'PY'
import json, sys
from pathlib import Path
r = json.loads(Path(sys.argv[1]).read_text())
a = r['args']
assert a[0] == str(Path.home() / '.local/bin/mcp-remote')
assert a[1] == 'https://21st.dev/api/mcp'
assert '--header' not in a, 'Rejected CLI key must not shadow OAuth'
assert r['cache'] == str(Path.home() / '.mcp-auth')
metadata = json.loads(a[a.index('--static-oauth-client-metadata') + 1])
assert 'offline_access' in metadata['scope'].split()
assert 'refresh_token' in metadata['grant_types']
print('21st launcher: shared cache, no stale key, refresh grant verified.')
PY
