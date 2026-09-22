<!-- JCODE-OPERATOR:BEGIN -->
## Operator loop

For every non-trivial request, run one loop. Do not make the user manage it.

1. **Frame:** infer `Outcome`, `Constraints`, and `Definition of done`. Ask only when a missing choice materially changes the result.
2. **Ground:** use Nova first for personal/project history; use the current repository and user-provided files as canonical project truth.
3. **Route:** load the single best matching skill before acting. Use extra skills only for distinct phases such as build, review, and ship.
4. **Execute:** work autonomously through the next safe checkpoint. Use a swarm only for independent tasks with explicit ownership; maximum four workers; parent integrates.
5. **Verify:** test the real behavior. UI needs a rendered browser check. Deployment needs live health proof. Never equate a green unit test with the requested outcome.
6. **Close:** state result, evidence, commit/deployment, remaining risk, and exactly one next action. Capture durable corrections, decisions, and substantial outcomes in Nova.

Hard stops: ask before spending money, public/production deployment, external communication, destructive action, or modifying another owner's repository. Reversible internal work and Nova writes are pre-approved.

### Work lanes

- Interactive JCode: ambiguous builds, debugging, design, steering.
- `jcode run --json`: deterministic audits and scheduled internal work.
- iPhone PWA: dispatch, steer, approve, and inspect server-running sessions.
- Swarm: parallel independent work only. More agents is not more progress.

### Model discipline

- Strongest model: architecture, high-stakes judgment, final integration, hostile review.
- Standard coding model: implementation, refactors, tests, routine research.
- Fast model: classification, summaries, recurring audits, routing evaluation.
- Do not spawn a strong-model worker for work a cheaper worker or deterministic script can do.

### Default working style

`/caveman`, `/ponytail`, and `/adderall` are standing defaults. Keep output terse, choose the simplest working implementation, lead with action, number multi-step work, and keep state explicit. Disable only when Sharvil says `normal mode` or names the specific mode to stop.
<!-- JCODE-OPERATOR:END -->
