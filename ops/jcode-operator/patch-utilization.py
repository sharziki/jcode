#!/usr/bin/env python3
"""One-time migration for honest event windows and MCP name normalization."""

from pathlib import Path


path = Path("/root/bin/jcode-utilization")
text = path.read_text()
replacements = {
    '        srv = name.split("__")[1]\n':
        '        srv = name.split("__")[1].replace("-", "_")\n',
    '        if ts and ts < CUTOFF:\n            continue\n'
    '        ev = e.get("event") or e.get("hook_event") or "?"\n':
        '        # Legacy hook rows had no timestamp, so no honest date window can place them.\n'
        '        if ts is None or ts < CUTOFF:\n            continue\n'
        '        ev = e.get("event") or e.get("hook_event") or "?"\n',
    '    configured = set((mcpcfg.get("mcpServers") or mcpcfg).keys())\n':
        '    configured = {n.replace("-", "_") for n in '
        '(mcpcfg.get("mcpServers") or mcpcfg).keys()}\n',
}

for old, new in replacements.items():
    if new in text:
        continue
    if old not in text:
        raise SystemExit(f"missing patch target: {old!r}")
    text = text.replace(old, new, 1)

path.write_text(text)
