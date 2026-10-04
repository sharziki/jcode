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
- `efficiency-spec.md` defines the graph → constitution → spec → build → verify
  contract. The installed overlay applies it to project work; it is model
  guidance, not a hard tool gate. Graphify uses local code extraction by default.
- `efficiency-policy.md` is the shared source for managed sections in the local
  Jcode overlay, `~/.claude/CLAUDE.md`, and `~/.codex/AGENTS.md`. Keep these sections
  identical. Claude's `effortLevel` is medium; requested model choices stay intact.
  Jcode's `agents.swarm_max_concurrent_agents` is four. Settings are backed up
  before modification; do not restart active workers just to change defaults.
- Quiet display uses the existing settings below in `~/.jcode-local/config.toml`.
  Reopen the TUI to apply display changes; Ctrl+T exposes the full transcript.
  Hiding reasoning does not reduce billed reasoning tokens.
- Quiet mode hides assistant text attached to tool calls or followed by tool
  output, as well as tool output and reasoning. The working indicator, errors,
  and final replies remain visible; Ctrl+T restores the full transcript.
- `quiet-output-style.md` installs as
  `~/.claude/output-styles/quiet-caveman.md`; Claude's global `outputStyle` is
  `Quiet Caveman`, with coding instructions retained. Restart/resume Claude
  after adding the style file. Codex uses `hide_agent_reasoning = true`,
  `show_raw_agent_reasoning = false`, and `model_verbosity = "low"` at the top
  level of its config. These settings do not remove Codex's native tool cards.

```toml
[display]
show_thinking = false
reasoning_display = "off"
focused_output = true
compact_notifications = true
```

JCode owns execution. Nova owns durable context. User-facing sessions coordinate;
spawned workers implement their assigned project scope.

`21st-mcp` is the shared local 21st OAuth launcher, linked from
`~/.local/bin/21st-mcp`. It uses `~/.mcp-auth`, requests offline access and
refresh tokens, and does not send the separate CLI key. A rejected CLI key
previously caused HTTP 401 and repeated browser fallback. A successful browser
consent and live tools listing must be verified before calling auth repaired.

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
