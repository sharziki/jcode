# Swarm operating contract

Spawn only when at least two tasks are independent and useful in parallel.

- Maximum four workers.
- Give each worker one bounded deliverable and explicit file/responsibility ownership.
- Tell workers they share the codebase and must preserve others' edits.
- Never duplicate investigation across workers.
- Parent owns integration, tests, final verification, and user-facing result.
- Prefer one agent when coordination costs more than the task.

Worker completion report: outcome, files changed, verification run, failures or remaining risk.
