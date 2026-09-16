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
/**
 * Render markdown into `target`.
 *
 * Every text node is created with `textContent`, and no string is ever assigned
 * to `innerHTML`, so model or server output can never execute as script. The
 * supported subset matches what models actually emit: fenced and inline code,
 * ATX headings, ordered/unordered/task lists, blockquotes, tables, horizontal
 * rules, links, bold, italic, and strikethrough.
 */
function renderMarkdown(target, text) {
  target.textContent = "";
  for (const block of parseBlocks(String(text))) {
    target.append(block);
  }
}

/** Split source into block-level nodes. Fenced code is taken verbatim first. */
function parseBlocks(text) {
  const out = [];
  const lines = text.split("\n");
  let i = 0;

  // Normalize heading depth against the shallowest heading present, so a
  // message that starts at "###" still begins at h2 rather than skipping
  // levels below the screen's h1.
  let minHash = 7;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+\S/);
    if (h) minHash = Math.min(minHash, h[1].length);
  }
  if (minHash === 7) minHash = 1;

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    const p = document.createElement("p");
    // A single newline inside a paragraph is a soft break, as in chat UIs.
    renderInline(p, buf.join("\n"));
    out.push(p);
    buf.length = 0;
  };

  const para = [];
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);

    if (fence) {
      flushParagraph(para);
      const marker = fence[1][0].repeat(3);
      const lang = fence[2];
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing fence (absent at EOF while streaming)
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (lang) code.dataset.lang = lang;
      code.textContent = body.join("\n");
      pre.append(code);
      out.push(pre);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph(para);
      // The screen title is the h1, so message headings start at h2 regardless
      // of how many '#' the model used. Starting deeper skips a level
      // (h1 -> h3) and breaks the document outline for screen readers.
      // Relative depth is preserved, clamped at h6.
      const level = Math.min(6, Math.max(2, heading[1].length - minHash + 2));
      const h = document.createElement(`h${level}`);
      renderInline(h, heading[2]);
      out.push(h);
      i += 1;
      continue;
    }

    // Display math, centered as a block.
    //
    // Both `\[ ... \]` and a bare `[ ... ]` on its own line: models emit the
    // unescaped form far more often (118 vs 12 occurrences across 20 real
    // sessions here), and a lone `[` cannot be a markdown link, so treating it
    // as math is unambiguous. A line with other content is left alone.
    if (/^\s*(\\\[|\[)\s*$/.test(line) || /^\s*\\\[/.test(line)) {
      flushParagraph(para);
      const body = [];
      let cur = line.replace(/^\s*(\\\[|\[)/, "");
      let closed = false;
      while (true) {
        // Accept either closing form, matching the opener's flexibility.
        const escIdx = cur.indexOf("\\]");
        const bareIdx = /^\s*\]\s*$/.test(cur) ? cur.indexOf("]") : -1;
        const idx = escIdx >= 0 ? escIdx : bareIdx;
        if (idx >= 0) {
          body.push(cur.slice(0, idx));
          closed = true;
          break;
        }
        body.push(cur);
        i += 1;
        if (i >= lines.length) break;
        cur = lines[i];
      }
      i += 1;
      const div = document.createElement("div");
      div.className = "math-display";
      div.textContent = latexToText(body.join(" "));
      out.push(div);
      if (!closed) {
        // Unterminated while streaming: still show what arrived.
      }
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph(para);
      out.push(document.createElement("hr"));
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph(para);
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      const bq = document.createElement("blockquote");
      for (const node of parseBlocks(quoted.join("\n"))) bq.append(node);
      out.push(bq);
      continue;
    }

    if (isTableStart(lines, i)) {
      flushParagraph(para);
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(lines[i]);
        i += 1;
      }
      out.push(buildTable(rows));
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushParagraph(para);
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }

    if (!line.trim()) {
      flushParagraph(para);
      i += 1;
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushParagraph(para);
  return out;
}

/** A table needs a header row and a `---|---` delimiter directly beneath it. */
function isTableStart(lines, i) {
  return (
    lines[i].includes("|") &&
    i + 1 < lines.length &&
    /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) &&
    lines[i + 1].includes("-")
  );
}

function splitRow(row) {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function buildTable(rows) {
  const table = document.createElement("table");
  const aligns = splitRow(rows[1] || "").map((spec) => {
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return left ? "left" : "";
  });

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  splitRow(rows[0]).forEach((cell, index) => {
    const th = document.createElement("th");
    if (aligns[index]) th.style.textAlign = aligns[index];
    renderInline(th, cell);
    hr.append(th);
  });
  thead.append(hr);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows.slice(2)) {
    const tr = document.createElement("tr");
    splitRow(row).forEach((cell, index) => {
      const td = document.createElement("td");
      if (aligns[index]) td.style.textAlign = aligns[index];
      renderInline(td, cell);
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

/**
 * Parse one list, including nested lists and `- [ ]` task items.
 * Returns the built element and the index of the first unconsumed line.
 */
function parseList(lines, start) {
  const first = lines[start].match(/^(\s*)([-*+]|\d+[.)])\s+/);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = document.createElement(ordered ? "ol" : "ul");
  if (ordered) {
    const startNum = parseInt(first[2], 10);
    if (startNum > 1) list.start = startNum;
  }

  let i = start;
  let item = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless what follows is genuinely part of it:
      // another marker at this level, or a line indented deeper than the marker.
      // Comparing against `baseIndent` alone never terminated a top-level list
      // (nothing is indented less than 0), so a blank line was swallowed along
      // with every block after it.
      const next = lines[i + 1] || "";
      const continues =
        next.trim() &&
        (next.search(/\S/) > baseIndent ||
          new RegExp(`^\\s{${baseIndent}}([-*+]|\\d+[.)])\\s+`).test(next));
      if (!continues) break;
      i += 1;
      continue;
    }
    const indent = line.search(/\S/);
    if (indent < baseIndent) break;

    const marker = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (marker && marker[1].length === baseIndent) {
      // A bullet list and a numbered list are different lists even at the same
      // indent. Without this, "- a" followed by "1. b" produced one <ul>
      // containing both, silently losing the ordered list.
      if (/\d/.test(marker[2]) !== ordered) break;
      item = document.createElement("li");
      let body = marker[3];
      const task = body.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        // A bare checkbox has no accessible name. Wrapping it and the item text
        // in a <label> gives screen readers "done: <text>" instead of an
        // unlabelled control, and keeps the checked state meaningful.
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = task[1].toLowerCase() === "x";
        box.disabled = true;
        const span = document.createElement("span");
        renderInline(span, task[2]);
        label.append(box, span);
        item.append(label);
        item.classList.add("task");
        list.append(item);
        i += 1;
        continue;
      }
      const span = document.createElement("span");
      renderInline(span, body);
      item.append(span);
      list.append(item);
      i += 1;
      continue;
    }
    if (marker && marker[1].length > baseIndent) {
      const [nested, next] = parseList(lines, i);
      (item || list).append(nested);
      i = next;
      continue;
    }
    // A display-math block indented under an item belongs to that item. Models
    // write this constantly ("- **Circle:** so\n  \[\n  ...\n  \]"), and
    // treating it as lazy continuation rendered the LaTeX as raw source.
    if (item && /^\s*(\\\[|\[)\s*$/.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*(\\\]|\])\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closer (absent at EOF while streaming)
      const div = document.createElement("div");
      div.className = "math-display";
      div.textContent = latexToText(body.join(" "));
      item.append(div);
      continue;
    }

    // Lazy continuation of the current item.
    if (item) {
      item.append(document.createTextNode(" "));
      renderInline(item, line.trim());
    }
    i += 1;
  }
  return [list, i];
}

/**
 * Inline spans: code, bold, italic, strikethrough, and links.
 *
 * Code is matched first and its contents are never re-parsed, so `**x**`
 * inside backticks stays literal. Links only accept http/https/mailto to keep
 * `javascript:` URLs out of the DOM.
 */
// The escape alternative must come first, and every emphasis delimiter is
// `(?<!\\)`-guarded: without that, `*...*` happily spans an escaped `\*` and
// swallows it before the escape branch can run, which is exactly how a real
// transcript's `*\*\*text\*\*​*` wrapper turned into stray italics full of
// literal backslashes.
const INLINE_RE =
  /(\\\((?:[\s\S]*?)\\\))|(\[\s*\\[A-Za-z][^\]\n]*\])|(\\[\\`*_~[\]()#+\-.!>])|(`[^`]+`)|((?<!\\)\*\*(?:[^*\\]|\\.)+?\*\*|(?<!\\)__(?:[^_\\]|\\.)+?__)|((?<!\\)\*(?:[^*\\\n]|\\.)+?\*|(?<![A-Za-z0-9_\\])_(?:[^_\\\n]|\\.)+?_(?![A-Za-z0-9_]))|((?<!\\)~~(?:[^~\\]|\\.)+?~~)|(\[[^\]\n]*\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;

function renderInline(target, text) {
  let last = 0;
  for (const m of String(text).matchAll(INLINE_RE)) {
    if (m.index > last) {
      target.append(document.createTextNode(text.slice(last, m.index)));
    }
    const [tok] = m;
    if (m[1]) {
      // Inline math `\( ... \)`, rendered to Unicode instead of left as raw
      // source, which is unreadable on a phone.
      const span = document.createElement("span");
      span.className = "math";
      span.textContent = latexToText(tok.slice(2, -2));
      target.append(span);
    } else if (m[2]) {
      // `[ \cmd ... ]` inline in a sentence. Models emit this bracketed form
      // alongside `\( ... \)`; requiring a leading LaTeX command keeps it from
      // ever swallowing a markdown link or ordinary bracketed prose.
      const span = document.createElement("span");
      span.className = "math";
      span.textContent = latexToText(tok.slice(1, -1));
      target.append(span);
    } else if (m[3]) {
      // Backslash escape: emit the literal character, never the backslash.
      // Real transcripts contain `\*\*text\*\*`, which without this both
      // showed stray backslashes and mis-parsed the surrounding emphasis.
      target.append(document.createTextNode(tok[1]));
    } else if (m[4]) {
      const code = document.createElement("code");
      code.textContent = tok.slice(1, -1);
      target.append(code);
    } else if (m[5]) {
      const strong = document.createElement("strong");
      renderInline(strong, tok.slice(2, -2));
      target.append(strong);
    } else if (m[6]) {
      const em = document.createElement("em");
      renderInline(em, tok.slice(1, -1));
      target.append(em);
    } else if (m[7]) {
      const del = document.createElement("del");
      renderInline(del, tok.slice(2, -2));
      target.append(del);
    } else if (m[8]) {
      const parts = tok.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/);
      target.append(buildLink(parts[2], parts[1] || parts[2]));
    } else if (m[9]) {
      target.append(buildLink(tok, tok));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) {
    target.append(document.createTextNode(text.slice(last)));
  }
}

/**
 * Math rendering.
 *
 * jcode's TUI renders LaTeX to Unicode (see `jcode-render-core/src/math.rs`),
 * and 13 of 25 recent sessions on a real install contain LaTeX. Without this
 * the web client showed raw source like `\(\mathbf r(t)\)` and
 * `\[\boxed{surface \rightarrow point}\]`, which is unreadable on a phone.
 *
 * This is deliberately a readable subset of the TUI renderer, not a port of it:
 * delimiters are stripped, the common symbol commands become their Unicode
 * equivalents, and structure like fractions degrades to `a/b` rather than
 * pretending to typeset. Anything unrecognized is left as-is, so no content is
 * ever lost to a parse failure.
 */
const LATEX_SYMBOLS = {
  to: "\u2192", rightarrow: "\u2192", leftarrow: "\u2190",
  leftrightarrow: "\u2194", Rightarrow: "\u21d2", implies: "\u21d2",
  Leftarrow: "\u21d0", Leftrightarrow: "\u21d4", iff: "\u21d4",
  mapsto: "\u21a6", uparrow: "\u2191", downarrow: "\u2193",
  times: "\u00d7", cdot: "\u22c5", div: "\u00f7", pm: "\u00b1", mp: "\u2213",
  leq: "\u2264", le: "\u2264", geq: "\u2265", ge: "\u2265", neq: "\u2260",
  ne: "\u2260", approx: "\u2248", equiv: "\u2261", sim: "\u223c",
  propto: "\u221d", infty: "\u221e", partial: "\u2202", nabla: "\u2207",
  sum: "\u2211", prod: "\u220f", int: "\u222b", oint: "\u222e",
  sqrt: "\u221a", in: "\u2208", notin: "\u2209", subset: "\u2282",
  subseteq: "\u2286", supset: "\u2283", supseteq: "\u2287", cup: "\u222a",
  cap: "\u2229", emptyset: "\u2205", varnothing: "\u2205",
  forall: "\u2200", exists: "\u2203", neg: "\u00ac", land: "\u2227",
  lor: "\u2228", ldots: "\u2026", dots: "\u2026", cdots: "\u22ef",
  angle: "\u2220", perp: "\u22a5", parallel: "\u2225",
  langle: "\u27e8", rangle: "\u27e9", alpha: "\u03b1", beta: "\u03b2",
  gamma: "\u03b3", delta: "\u03b4", epsilon: "\u03b5", varepsilon: "\u03b5",
  zeta: "\u03b6", eta: "\u03b7", theta: "\u03b8", lambda: "\u03bb",
  mu: "\u03bc", nu: "\u03bd", xi: "\u03be", pi: "\u03c0", rho: "\u03c1",
  sigma: "\u03c3", tau: "\u03c4", phi: "\u03c6", varphi: "\u03c6",
  chi: "\u03c7", psi: "\u03c8", omega: "\u03c9", Gamma: "\u0393",
  Delta: "\u0394", Theta: "\u0398", Lambda: "\u039b", Xi: "\u039e",
  Pi: "\u03a0", Sigma: "\u03a3", Phi: "\u03a6", Psi: "\u03a8",
  Omega: "\u03a9", quad: " ", qquad: "  ", ",": " ", ";": " ", ":": " ",
};

const SUPERSCRIPTS = {
  0: "\u2070", 1: "\u00b9", 2: "\u00b2", 3: "\u00b3", 4: "\u2074",
  5: "\u2075", 6: "\u2076", 7: "\u2077", 8: "\u2078", 9: "\u2079",
  "+": "\u207a", "-": "\u207b", n: "\u207f", i: "\u2071",
};

const SUBSCRIPTS = {
  0: "\u2080", 1: "\u2081", 2: "\u2082", 3: "\u2083", 4: "\u2084",
  5: "\u2085", 6: "\u2086", 7: "\u2087", 8: "\u2088", 9: "\u2089",
  "+": "\u208a", "-": "\u208b", a: "\u2090", e: "\u2091", i: "\u1d62",
  o: "\u2092", x: "\u2093", n: "\u2099", t: "\u209c",
};

/** Convert one LaTeX fragment to readable Unicode text. */
function latexToText(src) {
  let out = src;
  // Font and emphasis wrappers carry no meaning once we are plain text.
  // `\b` matters: without it `\right` matches inside `\rightarrow` and leaves
  // the word "arrow" behind. The trailing space is preserved (not consumed) so
  // `\mathbf r\cdot\mathbf v` does not collapse into `r\cdotv`.
  out = out.replace(
    /\\(?:mathbf|mathrm|mathit|mathsf|mathtt|mathcal|mathbb|textbf|textit|text|operatorname|boxed|left|right)\b/g,
    "",
  );
  // Fractions degrade to a/b rather than pretending to stack.
  out = out.replace(/\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
  out = out.replace(/\\sqrt\s*\{([^{}]*)\}/g, "\u221a($1)");
  // Scripts, where every character has a Unicode form.
  out = out.replace(/\^\{?([A-Za-z0-9+-]+)\}?/g, (m, body) =>
    [...body].every((c) => SUPERSCRIPTS[c])
      ? [...body].map((c) => SUPERSCRIPTS[c]).join("")
      : m,
  );
  out = out.replace(/_\{?([A-Za-z0-9+-]+)\}?/g, (m, body) =>
    [...body].every((c) => SUBSCRIPTS[c])
      ? [...body].map((c) => SUBSCRIPTS[c]).join("")
      : m,
  );
  // Named symbols. Longest-first matching is implicit in the alternation being
  // built from the key list, which matters because stripping a font wrapper
  // consumes its trailing space: `\mathbf r\cdot\mathbf v` becomes
  // `r\cdotv`, and a greedy `\\([A-Za-z]+)` would read the command as "cdotv"
  // and leave it untouched.
  const names = Object.keys(LATEX_SYMBOLS)
    .filter((n) => /^[A-Za-z]+$/.test(n))
    .sort((a, b) => b.length - a.length)
    .join("|");
  out = out.replace(new RegExp(`\\\\(${names})`, "g"), (_m, name) => LATEX_SYMBOLS[name]);
  out = out.replace(/\\([,;:])/g, (m, name) => LATEX_SYMBOLS[name] ?? m);
  // Grouping braces have no meaning left.
  out = out.replace(/[{}]/g, "");
  return out.replace(/\s+/g, " ").trim();
}

/** Build a link, or plain text when the scheme is not one we trust. */
function buildLink(href, label) {
  if (!/^(https?:|mailto:)/i.test(href)) {
    return document.createTextNode(label);
  }
  const a = document.createElement("a");
  a.href = href;
  a.textContent = label;
  a.target = "_blank";
  // noopener/noreferrer: the opened page must not reach back via window.opener,
  // and must not learn the gateway URL through a Referer.
  a.rel = "noopener noreferrer";
  return a;
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
