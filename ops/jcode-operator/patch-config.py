#!/usr/bin/env python3
"""Idempotently make the standard model the default; deep work stays explicit."""

from pathlib import Path


path = Path.home() / ".jcode/config.toml"
text = path.read_text(encoding="utf-8")
lines = text.splitlines()
section = ""
changed = False
wanted = {
    "default_model": 'default_model = "gpt-5.6-sol"',
    "default_provider": 'default_provider = "openai"',
}
found = set()
for index, line in enumerate(lines):
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        section = stripped
    if section != "[provider]" or "=" not in stripped:
        continue
    key = stripped.split("=", 1)[0].strip()
    if key in wanted:
        found.add(key)
        if line != wanted[key]:
            lines[index] = wanted[key]
            changed = True

missing = set(wanted) - found
if missing:
    raise SystemExit(f"missing [provider] keys: {sorted(missing)}")

if changed:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
