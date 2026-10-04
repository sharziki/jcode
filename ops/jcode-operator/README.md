# JCode Operator

Thin operating layer for Sharvil's canonical JCode server.

## Runtime

- `jcode` opens the existing persistent coordinator locally, using Claude Opus
  5.5 at medium effort. It resumes the same thread and project workers.
- `scripts/jcode-local-launcher.sh` is the sole launcher implementation. Fish
  and bash use the same PATH entry. Remote work requires an explicit `--ssh`.
- Local state, credentials, sessions, and builds live in `~/.jcode-local`.
  Older mirrored data in `~/.jcode` stays archived and recoverable.
- `jcode-gateway.service` supervises the local daemon independently of the TUI.
  Closing the terminal leaves its headless workers running.
- `coordinator-overlay.md` defines routing, worker ownership, continuation,
  checkpoints, model selection, and verification. Install it as the local
  state's `prompt-overlay.md`.

JCode owns execution. Nova owns durable context. User-facing sessions coordinate;
spawned workers implement their assigned project scope.

The server installation below documents the previous explicit remote operator
setup. It is not the default local `jcode` launcher.

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
