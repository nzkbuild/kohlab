import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { api } from "../api";

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

export default function CodeView({ workspaceId, filePath, onBack }: Props) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const lang = LANG_BY_EXT[ext] ?? "plaintext";

  useEffect(() => {
    api.file(workspaceId, filePath)
      .then((f) => setContent(f.content))
      .catch((e) => setError((e as Error).message));
  }, [workspaceId, filePath]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#27272a] text-xs text-zinc-400">
        <button onClick={onBack} className="text-emerald-400 hover:underline">back</button>
        <span className="font-mono text-zinc-300">{filePath}</span>
      </div>
      {error ? (
        <div className="p-4 text-red-400 text-sm">{error}</div>
      ) : (
        <div className="flex-1 min-h-0">
          <Editor
            height="100%"
            defaultLanguage={lang}
            value={content}
            theme="vs-dark"
            options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }}
          />
        </div>
      )}
    </div>
  );
}
