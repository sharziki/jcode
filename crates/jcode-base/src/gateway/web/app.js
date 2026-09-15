/*
 * jcode web client.
 *
 * Talks the same wire protocol as the TUI and the iOS app:
 *   POST /pair      6-digit code  -> long-lived token
 *   GET  /sessions  token         -> recent session metadata
 *   GET  /ws        token         -> NDJSON request/event stream
 *
 * State lives in three screens (pair, sessions, chat) driven by a single
 * reducer over server events, mirroring ios/Sources/JCodeKit/SessionReducer.swift.
 */
"use strict";

// ----------------------------------------------------------------- storage

const STORE_KEY = "jcode.credentials.v1";

/**
 * Credentials are per-origin: one browser can be paired with several servers
 * (laptop, desktop) and each keeps its own token.
 */
const credentials = {
  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const all = JSON.parse(raw);
      return all[location.host] || null;
    } catch {
      return null;
    }
  },
  save(value) {
    let all = {};
    try {
      all = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch {
      all = {};
    }
    all[location.host] = value;
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  },
  clear() {
    let all = {};
    try {
      all = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch {
      all = {};
    }
    delete all[location.host];
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  },
};

/** Stable per-browser device id, so re-pairing replaces rather than duplicates. */
function deviceID() {
  let id = localStorage.getItem("jcode.device-id");
  if (!id) {
    id =
      (crypto.randomUUID && crypto.randomUUID()) ||
      "web-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    localStorage.setItem("jcode.device-id", id);
  }
  return id;
}

/** A human-recognizable default name for the pairing screen. */
function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone (web)";
  if (/iPad/.test(ua)) return "iPad (web)";
  if (/Android/.test(ua)) return "Android (web)";
  if (/Mac OS X/.test(ua)) return "Mac (web)";
  if (/Windows/.test(ua)) return "Windows (web)";
  return "Browser";
}

// ---------------------------------------------------------------- elements

const $ = (id) => document.getElementById(id);
const el = {
  pairView: $("pair-view"),
  pairForm: $("pair-form"),
  pairCode: $("pair-code"),
  pairSubmit: $("pair-submit"),
  deviceName: $("device-name"),
  pairStatus: $("pair-status"),
  pairHost: $("pair-host"),

  sessionsView: $("sessions-view"),
  sessionList: $("session-list"),
  sessionsEmpty: $("sessions-empty"),
  sessionsStatus: $("sessions-status"),
  sessionsRefresh: $("sessions-refresh"),
  sessionsUnpair: $("sessions-unpair"),

  chatView: $("chat-view"),
  chatBack: $("chat-back"),
  chatTitle: $("chat-title"),
  chatPhase: $("chat-phase"),
  transcript: $("transcript"),
  statusLine: $("status-line"),
  composer: $("composer"),
  composerInput: $("composer-input"),
  composerSend: $("composer-send"),
  composerStop: $("composer-stop"),
};

function show(view) {
  for (const v of [el.pairView, el.sessionsView, el.chatView]) {
    v.hidden = v !== view;
  }
}

function setStatus(node, text, kind) {
  node.textContent = text || "";
  if (kind) node.dataset.kind = kind;
  else delete node.dataset.kind;
}

// ------------------------------------------------------------------ pairing

