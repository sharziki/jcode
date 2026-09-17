/**
 * Tests for one-tap pairing via a pre-authorized link.
 *
 * A pairing code expires in 5 minutes, which cannot survive "set this up while
 * I sleep". A link carrying the token pairs on first tap instead. That makes
 * this security-relevant code, so the rules are pinned:
 *
 *   - the token must ride in the URL FRAGMENT, never the query string, because
 *     fragments are not sent to the server and never reach an access log
 *   - it must be stripped from the URL immediately after use
 *   - a malformed token must be rejected rather than saved
 *   - pairing one host must not disturb credentials for another
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const VALID = "6c012ac8c5e92de45dc864e7e38d14c4dd70f7c24dfb0c8359cf589c443bc0d9";

/** Run the real consumeTokenFromURL() against a fake browser. */
function run({ hash, host = "server:7643", existing = {} }) {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/gateway/web/app.js"),
    "utf8",
  );
  const start = source.indexOf("function consumeTokenFromURL()");
  const end = source.indexOf("(function boot()");
  assert.ok(start > 0, "consumeTokenFromURL not found in app.js");
  assert.ok(end > start, "boot() must follow consumeTokenFromURL");

  const store = { "jcode.credentials.v1": JSON.stringify(existing) };
  const context = {
    location: { hash, host, pathname: "/", search: "" },
    history: {
      replaced: null,
      replaceState(_s, _t, url) { this.replaced = url; },
    },
    localStorage: {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = v; },
    },
  };
  context.window = context;
  vm.createContext(context);
  // The storage + credentials helpers live at the top of app.js.
  const head = source.slice(0, source.indexOf("async function pair("));
  const helpers = head.slice(head.indexOf("const storage = {"));
  vm.runInContext(
    `${helpers}\n${source.slice(start, end)}\nthis.consume = consumeTokenFromURL;`,
    context,
  );
  const result = context.consume();
  return {
    result,
    saved: JSON.parse(store["jcode.credentials.v1"] || "{}"),
    replacedURL: context.history.replaced,
  };
}

test("a valid token in the fragment pairs the device", () => {
  const { result, saved } = run({ hash: `#token=${VALID}` });
  assert.strictEqual(result, true);
  assert.strictEqual(saved["server:7643"].token, VALID);
});

test("the token is stripped from the URL after use", () => {
  // Otherwise a screenshot of the address bar, or a shared link, leaks a
  // credential that never expires.
  const { replacedURL } = run({ hash: `#token=${VALID}` });
  assert.ok(replacedURL !== null, "history.replaceState must be called");
  assert.ok(!replacedURL.includes(VALID), `token still in URL: ${replacedURL}`);
});

test("pairing one host leaves another host's credentials intact", () => {
  // The laptop gateway and the server gateway are different hosts. Pairing the
  // server must not log the user out of the laptop.
  const existing = { "laptop:7643": { token: "aaaa1111bbbb2222cccc3333dddd4444" } };
  const { saved } = run({ hash: `#token=${VALID}`, host: "server:7643", existing });
  assert.strictEqual(saved["laptop:7643"].token, "aaaa1111bbbb2222cccc3333dddd4444");
  assert.strictEqual(saved["server:7643"].token, VALID);
});

test("a malformed token is rejected, not stored", () => {
  for (const bad of ["#token=short", "#token=not-hex-!!!", "#token="]) {
    const { result, saved } = run({ hash: bad });
    assert.strictEqual(result, false, `should reject ${bad}`);
    assert.deepStrictEqual(saved, {}, `should store nothing for ${bad}`);
  }
});

test("an ordinary session link is not treated as a token", () => {
  // `#<session-id>` is the normal deep link into a chat and must still work.
  const { result, saved } = run({ hash: "#session_bonehound_1789618412218" });
  assert.strictEqual(result, false);
  assert.deepStrictEqual(saved, {});
});

test("no fragment at all is a no-op", () => {
  const { result, replacedURL } = run({ hash: "" });
  assert.strictEqual(result, false);
  assert.strictEqual(replacedURL, null, "must not rewrite history when idle");
});
