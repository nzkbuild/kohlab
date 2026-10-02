/**
 * Monaco, served from this box.
 *
 * @monaco-editor/react's default loader fetches Monaco from cdn.jsdelivr.net at
 * runtime, which broke Review and Files on any server without outbound internet,
 * and contradicted "nothing is sent anywhere else". `loader.config({ monaco })`
 * hands it the bundled copy instead.
 *
 * Only the editor core and the Monarch grammars are pulled in: both views are
 * read-only, so the TypeScript/JSON/CSS/HTML language services (and their
 * multi-megabyte workers) would buy diagnostics nobody can act on. The one
 * worker left is the editor worker, which computes diffs.
 *
 * Import this module only from lazily loaded views: it is the whole editor.
 */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { loader, type Monaco } from "@monaco-editor/react";
import { monoFont, tokenColor } from "./tokenColor";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

export const MONACO_THEME = "kohlab";

/** Colours from the same tokens as the terminal, so the panes read as one surface. */
export function defineKohlabTheme(m: Monaco) {
  const el = document.documentElement;
  const c = (token: string, alpha?: number) => tokenColor(el, token, alpha) ?? "#000000";
  m.editor.defineTheme(MONACO_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": c("--surface-sunken"),
      "editor.foreground": c("--text-primary"),
      "editorGutter.background": c("--surface-sunken"),
      "editorLineNumber.foreground": c("--text-faint"),
      "editorLineNumber.activeForeground": c("--text-muted"),
      "editor.selectionBackground": c("--accent", 0.32),
      "editor.lineHighlightBackground": c("--surface-hover", 0.6),
      "editorCursor.foreground": c("--accent"),
      "editorWidget.background": c("--surface-overlay"),
      "editorWidget.border": c("--line-strong"),
      "diffEditor.insertedTextBackground": c("--status-running", 0.2),
      "diffEditor.removedTextBackground": c("--status-danger", 0.2),
      "diffEditor.insertedLineBackground": c("--status-running", 0.08),
      "diffEditor.removedLineBackground": c("--status-danger", 0.08),
      "diffEditor.border": c("--line-subtle"),
      "scrollbarSlider.background": c("--line-strong", 0.5),
      "scrollbarSlider.hoverBackground": c("--line-strong", 0.8),
    },
  });
}

/** Options both read-only views share. */
export function baseOptions() {
  return {
    readOnly: true,
    minimap: { enabled: false },
    fontFamily: monoFont(),
    fontSize: 12,
    scrollBeyondLastLine: false,
  } as const;
}
