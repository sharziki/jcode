/**
 * Tests for the web client's markdown renderer.
 *
 * The renderer is the largest piece of untested logic in the web client, it
 * handles untrusted model output, and two real bugs in it silently ate message
 * content. This locks in both the behavior and those regressions.
 *
 * No dependencies and no browser: the renderer only touches a small slice of
 * the DOM, so a shim is cheaper and faster than pulling in jsdom, and it keeps
 * the test runnable anywhere `node` exists.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// --- minimal DOM ---------------------------------------------------------

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    names.forEach((n) => this.set.add(n));
  }
  contains(name) {
    return this.set.has(name);
  }
  toString() {
    return [...this.set].join(" ");
  }
}

class Node {
  constructor(tagName) {
    this.tagName = (tagName || "").toUpperCase();
    this.childNodes = [];
    this.classList = new ClassList();
    this.dataset = {};
    this.style = {};
    this.attrs = {};
  }
  /** The real DOM keeps `className` and `classList` in sync; so must the shim. */
  set className(value) {
    this.classList = new ClassList();
    String(value)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((n) => this.classList.add(n));
  }
  get className() {
    return this.classList.toString();
  }
  append(...nodes) {
    for (const n of nodes) this.childNodes.push(n);
  }
  get children() {
    return this.childNodes.filter((n) => n instanceof Node);
  }
  set textContent(value) {
    this.childNodes = [];
    if (value !== "") this.childNodes.push(new TextNode(String(value)));
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  /** Depth-first list of descendant elements. */
  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }
  /** Count descendants (and self) whose tag matches. */
  count(tag) {
    const want = tag.toUpperCase();
    return this.descendants().filter((n) => n.tagName === want).length;
  }
  find(tag) {
    const want = tag.toUpperCase();
    return this.descendants().find((n) => n.tagName === want);
  }
  findAll(tag) {
    const want = tag.toUpperCase();
    return this.descendants().filter((n) => n.tagName === want);
  }
  /** Tag names of direct element children, for structural assertions. */
  shape() {
    return this.children.map((c) => c.tagName);
  }
}

class TextNode {
  constructor(text) {
    this.text = text;
  }
  get textContent() {
    return this.text;
  }
}

function makeDocument() {
  return {
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => new TextNode(String(text)),
  };
}

// --- load the renderer out of app.js -------------------------------------

/**
 * `app.js` is a browser script that touches `document` and `localStorage` at
 * load time, so it cannot simply be required. Extract just the pure rendering
 * functions and evaluate them against the shim.
 */
function loadRenderer() {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/gateway/web/app.js"),
    "utf8",
  );
  const start = source.indexOf("function renderMarkdown(target, text)");
  const end = source.indexOf("/** True when the user is near the bottom");
  assert.ok(start > 0 && end > start, "renderer block not found in app.js");

  const context = { document: makeDocument() };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nthis.renderMarkdown = renderMarkdown;`,
    context,
  );
  return (markdown) => {
    const root = context.document.createElement("div");
    context.renderMarkdown(root, markdown);
    return root;
  };
}

const render = loadRenderer();

// --- regressions ---------------------------------------------------------

test("a blank line ends a top-level list", () => {
  // Regression: `next.search(/\S/) < baseIndent` can never be true when
  // baseIndent is 0, so a top-level list consumed every following block.
  const root = render("- a\n- b\n\n> quote\n\n---\n\nAfter.");
  assert.strictEqual(root.count("ul"), 1);
  assert.strictEqual(root.count("blockquote"), 1, "quote survives the list");
  assert.strictEqual(root.count("hr"), 1, "rule survives the list");
  assert.ok(root.textContent.includes("After."), "trailing text survives");
});

test("an ordered list after a bullet list stays a separate <ol>", () => {
  // Regression: the numbered items were appended to the open <ul>, so the
  // <ol> vanished and its items rendered as bullets.
  const root = render("- bullet\n\n1. first\n2. second");
  assert.strictEqual(root.count("ul"), 1);
  assert.strictEqual(root.count("ol"), 1);
  assert.strictEqual(root.find("ol").count("li"), 2);
});

test("a bullet list directly after a numbered list also splits", () => {
  const root = render("1. one\n\n- bullet");
  assert.strictEqual(root.count("ol"), 1);
  assert.strictEqual(root.count("ul"), 1);
});

// --- block constructs ----------------------------------------------------

test("headings normalize so the shallowest becomes h2", () => {
  // The screen title is the h1; message headings must not skip a level.
  assert.strictEqual(render("# Top").find("h2").textContent, "Top");
  assert.strictEqual(render("## Top").find("h2").textContent, "Top");
  assert.strictEqual(render("### Top").find("h2").textContent, "Top");

  // Relative depth is preserved.
  const root = render("## Outer\n\n### Inner");
  assert.deepStrictEqual(root.shape(), ["H2", "H3"]);

  // And never exceeds h6.
  assert.ok(render("###### Deep\n\nx").find("h2"), "clamps to a valid level");
});

test("fenced code is literal and keeps its language", () => {
  const root = render('```rust\nlet x = "**not bold**";\n```');
  const code = root.find("code");
  assert.strictEqual(code.dataset.lang, "rust");
  assert.strictEqual(code.textContent, 'let x = "**not bold**";');
  assert.strictEqual(root.count("strong"), 0, "markdown inside code is inert");
});

test("an unterminated fence still renders, for streaming", () => {
  // While a response streams, the closing fence has not arrived yet.
  const root = render("```js\nconst a = 1;");
  assert.strictEqual(root.count("pre"), 1);
  assert.strictEqual(root.find("code").textContent, "const a = 1;");
});

