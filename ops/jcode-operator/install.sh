#!/usr/bin/env bash
set -euo pipefail

src=$(cd "$(dirname "$0")" && pwd)
home_dir=${HOME:?}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$home_dir/.local/state/jcode-operator/backups/$stamp"
mkdir -p "$backup" "$home_dir/bin" "$home_dir/.jcode"

for path in "$home_dir/.jcode/prompt-overlay.md" "$home_dir/.jcode/config.toml" "$home_dir/.jcode/swarm-prompt.md" \
  "$home_dir/bin/jcode-event-log" "$home_dir/bin/jcode-outcome-candidates" \
  "$home_dir/bin/jcode-task-receipts" "$home_dir/bin/jcode-tool-policy" "$home_dir/bin/jcode-operator"; do
  [[ -f "$path" ]] && cp -a "$path" "$backup/$(basename "$path")"
done

python3 - "$home_dir/.jcode/prompt-overlay.md" "$src/operator-overlay.md" <<'PY'
from pathlib import Path
import sys

target, source = map(Path, sys.argv[1:])
overlay = source.read_text(encoding="utf-8")
text = target.read_text(encoding="utf-8") if target.exists() else ""
begin = "<!-- JCODE-OPERATOR:BEGIN -->"
end = "<!-- JCODE-OPERATOR:END -->"
if begin in text and end in text:
    left, rest = text.split(begin, 1)
    _, right = rest.split(end, 1)
    text = left.rstrip() + "\n\n" + overlay.strip() + "\n" + right.lstrip()
else:
    text = overlay.strip() + "\n\n" + text.lstrip()
target.write_text(text, encoding="utf-8")
PY

install -m 0755 "$src/jcode-event-log" "$home_dir/bin/jcode-event-log"
install -m 0755 "$src/jcode-outcome-candidates" "$home_dir/bin/jcode-outcome-candidates"
install -m 0755 "$src/jcode-task-receipts" "$home_dir/bin/jcode-task-receipts"
install -m 0755 "$src/jcode-tool-policy" "$home_dir/bin/jcode-tool-policy"
install -m 0755 "$src/jcode-operator" "$home_dir/bin/jcode-operator"
install -m 0644 "$src/swarm-prompt.md" "$home_dir/.jcode/swarm-prompt.md"
python3 "$src/patch-config.py"

echo "installed; backup=$backup"
