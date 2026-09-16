/* Dependency-free reducer/transport tests. Run: node --test scripts/tests/gateway-client.test.cjs
 * The small DOM below is a synthetic harness, not a replacement for browser QA. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'crates/jcode-base/src/gateway/web/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'crates/jcode-base/src/gateway/web/index.html'), 'utf8');

function harness({ paired = true, saved = new Map(), hash = '', origin = 'http://localhost:17643' } = {}) {
  let context;
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = { setProperty(key, value) { this[key] = value; } }; this.attributes = {};
      this.listeners = {}; this.className = ''; this.value = ''; this.hidden = false; this.open = false;
      this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100; this.isConnected = true;
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' ').trim(); },
        remove: (name) => { this.className = this.className.split(' ').filter((s) => s !== name).join(' '); },
        toggle: (name, value) => { if (value) this.classList.add(name); else this.classList.remove(name); },
      };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return (this._text || '') + this.children.map((c) => c.textContent).join(''); }
    append(...nodes) { for (let node of nodes) { if (typeof node === 'string') { const n = new Node('#text'); n.textContent = node; node = n; } node.parentNode = this; this.children.push(node); } }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    async emit(type, data = {}) { for (const fn of this.listeners[type] || []) await fn({ target: this, preventDefault() {}, ...data }); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    focus() { document.activeElement = this; }
    select() { this.focus(); }
    showModal() { this.open = true; this.focus(); }
    close() { this.open = false; this.emit('close'); }
    closest() { return null; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((n) => n !== this); this.isConnected = false; }
    replaceWith(other) { const index = this.parentNode.children.indexOf(this); this.parentNode.children[index] = other; other.parentNode = this.parentNode; }
    querySelectorAll(selector) {
      const matches = (node) => selector.startsWith('.') ? selector.slice(1).split('.').every((c) => node.className.split(' ').includes(c)) : node.tagName.toLowerCase() === selector;
      return this.children.flatMap((node) => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
    }
    getBoundingClientRect() { return { left: 0, right: 390, top: 0, bottom: 844 }; }
  }
  const nodes = new Map([...html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"/g)].map((m) => [m[2], new Node(m[1])]));
  const metas = new Map(['theme-color', 'color-scheme'].map((key) => [key, new Node('meta')]));
  const document = new Node('document');
  document.visibilityState = 'visible'; document.documentElement = new Node('html'); document.body = new Node('body');
  document.getElementById = (id) => nodes.get(id) || null;
  document.createElement = (tag) => new Node(tag);
  document.createTextNode = (text) => { const node = new Node('#text'); node.textContent = text; return node; };
  document.querySelectorAll = (selector) => selector === 'dialog' || selector === 'dialog[open]' ? [...nodes.values()].filter((n) => n.tagName === 'DIALOG' && (selector === 'dialog' || n.open)) : [];
  document.querySelector = (selector) => metas.get(selector.match(/meta\[name="([^"]+)"\]/)?.[1]) || null;
  document.execCommand = () => true;
  const sockets = [];
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; sockets.push(this); }
    send(data) { if (this.fail) throw new Error('offline'); this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; this.readyState = 3; }
    connect() { this.readyState = 1; this.onopen?.(); }
  }
  const location = new URL(origin); location.hash = hash;
  if (paired && !saved.has('jcode.credentials.v1')) saved.set('jcode.credentials.v1', JSON.stringify({ [location.host]: { token: 'test-token' } }));
  let fetches = 0;
  let fetchHandler = async () => ({ ok: true, status: 200, json: async () => ({ sessions: [] }) });
  const timers = new Map(); let timerID = 0;
  const window = new Node('window'); window.innerHeight = 844; window.isSecureContext = false;
  const media = { matches: false, addEventListener() {} }; window.matchMedia = () => media;
  context = vm.createContext({
    document, window, location, navigator: { userAgent: 'test' }, WebSocket: Socket, console, URL,
    history: { pushState(_, __, url) { location.hash = url; }, replaceState(_, __, url) { location.hash = url; } },
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    fetch: (...args) => { fetches++; return fetchHandler(...args); },
    setTimeout: (fn, delay) => { timers.set(++timerID, { fn, delay }); return timerID; }, clearTimeout: (id) => timers.delete(id),
    confirm: () => true,
  });
  vm.runInContext(source, context);
  return {
    context, document, window, nodes, sockets, saved, timers, media, metas, location,
    run: (code) => vm.runInContext(code, context),
    setFetch: (fn) => { fetchHandler = fn; }, fetches: () => fetches,
    flush: async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); },
    event: (event) => { context.incoming = event; vm.runInContext('handleEvent(incoming)', context); },
    async attach(id = 'session-one') {
      await this.flush(); this.run(`workingDir = '/home/test/project'; ensureSession()`);
      this.sockets.at(-1).connect(); this.event({ type: 'history', id: this.run('connection.historyRequestID'), session_id: id, messages: [], provider_model: 'server-model', available_models: ['server-model', 'other-model'], activity: { is_processing: false } });
      await this.flush();
    },
  };
}

test('welcome has no socket; new send subscribes with explicit project and waits for history', async () => {
  const h = harness(); await h.flush(); assert.equal(h.sockets.length, 0);
  h.run("workingDir='/home/test/project'; el.composerInput.value='hello'; sendMessage()");
  const socket = h.sockets[0]; socket.connect();
  assert.deepEqual(socket.sent.map((r) => r.type), ['subscribe', 'get_history']);
  assert.equal(socket.sent[0].working_dir, '/home/test/project'); assert.equal(socket.sent[0].continue_on_disconnect, true);
  assert.ok(!('target_session_id' in socket.sent[0]));
  h.event({ type: 'session', session_id: 'new-real-id' }); assert.equal(socket.sent.length, 2);
  h.event({ type: 'history', session_id: 'new-real-id', id: socket.sent[1].id, messages: [] });
  assert.equal(socket.sent.at(-1).type, 'message'); assert.equal(socket.sent.at(-1).content, 'hello');
  assert.equal(h.run('draftSession'), 'new-real-id'); assert.equal(h.run('draftRecord().pending.length'), 1);
});

test('opening drawer preserves socket and existing chat subscribe targets its ID', async () => {
  const h = harness(); await h.attach(); const socket = h.sockets.at(-1);
  await h.run('openSessions()'); assert.equal(h.sockets.length, 1); assert.equal(socket.closed, false);
  h.run("openChat({id:'existing',title:'Readable',working_dir:'/home/test'})");
  assert.equal(socket.closed, true); const next = h.sockets.at(-1); next.connect();
  assert.equal(next.sent[0].target_session_id, 'existing'); assert.ok(!('working_dir' in next.sent[0]));
});

test('catalog history does not erase transcript and model selection requires confirmation', async () => {
  const h = harness(); await h.attach(); h.run("addMessage('assistant','Keep this answer'); connection.catalog()");
  const id = h.sockets.at(-1).sent.at(-1).id;
  h.event({ type: 'history', id, messages: [], provider_model: 'server-model', available_models: ['real/new', 'server-model'] });
  assert.match(h.nodes.get('transcript').textContent, /Keep this answer/);
  h.run("selectModel('real/new')"); assert.equal(h.run('view.model'), 'server-model');
  h.event({ type: 'model_changed', id: h.run('view.modelRequest'), model: 'real/new' });
  assert.equal(h.run('view.model'), 'real/new');
  h.run("selectModel('server-model')"); h.event({ type: 'model_changed', model: 'server-model', error: 'Provider unavailable' });
  assert.equal(h.run('view.model'), 'real/new'); assert.match(h.nodes.get('model-status').textContent, /Provider unavailable/);
});

test('mid-turn follow-ups, echo dedupe and stop wait for actual turn events', async () => {
  const h = harness(); await h.attach();
  h.run("el.composerInput.value='first'; sendMessage()");
  h.event({ type: 'user_message', content: 'first' });
  assert.equal(h.run("el.transcript.querySelectorAll('.msg.user').length"), 1);
  h.event({ type: 'text_delta', text: 'Working' }); h.event({ type: 'message_end', stop_reason: 'tool_use' });
  assert.equal(h.run('view.processing'), true);
  h.run("el.composerInput.value='follow up'; sendMessage()");
  const follow = h.sockets.at(-1).sent.at(-1); assert.equal(follow.type, 'soft_interrupt');
  h.event({ type: 'soft_interrupt', content: 'follow up' }); h.event({ type: 'soft_interrupt_injected', content: 'follow up' });
  assert.equal(h.run("el.transcript.querySelectorAll('.msg.user').length"), 2);
  h.event({ type: 'done', id: follow.id }); assert.equal(h.run('view.processing'), true);
  await h.nodes.get('composer-stop').emit('click'); assert.equal(h.run('view.processing'), true); assert.equal(h.run('view.stopping'), true);
  h.event({ type: 'interrupted' }); assert.equal(h.run('view.processing'), false);
  h.event({ type: 'future_server_event', payload: {} });
});

test('failed send and server-rejected send preserve draft, scoped across navigation and reload', async () => {
  const h = harness(); await h.attach(); const socket = h.sockets.at(-1);
  socket.fail = true; h.run("el.composerInput.value='keep me'; sendMessage()"); assert.equal(h.run('el.composerInput.value'), 'keep me');
  socket.fail = false; h.run('sendMessage()'); const id = socket.sent.at(-1).id;
  h.event({ type: 'error', id, message: 'rejected' }); assert.equal(h.run('el.composerInput.value'), 'keep me');
  h.run("openChat({id:'second'})"); assert.equal(h.run('el.composerInput.value'), '');
  h.run("el.composerInput.value='second draft'; saveDraft(); openChat({id:'session-one'})"); assert.equal(h.run('el.composerInput.value'), 'keep me');
  const reloaded = harness({ saved: h.saved, hash: '#session-one' }); assert.equal(reloaded.run('el.composerInput.value'), 'keep me');
  const otherOrigin = harness({ saved: h.saved, paired: false, origin: 'http://other-server:17643', hash: '#session-one' });
  assert.equal(otherOrigin.run('el.composerInput.value'), '');
});

test('unacknowledged outgoing content survives reload without automatic resend', async () => {
  const h = harness(); await h.attach(); h.run("el.composerInput.value='uncertain delivery'; sendMessage()");
  const restored = harness({ saved: h.saved, hash: '#session-one' });
  assert.equal(restored.run('el.composerInput.value'), 'uncertain delivery'); assert.equal(restored.sockets[0].sent.length, 0);
});

test('reconnect closes stale socket and visibility does not create concurrent live sockets', async () => {
  const h = harness(); await h.attach(); const old = h.sockets.at(-1);
  h.run('connection.open()'); assert.equal(old.closed, true); assert.equal(old.onmessage, null);
  h.sockets.at(-1).connect(); h.document.visibilityState = 'hidden'; await h.document.emit('visibilitychange');
  h.document.visibilityState = 'visible'; await h.document.emit('visibilitychange'); await h.window.emit('focus');
  assert.equal(h.sockets.filter((s) => !s.closed).length, 1);
});

test('directory refresh is nonoverlapping, visible-only and keeps unknown-count legacy rows', async () => {
  const h = harness(); await h.flush(); let resolve;
  h.setFetch(() => new Promise((r) => { resolve = r; })); const before = h.fetches();
  h.run('refreshSessions(); refreshSessions(); refreshSessions()'); assert.equal(h.fetches(), before + 1);
  resolve({ ok: true, status: 200, json: async () => ({ sessions: [
    { id: 'empty', title: 'Empty', message_count: 0, working_dir: '/home/test', updated_at_ms: 1 },
    { id: 'legacy', title: 'Legacy', message_count: null, working_dir: '/home/test/project', updated_at_ms: 2 },
  ] }) }); await h.flush();
  assert.equal(h.run('filteredSessions().length'), 1); assert.equal(h.run('filteredSessions()[0].id'), 'legacy');
  assert.equal(h.run('workingDir'), '/home/test/project');
  h.run('showAll=true; renderSessions()'); assert.equal(h.run('filteredSessions().length'), 2);
  h.nodes.get('session-search').value = 'nothing'; h.run('renderSessions()'); assert.match(h.nodes.get('sessions-empty').textContent, /No matching conversations/);
  h.document.visibilityState = 'hidden'; await h.run('refreshSessions()'); assert.equal(h.fetches(), before + 1);
});

test('revoked auth and rejected attach stop reconnecting without losing input', async () => {
  const h = harness(); await h.attach(); h.run("el.composerInput.value='draft'; saveDraft(); connection.attached=false");
  h.event({ type: 'error', id: h.run('connection.attachRequestID'), message: 'Transcript unavailable' });
  assert.equal(h.run('connection.stopped'), true); assert.equal(h.run('connection.fatalReason'), 'Transcript unavailable');
  assert.equal(h.run('el.composerInput.value'), 'draft');
  h.setFetch(async () => ({ ok: false, status: 401 })); await h.run('refreshSessions()');
  assert.equal(h.run('credentials.load()'), null); assert.equal(h.nodes.get('pair-view').hidden, false);
});

test('rename is native and updates title only after server confirmation', async () => {
  const h = harness(); await h.attach(); h.nodes.get('rename-input').value = 'Actual title';
  await h.nodes.get('rename-form').emit('submit'); const req = h.sockets.at(-1).sent.at(-1);
  assert.equal(req.type, 'rename_session'); assert.equal(req.title, 'Actual title'); assert.notEqual(h.nodes.get('chat-title').textContent, 'Actual title');
  h.event({ type: 'session_renamed', session_id: 'session-one', display_title: 'Actual title' });
  assert.equal(h.nodes.get('chat-title').textContent, 'Actual title');
});

test('streaming and history refresh preserve reading position and expose jump to latest', async () => {
  const h = harness(); await h.attach(); const transcript = h.nodes.get('transcript');
  transcript.scrollHeight = 2000; transcript.clientHeight = 500; transcript.scrollTop = 100;
  h.event({ type: 'text_delta', text: 'Long content' }); assert.equal(transcript.scrollTop, 100); assert.equal(h.nodes.get('jump-latest').hidden, false);
  h.event({ type: 'history', session_id: 'session-one', messages: [{ role: 'assistant', content: 'Updated history' }] });
  assert.equal(transcript.scrollTop, 100);
  await h.nodes.get('jump-latest').emit('click'); assert.equal(transcript.scrollTop, 2000);
});

test('reasoning/tool disclosures, safe markdown/math, copy fallback and theme work', async () => {
  const h = harness(); await h.attach();
  h.event({ type: 'reasoning_delta', text: 'Private thought' }); assert.equal(h.nodes.get('transcript').children[0].tagName, 'DETAILS');
  h.event({ type: 'tool_start', id: 't', name: 'read' }); h.event({ type: 'tool_exec', id: 't', name: 'read' });
  assert.equal(h.run("view.tools.get('t').status.textContent"), 'Running'); h.event({ type: 'tool_done', id: 't', name: 'read', output: '<script>not HTML</script>' });
  assert.equal(h.run("view.tools.get('t').node.open"), false);
  h.run("addMessage('assistant', '<script>alert(1)</script> [bad](javascript:alert) \\(x \\to y\\)')");
  assert.equal(h.nodes.get('transcript').querySelectorAll('script').length, 0); assert.equal(h.nodes.get('transcript').querySelectorAll('a').length, 0);
  assert.equal(h.run('latexToText(String.raw`\\alpha \\to \\beta`)'), 'α → β');
  await h.run("copyText('copy over HTTP')"); assert.equal(h.document.body.children.length, 0);
  h.nodes.get('theme-select').value = 'dark'; await h.nodes.get('theme-select').emit('change');
  assert.equal(h.document.documentElement.dataset.theme, 'dark'); assert.equal(h.metas.get('theme-color').getAttribute('content'), '#1f1e1b');
});

test('model provider labels are actual per-model metadata, never the active provider', async () => {
  const h = harness(); await h.attach();
  h.event({ type: 'available_models_updated', provider_name: 'Current provider', available_models: ['opaque-id', 'routed-id'], available_model_routes: [{ model: 'routed-id', provider: 'Actual provider', available: true }] });
  assert.equal(h.run('view.models[0].provider'), ''); assert.equal(h.run('view.models[1].provider'), 'Actual provider');
  assert.equal(h.nodes.get('model-list').children[0].children.length, 1);
  h.run("selectModel('routed-id'); connection.open()"); assert.equal(h.run('view.modelRequest'), null);
});

test('confirmed catalog after first attach enables rows and fresh welcome hides status', async () => {
  const h = harness(); await h.flush(); assert.equal(h.nodes.get('chat-phase').hidden, true);
  await h.attach(); assert.equal(h.nodes.get('chat-phase').hidden, false);
  assert.equal(h.nodes.get('model-list').children[0].disabled, false);
});

test('failed directory refresh clears its error after unchanged successful response', async () => {
  const h = harness(); await h.flush();
  h.setFetch(async () => { throw new Error('offline'); }); await h.run('refreshSessions()');
  assert.match(h.nodes.get('sessions-status').textContent, /offline/);
  h.setFetch(async () => ({ ok: true, json: async () => ({ sessions: [] }) })); await h.run('refreshSessions()');
  assert.doesNotMatch(h.nodes.get('sessions-status').textContent, /offline/);
});

test('IME composition Enter does not send', async () => {
  const h = harness(); await h.attach(); h.run("el.composerInput.value='composition'");
  const before = h.sockets.at(-1).sent.length;
  await h.nodes.get('composer-input').emit('keydown', { key: 'Enter', isComposing: true });
  assert.equal(h.sockets.at(-1).sent.length, before);
});

test('first-run model picker resumes loading after user chooses a project', async () => {
  const h = harness(); await h.flush(); await h.nodes.get('composer-model').emit('click');
  assert.equal(h.nodes.get('project-dialog').open, true); assert.equal(h.sockets.length, 0);
  h.run("chooseProject('/home/test/new-project')"); assert.equal(h.sockets.length, 1);
  h.sockets[0].connect(); assert.equal(h.sockets[0].sent[0].working_dir, '/home/test/new-project');
});

test('message error ends its active turn but unrelated action errors do not', async () => {
  const h = harness(); await h.attach(); h.run("el.composerInput.value='first'; sendMessage()");
  const messageID = h.sockets.at(-1).sent.at(-1).id;
  h.event({ type: 'text_delta', text: 'partial' });
  h.run("selectModel('other-model')");
  h.event({ type: 'error', id: h.run('view.modelRequest'), message: 'Model unavailable' });
  assert.equal(h.run('view.processing'), true);
  h.event({ type: 'error', id: messageID, message: 'Generation failed' });
  assert.equal(h.run('view.processing'), false); assert.equal(h.run('view.streaming'), null);
});

test('first prompt titles old-server chats until authoritative directory title arrives', async () => {
  const h = harness(); await h.attach(); h.run("el.composerInput.value='A meaningful first prompt'; sendMessage()");
  assert.equal(h.nodes.get('chat-title').textContent, 'A meaningful first prompt'); await h.flush();
  h.setFetch(async () => ({ ok: true, json: async () => ({ sessions: [{ id: 'session-one', title: 'New conversation' }] }) }));
  await h.run('refreshSessions()'); assert.equal(h.nodes.get('chat-title').textContent, 'A meaningful first prompt');
  h.setFetch(async () => ({ ok: true, json: async () => ({ sessions: [{ id: 'session-one', title: 'Server-generated title' }] }) }));
  await h.run('refreshSessions()'); assert.equal(h.nodes.get('chat-title').textContent, 'Server-generated title');
  h.run('view.renameRequest=999');
  h.setFetch(async () => ({ ok: true, json: async () => ({ sessions: [{ id: 'session-one', title: 'Stale title' }] }) }));
  await h.run('refreshSessions()'); assert.equal(h.nodes.get('chat-title').textContent, 'Server-generated title');
});

test('readable known-model labels retain raw server IDs for switching and details', async () => {
  const h = harness(); await h.attach();
  for (const [raw, label] of [['gpt-6-astra', 'GPT-6 Astra'], ['gpt-5.6-luna', 'GPT-5.6 Luna'], ['claude-opus-4-6', 'Claude Opus 4.6'], ['claude-sonnet-4-20250514', 'Claude Sonnet 4'], ['unrecognized-vendor-id', 'unrecognized-vendor-id']]) {
    h.context.rawModel = raw; assert.equal(h.run('modelLabel(rawModel)'), label);
  }
  h.event({ type: 'available_models_updated', provider_model: 'gpt-6-astra', available_models: ['gpt-6-astra'] });
  assert.equal(h.nodes.get('composer-model-name').textContent, 'GPT-6 Astra');
  assert.equal(h.nodes.get('model-list').children[0].children[1].textContent, 'gpt-6-astra');
  await h.nodes.get('model-list').children[0].emit('click');
  assert.equal(h.sockets.at(-1).sent.at(-1).model, 'gpt-6-astra');
});

test('offline event immediately clears attachment and online resumes one socket with saved draft', async () => {
  const h = harness(); await h.attach(); const old = h.sockets.at(-1);
  h.run("el.composerInput.value='offline draft'; navigator.onLine=false");
  await h.window.emit('offline');
  assert.equal(old.closed, true); assert.equal(h.run('connection.attached'), false); assert.equal(h.run('connection.stopped'), false);
  assert.match(h.nodes.get('chat-phase').textContent, /Offline/); assert.equal(h.run('draftRecord().text'), 'offline draft');
  const count = h.sockets.length; const requests = h.fetches();
  h.run('connection.open(); refreshSessions()'); assert.equal(h.sockets.length, count); assert.equal(h.fetches(), requests);
  h.run('navigator.onLine=true'); await h.window.emit('online');
  assert.equal(h.sockets.length, count + 1); assert.equal(h.sockets.filter((s) => !s.closed).length, 1);
  assert.equal(h.run('el.composerInput.value'), 'offline draft');
});

test('external turn completion reconciles observer user prompts without creating another socket', async () => {
  const h = harness(); await h.attach();
  h.event({ type: 'text_delta', text: 'Observed assistant response' });
  h.event({ type: 'done', id: 987654321 });
  const request = h.sockets.at(-1).sent.at(-1);
  assert.equal(request.type, 'get_history'); assert.equal(h.sockets.length, 1);
  const count = h.sockets.at(-1).sent.length;
  h.event({ type: 'done', id: 987654322 }); assert.equal(h.sockets.at(-1).sent.length, count);
  h.event({ type: 'history', id: request.id, session_id: 'session-one', messages: [{ role: 'user', content: 'Sent from another client' }, { role: 'assistant', content: 'Observed assistant response' }], activity: { is_processing: false } });
  assert.equal(h.run("el.transcript.querySelectorAll('.msg.user').length"), 1);
  assert.match(h.nodes.get('transcript').textContent, /Sent from another client/);
  assert.equal(h.run('connection.syncRequestID'), null);
});

test('external terminal failure ends processing, but known local control failure does not', async () => {
  const h = harness(); await h.attach(); h.event({ type: 'text_delta', text: 'External work' });
  h.run("view.renameRequest=connection.send({type:'rename_session',title:'rename'})");
  h.event({ type: 'error', id: h.run('view.renameRequest'), message: 'Rename failed' }); assert.equal(h.run('view.processing'), true);
  h.event({ type: 'error', id: 987654321, message: 'Upstream terminal failure' });
  assert.equal(h.run('view.processing'), false); assert.equal(h.nodes.get('composer-stop').hidden, true); assert.equal(h.run('view.streaming'), null);
});

test('session live badge is inline metadata and ambiguous projects retain path context', async () => {
  const h = harness(); await h.flush();
  h.run("sessions=[{id:'one',title:'One',working_dir:'/home/test/project',live:true},{id:'two',title:'Two',working_dir:'/work/project'}]; renderSessions()");
  assert.equal(h.run("projectLabel('/home/test/project')"), '~/project');
  const live = h.nodes.get('session-list').querySelectorAll('.session-live')[0]; assert.equal(live.parentNode.className, 'session-meta');
  h.run("sessions=sessions.slice(0,1)"); assert.equal(h.run("projectLabel('/home/test/project')"), 'project');
});

test('empty search preserves styled title and hint nodes across refreshes', async () => {
  const h = harness(); await h.flush();
  const empty = h.nodes.get('sessions-empty');
  const title = empty.querySelectorAll('.empty-title')[0]; const hint = empty.querySelectorAll('.empty-hint')[0];
  h.run("sessions=[{id:'one',title:'One'}]; $('session-search').value='not found'; renderSessions()");
  assert.equal(empty.querySelectorAll('.empty-title')[0], title); assert.equal(empty.querySelectorAll('.empty-hint')[0], hint);
  assert.equal(title.textContent, 'No matching conversations'); assert.match(hint.textContent, /Clear search/);
});
