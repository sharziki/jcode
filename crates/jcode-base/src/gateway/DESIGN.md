# Mobile web design contract

## Authority and sources
Claude's iOS app, inspected directly through authenticated Mobbin MCP on 2026-09-16. This is a Jcode client, not an Anthropic app. Keep Jcode's name and code-bracket identity; do not copy the Claude wordmark or sunburst.
- Welcome/composer: https://mobbin.com/screens/3ecbf36f-0aea-4f7c-846b-703ce03bd2ab
- Light navigation: https://mobbin.com/screens/9a78871e-afe7-4464-b320-a395202a739a
- Dark navigation: https://mobbin.com/screens/9059f305-c9bb-44b9-b0fe-efe19e50a428
- Keyboard: https://mobbin.com/screens/0c723473-1bab-4bba-8786-10abe4b1d5a2
- Supplementary component prior art: 21st.dev Claude-style Chat Input (sensewood8, 9698).
Reference images are research-only scratch artifacts, not redistributable application assets.

## Composition
A conversation app, never a dashboard. A warm almost-white full-height canvas. Floating circular controls in a quiet top bar. The empty view has a small terracotta bracket mark and a modest serif greeting, vertically centered with abundant whitespace. No tiles, feature cards, fake usage stats, starter-prompt gallery, gradient blobs, or upgrade banner.

The composer is a bottom-inset, softly outlined surface with a 26px radius, 16px textarea, a second row containing a project button, compact real model picker pill, and round send/stop actions. Safe-area padding survives standalone iOS. Focus and selection are legible. No microphone or attachment icon unless the actual flow is implemented.

Assistant output is readable unboxed serif prose. User messages are subtle warm rounded bubbles aligned right. Tools/thinking are collapsed disclosures with live status, not a wall of JSON. Code is monospaced with horizontal inner scrolling, never page overflow. Copy actions are quiet and functional.

History is a left drawer, roughly 86% of a phone width (max 360px), with a Jcode serif wordmark, search, project filter, muted recency headings, and plain clickable text rows. Selected rows get a subtle filled background. Live dots do not imply processing. A black New chat pill is anchored near the drawer's bottom. Unpair is in settings, not the primary navigation.

## Tokens
- Light: canvas #faf9f6, drawer #f3f2ee, surface #ffffff, user bubble #eeeae3, text #282722, muted #73716b, rule #e7e4dd, accent #b86646, accent hover #a75335.
- Dark: canvas #1f1e1b, drawer #191917, surface #292824, user bubble #34322d, text #ebe8e1, muted #aaa69d, rule #3e3b35, accent #d58c6e.
- System sans for controls/history; Georgia/Charter/Iowan Old Style for welcome and assistant. No remote fonts.
- Text sizes: greeting 30px, header 18px, message 17px/1.65, controls 14px, metadata 12px. Input 16px minimum.
- Spacing 4/8/12/16/20/24/32. Touch targets >=44px. No visible border around each history row.
- Motion: drawer/sheets <=200ms and only opacity/transform. Respect prefers-reduced-motion. Content never hidden behind animation initialization.

## Route/state matrix
Pair: code validation, submitting, server error, success. Chat: new, attaching, loaded, streaming, stopping, offline/reconnecting, unavailable. Drawer: loading, populated, no search results, empty, fetch error with retry. Sheets: model catalog/search, rename, new-chat project, appearance/settings. Every visible control is real. Server-confirmed model/title only. Drafts scoped by origin/session and preserved on failure.

## Implementation contract
Existing IDs for pairing and chat stay. `sessions-view` is a native dialog/drawer, not a replacement full-page view. Other sheets are native dialogs for focus containment and Escape handling.

Extra IDs: `sessions-close`, `sessions-new`, `session-search`, `project-filter` (select), `sessions-all` (button toggle), `drawer-settings`; `chat-new`, `chat-more`, `welcome`, `welcome-title`, `jump-latest`, `composer-model`, `composer-model-name`, `composer-project`, `composer-project-name`, `composer-hint`; `model-dialog`, `model-list`, `model-search`, `model-status`; `settings-dialog`, `theme-select` (system/light/dark), `settings-host`; `rename-dialog`, `rename-form`, `rename-input`, `rename-status`; `project-dialog`, `project-list`, `project-form`, `project-input`, `project-status`; `more-dialog`, `rename-open`, `details-project`, `details-model`, `details-session`; `toast`.

Close buttons use `[data-close-dialog]` attribute containing dialog id. Dynamic session rows: li > button.session-row with `.session-title`, `.session-preview`, `.session-meta`, `.session-live`. Group headings li.session-group. Model rows button.model-option containing model name and provider. Project rows button.project-option. Transcript retains `.msg.user`, `.msg.assistant`, `.msg.system`, `.msg.error`, `.trace.tool` and adds `.message-copy`, `.tool-status`. Set `data-processing` on chat-view if useful. `#welcome` sits adjacent to transcript in .conversation-stage, hidden when messages exist. Composer button/icon child markup must be retained (use composer-model-name/project-name spans). Dialog code must not replace text of icon buttons.

## Gates
380px, 390x844, 1280px. Both themes. Pair/welcome/drawer/conversation/long code/tool disclosure/model sheet. No overflow, visible focus and semantic labels, reduced motion. Real streaming from gateway plus offline/foreground/revoked-token tests. Independent design-critique before shipping.
