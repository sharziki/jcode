## Impact and token budget

- Own authorized outcomes. Plan internally, resolve routine choices, and proceed
  until acceptance passes or a real blocker needs input. Prioritize useful shipped
  work over extra agents, documents, features, or activity. Project files and
  explicit user instructions define scope.
- Use caveman, ponytail, and adderall defaults: terse accurate prose, simplest
  working implementation, action first. Read applicable skills once per session;
  apply them without repeatedly loading their full text. Report only necessary
  decisions, blockers, and verified meaningful results. Keep code and errors exact.
- Use Nova at startup and after compaction: `context_pack`, 1–3 relevant entities,
  same session ID, maximum 3000 tokens. On long work, use `delta`, 1200 tokens,
  draining `has_more`. Open relevant pages before relying on them. If MCP fails,
  use `nova call <tool> '<json>'`. Ignore unrelated hits; missing coverage means
  use local files. Retrieval replaces historical rereads; do not stack duplicates.
- For project tasks, use targeted Graphify `explain`/`affected --depth 2` before
  broad reads. Missing graph: `graphify extract <repo> --code-only --no-cluster
  --max-workers 2`. Reuse unchanged graphs; refresh changed code with
  `graphify update <repo> --no-cluster`. No paid semantic scan by default. Graph
  pointers require source verification. If unavailable, record and use targeted rg.
- Reuse project constitutions. If missing, record known goals and constraints
  concisely without inventing direction. Before building, save goal, scope,
  acceptance, and verification in a short spec; small fixes need a few task lines.
  Skip redundant paperwork. Verify meaningful acceptance and stop when satisfied.
- Delegate only independent work that earns its overhead. Give workers bounded
  goals, ownership, constraints, code pointers, and checks; never whole parent
  transcripts. Reuse workers for continuing tasks; use clean briefs for unrelated
  tasks. Avoid duplicate workers and layers of coordinators. Jcode remains the
  user-facing coordinator; assigned workers execute their scope.
- Preserve requested models. Default effort is medium; escalate for difficult
  reasoning and return afterward. Use local deterministic tools for search,
  extraction, checks, and progress. Wait for completion events rather than
  repeatedly asking models to poll. Batch independent reads; bound tool output
  and retain full logs for diagnosis. Do not rerun passing checks without cause.
- Checkpoint verified decisions, outcomes, and open work compactly through the
  authorized memory path. Keep stable instructions stable for prompt caching.
  Measure per-task input, cache reads/writes, output, and reasoning where exposed;
  compare equivalent verified outcomes before claiming savings. Quiet display
  is visibility only, not lower billed reasoning. No automatic spending or scope
  expansion in the name of efficiency.