async function pair(code, name) {
  const response = await fetch("/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      device_id: deviceID(),
      device_name: name || defaultDeviceName(),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Pairing failed (HTTP ${response.status})`);
  }
  if (!data.token) throw new Error("Server returned no token");
  return data;
}

el.pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = el.pairCode.value.replace(/\D/g, "");
  if (code.length !== 6) {
    setStatus(el.pairStatus, "Enter the 6-digit code.", "error");
    return;
  }
  el.pairSubmit.disabled = true;
  setStatus(el.pairStatus, "Pairing...");
  try {
    const result = await pair(code, el.deviceName.value.trim());
    credentials.save({
      token: result.token,
      serverName: result.server_name,
      serverVersion: result.server_version,
    });
    setStatus(el.pairStatus, "Paired.", "ok");
    el.pairCode.value = "";
    await openSessions();
  } catch (error) {
    setStatus(el.pairStatus, error.message, "error");
  } finally {
    el.pairSubmit.disabled = false;
  }
});

// ------------------------------------------------------------ session list

function relativeTime(ms) {
  if (!ms) return "";
  const delta = Date.now() - ms;
  const minute = 60000;
  if (delta < minute) return "just now";
  if (delta < 60 * minute) return `${Math.floor(delta / minute)}m ago`;
  if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))}h ago`;
  return `${Math.floor(delta / (24 * 60 * minute))}d ago`;
}

/** Collapse an absolute working dir to something readable on a phone. */
function shortPath(path) {
  if (!path) return "";
  return path.replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");
}

async function fetchSessions(token) {
  const response = await fetch("/sessions?limit=60", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new Error("unauthorized");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.sessions || [];
}

async function openSessions() {
  const creds = credentials.load();
  if (!creds) return openPairing();
  show(el.sessionsView);
  setStatus(el.sessionsStatus, "Loading sessions...");
  // Hide the empty block while loading and on failure: "No sessions yet" would
  // misreport a server we simply could not reach.
  el.sessionsEmpty.hidden = true;
  try {
    const sessions = await fetchSessions(creds.token);
    renderSessions(sessions);
    // The empty block already explains the empty case; repeating it here would
    // be redundant.
    setStatus(el.sessionsStatus, sessions.length ? `${sessions.length} sessions` : "");
  } catch (error) {
    if (error.message === "unauthorized") {
      credentials.clear();
      openPairing("This device is no longer paired. Enter a new code.");
      return;
    }
    setStatus(el.sessionsStatus, `Could not load sessions: ${error.message}`, "error");
  }
}

function renderSessions(sessions) {
  el.sessionList.textContent = "";
  // An empty list is a legitimate state (a brand-new pairing), not a failure.
  // Show an explanation instead of a blank screen, and let the empty block take
  // the space so it centers rather than stranding text at the bottom.
  el.sessionsEmpty.hidden = sessions.length > 0;
  el.sessionList.style.flex = sessions.length ? "" : "0";
  for (const session of sessions) {
    const item = document.createElement("li");

    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title || session.id;
    item.append(title);

    const meta = document.createElement("span");
    meta.className = "session-meta";
    const parts = [];
    if (session.live) parts.push("live");
    const when = relativeTime(session.updated_at_ms);
    if (when) parts.push(when);
    const dir = shortPath(session.working_dir);
    if (dir) parts.push(dir);
    meta.textContent = parts.join("  ·  ");
    if (session.live) meta.classList.add("session-live");
    item.append(meta);

    item.addEventListener("click", () => openChat(session));
    el.sessionList.append(item);
  }
}

el.sessionsRefresh.addEventListener("click", () => openSessions());

el.sessionsUnpair.addEventListener("click", () => {
  if (!confirm("Forget this server on this device?")) return;
  connection.stop();
  credentials.clear();
  openPairing("Unpaired.");
});

function openPairing(message) {
  show(el.pairView);
  el.pairHost.textContent = `Server: ${location.host}`;
  el.deviceName.value = el.deviceName.value || defaultDeviceName();
  setStatus(el.pairStatus, message || "", message ? "error" : null);
  el.pairCode.focus();
}

// -------------------------------------------------------------- connection

/**
 * One reconnecting WebSocket to the gateway.
 *
 * Reconnect uses capped exponential backoff, except after a `reloading` event
 * where the server is expected back immediately, and stops entirely on 401 or
 * an explicit server close request (retrying either can never succeed).
 */
const connection = {
  socket: null,
  token: null,
  sessionID: null,
  nextRequestID: 1,
  attempt: 0,
  timer: null,
  stopped: true,
  /** Request id of the `subscribe` for the current socket. */
  attachRequestID: null,
  /** Set once the server accepts the attach, so retries can be distinguished. */
  attached: false,
  /** Reason the server refused to attach; retrying it can never succeed. */
  fatalReason: null,

  start(token, sessionID) {
    this.stop();
    this.stopped = false;
    this.token = token;
    this.sessionID = sessionID;
    this.attempt = 0;
    this.fatalReason = null;
    this.open();
  },

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      try {
        this.socket.close();
      } catch {
        /* already closing */
      }
      this.socket = null;
    }
  },

  open() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    // Browsers cannot set headers on a WebSocket handshake, so the gateway's
    // documented query-token fallback is the only option here.
    const url = `${scheme}://${location.host}/ws?token=${encodeURIComponent(this.token)}`;
    setPhase(this.attempt === 0 ? "connecting" : "reconnecting");

    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      setPhase("connected");
      this.attachRequestID = this.nextRequestID;
      this.attached = false;
      this.send({ type: "subscribe", target_session_id: this.sessionID });
      this.send({ type: "get_history" });
    };

    socket.onmessage = (event) => {
      // A single frame may carry several newline-delimited events.
      for (const line of String(event.data).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        handleEvent(parsed);
      }
    };

    socket.onclose = (event) => {
      if (this.stopped) return;
      this.socket = null;
      // 1008/4401-style auth rejections and handshake 401s both surface as an
      // abnormal close; a failed handshake never reached onopen.
      if (event.code === 1008) {
        setPhase("failed", "unpaired");
        credentials.clear();
        openPairing("This device is no longer paired. Enter a new code.");
        return;
      }
      // The server refused the attach and then closed. Reconnecting replays the
      // same rejected subscribe forever, which looks like a flaky network and
      // hides an error the server already explained. Stop and say why.
      if (this.fatalReason) {
        setPhase("failed", "unavailable");
        addMessage("error", this.fatalReason);
        setStatusLine("");
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      /* onclose always follows; reconnect is handled there. */
    };
  },

  scheduleReconnect() {
    if (this.stopped) return;
    this.attempt += 1;
    setPhase("reconnecting");
    const delay = Math.min(1000 * 2 ** (this.attempt - 1), 30000);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), delay);
  },

  /** Reconnect immediately, for a server that just announced a reload. */
  reconnectSoon() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), 500);
  },

  send(request) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const payload = { id: this.nextRequestID++, ...request };
    this.socket.send(JSON.stringify(payload));
    return true;
  },
};