test("tables parse with alignment", () => {
  const root = render("| a | b |\n|---|--:|\n| 1 | 2 |");
  assert.strictEqual(root.count("table"), 1);
  assert.strictEqual(root.count("th"), 2);
  assert.strictEqual(root.count("td"), 2);
  assert.strictEqual(root.findAll("td")[1].style.textAlign, "right");
});

test("a pipe line without a delimiter row is not a table", () => {
  const root = render("a | b | c");
  assert.strictEqual(root.count("table"), 0);
  assert.strictEqual(root.count("p"), 1);
});

test("blockquotes nest their own blocks", () => {
  const root = render("> quoted\n>\n> - item");
  const quote = root.find("blockquote");
  assert.ok(quote, "blockquote exists");
  assert.strictEqual(quote.count("ul"), 1, "list inside the quote");
});

test("task items render a labelled checkbox", () => {
  const root = render("- [x] done\n- [ ] open");
  const boxes = root.findAll("input");
  assert.strictEqual(boxes.length, 2);
  assert.strictEqual(boxes[0].checked, true);
  assert.strictEqual(boxes[1].checked, false);
  // The label supplies the accessible name; a bare checkbox is a critical
  // accessibility violation.
  assert.strictEqual(root.count("label"), 2);
  assert.ok(root.find("label").textContent.includes("done"));
});

test("nested lists are nested, not flattened", () => {
  const root = render("- outer\n  - inner");
  const outer = root.find("ul");
  assert.strictEqual(outer.count("ul"), 1, "inner list is inside the outer");
});

test("horizontal rules require three or more markers", () => {
  assert.strictEqual(render("---").count("hr"), 1);
  assert.strictEqual(render("***").count("hr"), 1);
  assert.strictEqual(render("--").count("hr"), 0);
});

// --- inline constructs ---------------------------------------------------

test("inline emphasis, code, and strikethrough", () => {
  const root = render("**b** *i* `c` ~~s~~");
  assert.strictEqual(root.count("strong"), 1);
  assert.strictEqual(root.count("em"), 1);
  assert.strictEqual(root.count("code"), 1);
  assert.strictEqual(root.count("del"), 1);
});

test("underscores inside words do not italicize", () => {
  // snake_case identifiers are common in this app's output.
  const root = render("call some_long_name now");
  assert.strictEqual(root.count("em"), 0);
  assert.ok(root.textContent.includes("some_long_name"));
});

