import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, CaretRight, DownloadSimple, File, FilePlus, FolderOpen, FolderPlus, FolderSimple, UploadSimple } from "@phosphor-icons/react";
import { toast } from "sonner";
import { useCan } from "../store";
import { announce } from "../lib/announce";
import { api } from "../api";
import type { TreeNode } from "../types";
import { cn } from "../lib/utils";
import { Button, SkeletonRows } from "./ui";

interface Props {
  workspaceId: string;
  onOpenFile: (path: string) => void;
}

interface Row {
  path: string;
  name: string;
  type: "dir" | "file";
  depth: number;
}

/** Visible rows in visual order, the order the arrow keys walk. */
function flattenTree(nodes: TreeNode[], expanded: Set<string>, depth = 0, prefix = ""): Row[] {
  const rows: Row[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    rows.push({ path, name: node.name, type: node.type, depth });
    if (node.type === "dir" && expanded.has(path)) {
      rows.push(...flattenTree(node.children ?? [], expanded, depth + 1, path));
    }
  }
  return rows;
}

/**
 * File tree. The tree is flattened into the rows you can actually see, and the
 * arrow keys walk that list: this is what makes Down/Up/RIGHT/LEFT mean the
 * same thing here as in every other file explorer (APG tree pattern, roving
 * tabindex so the whole tree is one tab stop).
 */
