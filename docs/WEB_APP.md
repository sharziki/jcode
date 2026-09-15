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

### Upgrading a running daemon onto this build

`jcode server reload` alone is **not** enough when the new binary only exists in
a repo checkout. The running server decides whether to reload by calling
`server_has_newer_binary()`, which only considers installed channels
(`~/.jcode/builds/shared-server`, then `stable`), never a repo `target/release`.
Against an old daemon it therefore reports *"already running the newest binary;
no reload needed"* and does nothing, so `/` keeps returning 404.

Install the build into the shared-server channel first, then reload:

```bash
cargo build --release --bin jcode

V=$(git rev-parse --short HEAD)
mkdir -p ~/.jcode/builds/versions/"$V"
cp target/release/jcode ~/.jcode/builds/versions/"$V"/jcode
ln -sfn ../versions/"$V"/jcode ~/.jcode/builds/shared-server/jcode
echo "$V" > ~/.jcode/builds/shared-server-version

jcode server reload     # now reports "reloaded onto the newest binary"
```

Reload hands live sessions to the freshly exec'd server, so headless and swarm
work is preserved; `server stop --force` is only for a wedged daemon. Verify
with `curl -s localhost:7643/health` and `curl -o /dev/null -w '%{http_code}'
localhost:7643/` (expect `200`, and `401` from `/sessions` without a token).

Before reloading, it is worth checking what is genuinely live, because
`~/.jcode/active_pids` can hold stale markers for sessions whose owning process
already exited:

```bash
for s in ~/.jcode/active_pids/*; do
  pid=$(cat "$s"); kill -0 "$pid" 2>/dev/null && echo "live: $(basename "$s")"
done
```

Only entries whose PID is still alive represent work a reload has to carry.

### A note on HTTPS, iOS, and service workers

Over a plain-HTTP origin that is not `localhost` (a Tailscale IP or MagicDNS
name), `window.isSecureContext` is `false` and `navigator.serviceWorker` is
undefined entirely. What that does and does not cost is worth being precise
about, because it is easy to overstate:

- **Still works:** the whole app. Pairing, the session list, attaching, live
  streaming over the WebSocket, and **Add to Home Screen on iOS**, which grants
  standalone full-screen mode from `apple-mobile-web-app-capable` and the touch
  icon rather than from a service worker. Verified on `archlinux.tail883455.ts.net`.
- **Lost:** offline shell caching, and Chrome/Android's install prompt, which
  does require a secure origin and a registered worker.

The client guards registration, so the absence degrades cleanly with no errors.

If you want offline support and the Android install prompt, serve it over TLS:

```bash
tailscale serve --bg 7643     # https://<machine>.<tailnet>.ts.net
```

That needs HTTPS certs enabled for the tailnet (Admin console -> DNS -> enable
HTTPS). Without it, `tailscale cert` fails with *"your Tailscale account does
not support getting TLS certs"* and the plain-HTTP behavior above applies.

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
- **A server error answering the attach is fatal for that session.** If the
  server refuses the `subscribe` (for example the session's transcript is gone,
  so it has no working directory) it sends an `error` and closes. Reconnecting
  would replay the same rejected subscribe about once a second forever, which
  looks like a flaky network while hiding a reason the server already gave. The
  client records that reason and reports it instead of retrying.
- A 401 anywhere clears the token and returns to pairing with an explanation.
- Sending while a turn is in flight becomes a `soft_interrupt`, matching the TUI.
  If either send cannot reach the server, the text stays in the composer and the
  failure is shown rather than silently dropping the user's words.
- Returning to a backgrounded tab reconnects, since mobile browsers drop sockets.

## Verification

`cargo test -p jcode-base gateway` covers asset/manifest/service-worker
consistency, PNG validity, path-escape rejection, and `?limit=` clamping.

Verified end to end in a real browser at a 390x844 mobile viewport against a
live gateway running the **release** binary: pairing through the form, the
session list (60 sessions, live badges, relative times), attaching over
WebSocket and rendering 146 messages of real history, code/bold/tool rendering
with an injection payload staying inert text, `Page.getAppManifest` reporting
zero installability errors, service worker precaching the shell and serving it
with the network disabled, and both unpair and revoked-token paths returning to
the pairing screen. Three devices paired independently against one server.

A genuine streamed turn was observed rather than simulated: 10 `text_delta`
events over the socket, assistant text growing incrementally (4 -> 30 chars),
the streaming caret visible during and cleared after, and `message_end`
returning the composer to idle. Stop was exercised mid-stream (server confirmed
`interrupted`), and typing mid-turn was confirmed to reach the server as
`soft_interrupt_injected`.

That real-turn test is also what caught the attach-failure reconnect loop
described above: a session whose transcript was absent made the client retry
about once a second indefinitely while showing "reconnecting", hiding the
server's actual explanation.

Note: a plain-HTTP tailnet origin is not a secure context, so the service worker
is unavailable there (offline caching and Android's install prompt are lost).
The full app, including iOS Add to Home Screen, was verified working on
`http://archlinux.tail883455.ts.net:7698/`: paired, listed 60 sessions, and ran
a complete streamed turn (20 `text_delta` events, incremental growth, clean
finish) over that exact origin.
