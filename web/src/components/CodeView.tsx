import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { MONACO_THEME, baseOptions, defineKohlabTheme } from "../lib/monaco";
import { ArrowLeft, Copy } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import { Button, SkeletonRows } from "./ui";
import { copyText } from "../lib/clipboard";

interface Props {
  workspaceId: string;
  filePath: string;
  onBack: () => void;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  json: "json", md: "markdown", html: "html", css: "css", py: "python",
  go: "go", rs: "rust", sh: "shell", yml: "yaml", yaml: "yaml", c: "c",
  cpp: "cpp", h: "c", java: "java", rb: "ruby", php: "php", sql: "sql",
};

/** Read-only viewer for one file in the workspace. Monaco is lazy-loaded by the caller. */
export default function CodeView({ workspaceId, filePath, onBack }: Props) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const lang = LANG_BY_EXT[ext] ?? "plaintext";

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .file(workspaceId, filePath)
      .then((f) => {
        if (!alive) return;
        setContent(f.content);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, filePath, nonce]);

  const copy = async (value: string, what: string) => {
    try {
      await copyText(value);
      toast.success(`${what} copied`);
    } catch {
      toast.error(`could not copy the ${what}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* A toolbar row inside the Files pane, so it follows the same pane-header
          geometry as the rest. No title: the open file's identity is the
          breadcrumb in the pane header directly above this one. */}
      <header className="cockpit-head">
        <Button size="sm" variant="quiet" onClick={onBack}>
          <ArrowLeft size={13} aria-hidden="true" />
          close
        </Button>
        {/* The path itself is in the tab's breadcrumb, repeating it here would
            just push the actions off a narrow pane. */}
        <div className="flex-1" />
        <Button
          size="sm"
          variant="quiet"
          iconOnly
          aria-label="copy file path"
          disabled={loading || !!error}
          onClick={() => void copy(filePath, "path")}
        >
          <Copy size={13} />
        </Button>
        <Button
          size="sm"
          variant="quiet"
          iconOnly
          aria-label="copy file contents"
          disabled={loading || !!error}
          onClick={() => void copy(content, "contents")}
        >
          <Copy size={13} weight="fill" />
        </Button>
      </header>

      {error ? (
        <div role="alert" className="p-4">
          <p className="text-sm text-status-danger">Could not open {filePath}</p>
          <p className="mono mt-1 text-xs leading-relaxed text-text-muted">{error}</p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => setNonce((n) => n + 1)}>
            retry
          </Button>
        </div>
      ) : loading ? (
        <SkeletonRows rows={12} className="p-4" />
      ) : (
        <div className="min-h-0 flex-1">
          <Editor
            height="100%"
            language={lang}
            value={content}
            beforeMount={defineKohlabTheme}
            theme={MONACO_THEME}
            options={{
              ...baseOptions(),
              renderWhitespace: "selection",
              padding: { top: 8 },
            }}
          />
        </div>
      )}
    </div>
  );
}