export default function FileTree({ workspaceId, onOpenFile }: Props) {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const [activeType, setActiveType] = useState<"dir" | "file" | null>(null);
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const can = useCan();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setTree(await api.files(workspaceId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => flattenTree(tree ?? [], expanded), [tree, expanded]);
  const focusIndex = Math.min(focused, Math.max(rows.length - 1, 0));

  const focusRow = (index: number) => {
    setFocused(index);
    containerRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.focus();
  };

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  const openFile = (path: string) => {
    setActivePath(path);
    setActiveType("file");
    onOpenFile(path);
  };

  // New things land in the selected folder, or beside the selected file.
  const targetDir = activePath ? (activeType === "dir" ? activePath : activePath.split("/").slice(0, -1).join("/")) : "";
  const under = (name: string) => (targetDir ? `${targetDir}/${name}` : name);
  const where = targetDir ? `${targetDir}/` : "the workspace root";

  const reveal = (dir: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = dir.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });

  const create = async () => {
    const name = newName.trim().replace(/^\/+/, "");
    if (!name || !creating) return;
    setBusy(true);
    try {
      const path = under(name);
      await api.fsOp(workspaceId, creating === "folder" ? "mkdir" : "touch", path);
      await load();
      reveal(creating === "folder" ? path : targetDir);
      announce(`${creating} ${path} created`);
      if (creating === "file") openFile(path);
      setCreating(null);
      setNewName("");
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(false);
  };

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    let done = 0;
    for (const file of files) {
      // A picked folder keeps its structure (webkitRelativePath).
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const path = under(rel);
      try {
        await api.putFile(workspaceId, path, file);
        done++;
      } catch (e) {
        const msg = (e as Error).message;
        if (/already exists/.test(msg) && window.confirm(`${path} already exists. Replace it?`)) {
          try {
            await api.putFile(workspaceId, path, file, true);
            done++;
          } catch (e2) {
            toast.error(`${path}: ${(e2 as Error).message}`);
          }
        } else if (!/already exists/.test(msg)) {
          toast.error(`${path}: ${msg}`);
        }
      }
    }
    await load();
    reveal(targetDir);
    setBusy(false);
    if (done) {
      toast.success(`uploaded ${done} file${done === 1 ? "" : "s"} to ${where}`);
      announce(`uploaded ${done} files`);
    }
  };

  const download = async () => {
    const path = activePath ?? "";
    try {
      await api.download(workspaceId, path);
    } catch (e) {
      toast.error(`could not download: ${(e as Error).message}`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const row = rows[index];
    if (!row) return;
    const last = rows.length - 1;

    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focusRow(
        e.key === "ArrowDown" ? Math.min(index + 1, last) : e.key === "ArrowUp" ? Math.max(index - 1, 0) : e.key === "Home" ? 0 : last,
      );
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (row.type !== "dir") return;
      if (!expanded.has(row.path)) {
        toggleDir(row.path);
        return;
      }
      const child = rows[index + 1];
      if (child && child.depth > row.depth) focusRow(index + 1);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (row.type === "dir" && expanded.has(row.path)) {
        toggleDir(row.path);
        return;
      }
      // Close a file row by hopping to the directory that owns it.
      for (let i = index - 1; i >= 0; i--) {
        if (rows[i].depth < row.depth) {
          focusRow(i);
          return;
        }
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (row.type === "dir") toggleDir(row.path);
      else openFile(row.path);
    }
  };

  const isOpen = tree !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Sidebar-like pane, but the same pane header as the rest: same height,
          padding, border and title treatment. */}
      <header className="cockpit-head">
        {/* The tab header above already says "Files"; this keeps the heading for
            screen readers and lets the buttons sit at the end. */}
        <h2 className="sr-only">File tree</h2>
        <div className="flex-1" />
        {can.mutate ? (
          <>
            <Button variant="quiet" size="sm" iconOnly aria-label="new file" title="new file" onClick={() => setCreating("file")}>
              <FilePlus size={14} />
            </Button>
            <Button variant="quiet" size="sm" iconOnly aria-label="new folder" title="new folder" onClick={() => setCreating("folder")}>
              <FolderPlus size={14} />
            </Button>
            <Button variant="quiet" size="sm" iconOnly aria-label="upload files" title="upload files (or drop them on the tree)" disabled={busy} onClick={() => fileInput.current?.click()}>
              <UploadSimple size={14} />
            </Button>
            <Button variant="quiet" size="sm" iconOnly aria-label="upload a folder" title="upload a folder" disabled={busy} onClick={() => folderInput.current?.click()}>
              <FolderOpen size={14} />
            </Button>
          </>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          aria-label={activePath ? `download ${activePath}` : "download the whole workspace"}
          title={activePath ? (activeType === "dir" ? `download ${activePath} as .tar.gz` : `download ${activePath}`) : "download the whole workspace as .tar.gz"}
          onClick={() => void download()}
        >
          <DownloadSimple size={14} />
        </Button>
        <Button variant="quiet" size="sm" iconOnly aria-label="refresh file tree" onClick={() => void load()}>
          <ArrowsClockwise size={13} />
        </Button>
        <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <input
          ref={folderInput}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          {...({ webkitdirectory: "" } as Record<string, string>)}
          onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }}
        />
      </header>

      {creating ? (
        <form
          className="flex items-center gap-1.5 border-b border-line-subtle px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            autoFocus
            className="field-input mono min-h-(--control-h-sm) py-1 text-xs"
            aria-label={`new ${creating} name, created in ${where}`}
            placeholder={creating === "folder" ? "folder name" : "file name, e.g. notes.md"}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setCreating(null);
                setNewName("");
              }
            }}
          />
          <Button type="submit" size="sm" variant="primary" disabled={busy || !newName.trim()}>
            add
          </Button>
        </form>
      ) : null}
      {creating ? <p className="px-2 pt-1 text-xs text-text-muted">in {where}</p> : null}

      <div
        className={cn("min-h-0 flex-1 overflow-auto p-1.5", dropping && "tree-drop")}
        onDragOver={(e) => {
          if (!can.mutate || !Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          if (!can.mutate) return;
          e.preventDefault();
          setDropping(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
      >
        {error ? (
          <div role="alert" className="p-2">
            <p className="text-xs text-status-danger">{error}</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => void load()}>
              retry
            </Button>
          </div>
        ) : !isOpen ? (
          <SkeletonRows rows={8} />
        ) : rows.length === 0 ? (
          <p className="p-2 text-xs text-text-muted">No files in this workspace yet.</p>
        ) : (
          <div ref={containerRef} role="tree" aria-label={`files in ${workspaceId}`}>
            {rows.map((row, index) => {
              const dir = row.type === "dir";
              const open = dir && expanded.has(row.path);
              return (
                <button
                  key={row.path}
                  type="button"
                  role="treeitem"
                  data-row={index}
                  data-selected={activePath === row.path ? "true" : undefined}
                  aria-level={row.depth + 1}
                  aria-expanded={dir ? open : undefined}
                  tabIndex={index === focusIndex ? 0 : -1}
                  className="file-row w-full text-start"
                  style={{ paddingLeft: `${row.depth * 12 + 6}px` }}
                  onClick={() => {
                    setFocused(index);
                    if (dir) {
                      toggleDir(row.path);
                      setActivePath(row.path);
                      setActiveType("dir");
                    } else openFile(row.path);
                  }}
                  onKeyDown={(e) => onKeyDown(e, index)}
                >
                  {dir ? (
                    <CaretRight
                      size={12}
                      aria-hidden="true"
                      className={cn("shrink-0 transition-transform", open && "rotate-90")}
                    />
                  ) : (
                    <span className="w-2.5 shrink-0" aria-hidden="true" />
                  )}
                  {dir ? (
                    open ? (
                      <FolderOpen size={13} aria-hidden="true" />
                    ) : (
                      <FolderSimple size={13} aria-hidden="true" />
                    )
                  ) : (
                    <File size={13} aria-hidden="true" />
                  )}
                  <span className="truncate">{row.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