function setPhase(phase, label) {
  el.chatPhase.dataset.phase = phase;
  el.chatPhase.textContent =
    label ||
    { connected: "live", connecting: "connecting", reconnecting: "reconnecting", failed: "offline", disconnected: "offline" }[
      phase
    ] ||
    phase;
}

// ---------------------------------------------------------------- rendering

/**
 * Minimal, injection-safe markdown: fenced code, inline code, bold.
 * Text is inserted via textContent at every step, so server or model output
 * can never become live HTML.
 */
function renderMarkdown(target, text) {
  target.textContent = "";
  const segments = String(text).split(/```/);
  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      // Drop an opening language tag line ("```rust").
      code.textContent = segment.replace(/^[a-zA-Z0-9_+-]*\n/, "");
      pre.append(code);
      target.append(pre);
      return;
    }
    for (const piece of segment.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (!piece) continue;
      if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
        const code = document.createElement("code");
        code.textContent = piece.slice(1, -1);
        target.append(code);
      } else if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
        const strong = document.createElement("strong");
        strong.textContent = piece.slice(2, -2);
        target.append(strong);
      } else {
        target.append(document.createTextNode(piece));
      }
    }
  });
}

/** True when the user is near the bottom, so we only autoscroll when following. */
function isPinnedToBottom() {
  const node = el.transcript;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function scrollToBottom(force) {
  if (force || isPinnedToBottom()) {
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }
}

function addMessage(role, text) {
  const pinned = isPinnedToBottom();
  const node = document.createElement("div");
  node.className = `msg ${role}`;
  renderMarkdown(node, text);
  el.transcript.append(node);
  scrollToBottom(pinned);
  return node;
}

// ------------------------------------------------------------------ reducer

/** Live view state for the attached session. */
const view = {
  streaming: null, // assistant bubble currently receiving text deltas
  streamingText: "",
  reasoning: null, // reasoning trace block
  reasoningText: "",
  tools: new Map(), // tool id -> { node, body, input }
  pendingToolInput: null, // tool whose input is still streaming
  processing: false,
  knownTitle: "", // title from the session list, used until the server sends one
};

function resetView() {
  el.transcript.textContent = "";
  view.streaming = null;
  view.streamingText = "";
  view.reasoning = null;
  view.reasoningText = "";
  view.tools.clear();
  view.pendingToolInput = null;
  setProcessing(false);
  setStatusLine("");
}

function setProcessing(active) {
  view.processing = active;
  el.composerStop.hidden = !active;
  el.composerSend.hidden = active;
}

function setStatusLine(text) {
  el.statusLine.textContent = text || "";
  el.statusLine.hidden = !text;
}

/** Finish the streaming bubble, if any, and drop the caret. */
function endStreaming() {
  if (view.streaming) {
    view.streaming.classList.remove("streaming");
    view.streaming = null;
    view.streamingText = "";
  }
  if (view.reasoning) {
    view.reasoning = null;
    view.reasoningText = "";
  }
}

function appendDelta(text) {
  const pinned = isPinnedToBottom();
  if (!view.streaming) {
    view.streaming = addMessage("assistant", "");
    view.streaming.classList.add("streaming");
    view.streamingText = "";
  }
  view.streamingText += text;
  renderMarkdown(view.streaming, view.streamingText);
  scrollToBottom(pinned);
}

function appendReasoning(text) {
  const pinned = isPinnedToBottom();
  if (!view.reasoning) {
    view.reasoning = document.createElement("div");
    view.reasoning.className = "trace";
    el.transcript.append(view.reasoning);
    view.reasoningText = "";
  }
  view.reasoningText += text;
  view.reasoning.textContent = view.reasoningText;
  scrollToBottom(pinned);
}

function startTool(id, name) {
  const pinned = isPinnedToBottom();
  const node = document.createElement("details");
  node.className = "trace tool";
  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.className = "tool-name";
  label.textContent = name;
  summary.append(label);
  node.append(summary);
  const body = document.createElement("div");
  body.className = "tool-body";
  node.append(body);
  el.transcript.append(node);
  const record = { node, summary, body, input: "" };
  view.tools.set(id, record);
  view.pendingToolInput = record;
  scrollToBottom(pinned);
  return record;
}

function finishTool(id, name, output, error) {
  const pinned = isPinnedToBottom();
  const record = view.tools.get(id) || startTool(id, name);
  view.pendingToolInput = null;
  if (error) record.node.classList.add("failed");
  const text = error ? `error: ${error}` : output || "";
  // Tool output can be enormous; the full text stays available on tap.
  record.body.textContent = text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text;
  scrollToBottom(pinned);
}

function handleEvent(event) {
  switch (event.type) {
    case "history":
      // History only arrives once the server accepted the attach.
      connection.attached = true;
      connection.fatalReason = null;
      renderHistory(event);
      break;

    case "text_delta":
      appendDelta(event.text || "");
      break;

    case "text_replace":
      if (!view.streaming) appendDelta("");
      view.streamingText = event.text || "";
      renderMarkdown(view.streaming, view.streamingText);
      break;

    case "reasoning_delta":
      appendReasoning(event.text || "");
      break;

    case "reasoning_done":
      view.reasoning = null;
      view.reasoningText = "";
      break;

    case "tool_start":
      startTool(event.id, event.name);
      break;

    case "tool_input":
      if (view.pendingToolInput) {
        view.pendingToolInput.input += event.delta || "";
        view.pendingToolInput.body.textContent = view.pendingToolInput.input;
      }
      break;

    case "tool_done":
      finishTool(event.id, event.name, event.output, event.error);
      break;

    case "message_end":
      endStreaming();
      setProcessing(false);
      setStatusLine("");
      break;

    case "done":
      setProcessing(false);
      break;

    case "interrupted":
      endStreaming();
      setProcessing(false);
      addMessage("system", "interrupted");
      break;

    case "status_detail":
      setStatusLine(event.detail || "");
      break;

    case "tokens":
      setStatusLine(`${event.input} in / ${event.output} out`);
      break;

    case "state":
      setProcessing(Boolean(event.is_processing));
      break;

    case "session":
      connection.sessionID = event.session_id;
      break;

    case "session_renamed":
      el.chatTitle.textContent = event.display_title || connection.sessionID;
      break;

    case "error":
      endStreaming();
      setProcessing(false);
      // An error answering the attach means this session cannot be opened at
      // all (e.g. its transcript is gone). Record it so the close that follows
      // reports the reason instead of reconnecting forever.
      if (!connection.attached && event.id === connection.attachRequestID) {
        connection.fatalReason = event.message || "This session could not be opened.";
      }
      addMessage("error", event.message || "Server error");
      break;

    case "reloading":
      addMessage("system", "server reloading");
      connection.reconnectSoon();
      break;

    case "session_close_requested":
      connection.stop();
      setPhase("failed", "closed");
      addMessage("system", event.reason || "Session closed by server");
      break;

    case "compaction":
      addMessage("system", `compacted (${event.trigger || "auto"})`);
      break;

    case "notification":
      addMessage("system", event.message || "");
      break;

    default:
      // Unknown event types are ignored so a newer server never breaks the app.
      break;
  }
}

function renderHistory(event) {
  resetView();
  // The server only sends display_title when the session has one. Falling back
  // to the raw id would replace a good title from the session list with an
  // unreadable identifier, so the known title wins over the id.
  el.chatTitle.textContent =
    event.display_title || view.knownTitle || event.session_id || connection.sessionID || "session";
  for (const message of event.messages || []) {
    const role = message.role;
    if (role === "user" || role === "assistant") {
      if (message.content) addMessage(role, message.content);
      if (message.tool_data) {
        const data = message.tool_data;
        const record = startTool(data.id, data.name);
        record.input = data.input || "";
        finishTool(data.id, data.name, data.output, data.error);
      }
    } else if (role === "system") {
      // System prompts are server-side context, not conversation.
      continue;
    }
  }
  if (event.total_tokens) {
    setStatusLine(`${event.total_tokens[0]} in / ${event.total_tokens[1]} out`);
  }
  scrollToBottom(true);
}

// --------------------------------------------------------------------- chat

function openChat(session) {
  const creds = credentials.load();
  if (!creds) return openPairing();
  show(el.chatView);
  resetView();
  view.knownTitle = session.title || "";
  el.chatTitle.textContent = session.title || session.id;
  setPhase("connecting");
  connection.start(creds.token, session.id);
  history.pushState({ session: session.id }, "", `#${session.id}`);
}

el.chatBack.addEventListener("click", () => {
  connection.stop();
  setPhase("disconnected");
  history.pushState({}, "", "#");
  openSessions();
});

window.addEventListener("popstate", () => {
  if (!location.hash || location.hash === "#") {
    connection.stop();
    if (credentials.load()) openSessions();
    else openPairing();
  }
});

// Auto-grow the composer instead of scrolling a one-line box.
function resizeComposer() {
  el.composerInput.style.height = "auto";
  el.composerInput.style.height = `${Math.min(el.composerInput.scrollHeight, window.innerHeight * 0.4)}px`;
}
el.composerInput.addEventListener("input", resizeComposer);

el.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

// Enter sends on a physical keyboard; on touch keyboards Enter inserts a
// newline, because there the send button is the obvious affordance.
el.composerInput.addEventListener("keydown", (event) => {
  const touch = window.matchMedia("(pointer: coarse)").matches;
  if (event.key === "Enter" && !event.shiftKey && !touch) {
    event.preventDefault();
    sendMessage();
  }
});

function sendMessage() {
  const content = el.composerInput.value.trim();
  if (!content) return;
  if (view.processing) {
    // Mid-turn input becomes a soft interrupt, matching the TUI.
    if (!connection.send({ type: "soft_interrupt", content, urgent: false })) {
      // Keep the text in the composer: silently dropping it loses the user's
      // words with no explanation.
      addMessage("error", "Not connected. Message not sent.");
      return;
    }
    addMessage("user", content);
  } else {
    if (!connection.send({ type: "message", content })) {
      addMessage("error", "Not connected. Message not sent.");
      return;
    }
    addMessage("user", content);
    endStreaming();
    setProcessing(true);
  }
  el.composerInput.value = "";
  resizeComposer();
  scrollToBottom(true);
}

el.composerStop.addEventListener("click", () => {
  connection.send({ type: "cancel" });
  setProcessing(false);
});

// A backgrounded tab gets its socket dropped by mobile browsers; reconnect on
// return so the session is live again without a manual refresh.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (connection.stopped || !connection.token) return;
  if (!connection.socket || connection.socket.readyState > WebSocket.OPEN) {
    connection.attempt = 0;
    connection.open();
  }
});

// ------------------------------------------------------------------- start

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline shell is a bonus, never a requirement */
    });
  });
}

(function boot() {
  const creds = credentials.load();
  if (!creds) {
    openPairing();
    return;
  }
  const hash = location.hash.slice(1);
  if (hash) {
    openChat({ id: hash, title: hash });
  } else {
    openSessions();
  }
})();
