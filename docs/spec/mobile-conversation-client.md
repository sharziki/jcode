# Mobile conversation client

## Outcome
Jcode's existing gateway becomes a usable, Claude-mobile-informed conversation app on Sharvil's phone. Hermes/relay stays untouched. No fake conversations, model choices, status, or chat actions ship.

## Parameters
| Parameter | Value | Confidence | Evidence |
|---|---|---|---|
| Audience | Paired phone owner remotely using the existing Jcode daemon | verified | User request, successful Tailscale pairing |
| Success | Start chat, choose model, send/stream/stop, revisit/rename/search conversations, live updates, reconnect without losing draft | verified | User asks functional and real time, existing wire protocol |
| Not doing | Hermes changes, deletion of old sessions, public exposure, iOS native build, Claude branding impersonation | verified | Explicit preserve-Hermes request |
| Stack | Existing embedded vanilla HTML/CSS/JS and Rust gateway, no client dependencies | verified | gateway/web.rs, docs/WEB_APP.md |
| Data | Real recent-session SQLite index plus existing NDJSON WebSocket | verified | gateway.rs, recent_session_index.rs, protocol/wire.rs |
| Auth | Existing paired per-origin bearer token, tailnet only, no auth weakening | verified | Current /pair and /sessions guards |
| Deploy | Same laptop gateway :7643 after safe reload, isolated preview first | verified | /health and embedded asset design |
| Design authority | Claude mobile screens via configured Mobbin MCP plus 21st Claude-style composer, adapted to jcode | verified | Authenticated welcome, light/dark drawer and keyboard frames inspected; canonical sources in gateway/DESIGN.md |
| Budget | Existing tools, no purchases, one focused rebuild and QA loop | assumed | User wants implementation now |
| Irreversible decisions | None. Additive schema, branch-scoped code, backup installed binary, no session removal | verified | Plan restrictions |
| Acceptance | Real paired-browser flows at 390x844, 380px, desktop; streaming growth and cancel events; live list refresh; reload reconnect; rust tests; no console errors | verified | Concrete checks below |

## Prior art and constraints
- Existing PWA has working injection-safe markdown and websocket streaming but no new-chat button or model picker, no searchable history, no continuous list refresh, and null titles expose raw animal IDs.
- The recent index intentionally avoids parsing huge session files. Enrichment must preserve bounded reads and prefer data written on persistence. Legacy backfill must not block the async listener or load unbounded transcripts.
- Mobbin is configured at https://api.mobbin.com/mcp in Claude and Codex. Jcode's native HTTP transport discovery skipped that entry. A temporary authenticated stdio bridge accessed the installed MCP and retrieved real Claude iOS frames. No credential or configuration changes were needed.
- 21st.dev search: Claude-style Chat Input by sensewood8, component 9698, and Claude Style AI Input by suraj-xd, component 2540. Borrow the restrained rounded composer and control hierarchy, not React dependencies or fake attachment buttons.
- HTTP on tailnet supports the app but not secure-context service workers. Do not mislabel offline caching as available there.

## Architecture
- Keep server-owned session IDs private to routing/details. Use custom/generated title, then actual first user prompt, then `New conversation` with project/time context. Do not destroy animal IDs.
- Metadata fields: title, preview, model, message count when known, working directory, timestamp, saved, live. Unknown counts/model remain unknown, never fabricated.
- Live token/tool output uses existing WebSocket. Session directory receives visible-only automatic refresh with no manual reload required, and refreshes immediately on focus and actions. Avoid opening extra agent sessions solely to watch the directory.
- New conversations use `subscribe` without target ID and explicit known working directory; existing conversations use target_session_id. Set continue_on_disconnect for mobile sessions. Only send after history/attach acceptance.
- Show drawer history with search and project filter, meaningful title/preview, live marker and grouped recency. Temporary/empty sessions are discoverable via All conversations, never deleted.
- Primary route is a conversation/new-chat welcome with a quiet serif greeting, warm paper palette, system sans controls, unboxed assistant prose, subtle user bubble, bottom rounded composer. Dark mode via system/explicit setting.
- Functional bottom sheets: model picker from server catalog, project/working directory for new chat, settings with appearance and disconnect, conversation rename. No unavailable placeholder buttons.

## Build order
1. Research/authenticate references, inspect protocol, save spec and visual contract.
2. Server enrich index/response and regression tests. Frontend interface and reducer enhancements in parallel with separate file ownership.
3. Isolated same-origin development proxy (not product deployment) serves edited assets over the real gateway. Verify real sessions without disturbing live daemon.
4. Build Rust release, test gateway and index, independent correctness/design critique. Fix findings.
5. Install immutable build and use graceful reload only. Verify :7643 serves byte-identical edited assets and phone origin works. Keep :8797 unchanged.

## Acceptance checks
- Pairing with bad code errors truthfully; real code opens app. 401 clears auth and returns to pairing.
- Open drawer, search title/project, filter, choose session, correct history visible. Animal ID never primary label.
- Start new conversation in known directory, receive real session id and actual available model list, change model and await server confirmation.
- Send real small prompt and observe multiple text deltas, not just final response. Stop a real long generation. Mid-turn follow-up is sendable.
- Draft survives navigation, reconnect, offline send failure and reload per session. UI never silently drops unsent input.
- Drawer reflects external/new/renamed conversations automatically. No fetch overlap or busy polling in hidden tab.
- Conversation remains attached while history drawer is open. Foreground reconnect closes stale socket before creating another, syncs history/processing state.
- At 380px/390px and desktop there is no horizontal page overflow, textarea is >=16px, controls >=44px, keyboard safe-area respected, sheets have labels and focus handling, escape/back work.
- Markdown remains injection-safe. No remote JS/fonts, no token in page URL/log artifacts, API responses not cached by SW.
- Build/test commands and browser evidence captured, then independent design and correctness gates.

## Risks
Legacy snapshots may exceed safe read budget, so some very old untitled sessions can remain `New conversation`. Main observer websocket must not cancel generation when a phone goes background. Native phone keyboard cannot be fully proven by desktop emulation. Mobbin references are research artifacts only, not redistributed application assets.
