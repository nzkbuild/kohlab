import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, DownloadSimple, FilePlus, UploadSimple, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../api";
import type { DiffFile, TreeNode } from "../types";
import { announce } from "../lib/announce";
import { findWorkspace, useApp, useCan } from "../store";
import { cn } from "../lib/utils";
import { Button, Dialog, Field, SkeletonRows } from "./ui";
import TreeList from "./files/TreeList";
import QuickOpen from "./files/QuickOpen";
import { changeMap, filePaths, imageType, isTextContent, sortTree, type Change } from "./files/tree";

// Monaco and the chat are heavy: neither is in the bundle of the page that mounts this view.
const CodeEditor = lazy(() => import("./files/CodeEditor"));
const ChatView = lazy(() => import("./ChatView"));

interface Props {
  workspaceId: string;
}

interface Tab {
  path: string;
  kind: "text" | "image" | "blocked";
  /** The text as it was last loaded or saved. Unsaved edits live in the buffer, not here. */
  original: string;
  /** Bumped when the open file changes on disk, so the editor remounts with the new text. */
  rev: number;
  imageUrl?: string;
}

const WIDE_QUERY = "(min-width: 900px)";
const CLAUDE_HIDDEN_KEY = "kohlab_files_claude_hidden";

function readClaudeHidden(): boolean {
  try {
    return localStorage.getItem(CLAUDE_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeClaudeHidden(hidden: boolean) {
  try {
    localStorage.setItem(CLAUDE_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    /* private mode: the choice lasts this visit only */
  }
}

/** Desktop (≥ 900px) gets three columns with Claude docked; phones get one column. */
function useMedia(query_: string): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(query_).matches);
  useEffect(() => {
    const query = window.matchMedia(query_);
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [query_]);
  return wide;
}

/** Claude is docked only where the editor keeps at least 480px beside the tree and the dock. */
const DOCK_QUERY = "(min-width: 1280px)";

const baseName = (path: string) => path.split("/").pop() ?? path;

/**
 * Project files: a tree, an editor with tabs, and Claude docked on the right.
 * The inner component is keyed by project, so one project's tabs never show in another.
 */
export default function FilesView({ workspaceId }: Props) {
  return <Files key={workspaceId} workspaceId={workspaceId} />;
}

function Files({ workspaceId }: Props) {
  const workspace = useApp((s) => findWorkspace(s.workspaces, workspaceId));
  const can = useCan().mutate;
  const wide = useMedia(WIDE_QUERY);
  const room = useMedia(DOCK_QUERY);
  const chat = !!workspace?.chat;
  // Anything that changes when Claude works or a run ends: a reason to re-read the tree and the diff.
  const signature = workspace
    ? [workspace.running, workspace.started, workspace.stopped, workspace.waiting, workspace.lastCommitAt, workspace.discardedAt].join("|")
    : "";

  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [changes, setChanges] = useState<Map<string, Change>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  const [opening, setOpening] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  /** null when the New file dialog is closed, otherwise the name typed so far. */
  const [newName, setNewName] = useState<string | null>(null);
  const [claudeHidden, setClaudeHidden] = useState(readClaudeHidden);
  const uploadRef = useRef<HTMLInputElement>(null);
  const newNameId = useId();

  // Async loaders read these, so they always see the latest tabs and unsaved text.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const buffers = useRef(new Map<string, string>());

  const paths = useMemo(() => (tree ? filePaths(tree) : []), [tree]);

  const loadTree = useCallback(async () => {
    try {
      const [nodes, diff] = await Promise.all([api.files(workspaceId), api.diff(workspaceId).catch((): DiffFile[] => [])]);
      setTree(sortTree(nodes));
      setChanges(changeMap(diff));
      setTreeError(null);
    } catch (e) {
      setTreeError((e as Error).message);
    }
  }, [workspaceId]);

  const setDirtyState = (path: string, isDirty: boolean) =>
    setDirty((prev) => {
      if (prev.has(path) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(path);
      else next.delete(path);
      return next;
    });

  /** Open files that Claude changed on disk are re-read; a file with unsaved edits keeps them. */
  const reloadOpen = useCallback(async () => {
    for (const tab of tabsRef.current) {
      if (tab.kind !== "text") continue;
      if ((buffers.current.get(tab.path) ?? tab.original) !== tab.original) continue;
      try {
        const { content } = await api.file(workspaceId, tab.path);
        if (content === tab.original || !isTextContent(content)) continue;
        buffers.current.set(tab.path, content);
        setTabs((prev) => prev.map((t) => (t.path === tab.path ? { ...t, original: content, rev: t.rev + 1 } : t)));
      } catch {
        /* gone or offline: keep what is open */
      }
    }
  }, [workspaceId]);

  const refreshAll = useCallback(() => {
    void loadTree();
    void reloadOpen();
  }, [loadTree, reloadOpen]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll, signature]);

  useEffect(
    () => () => {
      for (const tab of tabsRef.current) if (tab.imageUrl) URL.revokeObjectURL(tab.imageUrl);
    },
    [],
  );

  const reveal = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });

  const toggleFolder = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const openFile = async (path: string) => {
    reveal(path);
    if (tabsRef.current.some((t) => t.path === path)) {
      setActive(path);
      return;
    }
    setOpening(path);
    try {
      const mime = imageType(path);
      let tab: Tab;
      if (mime) {
        const blob = await api.rawBlob(workspaceId, path);
        tab = { path, kind: "image", original: "", rev: 0, imageUrl: URL.createObjectURL(new Blob([blob], { type: mime })) };
      } else {
        const { content } = await api.file(workspaceId, path);
        if (isTextContent(content)) {
          buffers.current.set(path, content);
          tab = { path, kind: "text", original: content, rev: 0 };
        } else {
          tab = { path, kind: "blocked", original: "", rev: 0 };
        }
      }
      setTabs((prev) => [...prev, tab]);
      setActive(path);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOpening(null);
    }
  };

  const onEdit = (tab: Tab, value: string) => {
    buffers.current.set(tab.path, value);
    setDirtyState(tab.path, value !== tab.original);
  };

  const closeTab = (path: string) => {
    const list = tabsRef.current;
    const tab = list.find((t) => t.path === path);
    if (!tab) return;
    const unsaved = tab.kind === "text" && (buffers.current.get(path) ?? tab.original) !== tab.original;
    if (unsaved && !window.confirm(`Close ${baseName(path)} without saving? Your changes will be lost.`)) return;
    if (tab.imageUrl) URL.revokeObjectURL(tab.imageUrl);
    buffers.current.delete(path);
    setDirtyState(path, false);
    const index = list.findIndex((t) => t.path === path);
    const rest = list.filter((t) => t.path !== path);
    setTabs(rest);
    if (active === path) setActive(rest[Math.min(index, rest.length - 1)]?.path ?? null);
  };

  const save = async () => {
    if (!can || !active) return;
    const tab = tabsRef.current.find((t) => t.path === active);
    if (!tab || tab.kind !== "text") return;
    const text = buffers.current.get(tab.path) ?? tab.original;
    try {
      await api.putFile(workspaceId, tab.path, new Blob([text], { type: "text/plain;charset=utf-8" }), true);
      setTabs((prev) => prev.map((t) => (t.path === tab.path ? { ...t, original: text } : t)));
      // Typing may have continued while the save was in flight.
      setDirtyState(tab.path, (buffers.current.get(tab.path) ?? text) !== text);
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const createFile = async (name: string) => {
    const path = name.trim().replace(/^\/+/, "");
    if (!path) return;
    try {
      await api.fsOp(workspaceId, "touch", path);
      setNewName(null);
      announce(`${path} created`);
      await loadTree();
      await openFile(path);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const upload = async (files: File[]) => {
    for (const file of files) {
      const path = file.name;
      try {
        await api.putFile(workspaceId, path, file);
      } catch (e) {
        const message = (e as Error).message;
        if (!/already exists/.test(message)) {
          toast.error(`${path}: ${message}`);
          continue;
        }
        if (!window.confirm(`${path} already exists. Replace it?`)) continue;
        try {
          await api.putFile(workspaceId, path, file, true);
        } catch (e2) {
          toast.error(`${path}: ${(e2 as Error).message}`);
        }
      }
    }
    refreshAll();
  };

  // Capture phase, so the editor never sees Ctrl/⌘ S or P first.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      e.stopPropagation();
      void save();
    } else if (key === "p") {
      e.preventDefault();
      e.stopPropagation();
      setQuickOpen(true);
    }
  };

  const setClaudeDocked = (hidden: boolean) => {
    setClaudeHidden(hidden);
    writeClaudeHidden(hidden);
  };

  const downloadProject = () => {
    api.download(workspaceId, "").catch((e: Error) => toast.error(e.message));
  };

  const activeTab = tabs.find((t) => t.path === active) ?? null;
  const status = activeTab?.kind === "text" ? (dirty.has(activeTab.path) ? "Unsaved" : "Saved") : null;
  const showDock = wide && room && chat && !claudeHidden;

  return (
    <div onKeyDownCapture={onKeyDown} className="flex h-full min-h-0 min-w-0">
      {/* Left: the tree. On a phone it is the whole view until a file is open. */}
      <section
        aria-label="Files"
        className={cn("flex min-h-0 w-full flex-col min-[900px]:w-[240px] min-[900px]:shrink-0", active && "max-[899px]:hidden")}
      >
        <div className="flex h-11 shrink-0 items-center justify-between gap-1 ps-3 pe-2">
          <p className="text-sm font-medium text-text-primary">Files</p>
          {can ? (
            <div className="flex items-center gap-0.5">
              <Button variant="quiet" iconOnly aria-label="New file" onClick={() => setNewName("")}>
                <FilePlus size={16} aria-hidden="true" />
              </Button>
              <Button variant="quiet" iconOnly aria-label="Upload files" onClick={() => uploadRef.current?.click()}>
                <UploadSimple size={16} aria-hidden="true" />
              </Button>
              <input
                ref={uploadRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void upload(files);
                }}
              />
            </div>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {treeError ? (
            <p role="alert" className="px-2 text-small text-status-danger">
              {treeError}
            </p>
          ) : tree === null ? (
            <SkeletonRows rows={6} />
          ) : tree.length === 0 ? (
            <p className="px-2 text-small text-text-muted">No files yet.</p>
          ) : (
            <TreeList
              nodes={tree}
              changes={changes}
              expanded={expanded}
              activePath={active}
              onToggle={toggleFolder}
              onOpen={(path) => void openFile(path)}
            />
          )}
        </div>
        <div className="shrink-0 px-3 pt-2 pb-3">
          <Button variant="secondary" className="w-full rounded-full" onClick={downloadProject}>
            <DownloadSimple size={14} aria-hidden="true" />
            Download project
          </Button>
        </div>
      </section>

      {/* Middle: the editor on the terminal surface. On a phone it opens full width with a Back button. */}
      <section
        aria-label="Editor"
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !active && "max-[899px]:hidden")}
      >
        <div className="dark-pane mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-surface-terminal">
          <div className="flex min-h-11 shrink-0 items-center gap-2 px-2">
            <Button variant="quiet" size="sm" className="min-[900px]:hidden" onClick={() => setActive(null)}>
              <ArrowLeft size={14} aria-hidden="true" />
              Back
            </Button>
            <ul aria-label="Open files" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              {tabs.map((tab) => {
                const name = baseName(tab.path);
                const isActive = tab.path === active;
                return (
                  <li key={tab.path} className={cn("flex max-w-56 shrink-0 items-center rounded-lg", isActive && "bg-surface-hover")}>
                    <button
                      type="button"
                      aria-current={isActive ? "true" : undefined}
                      title={tab.path}
                      onClick={() => setActive(tab.path)}
                      className={cn(
                        "mono flex min-w-0 items-center gap-2 py-1.5 ps-2.5 text-sm",
                        isActive ? "text-text-primary" : "text-text-muted hover:text-text-primary",
                      )}
                    >
                      <span className="truncate">{name}</span>
                      {dirty.has(tab.path) ? (
                        <>
                          <span className="size-1.5 shrink-0 rounded-full bg-text-muted" aria-hidden="true" />
                          <span className="sr-only">(unsaved)</span>
                        </>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${name}`}
                      onClick={() => closeTab(tab.path)}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-text-muted hover:text-text-primary"
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {status ? <span className="shrink-0 text-sm text-text-muted">{status}</span> : null}
            {wide && room && chat && claudeHidden ? (
              <Button variant="quiet" size="sm" onClick={() => setClaudeDocked(false)}>
                Show chat
              </Button>
            ) : null}
          </div>

          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0 flex flex-col">
              {activeTab?.kind === "text" ? (
                <Suspense fallback={<p className="p-4 text-small text-text-muted">Opening the editor…</p>}>
                  <div className="min-h-0 flex-1">
                    <CodeEditor
                      key={`${activeTab.path}#${activeTab.rev}`}
                      path={activeTab.path}
                      value={buffers.current.get(activeTab.path) ?? activeTab.original}
                      readOnly={!can}
                      onChange={(value) => onEdit(activeTab, value)}
                    />
                  </div>
                </Suspense>
              ) : activeTab?.kind === "image" && activeTab.imageUrl ? (
                <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4">
                  <img src={activeTab.imageUrl} alt={baseName(activeTab.path)} className="max-h-full max-w-full object-contain" />
                </div>
              ) : activeTab?.kind === "blocked" ? (
                <div className="flex flex-col items-start gap-3 p-6">
                  <p className="text-base text-text-secondary">This file can't be shown here.</p>
                  <Button variant="secondary" className="rounded-full" onClick={() => api.download(workspaceId, activeTab.path).catch((e: Error) => toast.error(e.message))}>
                    <DownloadSimple size={14} aria-hidden="true" />
                    Download
                  </Button>
                </div>
              ) : (
                <p className="p-6 text-base text-text-muted">
                  {opening ? "Opening the file…" : "Open a file from the list, or press Ctrl P (⌘ P on a Mac) to find one."}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Right: Claude, docked. Desktop only; on a phone Claude is its own tab. */}
      {showDock ? (
        <aside aria-label="Chat" className="flex min-h-0 w-[400px] shrink-0 flex-col pe-3">
          <div className="flex h-11 shrink-0 items-center justify-end px-2">
            <Button variant="quiet" size="sm" onClick={() => setClaudeDocked(true)}>
              Hide chat
            </Button>
          </div>
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0">
              <Suspense fallback={null}>
                <ChatView key={`${workspaceId}:${workspace?.chatReset ?? 0}`} workspaceId={workspaceId} compact onTurnEnd={refreshAll} />
              </Suspense>
            </div>
          </div>
        </aside>
      ) : null}

      <QuickOpen open={quickOpen} onOpenChange={setQuickOpen} paths={paths} onPick={(path) => void openFile(path)} />

      <Dialog.Root open={newName !== null} onOpenChange={(open) => !open && setNewName(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content p-4">
            <Dialog.Title className="text-base font-semibold text-text-primary">New file</Dialog.Title>
            <Dialog.Description className="sr-only">Create an empty file in the project.</Dialog.Description>
            <form
              className="mt-3 flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void createFile(newName ?? "");
              }}
            >
              <Field label="File name" htmlFor={newNameId} help="Use a slash to put it in a folder, for example notes/todo.md.">
                <input
                  id={newNameId}
                  aria-label="File name"
                  autoFocus
                  value={newName ?? ""}
                  onChange={(e) => setNewName(e.target.value)}
                  className="field-input mono"
                  autoComplete="off"
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setNewName(null)}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" disabled={!(newName ?? "").trim()}>
                  Create file
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
