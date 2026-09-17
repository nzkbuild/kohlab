/**
 * Unified-diff helpers for the review surface.
 *
 * A unified diff is a *patch*, not a document. Feeding it straight to a diff
 * editor renders the patch source (`@@ -1,2 +1,3 @@`, `+`/`-` markers) as if it
 * were the file's new content, against an empty original — so the reviewer sees
 * patch syntax instead of the change. These helpers reconstruct the two sides
 * so the editor can diff them properly.
 */

export interface SplitDiff {
  original: string;
  modified: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * Rebuild the original and modified documents from a unified diff.
 *
 * Only hunk contents are recoverable from a patch (the surrounding unchanged
 * file is not in it), so the result is the changed regions with their context —
 * which is exactly what a patch review shows. Context lines are copied to both
 * sides, `-` lines only to the original, `+` lines only to the modified, so the
 * two documents stay line-aligned.
 */
export function splitUnifiedDiff(diff: string): SplitDiff {
  const lines = diff.split("\n");
  // A trailing newline yields a final empty element; drop it so both sides do
  // not gain a phantom blank line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const original: string[] = [];
  const modified: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (HUNK_HEADER.test(line)) {
      inHunk = true;
      continue;
    }
    // Everything before the first hunk is patch metadata (diff --git, index,
    // ---/+++, mode changes, rename/similarity lines). None of it is file text.
    if (!inHunk) continue;

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    if (line.startsWith("+")) modified.push(line.slice(1));
    else if (line.startsWith("-")) original.push(line.slice(1));
    else if (line.startsWith(" ")) {
      original.push(line.slice(1));
      modified.push(line.slice(1));
    } else if (line === "") {
      original.push("");
      modified.push("");
    }
    // Anything else (e.g. "Binary files ... differ") is not diff content.
  }

  return { original: original.join("\n"), modified: modified.join("\n") };
}

/** Monaco language id for a path, by extension. Falls back to plain text. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  tf: "hcl",
  hcl: "hcl",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  lua: "lua",
  xml: "xml",
  svg: "xml",
};

const LANGUAGE_BY_BASENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "plaintext",
  ".env": "ini",
};

export function languageForFile(path: string): string {
  const base = path.split("/").pop() ?? path;
  const byName = LANGUAGE_BY_BASENAME[base.toLowerCase()];
  if (byName) return byName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? "plaintext";
}
