/* jcode's paired mobile client. Native protocol, one socket, no dependencies. */
"use strict";

const $ = (id) => document.getElementById(id);
const el = {};
for (const id of [
  "pair-view", "pair-form", "pair-code", "pair-submit", "device-name", "pair-status", "pair-host",
  "sessions-view", "session-list", "sessions-empty", "sessions-status", "sessions-refresh", "sessions-unpair",
  "chat-view", "chat-back", "chat-title", "chat-phase", "transcript", "status-line", "composer",
  "composer-input", "composer-send", "composer-stop",
]) el[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id);
const on = (id, event, handler) => $(id)?.addEventListener(event, handler);
const storage = {
  get(key, fallback = null) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
};
const STORE_KEY = "jcode.credentials.v1";
const credentials = {
  load() { return storage.get(STORE_KEY, {})[location.host] || null; },
  save(value) { const all = storage.get(STORE_KEY, {}); all[location.host] = value; storage.set(STORE_KEY, all); },
  clear() { const all = storage.get(STORE_KEY, {}); delete all[location.host]; storage.set(STORE_KEY, all); },
};
function deviceID() {
  let id;
  try { id = localStorage.getItem("jcode.device-id"); } catch { /* private browsing */ }
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || "web-" + Math.random().toString(16).slice(2);
    try { localStorage.setItem("jcode.device-id", id); } catch { /* pairing still works */ }
  }
  return id;
}
function defaultDeviceName() {
  const ua = navigator.userAgent;
  for (const [pattern, name] of [[/iPhone/, "iPhone"], [/iPad/, "iPad"], [/Android/, "Android"], [/Mac OS X/, "Mac"], [/Windows/, "Windows"]]) {
    if (pattern.test(ua)) return `${name} (web)`;
  }
  return "Browser";
}
function setStatus(node, text, kind) {
  if (!node) return;
  node.textContent = text || "";
  if (kind) node.dataset.kind = kind;
  else delete node.dataset.kind;
}
function show(view) {
  el.pairView.hidden = view !== el.pairView;
  el.chatView.hidden = view !== el.chatView;
}
const dialogFocus = new WeakMap();
function openDialog(id) {
  const dialog = $(id);
  if (!dialog || dialog.open) return;
  dialogFocus.set(dialog, document.activeElement);
  dialog.hidden = false;
  dialog.showModal();
}
function closeDialog(id) { const dialog = $(id); if (dialog?.open) dialog.close(); }
function closeDialogs() { document.querySelectorAll("dialog[open]").forEach((d) => d.close()); }
let toastTimer;
function toast(text) {
  const node = $("toast"); if (!node) return;
  setStatus(node, text); node.hidden = !text; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 5000);
}

// Drafts and unacknowledged sends are both durable, scoped to this origin/session.
let draftSession = "new";
function draftKey(id = draftSession) { return `jcode.draft.v2:${location.origin}:${id}`; }
function draftRecord(id = draftSession) { return storage.get(draftKey(id), { text: "", pending: [] }); }
function saveDraft() {
  const record = draftRecord();
  record.text = el.composerInput.value;
  if (!storage.set(draftKey(), record)) toast("Draft storage is unavailable in this browser.");
}
function loadDraft(id) {
  draftSession = id || "new";
  const record = draftRecord();
  // An unacknowledged send is never silently discarded on reload.
  el.composerInput.value = [record.text, ...(record.pending || []).map((p) => p.content)].filter(Boolean).join("\n\n");
  if (record.pending?.length) toast("A message had unconfirmed delivery. Review the restored draft before resending.");
  record.text = el.composerInput.value;
  record.pending = [];
  storage.set(draftKey(), record);
  resizeComposer();
}
function migrateDraft(id) {
  if (!id || draftSession === id) return;
  const record = draftRecord();
  storage.set(draftKey(id), record);
  storage.set(draftKey(), { text: "", pending: [] });
  draftSession = id;
}

