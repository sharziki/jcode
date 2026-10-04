# Coordinator efficiency contract

## Constitution

Apply the same efficiency policy to local Jcode, Claude Code, and Codex.
One local Jcode coordinator owns outcomes. Project files and each project's
existing constitution define scope. Workers implement explicit ownership;
the coordinator integrates and verifies. Preserve authorization and rollback.

## Acceptance

- Every project task starts with a targeted Graphify lookup. Missing code
  graphs use local AST extraction; no automatic paid semantic extraction.
- Before implementation, save a short spec with goal, boundaries, acceptance
  checks, and verification. Small fixes need only a few lines in the task record.
- Reuse existing constitutions; create a concise one from known requirements
  only when missing. Do not invent product direction or require routine approval.
- Worker briefs contain relevant constraints and code pointers, not the full
  coordinator transcript. Reuse workers and avoid duplicate implementation.
- User output defaults to blockers, necessary decisions, and verified results.
  Plans and progress live in task records; routine narration stays quiet.
- Hide reasoning and intermediate transcript through existing display settings.
  This changes visibility, not billed reasoning tokens.
- Default to medium effort, preserving requested models and allowing escalation
  for difficult tasks. Limit Jcode to four concurrent workers; do not stop active
  work to reload settings. Keep existing memory relevance checks intact.
- Install one versioned policy as managed sections in the three global instruction
  files. Preserve existing content and hooks, and back up each replaced file.
- Never claim token savings from context size alone. Compare provider input,
  cache reads/writes, output, and cost for comparable completed tasks.

## Verification

Quiet-mode repair: hide assistant narration attached to a tool call or immediately
followed by tool output, retain errors and final replies, and keep the working
indicator. Ctrl+T must still expose the full transcript. Test cached updates too.
Use short plain words in replies; quiet display cannot enforce model phrasing.

Capture a local token baseline without another model call. Validate JSON/TOML
settings and exact policy parity across all three agents. Validate Graphify
extraction and targeted queries, overlay
installation, and the existing focused-output behavior. No daemon restart
while authorized workers are active; existing TUIs pick up display changes
when reopened. New sessions load the installed policy.