test("backslash escapes render the literal character", () => {
  // Found in a real transcript: reasoning summaries arrive wrapped as
  // `*\u2063\\*\\*text\\*\\*\u2063*`. Without escape handling the backslashes
  // leaked into the page and the surrounding emphasis mis-parsed, producing
  // hundreds of stray <em> nodes showing literal "\\".
  const root = render("\\*\\*not bold\\*\\*");
  assert.strictEqual(root.count("strong"), 0, "escaped asterisks are not emphasis");
  assert.strictEqual(root.count("em"), 0);
  assert.ok(!root.textContent.includes("\\"), "no backslash reaches the page");
  assert.ok(root.textContent.includes("**not bold**"), "literal asterisks shown");
});

test("escapes cover the common markdown punctuation", () => {
  for (const ch of ["*", "_", "`", "[", "]", "(", ")", "#", "~", "\\"]) {
    const root = render(`a \\${ch} b`);
    assert.ok(
      root.textContent.includes(`a ${ch} b`),
      `escaped ${ch} should render literally`,
    );
  }
});

test("a real reasoning-summary wrapper renders cleanly", () => {
  // Verbatim shape from the deployed server's transcript.
  const root = render("*\u2063\\*\\*Verifying excluded lesson sections\\*\\*\u2063*");
  assert.ok(!root.textContent.includes("\\"), "no stray backslashes");
  assert.ok(root.textContent.includes("Verifying excluded lesson sections"));
});

test("inline code is not re-parsed as markdown", () => {
  const root = render("`**literal**`");
  assert.strictEqual(root.count("strong"), 0);
  assert.strictEqual(root.find("code").textContent, "**literal**");
});

// --- safety --------------------------------------------------------------

test("html in model output stays inert text", () => {
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const root = render(payload);
  assert.strictEqual(root.count("img"), 0);
  assert.strictEqual(root.count("script"), 0);
  // It is still shown to the user, just as text.
  assert.ok(root.textContent.includes("onerror"));
});

test("only http/https/mailto links become anchors", () => {
  const safe = render("[ok](https://example.com)");
  const anchor = safe.find("a");
  assert.strictEqual(anchor.attrs.href || anchor.href, "https://example.com");
  assert.strictEqual(anchor.rel, "noopener noreferrer");
  assert.strictEqual(anchor.target, "_blank");

  for (const hostile of [
    "[x](javascript:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](vbscript:msgbox)",
  ]) {
    const root = render(hostile);
    assert.strictEqual(root.count("a"), 0, `${hostile} must not become a link`);
    assert.ok(root.textContent.includes("x"), "label is still shown");
  }
});

test("bare urls are linkified", () => {
  const root = render("see https://example.com/a?b=1 now");
  assert.strictEqual(root.count("a"), 1);
  assert.strictEqual(root.find("a").textContent, "https://example.com/a?b=1");
});

// --- robustness ----------------------------------------------------------

test("empty and whitespace input produce no children", () => {
  assert.strictEqual(render("").children.length, 0);
  assert.strictEqual(render("\n\n  \n").children.length, 0);
});

test("a realistic mixed document keeps every construct", () => {
  const root = render(
    [
      "## Summary",
      "",
      "Fixed **two** bugs in `parseList`.",
      "",
      "- first",
      "  - nested",
      "- [x] done",
      "",
      "1. step one",
      "2. step two",
      "",
      "> note this",
      "",
      "| k | v |",
      "|---|--:|",
      "| a | 1 |",
      "",
      "---",
      "",
      "```sh",
      "cargo test",
      "```",
    ].join("\n"),
  );

  assert.strictEqual(root.count("h2"), 1, "heading");
  assert.strictEqual(root.count("ul"), 2, "outer + nested bullet lists");
  assert.strictEqual(root.count("ol"), 1, "ordered list survives");
  assert.strictEqual(root.count("blockquote"), 1, "quote survives");
  assert.strictEqual(root.count("table"), 1, "table survives");
  assert.strictEqual(root.count("hr"), 1, "rule survives");
  assert.strictEqual(root.count("pre"), 1, "code block survives");
  assert.strictEqual(root.count("input"), 1, "task checkbox");
  assert.ok(root.textContent.includes("cargo test"));
});

// --- math ----------------------------------------------------------------

