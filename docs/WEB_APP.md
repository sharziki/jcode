# jcode Web App (PWA)

> Status: implemented. Served by the gateway at `/`, no build step, no app store.

## What it is

An installable web client for jcode sessions, embedded in the `jcode` binary and
served by the same listener that already handles pairing and WebSockets. Open
the gateway address on any phone or laptop browser, enter a pairing code, and
you have your sessions.

It is a peer of the [iOS app](IOS_APP.md), not a replacement: same gateway, same
wire protocol, same visual identity. The web app reaches every device today; the
native app gets push notifications and system integration.

## Using it

```bash
# 1. Enable the gateway in ~/.jcode/config.toml, then restart the server.
[gateway]
enabled = true
port = 7643
bind_addr = "0.0.0.0"     # reachable over Tailscale/LAN

# 2. Generate a pairing code.
jcode pair
```

`jcode pair` prints the web app URL alongside the QR code. Open it, enter the
6-digit code, then **Add to Home Screen** for a standalone, full-screen app.

Reachability is assumed to be Tailscale or LAN, exactly as for the iOS app. The
gateway speaks plain HTTP; do not expose it to the public internet.

### A note on HTTPS and service workers

Browsers only register service workers on a secure origin. `localhost` counts as
secure, but a bare Tailscale IP (`http://100.x.y.z:7643`) does not: there
`window.isSecureContext` is `false` and `navigator.serviceWorker` is undefined
entirely. The app guards registration, so on such an origin it still pairs,
lists, and streams normally; only offline caching and the install prompt are
unavailable. To get the full installable experience, put it behind TLS:

```bash
tailscale serve --bg 7643     # https://<machine>.<tailnet>.ts.net
```

That origin is HTTPS with a real certificate, so the service worker registers and
the install prompt appears.

## Endpoints

The gateway serves all of these on one port:

| Route | Purpose |
| --- | --- |
| `GET /` and the shell assets | The embedded web client |
| `GET /manifest.webmanifest`, `/sw.js`, `/icon-*.png` | PWA install + offline shell |
| `GET /health` | Unauthenticated liveness probe |
| `POST /pair` | 6-digit code -> long-lived token |
| `GET /sessions` | Recent session metadata (**token required**) |
| `GET /ws` | Session request/event stream (**token required**) |

### `GET /sessions`

Added for the web client. The WebSocket protocol only reports session IDs for
the session you are already attached to, which is not enough to render a picker.

- Auth: `Authorization: Bearer <token>`, or `?token=` for parity with `/ws`.
- `?limit=` defaults to 50 and is clamped to 1..=500, so one request can never
  walk an entire install's history.
- Backed by the durable recent-session SQLite index, not by reading transcripts:
  an install can hold 100k+ sessions and a phone must not wait on that.
- `live` comes from the active-PID directory.

```json
{
  "sessions": [
    {
      "id": "session_cat_1789478626270_67e4c2b55dbfd0a1",
      "title": "MA261 Quiz 3 scope correction",
      "working_dir": "/home/sharziki",
      "updated_at_ms": 1789487968748,
      "saved": false,
      "live": true
    }
  ]
}
```

## Architecture

```
crates/jcode-base/src/gateway/
  web.rs                     asset table + HTTP responses (embedded via include_bytes!)
  web/
    index.html               three views: pair, sessions, chat
    app.js                   credentials, reconnecting socket, event reducer, renderer
    app.css                  design tokens mirrored from the iOS Theme
    sw.js                    app-shell precache, network-first
    manifest.webmanifest     installability
    icon*.png|svg            icons, derived from the iOS AppIcon
```

Assets are embedded with `include_bytes!` rather than read from disk: the gateway
must work from any working directory, from a released binary, and after the repo
it was built from has moved.

Design decisions worth keeping:

- **No build step and no dependencies.** Plain HTML/CSS/JS, so the client cannot
  rot behind an npm toolchain and `cargo build` is the only thing to run.
- **Assets resolve from an explicit allowlist**, so no request path can escape
  into the filesystem.
- **Rendering never produces live HTML.** Markdown is built with `textContent`
  at every step, so model or server output can never execute as script.
- **Query-token auth on `/ws` only.** Browsers cannot set headers on a WebSocket
  handshake; `/sessions` prefers the `Authorization` header.
- **The service worker never caches `/sessions`, `/ws`, or `/health`.** Stale
  session data would be worse than an honest error.

### Client state

`app.js` mirrors `SessionReducer.swift`: server events fold into view state, and
unknown event types are ignored so a newer server never breaks an older client.

- Reconnect uses capped exponential backoff (max 30s), reconnects eagerly after
  a `reloading` event, and stops entirely on a 401 or `session_close_requested`
  because retrying either can never succeed.
- A 401 anywhere clears the token and returns to pairing with an explanation.
- Sending while a turn is in flight becomes a `soft_interrupt`, matching the TUI.
- Returning to a backgrounded tab reconnects, since mobile browsers drop sockets.

## Verification

`cargo test -p jcode-base gateway` covers asset/manifest/service-worker
consistency, PNG validity, path-escape rejection, and `?limit=` clamping.

Verified end to end in a real browser at a 390x844 mobile viewport against a
live gateway: pairing through the form, the session list (60 sessions, live
badges, relative times), attaching over WebSocket and rendering 146 messages of
real history, `message`/`soft_interrupt`/`cancel` wire frames, code/bold/tool
rendering with an injection payload staying inert text, `Page.getAppManifest`
reporting zero installability errors, service worker precaching the shell and
serving it with the network disabled, and both unpair and revoked-token paths
returning to the pairing screen.
