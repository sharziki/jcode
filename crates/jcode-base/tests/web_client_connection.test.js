/**
 * Tests for connection handling across tab and chat switches.
 *
 * The reported bug: the PWA was "buggy switching tabs and chats" — the
 * transcript flickered and reloaded every time you came back.
 *
 * Cause: `open()` unconditionally called `closeSocket()` and rebuilt, even on a
 * perfectly healthy connection, which re-ran `subscribe` + `get_history` and
 * re-rendered everything. `visibilitychange` made it worse by calling `open()`
 * and then `foreground()`, which called `open()` again — twice per switch.
 *
 * The fix must satisfy two opposing requirements, so both are pinned here:
 *   1. a healthy socket must SURVIVE a foreground (no reload, no flicker)
 *   2. a socket that iOS thawed dead-but-OPEN must still be REPLACED
 * Satisfying only (1) leaves the app silently disconnected; only (2) is the
 * original bug.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "../src/gateway/web/app.js"),
  "utf8",
);

function connectionSource() {
  const start = SOURCE.indexOf("  open() {");
  const end = SOURCE.indexOf("  send(request) {");
  assert.ok(start > 0 && end > start, "connection methods not found in app.js");
  return SOURCE.slice(start, end);
}

test("open() leaves a healthy attached socket alone", () => {
  // This is the flicker fix. Rebuilding a live socket re-runs get_history and
  // repaints the transcript, which is exactly what the user saw.
  const src = connectionSource();
  assert.match(
    src,
    /readyState === WebSocket\.OPEN && this\.attached/,
    "open() must short-circuit on an already-open, attached socket",
  );
  const guardAt = src.indexOf("readyState === WebSocket.OPEN && this.attached");
  const closeAt = src.indexOf("this.closeSocket()");
  assert.ok(
    guardAt < closeAt,
    "the healthy-socket guard must come BEFORE closeSocket(), or it cannot prevent the teardown",
  );
});

test("visibilitychange no longer double-opens", () => {
  // It previously called open() directly AND foreground() (which opens too),
  // so every tab switch did the work twice.
  const handler = SOURCE.slice(
    SOURCE.indexOf('document.addEventListener("visibilitychange"'),
    SOURCE.indexOf('window.addEventListener("focus"'),
  );
  assert.ok(handler.length > 0, "visibilitychange handler not found");
  assert.ok(
    !/connection\.open\(\)/.test(handler),
    "visibilitychange must not call connection.open() directly; foreground() handles it",
  );
  assert.match(handler, /foreground\(\)/, "it should still call foreground()");
});

test("a dead-but-OPEN socket is still detected and replaced", () => {
  // The requirement that makes the fix safe. iOS hands back sockets that report
  // OPEN with a dead TCP connection; nothing errors and nothing arrives.
  const src = connectionSource();
  assert.match(src, /verifyLive\(\)/, "verifyLive must exist");
  assert.match(
    src,
    /this\.reconnectSoon\(\)/,
    "verifyLive must reconnect when the probe goes unanswered",
  );
  // Proof of life must come from the server, not from a local flag.
  assert.match(src, /noteInbound\(\)/, "an inbound frame must clear the probe");
});

test("foreground probes an open socket instead of trusting it", () => {
  const fg = SOURCE.slice(
    SOURCE.indexOf("function foreground()"),
    SOURCE.indexOf('document.addEventListener("visibilitychange"'),
  );
  assert.match(fg, /connection\.verifyLive\(\)/, "foreground must verify liveness");
  assert.match(
    fg,
    /readyState > WebSocket\.OPEN/,
    "a closing/closed socket must still reconnect immediately",
  );
});

test("a pending probe is cleared when the socket is torn down", () => {
  // Otherwise a timer from the old socket fires later and kills a healthy new
  // one, which would look like a random disconnect.
  const close = SOURCE.slice(
    SOURCE.indexOf("closeSocket()"),
    SOURCE.indexOf("  stop() {"),
  );
  assert.match(close, /clearTimeout\(this\.liveProbe\)/, "closeSocket must clear liveProbe");
});

test("re-opening the chat you are already in stays a no-op", () => {
  // Pre-existing guard; this test exists so the reconnect rework cannot quietly
  // remove it and reintroduce the duplicate-history-entry bug.
  const openChat = SOURCE.slice(
    SOURCE.indexOf("function openChat("),
    SOURCE.indexOf("function newChat("),
  );
  assert.match(
    openChat,
    /session\.id === connection\.sessionID && !connection\.stopped/,
    "openChat must short-circuit when the chat is already open",
  );
});