test("inline math renders as unicode, not raw latex", () => {
  // Real transcripts are full of this; 13 of 25 recent sessions on a live
  // install contained LaTeX delimiters, and it previously showed as source.
  const root = render("plug \\(\\mathbf r(t)\\) back in");
  const math = root.find("span");
  assert.ok(math, "inline math produces a span");
  assert.ok(!root.textContent.includes("\\mathbf"), "command is consumed");
  assert.ok(!root.textContent.includes("\\("), "delimiters are consumed");
  assert.ok(root.textContent.includes("r(t)"), "the expression survives");
});

test("display math becomes its own block", () => {
  const root = render("before\n\n\\[\n\\boxed{a \\rightarrow b}\n\\]\n\nafter");
  const block = root.children.find((c) => c.classList.contains("math-display"));
  assert.ok(block, "display math is a block");
  assert.ok(block.textContent.includes("\u2192"), "\\rightarrow becomes an arrow");
  assert.ok(!root.textContent.includes("\\boxed"), "wrapper command removed");
  assert.ok(root.textContent.includes("before") && root.textContent.includes("after"));
});

test("common latex symbols map to unicode", () => {
  const cases = [
    ["\\(\\alpha\\)", "\u03b1"],
    ["\\(\\leq\\)", "\u2264"],
    ["\\(\\infty\\)", "\u221e"],
    ["\\(\\sum\\)", "\u2211"],
    ["\\(x \\times y\\)", "\u00d7"],
  ];
  for (const [src, want] of cases) {
    assert.ok(render(src).textContent.includes(want), `${src} -> ${want}`);
  }
});

test("fractions and scripts degrade readably", () => {
  assert.ok(render("\\(\\frac{a}{b}\\)").textContent.includes("(a)/(b)"));
  assert.ok(render("\\(x^2\\)").textContent.includes("x\u00b2"));
  assert.ok(render("\\(a_1\\)").textContent.includes("a\u2081"));
});

test("unknown latex is left intact rather than dropped", () => {
  // Losing content to a parse failure would be worse than showing source.
  const root = render("\\(\\weirdcommand{z}\\)");
  assert.ok(root.textContent.includes("weirdcommand") || root.textContent.includes("z"));
});

test("bare-bracket display math is recognized", () => {
  // Models emit the unescaped form far more often than `\[`: 118 vs 12
  // occurrences across 20 real sessions on a live install.
  const root = render("text\n\n[\n\\mathbf r\\cdot\\mathbf v=0.\n]\n\nmore");
  const block = root.children.find((c) => c.classList.contains("math-display"));
  assert.ok(block, "bare [ ... ] becomes a math block");
  assert.ok(!root.textContent.includes("mathbf"), "commands are consumed");
  assert.ok(block.textContent.includes("\u22c5"), "\\cdot becomes a dot operator");
  assert.ok(root.textContent.includes("text") && root.textContent.includes("more"));
});

test("a markdown link is never mistaken for display math", () => {
  // `[label](url)` shares the opening bracket; only a lone `[` line is math.
  const root = render("see [the docs](https://example.com) now");
  assert.strictEqual(root.count("a"), 1);
  assert.strictEqual(
    root.children.filter((c) => c.classList.contains("math-display")).length,
    0,
  );
});

test("a bracketed line with other content is left as text", () => {
  const root = render("[not math] trailing words");
  assert.strictEqual(
    root.children.filter((c) => c.classList.contains("math-display")).length,
    0,
  );
  assert.ok(root.textContent.includes("not math"));
});

test("inline bracketed math inside a sentence renders", () => {
  // Verbatim from the deployed transcript: models mix this with \( ... \).
  const root = render("so [ \\mathbf r\\cdot\\mathbf v=0. ] therefore");
  assert.ok(!root.textContent.includes("mathbf"), "command consumed");
  assert.ok(root.textContent.includes("\u22c5"), "\\cdot rendered");
  assert.ok(root.textContent.includes("so ") && root.textContent.includes("therefore"));
});

test("bracketed prose without a latex command is untouched", () => {
  // The leading-command requirement is what keeps this from being math.
  const root = render("an array [1, 2, 3] and [see notes] here");
  assert.strictEqual(root.count("span"), 0, "no math spans");
  assert.ok(root.textContent.includes("[1, 2, 3]"));
  assert.ok(root.textContent.includes("[see notes]"));
});
