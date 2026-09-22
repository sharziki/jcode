# JCode Operator

Thin operating layer for Sharvil's canonical JCode server.

## Runtime

- Interactive default: `jcode` → server through native SSH transport.
- Routine model: `jcode-fast` / `jcode-fast run ...` → `gpt-5.6-sol` on server.
- Deep model: `jcode-deep` / `jcode-deep run ...` → `claude-opus-5` on server.
- Local escape hatch: `jcode-here` → isolated laptop state.
- Operations: `jcode-operator status|doctor|daily|weekly` → canonical server.

JCode stays execution runtime. Nova stays durable context/outcome store. SXOS
stays priority/autonomy control loop. No additional daemon is introduced.

## Installed server pieces

- `operator-overlay.md`: frame → ground → route → execute → verify → close.
- `swarm-prompt.md`: four-worker cap and explicit ownership.
- `jcode-event-log`: timestamped bounded lifecycle events.
- `jcode-task-receipts`: one deterministic receipt per root task family using
  native todo/goal evidence, tool outcomes, skill calls, models, and workers.
- `jcode-outcome-candidates`: bounded recent closeouts annotated with receipt status.
- `jcode-operator`: health audit plus verified Nova outcome ledger.
- Daily and weekly systemd timers.

Server state is backed up before overlay, config, or hook replacement. Root
service migration remains separate because live workspaces and credentials are
root-owned; changing identity without migrating them would break existing
sessions.

New sessions default to OpenAI `gpt-5.6-sol`. Use `jcode-deep` for architecture,
high-stakes judgment, hostile review, or final integration that warrants Opus.

Install or update on the canonical server from this directory with `./install.sh`.
It creates a timestamped backup before replacing managed files.
