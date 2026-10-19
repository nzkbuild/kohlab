#!/usr/bin/env bun
/**
 * Chat replies: the parser behind code blocks, links, headings and lists.
 * Pure functions only; no browser, no server.
 *
 * Run:  bun scripts/check-markdown.mjs
 */
import { inline, parseBlocks } from "../web/src/lib/markdown.ts";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

/** The visible text of inline nodes, links shown by their label. */
const shown = (nodes) =>
  nodes.map((n) => (n.kind === "strong" ? shown(n.children) : n.kind === "text" || n.kind === "code" ? n.text : n.kind === "link" ? n.text : "")).join("");
const links = (nodes) => nodes.flatMap((n) => (n.kind === "link" ? [n.href] : n.kind === "strong" ? links(n.children) : []));

// fenced code
check(
  "fenced code with a language",
  parseBlocks("```html\n<p>hi</p>\n```"),
  [{ kind: "code", lang: "html", code: "<p>hi</p>" }],
);
check(
  "fenced code without a language",
  parseBlocks("```\nlet a = 1;\n```"),
  [{ kind: "code", lang: "", code: "let a = 1;" }],
);
check(
  "unclosed fence runs to the end (streaming)",
  parseBlocks("Here:\n```js\nconst a = 1;\n- not a bullet"),
  [
    { kind: "p", lines: ["Here:"] },
    { kind: "code", lang: "js", code: "const a = 1;\n- not a bullet" },
  ],
);
check(
  "text after a closed fence is prose again",
  parseBlocks("```\nx\n```\nafter"),
  [
    { kind: "code", lang: "", code: "x" },
    { kind: "p", lines: ["after"] },
  ],
);

// links
check(
  "[text](https://a.b) is a link",
  inline("see [x](https://a.b) now"),
  [
    { kind: "text", text: "see " },
    { kind: "link", href: "https://a.b", text: "x" },
    { kind: "text", text: " now" },
  ],
);
check(
  "bare URL with a trailing period leaves the period out",
  inline("go to https://example.com/a."),
  [
    { kind: "text", text: "go to " },
    { kind: "link", href: "https://example.com/a", text: "https://example.com/a" },
    { kind: "text", text: "." },
  ],
);
check("bare URL in brackets leaves the bracket out", links(inline("(see https://example.com)")), ["https://example.com"]);
check("balanced parentheses stay in a bare URL", links(inline("https://en.wikipedia.org/wiki/A_(b)")), ["https://en.wikipedia.org/wiki/A_(b)"]);
const js = inline("[x](javascript:alert(1))");
check("javascript: link is refused", links(js), []);
check("javascript: link shows as plain text", shown(js), "[x](javascript:alert(1))");
check("data: link is refused", links(inline("[x](data:text/html,hi)")), []);
check("link inside backticks is not linked", links(inline("use `[x](https://a.b)` here")), []);
check("link inside backticks shows as code", inline("`https://a.b`"), [{ kind: "code", text: "https://a.b" }]);
check("a link inside bold is still a link", links(inline("**see https://a.b**")), ["https://a.b"]);

// lists and headings
check(
  "bullets and numbers are still lists",
  parseBlocks("- a\n* b\n\n1. x\n2. y"),
  [
    { kind: "ul", items: ["a", "b"] },
    { kind: "ol", items: ["x", "y"] },
  ],
);
check("heading is a heading", parseBlocks("## Title"), [{ kind: "h", text: "Title" }]);
check("'#tag' without a space is prose", parseBlocks("#tag"), [{ kind: "p", lines: ["#tag"] }]);
check("--- is a rule", parseBlocks("---"), [{ kind: "hr" }]);
check("bold stays bold", inline("**b**"), [{ kind: "strong", children: [{ kind: "text", text: "b" }] }]);

// tables
check(
  "basic table with header and two rows",
  parseBlocks("| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |"),
  [{ kind: "table", head: ["a", "b", "c"], rows: [["1", "2", "3"], ["4", "5", "6"]] }],
);
check(
  "table without leading and trailing pipes",
  parseBlocks("a | b\n--- | ---\n1 | 2"),
  [{ kind: "table", head: ["a", "b"], rows: [["1", "2"]] }],
);
check(
  "paragraph, table, paragraph (blank line separated)",
  parseBlocks("Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter"),
  [
    { kind: "p", lines: ["Intro"] },
    { kind: "table", head: ["a", "b"], rows: [["1", "2"]] },
    { kind: "p", lines: ["After"] },
  ],
);
check("header line with no delimiter stays a paragraph", parseBlocks("| a | b |"), [{ kind: "p", lines: ["| a | b |"] }]);
check(
  "escaped pipe and pipe in backticks stay in one cell",
  parseBlocks("| a \\| b | `x|y` |\n|---|---|\n| 1 | 2 |"),
  [{ kind: "table", head: ["a | b", "`x|y`"], rows: [["1", "2"]] }],
);
check(
  "short body row is padded to the header length",
  parseBlocks("| a | b | c |\n|---|---|---|\n| 1 |"),
  [{ kind: "table", head: ["a", "b", "c"], rows: [["1", "", ""]] }],
);
check(
  "exact streamed table text",
  parseBlocks("| What | Today |\n|---|---|\n| **Question cards**: options | Raw text |"),
  [{ kind: "table", head: ["What", "Today"], rows: [["**Question cards**: options", "Raw text"]] }],
);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall markdown checks passed");
