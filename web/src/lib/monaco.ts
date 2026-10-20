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
import { useEffect, useState } from "react";
import { monoFont, tokenColor } from "./tokenColor";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

export const MONACO_DARK = "kohlab-dark";
export const MONACO_LIGHT = "kohlab-light";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** The editor follows the OS setting, like the rest of the page. */
export function monacoTheme(): string {
  return typeof matchMedia === "function" && matchMedia(LIGHT_QUERY).matches ? MONACO_LIGHT : MONACO_DARK;
}

/** The theme name for the current OS setting, switching live when it changes. */
export function useMonacoTheme(): string {
  const [name, setName] = useState(monacoTheme);
  useEffect(() => {
    const query = matchMedia(LIGHT_QUERY);
    const onChange = () => {
      // Colours are read from the page's tokens at define time, so they are read again before the switch.
      defineKohlabTheme(monaco);
      setName(monacoTheme());
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return name;
}

/** Both themes. The dark one reads the pinned .dark-pane tokens; the light one reads the page's, which are light whenever it is selected. */
export function defineKohlabTheme(m: Monaco) {
  defineOne(m, MONACO_DARK, "vs-dark", "dark-pane");
  defineOne(m, MONACO_LIGHT, "vs", "");
}

function defineOne(m: Monaco, name: string, base: "vs" | "vs-dark", paneClass: string) {
  // The probe is attached only to be read, with the pane class that pins the tokens.
  const el = document.createElement("div");
  el.className = paneClass;
  document.body.appendChild(el);
  const c = (token: string, alpha?: number) => tokenColor(el, token, alpha) ?? "#000000";
  m.editor.defineTheme(name, {
    base,
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
      // Additions are neutral: lime means a live agent (DESIGN.md), never a diff.
      "diffEditor.insertedTextBackground": c("--text-primary", 0.16),
      "diffEditor.removedTextBackground": c("--status-danger", 0.2),
      "diffEditor.insertedLineBackground": c("--text-primary", 0.08),
      "diffEditor.removedLineBackground": c("--status-danger", 0.08),
      "diffEditor.border": c("--line-subtle"),
      "scrollbarSlider.background": c("--line-strong", 0.5),
      "scrollbarSlider.hoverBackground": c("--line-strong", 0.8),
    },
  });
  el.remove();
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
