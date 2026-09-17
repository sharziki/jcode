/**
 * Tests for the web client's viewport sizing.
 *
 * This is the logic that decides how tall the app is and where its bottom edge
 * sits, and it had a bug no simulated test caught: it treated *any* coverage
 * over 100px as a software keyboard. On a modern iPhone, Safari's collapsed
 * toolbar plus the home-indicator inset is about 150px, which cleared that
 * threshold with no keyboard on screen. The app shortened itself by 150px and
 * left a dead black band under the drawer and composer.
 *
 * The fix requires two independent signals before shrinking: a large coverage
 * AND a focused text field. These tests pin both halves, because either one
 * alone reproduces the bug.
 *
 * Same approach as the markdown tests: extract the real functions from app.js
 * and run them against a small shim, so no browser or dependency is needed.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/**
 * Build a context with a fake viewport/document and run the real
 * updateViewport() against it. Returns the CSS custom properties it set.
 */
function measure({ layout, visual, offsetTop = 0, focusedTag = null, scrollY = 0 }) {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/gateway/web/app.js"),
    "utf8",
  );
  const start = source.indexOf("const KEYBOARD_MIN_COVERAGE");
  const end = source.indexOf("// --- end viewport ---");
  assert.ok(start > 0, "KEYBOARD_MIN_COVERAGE not found in app.js; update this anchor");
  assert.ok(
    end > start,
    "the '// --- end viewport ---' marker is missing from app.js or sits before " +
      "the viewport code; it must stay directly after updateViewport() so this " +
      "test keeps exercising the real function",
  );

  const props = {};
  const context = {
    document: {
      documentElement: {
        clientHeight: layout,
        style: { setProperty: (k, v) => { props[k] = v; } },
      },
      activeElement: focusedTag ? { tagName: focusedTag, isContentEditable: false } : null,
    },
    window: {
      innerHeight: layout,
      visualViewport: { height: visual, offsetTop },
      scrollX: 0,
      scrollY,
      scrollTo: () => { context.window.scrollY = 0; context.window.scrollX = 0; },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nthis.updateViewport = updateViewport;`,
    context,
  );
  context.updateViewport();
  return {
    appHeight: parseInt(props["--app-height"], 10),
    offset: parseInt(props["--viewport-offset"], 10),
    gap: parseInt(props["--viewport-gap"], 10),
  };
}

// iPhone 16 Pro-ish layout height.
const LAYOUT = 932;

test("regression: browser chrome must not be mistaken for a keyboard", () => {
  // The reported bug. 150px of persistent chrome, nothing focused. The old
  // `covered > 100` rule shortened the app and left a 150px dead band under
  // the drawer. The app must stay full height.
  const m = measure({ layout: LAYOUT, visual: LAYOUT - 150, focusedTag: null });
  assert.strictEqual(m.appHeight, LAYOUT, "app should stay full height with no keyboard");
  assert.strictEqual(m.gap, 0, "no dead band below the app");
});

test("regression: chrome is ignored even at keyboard-sized coverage", () => {
  // Coverage alone is not enough. Without a focused field this is not a
  // keyboard, no matter how large, so height must not change.
  const m = measure({ layout: LAYOUT, visual: LAYOUT - 336, focusedTag: null });
  assert.strictEqual(m.appHeight, LAYOUT);
  assert.strictEqual(m.gap, 0);
});

test("a real keyboard still shortens the app", () => {
  // The behaviour the original fix existed for must survive. Focused textarea
  // plus a large coverage is a genuine keyboard.
  const m = measure({ layout: LAYOUT, visual: LAYOUT - 336, focusedTag: "TEXTAREA" });
  assert.strictEqual(m.appHeight, LAYOUT - 336, "app shrinks to the visible band");
  assert.strictEqual(m.gap, 336, "dialogs are lifted above the keyboard");
});

test("a focused search input also counts as text entry", () => {
  // The drawer's search field is an <input>. Typing there raises the keyboard
  // exactly like the composer does.
  const m = measure({ layout: LAYOUT, visual: LAYOUT - 300, focusedTag: "INPUT" });
  assert.strictEqual(m.appHeight, LAYOUT - 300);
});

test("a focused button is not text entry", () => {
  // Tapping a button can transiently focus it while chrome is collapsed.
  // That must not be read as a keyboard.
  const m = measure({ layout: LAYOUT, visual: LAYOUT - 150, focusedTag: "BUTTON" });
  assert.strictEqual(m.appHeight, LAYOUT);
  assert.strictEqual(m.gap, 0);
});

test("small deltas never shrink the app, focused or not", () => {
  // Pinch-zoom and rounding noise. Below the coverage floor nothing happens,
  // which is what kept the layout from jittering during scroll.
  for (const focusedTag of [null, "TEXTAREA"]) {
    const m = measure({ layout: LAYOUT, visual: LAYOUT - 60, focusedTag });
    assert.strictEqual(m.appHeight, LAYOUT, `should ignore 60px delta (focus=${focusedTag})`);
  }
});

test("an unshrunk viewport reports no gap", () => {
  const m = measure({ layout: LAYOUT, visual: LAYOUT, focusedTag: null });
  assert.strictEqual(m.appHeight, LAYOUT);
  assert.strictEqual(m.gap, 0);
  assert.strictEqual(m.offset, 0);
});

test("a visual-viewport offset translates the app and is not double-counted", () => {
  // iOS can leave a residual offsetTop that scrollTo cannot undo. The app is
  // translated down by it, and that shift must not also be billed as coverage.
  const m = measure({
    layout: LAYOUT,
    visual: LAYOUT - 336,
    offsetTop: 40,
    focusedTag: "TEXTAREA",
  });
  assert.strictEqual(m.offset, 40, "app is translated by the residual offset");
  // covered = 932 - 596 - 40 = 296, so height = 636, minus the 40 offset.
  assert.strictEqual(m.appHeight, 636 - 40);
});

test("the document scroll is undone before measuring", () => {
  // iOS scrolls the document to reveal a focused field, carrying this
  // fixed-position app off screen. Measuring before undoing that would bake
  // the broken state into the height.
  const m = measure({ layout: LAYOUT, visual: LAYOUT, scrollY: 220, focusedTag: "TEXTAREA" });
  assert.strictEqual(m.appHeight, LAYOUT);
  assert.strictEqual(m.gap, 0);
});