async function pair(code, name) {
  const response = await fetch("/pair", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, device_id: deviceID(), device_name: name || defaultDeviceName() }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Pairing failed (HTTP ${response.status})`);
  if (!data.token) throw new Error("Server returned no token");
  return data;
}
on("pair-form", "submit", async (event) => {
  event.preventDefault();
  const code = el.pairCode.value.replace(/\D/g, "");
  if (code.length !== 6) return setStatus(el.pairStatus, "Enter the 6-digit code.", "error");
  el.pairSubmit.disabled = true;
  setStatus(el.pairStatus, "Pairing…");
  try {
    const result = await pair(code, el.deviceName.value.trim());
    credentials.save({ token: result.token, serverName: result.server_name, serverVersion: result.server_version });
    el.pairCode.value = "";
    await newChat();
  } catch (error) { setStatus(el.pairStatus, error.message, "error"); }
  finally { el.pairSubmit.disabled = false; }
});
function openPairing(message) {
  saveDraft();
  connection.stop();
  closeDialogs();
  show(el.pairView);
  el.pairHost.textContent = `Server: ${location.host}`;
  el.deviceName.value ||= defaultDeviceName();
  setStatus(el.pairStatus, message || "", message ? "error" : null);
  el.pairCode.focus();
}
function unauthorized() {
  credentials.clear();
  openPairing("This device is no longer paired. Enter a new code.");
}

// Directory refresh never opens a socket and never overlaps another refresh.
let sessions = [];
let directoryRequest = null;
let directoryTimer = null;
let showAll = false;
let workingDir = "";
let directoryLoaded = false;
function relativeTime(ms) {
  if (!ms) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
function shortPath(path) { return (path || "").replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~"); }
function projectLabel(path) {
  const short = shortPath(path);
  const name = short.split("/").filter(Boolean).pop() || short;
  const matches = availableDirectories().filter((dir) => shortPath(dir).split("/").filter(Boolean).pop() === name);
  return matches.length > 1 ? short : name;
}
function validDirectory(path) { return typeof path === "string" && /^(\/|[A-Za-z]:[\\/])/.test(path) && !/[\x00-\x1f]/.test(path); }
function availableDirectories() {
  return [...new Set(sessions.filter((s) => validDirectory(s.working_dir)).map((s) => s.working_dir))];
}
async function fetchSessions(token) {
  const response = await fetch("/sessions?limit=200", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (response.status === 401 || response.status === 403) throw new Error("unauthorized");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.sessions) ? data.sessions : [];
}
function scheduleDirectory() {
  clearTimeout(directoryTimer);
  if (document.visibilityState === "visible" && navigator.onLine !== false && credentials.load()) directoryTimer = setTimeout(refreshSessions, 3000);
}
async function refreshSessions() {
  if (directoryRequest) return directoryRequest;
  if (document.visibilityState !== "visible" || navigator.onLine === false) return;
  const creds = credentials.load();
  if (!creds) return;
  clearTimeout(directoryTimer);
  if (!directoryLoaded) setStatus(el.sessionsStatus, "Loading conversations…");
  directoryRequest = (async () => {
    try {
      const result = await fetchSessions(creds.token);
      if (credentials.load()?.token !== creds.token) return;
      sessions = result.sort((a, b) => (b.updated_at_ms || 0) - (a.updated_at_ms || 0));
      directoryLoaded = true;
      if (!workingDir && !connection.sessionID) workingDir = availableDirectories()[0] || "";
      updateProjects();
      renderSessions();
      const active = sessions.find((s) => s.id === connection.sessionID);
      if (active) {
        if (!view.renameRequest && active.title && active.title !== "New conversation") {
          view.knownTitle = active.title; el.chatTitle.textContent = view.knownTitle;
        }
        if (!workingDir && validDirectory(active.working_dir)) workingDir = active.working_dir;
      }
      updateComposer();
    } catch (error) {
      if (error.message === "unauthorized") unauthorized();
      else setStatus(el.sessionsStatus, `Could not refresh conversations: ${error.message}. Use Refresh to retry.`, "error");
    } finally { directoryRequest = null; scheduleDirectory(); }
  })();
  return directoryRequest;
}
function filteredSessions() {
  const query = ($("session-search")?.value || "").trim().toLowerCase();
  const project = $("project-filter")?.value || "";
  return sessions.filter((s) => {
    // Unknown-count legacy sessions must remain discoverable by default.
    if (!showAll && s.message_count === 0 && !s.saved) return false;
    if (project && s.working_dir !== project) return false;
    return !query || [s.title, s.preview, s.working_dir].some((v) => String(v || "").toLowerCase().includes(query));
  });
}
function renderSessions() {
  const visible = filteredSessions();
  const signature = JSON.stringify([visible, connection.sessionID, showAll, $("session-search")?.value, $("project-filter")?.value]);
  // No conversation count: this is a single-user client, so "1,999 conversations"
  // is noise. Only the one fact that changes behaviour is worth a line.
  setStatus(el.sessionsStatus, !showAll && sessions.some((s) => s.message_count === 0 && !s.saved) ? "Empty chats hidden. Show all to see them." : "");
  // Do not destroy keyboard focus in the drawer every three seconds.
  if (el.sessionList.dataset.signature === signature) return;
  el.sessionList.dataset.signature = signature;
  const focusedID = document.activeElement?.dataset.sessionId;
  el.sessionList.textContent = "";
  el.sessionsEmpty.hidden = visible.length > 0;
  if (!visible.length) {
    let title = el.sessionsEmpty.querySelectorAll(".empty-title")[0];
    let hint = el.sessionsEmpty.querySelectorAll(".empty-hint")[0];
    if (!title) { title = document.createElement("p"); title.className = "empty-title"; el.sessionsEmpty.append(title); }
    if (!hint) { hint = document.createElement("p"); hint.className = "empty-hint"; el.sessionsEmpty.append(hint); }
    setStatus(title, sessions.length ? "No matching conversations" : "A fresh start.");
    setStatus(hint, sessions.length ? "Clear search or project filters, or show all conversations." : "No conversations yet. Start a new chat below.");
  }
  let previousGroup = "";
  for (const session of visible) {
    const age = Date.now() - (session.updated_at_ms || 0);
    const group = age < 86400000 ? "Today" : age < 604800000 ? "Previous 7 days" : "Earlier";
    if (group !== previousGroup) {
      const heading = document.createElement("li"); heading.className = "session-group"; heading.textContent = group;
      el.sessionList.append(heading); previousGroup = group;
    }
    const item = document.createElement("li");
    const button = document.createElement("button"); button.type = "button"; button.className = "session-row";
    button.dataset.sessionId = session.id;
    if (session.id === connection.sessionID) button.setAttribute("aria-current", "page");
    const title = document.createElement("span"); title.className = "session-title"; title.textContent = session.title || "New conversation";
    const meta = document.createElement("span"); meta.className = "session-meta";
    meta.textContent = [projectLabel(session.working_dir), relativeTime(session.updated_at_ms)].filter(Boolean).join(" · ");
    // Two-line rows: title + metadata only. The preview stays searchable in the
    // session data and surfaces on hover, so row height does not change when the
    // server starts returning enriched previews.
    if (session.preview) button.title = session.preview;
    button.append(title, meta);
    if (session.live) { const live = document.createElement("span"); live.className = "session-live"; live.textContent = "Live"; meta.append(document.createTextNode(" · "), live); }
    button.addEventListener("click", () => openChat(session)); item.append(button); el.sessionList.append(item);
    if (focusedID === session.id) button.focus({ preventScroll: true });
  }
}
function updateProjects() {
  const select = $("project-filter");
  const paths = availableDirectories();
  if (select && select.dataset.paths !== JSON.stringify(paths)) {
    const selected = select.value;
    select.textContent = "";
    for (const path of ["", ...paths]) { const option = document.createElement("option"); option.value = path; option.textContent = path ? shortPath(path) : "All projects"; select.append(option); }
    select.value = paths.includes(selected) ? selected : "";
    select.dataset.paths = JSON.stringify(paths);
  }
  const list = $("project-list");
  if (list) {
    list.textContent = "";
    for (const path of paths) {
      const button = document.createElement("button"); button.type = "button"; button.className = "project-option"; button.textContent = shortPath(path);
      button.addEventListener("click", () => chooseProject(path)); list.append(button);
    }
  }
}
async function openSessions() { openDialog("sessions-view"); await refreshSessions(); }

// One transport. Every replacement detaches handlers and closes the stale socket.
const connection = {
  // Terminal turn events fan out across clients; use a browser-random request namespace.
  socket: null, token: null, sessionID: null, nextRequestID: Math.floor(Math.random() * 2 ** 48) + 1, attempt: 0, timer: null,
  stopped: true, attached: false, fatalReason: null, attachRequestID: null,
  historyRequestID: null, syncRequestID: null, syncError: null, catalogRequests: new Set(), requests: new Map(),
  start(token, sessionID) {
    this.stop(); this.stopped = false; this.token = token; this.sessionID = sessionID || null;
    this.attempt = 0; this.fatalReason = null; this.open();
  },
  closeSocket() {
    const socket = this.socket; this.socket = null; this.attached = false; this.syncRequestID = null; this.syncError = null;
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; try { socket.close(); } catch { /* already closed */ } }
  },
  stop() { this.stopped = true; clearTimeout(this.timer); this.closeSocket(); this.catalogRequests.clear(); this.requests.clear(); },
  open() {
    if (this.stopped || !this.token || document.visibilityState !== "visible" || navigator.onLine === false) return;
    clearTimeout(this.timer); this.closeSocket();
    this.catalogRequests.clear(); this.requests.clear();
    view.modelRequest = null; view.renameRequest = null;
    renderModels();
    setPhase(this.attempt ? "reconnecting" : "connecting");
    let socket;
    try { socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(this.token)}`); }
    catch { this.scheduleReconnect(); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      this.attempt = 0;
      setPhase("connecting", "Loading conversation…");
      const request = { type: "subscribe", continue_on_disconnect: true };
      if (this.sessionID) request.target_session_id = this.sessionID;
      else request.working_dir = workingDir;
      this.attachRequestID = this.send(request);
      this.historyRequestID = this.send({ type: "get_history" });
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      for (const line of String(message.data).split("\n")) {
        if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event && typeof event === "object") handleEvent(event);
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null; this.attached = false; updateComposer();
      if ([1008, 4401, 4403].includes(event.code)) return unauthorized();
      if (this.fatalReason) { setPhase("failed", "Unavailable"); return; }
      // Browsers hide HTTP handshake status. The authenticated directory detects revocation.
      refreshSessions();
      this.scheduleReconnect();
    };
    socket.onerror = () => {};
  },
  scheduleReconnect() {
    if (this.stopped || this.fatalReason) return;
    this.attempt += 1; setPhase("reconnecting"); clearTimeout(this.timer);
    if (document.visibilityState === "visible") this.timer = setTimeout(() => this.open(), Math.min(1000 * 2 ** Math.min(this.attempt - 1, 5), 30000));
  },
  reconnectSoon() {
    if (this.stopped) return;
    this.closeSocket(); clearTimeout(this.timer); setPhase("reconnecting");
    this.timer = setTimeout(() => this.open(), 500);
  },
  send(request) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const id = this.nextRequestID++;
    try { this.socket.send(JSON.stringify({ id, ...request })); this.requests.set(id, request.type); return id; }
    catch { return false; }
  },
  syncHistory(error = null) {
    if (error) this.syncError = error;
    if (this.attached && !this.syncRequestID) this.syncRequestID = this.send({ type: "get_history" }) || null;
  },
  catalog() { if (!this.attached) return; const id = this.send({ type: "get_model_catalog" }); if (id) this.catalogRequests.add(id); },
};
function setPhase(phase, label) {
  el.chatPhase.dataset.phase = phase;
  el.chatPhase.hidden = phase === "new";
  el.chatPhase.textContent = label || ({ connected: "Connected", connecting: "Connecting…", reconnecting: "Reconnecting…", failed: "Offline", disconnected: "Not connected", new: "" }[phase] || phase);
  updateComposer();
}

// The injection-safe markdown/math renderer below is intentionally unchanged.
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

/**
 * jcode marks a reasoning line as `*<U+2063>body<U+2063>*`, with the body's
 * inline markdown backslash-escaped so it renders literally inside the
 * emphasis run (see `jcode-render-core/src/reasoning.rs`). That is a protocol
 * detail, not something a reader should see: on the deployed app it surfaced as
 * literal `**Clarifying ...**` wrapped in invisible separators.
 *
 * Returns the unescaped body when `line` is a reasoning line, else null.
 */
function reasoningLineContent(line) {
  const trimmed = line.replace(/[\s\r\n]+$/, "");
  if (!trimmed.startsWith("*\u2063") || !trimmed.endsWith("\u2063*")) return null;
  const body = trimmed.slice(2, -2);
  if (!body) return null;
  // Mirror REASONING_ESCAPES from the Rust side exactly.
  return body.replace(/\\([\\*_`[\]<>&~|$])/g, "$1");
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

    // A reasoning line is jcode's own marker, not user-visible markdown.
    const reasoning = reasoningLineContent(line);
    if (reasoning !== null) {
      flushParagraph(para);
      const div = document.createElement("div");
      div.className = "reasoning-line";
      div.textContent = reasoning;
      out.push(div);
      i += 1;
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

// --- end renderer ---
// tests/web_client_markdown.test.js slices the renderer out of this file by
// text position, between `function renderMarkdown` and this marker, because the
// file is a browser script that cannot be required. Keep this marker directly
// after the last renderer function. The comment it previously keyed on was
// deleted in an unrelated edit, which silently broke that CI job: the slice
// came back empty and every renderer test stopped running.

// Transcript mutations capture the scroll position BEFORE growing the content.
function isPinnedToBottom() { const n = el.transcript; return n.scrollHeight - n.scrollTop - n.clientHeight < 80; }
function updateJump() { if ($("jump-latest")) $("jump-latest").hidden = isPinnedToBottom(); }
function scrollToBottom(force = false) { if (force) el.transcript.scrollTop = el.transcript.scrollHeight; updateJump(); }
function updateWelcome() { if ($("welcome")) $("welcome").hidden = el.transcript.children.length > 0; }
async function copyText(text) {
  if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP or denied: use selection */ } }
  const focused = document.activeElement;
  const input = document.createElement("textarea"); input.value = text; input.style.position = "fixed"; input.style.opacity = "0";
  document.body.append(input); input.select();
  try { if (!document.execCommand("copy")) throw new Error("Copy is unavailable. Select the response to copy it."); }
  finally { input.remove(); focused?.focus({ preventScroll: true }); }
}
function addCopy(node, text) {
  if (!text) return;
  const button = document.createElement("button"); button.type = "button"; button.className = "message-copy";
  button.textContent = "Copy"; button.setAttribute("aria-label", "Copy response");
  button.addEventListener("click", async () => {
    try { await copyText(text); toast("Response copied."); } catch (error) { toast(error.message); }
  });
  node.append(button);
}
function renderMessage(node, text, copy = false) {
  renderMarkdown(node, text);
  // Preserve the renderer, but put its historical reasoning markers in disclosures.
  for (const line of [...node.querySelectorAll(".reasoning-line")]) {
    const details = document.createElement("details"); details.className = "trace reasoning";
    const summary = document.createElement("summary"); summary.textContent = "Thinking";
    line.replaceWith(details); details.append(summary, line);
  }
  if (copy) addCopy(node, text);
}
function addMessage(role, text) {
  const pinned = isPinnedToBottom();
  const node = document.createElement("div"); node.className = `msg ${role}`;
  renderMessage(node, text, role === "assistant"); el.transcript.append(node);
  updateWelcome(); scrollToBottom(pinned); return node;
}
const view = {
  streaming: null, streamingText: "", reasoning: null, reasoningText: "", tools: new Map(), pendingToolInput: null,
  processing: false, stopping: false, knownTitle: "", model: "", models: [], optimistic: [],
  modelRequest: null, renameRequest: null, queuedSend: false,
};
function resetView() {
  el.transcript.textContent = ""; view.streaming = null; view.streamingText = ""; view.reasoning = null; view.reasoningText = "";
  view.tools.clear(); view.pendingToolInput = null; view.optimistic = [];
  setProcessing(false); setStatusLine(""); updateWelcome(); updateJump();
}
function updateComposer() {
  const attached = connection.attached && connection.socket?.readyState === WebSocket.OPEN;
  el.composerSend.hidden = false; // Follow-up remains available while a turn is running.
  el.composerSend.disabled = !el.composerInput.value.trim() || (!attached && !connection.stopped) || Boolean(connection.fatalReason);
  el.composerSend.setAttribute("aria-label", view.processing ? "Send follow-up" : "Send message");
  el.composerStop.hidden = !view.processing;
  el.composerStop.disabled = !attached || view.stopping;
  el.chatView.dataset.processing = String(view.processing);
  if ($("composer-model-name")) $("composer-model-name").textContent = modelLabel(view.model) || "Choose model";
  if ($("composer-project-name")) $("composer-project-name").textContent = shortPath(workingDir).split("/").pop() || shortPath(workingDir) || "Choose project";
  if ($("composer-project")) $("composer-project").disabled = Boolean(connection.sessionID);
  setStatus($("composer-hint"), view.stopping ? "Stopping…" : view.processing ? "You can send a follow-up while Jcode works." : "");
}
function setProcessing(active) { view.processing = active; if (!active) view.stopping = false; updateComposer(); }
function setStatusLine(text) { el.statusLine.textContent = text || ""; el.statusLine.hidden = !text; }
function endStreaming() {
  if (view.streaming) { view.streaming.classList.remove("streaming"); addCopy(view.streaming, view.streamingText); }
  view.streaming = null; view.streamingText = ""; view.reasoning = null; view.reasoningText = "";
}
function appendDelta(text) {
  const pinned = isPinnedToBottom();
  if (!view.streaming) { view.streaming = addMessage("assistant", ""); view.streaming.classList.add("streaming"); view.streamingText = ""; }
  view.streamingText += text; renderMessage(view.streaming, view.streamingText); scrollToBottom(pinned);
}
function appendReasoning(text) {
  const pinned = isPinnedToBottom();
  if (!view.reasoning) {
    const details = document.createElement("details"); details.className = "trace reasoning";
    const summary = document.createElement("summary"); summary.textContent = "Thinking";
    const body = document.createElement("div"); body.className = "reasoning-body";
    details.append(summary, body); el.transcript.append(details); view.reasoning = body; view.reasoningText = ""; updateWelcome();
  }
  view.reasoningText += text; view.reasoning.textContent = view.reasoningText; scrollToBottom(pinned);
}
function startTool(id, name) {
  if (view.tools.has(id)) return view.tools.get(id);
  const pinned = isPinnedToBottom();
  const node = document.createElement("details"); node.className = "trace tool";
  const summary = document.createElement("summary");
  const label = document.createElement("span"); label.className = "tool-name"; label.textContent = name || "Tool";
  const status = document.createElement("span"); status.className = "tool-status"; status.textContent = "Preparing";
  summary.append(label, status);
  const body = document.createElement("div"); body.className = "tool-body"; node.append(summary, body); el.transcript.append(node);
  const record = { node, summary, status, body, input: "" }; view.tools.set(id, record); view.pendingToolInput = record;
  updateWelcome(); scrollToBottom(pinned); return record;
}
function finishTool(id, name, output, error) {
  const pinned = isPinnedToBottom(); const record = view.tools.get(id) || startTool(id, name);
  view.pendingToolInput = null; record.node.classList.toggle("failed", Boolean(error));
  record.status.textContent = error ? "Failed" : "Done";
  record.body.textContent = error ? `Error: ${error}\n${output || ""}` : output || "";
  scrollToBottom(pinned);
}
function updateCatalog(event) {
  if (typeof event.provider_model === "string") view.model = event.provider_model;
  if (Array.isArray(event.available_models)) {
    const routes = event.available_model_routes || [];
    // IDs come exclusively from the server's selectable catalog, not invented labels.
    view.models = [...new Set(event.available_models)].filter((m) => typeof m === "string").map((model) => {
      const route = routes.find((r) => r.model === model);
      return { model, provider: route?.provider || "", available: route?.available !== false };
    });
  }
  renderModels(); updateComposer();
}
function modelLabel(id) {
  const raw = String(id || "");
  const claude = raw.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d{1,2}))?(?:-\d{8})?$/i);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1).toLowerCase()} ${claude[2]}${claude[3] ? "." + claude[3] : ""}`;
  const gpt = raw.match(/^gpt-(\d+(?:\.\d+)?)(?:-(astra|luna|mini|nano|pro))?(?:-\d{4}-\d{2}-\d{2})?$/i);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? " " + gpt[2][0].toUpperCase() + gpt[2].slice(1).toLowerCase() : ""}`;
  return raw;
}
function renderModels() {
  const list = $("model-list"); if (!list) return;
  list.textContent = "";
  const query = ($("model-search")?.value || "").toLowerCase();
  const models = view.models.filter((m) => `${m.model} ${m.provider}`.toLowerCase().includes(query));
  for (const model of models) {
    const button = document.createElement("button"); button.type = "button"; button.className = "model-option";
    button.disabled = !connection.attached || !model.available || Boolean(view.modelRequest);
    button.setAttribute("aria-pressed", String(model.model === view.model));
    const name = document.createElement("span"); name.textContent = modelLabel(model.model);
    const provider = document.createElement("span"); provider.className = "model-provider"; provider.textContent = [model.provider, modelLabel(model.model) !== model.model ? model.model : ""].filter(Boolean).join(" · ");
    button.append(name); if (provider.textContent) button.append(provider); button.addEventListener("click", () => selectModel(model.model)); list.append(button);
  }
  if (!view.modelRequest) setStatus($("model-status"), models.length ? "" : connection.attached ? "No matching models are available from this server." : "Connect to load available models.");
}
function selectModel(model) {
  if (!connection.attached || view.modelRequest) return;
  view.modelRequest = connection.send({ type: "set_model", model }) || null;
  setStatus($("model-status"), view.modelRequest ? "Changing model…" : "Not connected. Model unchanged.", view.modelRequest ? null : "error");
  renderModels(); refreshSessions();
}
function acknowledge(id) {
  const record = draftRecord(); record.pending = (record.pending || []).filter((p) => p.id !== id); storage.set(draftKey(), record);
}
function echoUser(content, kind = "user_message", displayRole) {
  const optimistic = view.optimistic.find((m) => m.content === content && !m.echoes.has(kind));
  if (optimistic) { optimistic.echoes.add(kind); acknowledge(optimistic.id); optimistic.node.dataset.pending = "false"; return; }
  addMessage(displayRole === "system" ? "system" : "user", content);
}
function recoverSend(id) {
  const record = draftRecord(); const failed = (record.pending || []).filter((p) => p.id === id);
  if (!failed.length) return;
  el.composerInput.value = [el.composerInput.value, ...failed.map((p) => p.content)].filter(Boolean).join("\n\n");
  acknowledge(id); saveDraft(); resizeComposer(); updateComposer();
  const optimistic = view.optimistic.find((p) => p.id === id);
  if (optimistic) { optimistic.node.dataset.pending = "failed"; optimistic.node.setAttribute("aria-label", "Message not sent"); }
}
function acceptSession(id) {
  if (!id) return;
  if (!connection.sessionID) migrateDraft(id);
  connection.sessionID = id;
  history.replaceState({ session: id }, "", `#${encodeURIComponent(id)}`);
  updateComposer();
}
function handleEvent(event) {
  switch (event.type) {
    case "history": {
      updateCatalog(event);
      if (connection.catalogRequests.delete(event.id)) { connection.requests.delete(event.id); break; }
      const syncError = event.id === connection.syncRequestID ? connection.syncError : null;
      if (event.id === connection.syncRequestID) { connection.syncRequestID = null; connection.syncError = null; }
      const preservePosition = el.transcript.children.length > 0;
      acceptSession(event.session_id); connection.attached = true; connection.fatalReason = null;
      renderHistory(event, preservePosition);
      if (syncError) addMessage("error", syncError);
      setPhase("connected"); renderModels();
      connection.requests.delete(event.id);
      if (view.queuedSend) { view.queuedSend = false; sendMessage(); }
      refreshSessions(); break;
    }
    case "available_models_updated": updateCatalog(event); break;
    case "model_changed":
      if (!event.error) { view.model = event.model || view.model; setStatus($("model-status"), "Model updated.", "ok"); closeDialog("model-dialog"); }
      view.modelRequest = null; connection.requests.delete(event.id); updateComposer(); renderModels();
      if (event.error) setStatus($("model-status"), event.error, "error");
      refreshSessions(); break;
    case "text_delta": setProcessing(true); appendDelta(event.text || ""); break;
    case "text_replace": {
      const pinned = isPinnedToBottom(); if (!view.streaming) appendDelta(""); view.streamingText = event.text || "";
      renderMessage(view.streaming, view.streamingText); scrollToBottom(pinned); break;
    }
    case "reasoning_delta": setProcessing(true); appendReasoning(event.text || ""); break;
    case "reasoning_done": view.reasoning = null; view.reasoningText = ""; break;
    case "tool_start": setProcessing(true); startTool(event.id, event.name); break;
    case "tool_exec": startTool(event.id, event.name).status.textContent = "Running"; break;
    case "tool_input": if (view.pendingToolInput) { view.pendingToolInput.input += event.delta || ""; view.pendingToolInput.body.textContent = view.pendingToolInput.input; } break;
    case "tool_done": finishTool(event.id, event.name, event.output, event.error); break;
    case "message_end": endStreaming(); break; // A tool-use message is not the end of the turn.
    case "done": {
      const request = connection.requests.get(event.id);
      if (!request || request === "message" || request === "cancel") {
        endStreaming(); setProcessing(false); setStatusLine(""); refreshSessions();
        // Native fanout has no ordinary user-message echo. Reconcile observer prompts at the turn boundary.
        connection.syncHistory();
      }
      acknowledge(event.id); connection.requests.delete(event.id); break;
    }
    case "interrupted": endStreaming(); setProcessing(false); setStatusLine("Stopped."); connection.syncHistory(); refreshSessions(); break;
    case "status_detail": setStatusLine(event.detail || ""); break;
    case "tokens": setStatusLine(`${event.input} in / ${event.output} out`); break;
    case "state": setProcessing(Boolean(event.is_processing)); break;
    case "session": acceptSession(event.session_id); break;
    case "session_renamed": {
      const title = event.display_title || event.title || "New conversation";
      const session = sessions.find((s) => s.id === event.session_id); if (session) session.title = title;
      if (!event.session_id || event.session_id === connection.sessionID) { view.knownTitle = title; el.chatTitle.textContent = title; }
      connection.requests.delete(view.renameRequest); view.renameRequest = null; closeDialog("rename-dialog"); setStatus($("rename-status"), ""); renderSessions(); refreshSessions(); break;
    }
    case "user_message": echoUser(event.content || event.text || "", "user_message", event.display_role); break;
    case "soft_interrupt": echoUser(event.content || event.text || "", "soft_interrupt", event.display_role); break;
    case "soft_interrupt_injected": echoUser(event.content || "", "soft_interrupt_injected", event.display_role); break;
    case "error": {
      const message = event.message || "Server error";
      const request = connection.requests.get(event.id);
      if (event.id === connection.syncRequestID) connection.syncRequestID = null;
      connection.catalogRequests.delete(event.id);
      if (!connection.attached && (event.id === connection.attachRequestID || event.id === connection.historyRequestID)) {
        connection.fatalReason = message; connection.stop(); view.queuedSend = false; setPhase("failed", "Unavailable");
      }
      if (event.id === view.modelRequest) { view.modelRequest = null; renderModels(); setStatus($("model-status"), message, "error"); }
      if (event.id === view.renameRequest) { view.renameRequest = null; setStatus($("rename-status"), message, "error"); }
      // Broadcast terminal failures retain the originating client’s request ID.
      // Known local control failures must not terminate an unrelated active turn.
      if (request === "message" || (!request && connection.attached)) {
        endStreaming(); setProcessing(false); setStatusLine(""); connection.syncHistory(message);
      }
      if (connection.requests.get(event.id) === "cancel") { view.stopping = false; updateComposer(); }
      recoverSend(event.id); addMessage("error", message); connection.requests.delete(event.id); break;
    }
    case "reloading": setStatusLine("Server reloading…"); connection.reconnectSoon(); break;
    case "session_close_requested": connection.stop(); setPhase("failed", "Closed"); addMessage("system", event.reason || "Session closed by server"); break;
    case "compaction": setStatusLine(`Context compacted (${event.trigger || "auto"}).`); break;
    case "notification": addMessage("system", event.message || ""); break;
    default: break; // Forward compatibility: unknown events do not break the stream.
  }
}
function promptTitle(content) {
  const title = String(content || "").replace(/\s+/g, " ").trim();
  return title.length > 80 ? `${title.slice(0, 80)}…` : title;
}
function usePromptTitle(content) {
  if (!view.knownTitle || view.knownTitle === "New conversation") {
    view.knownTitle = promptTitle(content) || "New conversation";
    el.chatTitle.textContent = view.knownTitle;
  }
}
function renderHistory(event, preservePosition = false) {
  const pinned = isPinnedToBottom(); const scrollTop = el.transcript.scrollTop;
  const pending = draftRecord().pending || [];
  const previousTools = new Map(view.tools);
  resetView();
  usePromptTitle((event.messages || []).find((m) => m.role === "user" && m.content)?.content);
  el.chatTitle.textContent = event.display_title || view.knownTitle || "New conversation";
  const users = [];
  for (const [index, message] of (event.messages || []).entries()) {
    // Native persisted tool results have role=tool, output in content, and call metadata in tool_data.
    // Handle them before the prose-role filter rather than dropping them at reconciliation.
    if (message.tool_data || message.role === "tool") {
      const data = message.tool_data || {};
      const id = data.id || `history-tool-${index}`;
      const record = startTool(id, data.name || "Tool");
      record.input = typeof data.input === "string" ? data.input : JSON.stringify(data.input ?? {});
      finishTool(id, data.name || "Tool", message.content || data.output || "", data.error);
      const previous = previousTools.get(id);
      record.node.open = previous?.node.open || false;
      if (previous?.status.textContent === "Failed") { record.status.textContent = "Failed"; record.node.classList.add("failed"); }
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.content) addMessage(message.role, message.content);
    if (message.role === "user") users.push(message.content);
  }
  // Reconcile only the post-send portion of history, so an older identical prompt is not an ACK.
  for (const p of pending) {
    if (users.slice(p.userCount || 0).includes(p.content)) acknowledge(p.id);
    else {
      const node = addMessage("user", p.content); node.dataset.pending = "true";
      view.optimistic.push({ ...p, node, echoes: new Set() });
    }
  }
  setProcessing(Boolean(event.activity?.is_processing));
  if (event.status_detail) setStatusLine(event.status_detail);
  if (preservePosition && !pinned) { el.transcript.scrollTop = scrollTop; updateJump(); }
  else scrollToBottom(true);
}

// Navigation starts with a local welcome, and creates a real session only when needed.
// Set while a switch is in flight. A second tap on a phone arrives well before
// the socket attaches, and without this it started a second connection to the
// same chat and re-rendered the transcript underneath the first.
let switching = "";
function openChat(session, push = true) {
  if (!credentials.load()) return openPairing();
  if (switching && switching === session.id) { closeDialogs(); show(el.chatView); return; }
  // Re-selecting the chat you are already in must be a no-op, not a reload.
  // Without this, tapping the current row in the drawer pushed another history
  // entry for the same chat and tore down a healthy socket, so Back appeared to
  // "take you to the same chat multiple times" and the transcript flickered.
  if (session.id && session.id === connection.sessionID && !connection.stopped) {
    closeDialogs();
    show(el.chatView);
    return;
  }
  switching = session.id || "";
  // Cleared on a timer, not on attach: a chat that fails to connect must not
  // become permanently unopenable. One second is far longer than a double tap
  // and far shorter than a user's next deliberate switch.
  setTimeout(() => { if (switching === (session.id || "")) switching = ""; }, 1000);
  saveDraft(); closeDialogs(); show(el.chatView); resetView();
  view.knownTitle = session.title || "New conversation"; view.model = session.model || ""; view.models = [];
  view.queuedSend = false; view.modelRequest = null; view.renameRequest = null;
  workingDir = validDirectory(session.working_dir) ? session.working_dir : "";
  el.chatTitle.textContent = view.knownTitle; loadDraft(session.id);
  connection.start(credentials.load().token, session.id);
  // Replace rather than push when the URL already points at this chat,
  // otherwise every visit stacks a duplicate entry that Back has to walk.
  const hash = `#${encodeURIComponent(session.id)}`;
  if (!push || location.hash === hash) history.replaceState({ session: session.id }, "", hash);
  else history.pushState({ session: session.id }, "", hash);
  refreshSessions();
}
async function newChat(push = true) {
  if (!credentials.load()) return openPairing();
  saveDraft(); connection.stop(); connection.sessionID = null; connection.fatalReason = null;
  closeDialogs(); show(el.chatView); resetView();
  view.knownTitle = ""; view.model = ""; view.models = []; view.queuedSend = false; view.modelRequest = null; view.renameRequest = null;
  workingDir = availableDirectories()[0] || "";
  el.chatTitle.textContent = "New conversation"; loadDraft("new"); setPhase("new");
  // Same rule as openChat: do not stack duplicate "new chat" entries.
  if (!push || location.hash === "#" || location.hash === "") history.replaceState({}, "", "#");
  else history.pushState({}, "", "#");
  await refreshSessions();
}
function ensureSession() {
  if (connection.attached) return true;
  if (!connection.stopped) return false;
  if (!validDirectory(workingDir)) {
    setStatus($("project-status"), "Choose a project or enter an absolute working directory first."); openDialog("project-dialog"); return false;
  }
  const creds = credentials.load(); if (!creds) { openPairing(); return false; }
  connection.start(creds.token, null); return false;
}
function chooseProject(path) {
  if (!validDirectory(path)) return setStatus($("project-status"), "Enter an absolute directory on the server, such as /home/you/project.", "error");
  if (connection.sessionID) return;
  // A pre-attach project change must not leave a stale in-flight subscribe.
  if (!connection.stopped) connection.stop();
  workingDir = path; closeDialog("project-dialog"); updateComposer(); refreshSessions();
  if (view.queuedSend || $("model-dialog")?.open) ensureSession();
}
function resizeComposer() {
  el.composerInput.style.height = "auto";
  el.composerInput.style.height = `${Math.min(el.composerInput.scrollHeight, window.innerHeight * 0.4)}px`;
}
function sendMessage() {
  const content = el.composerInput.value.trim(); if (!content) return;
  saveDraft();
  if (!connection.attached) {
    if (connection.fatalReason || (connection.sessionID && !connection.attached)) { toast("Not connected. Your draft is saved."); return; }
    view.queuedSend = true; ensureSession(); return;
  }
  const request = view.processing ? { type: "soft_interrupt", content, urgent: false } : { type: "message", content };
  const id = connection.send(request);
  if (!id) { toast("Not connected. Message not sent. Your draft is saved."); return; }
  const record = draftRecord();
  const pending = { id, content, userCount: el.transcript.querySelectorAll(".msg.user").length };
  record.pending = [...(record.pending || []), pending]; record.text = ""; storage.set(draftKey(), record);
  if (pending.userCount === 0) usePromptTitle(content);
  const node = addMessage("user", content); node.dataset.pending = "true";
  view.optimistic.push({ ...pending, node, echoes: new Set() });
  if (view.optimistic.length > 100) view.optimistic.shift();
  if (!view.processing) { endStreaming(); setProcessing(true); }
  el.composerInput.value = ""; resizeComposer(); updateComposer(); scrollToBottom(true); refreshSessions();
}
on("composer", "submit", (event) => { event.preventDefault(); sendMessage(); });
on("composer-input", "input", () => { resizeComposer(); saveDraft(); updateComposer(); });
on("composer-input", "keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !window.matchMedia("(pointer: coarse)").matches) { event.preventDefault(); sendMessage(); }
});
on("composer-stop", "click", () => {
  if (!connection.attached || !connection.send({ type: "cancel" })) return toast("Not connected. Could not send stop.");
  view.stopping = true; updateComposer(); setStatusLine("Stopping…"); refreshSessions();
});
on("chat-back", "click", openSessions);
on("sessions-close", "click", () => closeDialog("sessions-view"));
on("sessions-refresh", "click", refreshSessions);
on("sessions-new", "click", () => newChat());
on("chat-new", "click", () => newChat());
on("session-search", "input", renderSessions);
on("project-filter", "change", renderSessions);
on("sessions-all", "click", () => { showAll = !showAll; $("sessions-all").setAttribute("aria-pressed", String(showAll)); renderSessions(); });
on("jump-latest", "click", () => scrollToBottom(true));
on("transcript", "scroll", updateJump);
on("composer-model", "click", () => { openDialog("model-dialog"); renderModels(); if (ensureSession()) connection.catalog(); });
on("model-search", "input", renderModels);
on("composer-project", "click", () => { updateProjects(); if ($("project-input")) $("project-input").value = workingDir; openDialog("project-dialog"); });
on("project-form", "submit", (event) => { event.preventDefault(); chooseProject($("project-input").value.trim()); });
on("chat-more", "click", () => {
  setStatus($("details-project"), workingDir || "Not selected"); setStatus($("details-model"), view.model || "Not connected");
  setStatus($("details-session"), connection.sessionID || "New conversation");
  if ($("rename-open")) $("rename-open").disabled = !connection.attached;
  openDialog("more-dialog");
});
on("rename-open", "click", () => { closeDialog("more-dialog"); $("rename-input").value = view.knownTitle || ""; openDialog("rename-dialog"); });
on("rename-form", "submit", (event) => {
  event.preventDefault(); if (!connection.attached || view.renameRequest) return;
  const title = $("rename-input").value.trim();
  view.renameRequest = connection.send({ type: "rename_session", title: title || null }) || null;
  setStatus($("rename-status"), view.renameRequest ? "Renaming…" : "Not connected. Title unchanged."); refreshSessions();
});
on("drawer-settings", "click", () => { setStatus($("settings-host"), `${credentials.load()?.serverName || "Jcode"} · ${location.host}`); openDialog("settings-dialog"); });
on("sessions-unpair", "click", () => {
  if (!confirm("Forget this server on this device? Drafts will stay on this device.")) return;
  credentials.clear(); openPairing("Unpaired.");
});
for (const button of document.querySelectorAll("[data-close-dialog]")) button.addEventListener("click", () => closeDialog(button.dataset.closeDialog));
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", () => { const prior = dialogFocus.get(dialog); if (prior?.isConnected && !prior.closest("[hidden]")) prior.focus({ preventScroll: true }); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
}
const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const choice = storage.get("jcode.theme.v1", "system");
  const theme = choice === "dark" || (choice === "system" && colorScheme.matches) ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#1f1e1b" : "#faf9f6");
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  if ($("theme-select")) $("theme-select").value = choice;
}
on("theme-select", "change", () => { const value = $("theme-select").value; if (["system", "light", "dark"].includes(value)) storage.set("jcode.theme.v1", value); applyTheme(); });
colorScheme.addEventListener?.("change", applyTheme);
function updateViewport() {
  const viewport = window.visualViewport;
  // iOS scrolls the layout viewport to reveal a focused field, carrying this
  // fixed-position app up and off screen. The app never scrolls the document
  // itself, so any document scroll is the browser's doing and is safe to undo.
  // This must happen before measuring, or we measure the broken state.
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0);

  // The layout viewport is the honest full height. visualViewport.height alone
  // is wrong twice over: it shrinks under pinch-zoom (which made the composer
  // and drawer stop short of the bottom edge) and it is the only thing that
  // reacts to the keyboard. So measure the layout box, then subtract only the
  // part the keyboard actually covers.
  const layout = Math.round(document.documentElement.clientHeight || window.innerHeight);
  // Re-read offsetTop after the scroll reset. Whatever survives is a genuine
  // visual-viewport shift that scrollTo cannot undo, so the app has to be
  // translated by it instead. Undoing the scroll first keeps this from
  // double-counting, which is what left a gap at the bottom before.
  const offset = Math.max(0, Math.round(viewport?.offsetTop || 0));
  let height = layout;
  if (viewport) {
    const covered = layout - Math.round(viewport.height) - offset;
    // Ignore sub-100px deltas: those are URL-bar chrome and zoom rounding, not
    // a keyboard, and reacting to them made the layout jitter while scrolling.
    if (covered > 100) height = layout - covered;
  }
  document.documentElement.style.setProperty("--app-height", `${height - offset}px`);
  document.documentElement.style.setProperty("--viewport-offset", `${offset}px`);
  // Distance from the layout viewport's bottom edge up to the visible bottom.
  // `showModal()` dialogs render in the top layer, where the containing block
  // is the viewport itself rather than the translated body, so they cannot
  // inherit the offset and must be positioned in viewport coordinates. Exposing
  // the gap here keeps that arithmetic out of CSS, where `100dvh` would be a
  // guess at the layout height rather than the measured value.
  document.documentElement.style.setProperty("--viewport-gap", `${Math.max(0, layout - height)}px`);
}
let viewportFrame = 0;
function scheduleViewport() {
  if (viewportFrame) return;
  viewportFrame = requestAnimationFrame(() => { viewportFrame = 0; updateViewport(); });
}
window.visualViewport?.addEventListener("resize", scheduleViewport);
// offsetTop changes on scroll without a resize, e.g. when focus moves between
// fields while the keyboard is already up.
window.visualViewport?.addEventListener("scroll", scheduleViewport);
window.addEventListener("resize", scheduleViewport);
// Focusing an input is what triggers the scroll-away. The composer is focused
// throughout a conversation, not just at boot, and the transcript grows taller
// as the chat continues, so this fires on every refocus mid-chat, not only on
// the first one. Catch it directly rather than waiting for a viewport event
// that may arrive a frame too late.
window.addEventListener("focusin", scheduleViewport);
window.addEventListener("focusout", scheduleViewport);
// Some iOS scroll-aways emit only a document scroll. Correct it in the same
// frame so the app never visibly leaves the screen.
window.addEventListener("scroll", () => { if (window.scrollY || window.scrollX) scheduleViewport(); }, { passive: true });
window.addEventListener("popstate", () => {
  let id; try { id = decodeURIComponent(location.hash.slice(1)); } catch { id = ""; }
  // iOS fires popstate for scroll restoration and hash normalisation, not just
  // real navigation. Reopening the chat that is already on screen restarted its
  // socket and re-rendered the transcript for no reason, which read as the app
  // bouncing back to the same chat. Only act on an actual change.
  if (id) {
    if (id !== connection.sessionID) openChat(sessions.find((s) => s.id === id) || { id }, false);
  } else if (connection.sessionID) newChat(false);
});
function foreground() {
  if (document.visibilityState !== "visible") return;
  refreshSessions();
  if (!connection.stopped && (!connection.socket || connection.socket.readyState > WebSocket.OPEN)) connection.open();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // Mobile can thaw an apparently OPEN but dead TCP socket. Replace, don't duplicate it.
    if (!connection.stopped) connection.open();
    foreground();
  } else { saveDraft(); clearTimeout(directoryTimer); clearTimeout(connection.timer); }
});
window.addEventListener("focus", foreground);
window.addEventListener("online", foreground);
window.addEventListener("offline", () => {
  saveDraft(); clearTimeout(directoryTimer); clearTimeout(connection.timer);
  connection.closeSocket(); setPhase("disconnected", "Offline · draft saved");
});
window.addEventListener("pagehide", () => { saveDraft(); clearTimeout(directoryTimer); connection.closeSocket(); });
window.addEventListener("pageshow", foreground);
// Registered immediately rather than on `load`: waiting for `load` delayed the
// first install until after every subresource had settled, so the very first
// launch never got a warm cache and the second launch paid for it.
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
(function boot() {
  applyTheme(); updateViewport();
  // Load before any save to avoid overwriting the durable new-chat draft at boot.
  let id; try { id = decodeURIComponent(location.hash.slice(1)); } catch { id = ""; }
  loadDraft(id || "new");
  if (!credentials.load()) { openPairing(); return; }
  if (id) openChat({ id }, false); else newChat(false);
})();
