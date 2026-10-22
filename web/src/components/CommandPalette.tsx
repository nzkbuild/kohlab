import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Dialog } from "./ui";
import {
  ArrowDown,
  ArrowElbowDownLeft,
  ArrowUp,
  ClockCounterClockwise,
  DownloadSimple,
  Eye,
  File,
  FolderSimple,
  Gauge,
  GearSix,
  House,
  Keyboard,
  Link,
  MagnifyingGlass,
  NotePencil,
  Plus,
  Terminal,
  TerminalWindow,
  X,
  Copy,
} from "@phosphor-icons/react";
import { api } from "../api";
import { useApp, useCan } from "../store";
import { announce } from "../lib/announce";
import { copyText } from "../lib/clipboard";
import { readDraft } from "../lib/drafts";
import { PROMPT_MAX } from "../lib/route";
import { isApple, isTouchOnly, isTypingTarget } from "../lib/platform";
import { canContinue, copyProject } from "../lib/projectActions";
import { agentName, isAiAgent } from "../lib/agentName";
import { startNewProject } from "../lib/newProject";
import type { PanelAction, PanelRequest } from "../store";
import type { Workspace } from "../types";
import { projectTitle } from "../lib/format";
import { sidebarOrder } from "../lib/sidebarOrder";
import { STATUS_LABEL, workspaceStatus, type WorkspaceStatus } from "../lib/status";
import { Button, Kbd } from "./ui";

/** A group heading is plain text: the fixed ones, and the open project's name. */
type PaletteGroup = string;

type PaletteItem = {
  id: string;
  label: string;
  group: PaletteGroup;
  icon: ReactNode;
  /** Muted text on the right of the row: a shortcut, or "Current" for the model in use. */
  hint?: string;
  keywords?: string[];
  status?: WorkspaceStatus;
  onAction: () => void | Promise<unknown>;
};

/** The open project's own actions. Changing things is for people who can change the project. */
function projectActionItems(
  w: Workspace,
  group: string,
  mutate: boolean,
  powerTools: boolean,
  requestPanel: (request: PanelRequest) => void,
  setNotesFor: (id: string | null) => void,
  hasWork: boolean,
): PaletteItem[] {
  const panel = (action: PanelAction) => () => requestPanel({ workspaceId: w.id, action });
  // A chat project's terminal is a power tool: it is listed only once power tools are on.
  const terminals = mutate && (!w.chat || powerTools);
  return [
    ...(terminals
      ? [{ id: "project-terminal", label: "Open terminal", group, icon: <Terminal size={16} />, hint: "Ctrl `", keywords: ["shell", "console", "command line"], onAction: panel("terminal") }]
      : []),
    ...(terminals && canContinue(w)
      ? [{ id: "project-continue", label: "Continue in Claude's terminal", group, icon: <TerminalWindow size={16} />, keywords: ["resume", "chat", "claude"], onAction: panel("continue") }]
      : []),
    ...(mutate && w.chat
      ? [{ id: "project-notes", label: `Notes for ${isAiAgent(w.agent) ? agentName(w.agent) : "the AI"}…`, group, icon: <NotePencil size={16} />, keywords: ["remember", "business", "colours", "tone", "brand", "instructions"], onAction: () => setNotesFor(w.id) }]
      : []),
    ...(mutate ? [{ id: "project-copy", label: "Make a copy", group, icon: <Copy size={16} />, keywords: ["duplicate", "fork", "clone", "copy"], onAction: () => copyProject(w) }] : []),
    { id: "project-file", label: "Open file…", group, icon: <File size={16} />, keywords: ["files", "code", "browse"], onAction: panel("files") },
    { id: "project-versions", label: "Earlier versions", group, icon: <ClockCounterClockwise size={16} />, keywords: ["changes", "history", "undo", "versions"], onAction: panel("changes") },
    { id: "project-download", label: "Download project", group, icon: <DownloadSimple size={16} />, keywords: ["zip", "save", "export", "archive"], onAction: () => api.downloadProject(w.id, projectTitle(w)) },
    { id: "project-preview", label: "Preview", group, icon: <Eye size={16} />, keywords: ["site", "browser", "view", "page"], onAction: panel("preview") },
  ].filter((i) => i.id !== "project-preview" || !w.chat || hasWork || w.lastCommitAt !== undefined);
}

/**
 * Command palette: an APG combobox + listbox (popup) with grouped options.
 *
 * The combobox role lives on the input itself and DOM focus never leaves it:
 * the active option is expressed as `aria-activedescendant`, never as focus, so
 * arrowing through results cannot steal the caret out of the filter field.
 */
export default function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const workspaces = useApp((s) => s.workspaces);
  const route = useApp((s) => s.route);
  const requestPanel = useApp((s) => s.requestPanel);
  const navigate = useApp((s) => s.navigate);
  const setNewOpen = useApp((s) => s.setNewOpen);
  const setNotesFor = useApp((s) => s.setNotesFor);
  const powerTools = useApp((s) => s.powerTools);
  const setShortcutsOpen = useApp((s) => s.setShortcutsOpen);
  const setUsageOpen = useApp((s) => s.setUsageOpen);
  const can = useCan();
  const refresh = useApp((s) => s.refresh);

  const inputRef = useRef<HTMLInputElement>(null);
  // `useId` keeps option ids unique if a second palette is ever mounted.
  const uid = useId().replace(/:/g, "");
  const listId = `${uid}-listbox`;

  // Global accelerator, bound on document so it works from any surface. It must
  // not fire while someone is typing elsewhere; the palette's own input is the
  // exception, because Ctrl/⌘ K there is the documented way to close it again.
  // Ctrl/⌘ Shift P opens it too.
  // Rebinding on `open` is what lets the open path reset filter and selection in
  // one place: Radix only ever closes this dialog, so a Radix-driven *open*
  // never happens and cannot be the reset hook.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!(e.metaKey || e.ctrlKey) || !(key === "k" || (key === "p" && e.shiftKey))) return;
      if (e.target !== inputRef.current && isTypingTarget(e.target)) return;
      e.preventDefault();
      if (open) {
        setOpen(false);
        return;
      }
      setOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  // Every open (key or search button) starts with a clean filter.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
  }, [open]);

  // Workspace data is store-owned (visibility-gated poll + push socket), so the
  // palette asks for a fresh read on open rather than polling itself.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q) || s.toLowerCase().includes(q.replace(/\s+/g, "-"));

  // With a project open, its own group sits between Projects and Actions.
  const openId = route.kind === "workspace" ? route.id : null;
  const openProject = openId ? workspaces.find((w) => w.id === openId) : undefined;
  const projectGroup = openProject ? projectTitle(openProject) : null;
  const hasWork = useApp((s) => (openProject ? s.hasWork[openProject.id] === true : false));
  const groupOrder: readonly PaletteGroup[] = projectGroup
    ? ["Views", "Projects", projectGroup, "Actions"]
    : ["Views", "Projects", "Actions"];
  const projectItems: PaletteItem[] = openProject ? projectActionItems(openProject, projectGroup ?? "", can.mutate, powerTools, requestPanel, setNotesFor, hasWork) : [];
  // The draft of the screen behind the palette (its chat, or Home). The prompt link is offered only while it has text.
  const draftScope = route.kind === "workspace" ? route.id : route.kind === "workspaces" ? "home" : null;
  const draftText = draftScope ? readDraft(draftScope) : "";

  const items: PaletteItem[] = [
    {
      id: "view-home",
      label: "Home",
      group: "Views",
      icon: <House size={16} />,
      keywords: ["projects", "list", "dashboard", "start"],
      onAction: () => navigate({ kind: "workspaces" }),
    },
    {
      id: "view-settings",
      label: "Settings",
      group: "Views",
      icon: <GearSix size={16} />,
      keywords: ["claude", "account", "notifications", "updates", "preferences"],
      onAction: () => navigate({ kind: "settings" }),
    },
    // One entry per project, in sidebar order, with the sidebar's dot for the two statuses that need the user.
    // The open project has its own group above, so it is not listed twice.
    ...sidebarOrder(workspaces).filter((w) => w.id !== openId).map((w) => {
      const status = workspaceStatus(w);
      const title = projectTitle(w);
      return {
        id: `project-${w.id}`,
        label: title,
        group: "Projects" as const,
        icon: <FolderSimple size={16} />,
        status,
        keywords: [w.id],
        onAction: () => navigate({ kind: "workspace", id: w.id }),
      };
    }),
    ...projectItems,
    ...(can.mutate
      ? [
          {
            id: "action-new",
            label: "New project",
            group: "Actions" as const,
            icon: <Plus size={16} />,
            keywords: ["create", "start", "describe", "build"],
            onAction: startNewProject,
          },
          {
            id: "action-new-from-link",
            label: "Start from a folder or link",
            group: "Actions" as const,
            icon: <Link size={16} />,
            keywords: ["clone", "github", "copy", "import", "folder", "repo"],
            onAction: () => setNewOpen(true),
          },
        ]
      : []),
    ...(isTouchOnly()
      ? []
      : [
          {
            id: "action-usage",
            label: "Usage",
            group: "Actions" as const,
            icon: <Gauge size={16} />,
            keywords: ["plan", "limit", "limits", "quota", "claude"],
            onAction: () => setUsageOpen(true),
          },
          {
            id: "action-shortcuts",
            label: "Keyboard shortcuts",
            group: "Actions" as const,
            icon: <Keyboard size={16} />,
            keywords: ["keys", "hotkeys", "shortcuts", "help"],
            onAction: () => setShortcutsOpen(true),
          },
        ]),
    ...(draftText.trim() !== ""
      ? [
          {
            id: "action-prompt-link",
            label: "Copy prompt link",
            group: "Actions" as const,
            icon: <Link size={16} />,
            keywords: ["prompt", "share", "url", "link"],
            onAction: async () => {
              await copyText(`${location.origin}/new?prompt=${encodeURIComponent(draftText.slice(0, PROMPT_MAX))}`);
              announce("Prompt link copied");
            },
          },
        ]
      : []),
  ];

  const filtered = items.filter((i) => match(i.label) || i.keywords?.some((k) => match(k)));
  // Option ids are minted once, so the id attribute and the
  // `aria-activedescendant` reference can never drift apart.
  const optionIds = filtered.map((_, index) => `${uid}-option-${index}`);
  const sections = groupOrder.map((group) => ({
    group,
    entries: filtered.flatMap((entry, index) => (entry.group === group ? [{ entry, index }] : [])),
  })).filter((section) => section.entries.length > 0);

  // Clamped, so `aria-activedescendant` can only ever name a rendered option.
  const activePosition = filtered.length ? Math.min(activeIndex, filtered.length - 1) : -1;
  const activeOptionId = optionIds[activePosition];

  useEffect(() => {
    if (!open || !activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [open, activeOptionId]);

  // One activation path for keyboard and mouse alike, so no action is reachable
  // by pointer only.
  const activate = (target: PaletteItem) => {
    setOpen(false);
    void (async () => {
      try {
        await target.onAction();
      } catch (e) {
        announce(`${target.label} failed: ${(e as Error).message}`);
      }
    })();
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!filtered.length) return;
      setActiveIndex((i) => {
        const current = Math.min(i, filtered.length - 1);
        return e.key === "ArrowDown" ? Math.min(current + 1, filtered.length - 1) : Math.max(current - 1, 0);
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[activePosition];
      if (target) activate(target);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search pages, projects and actions. Use the arrow keys to move and Enter to run the highlighted one.
          </Dialog.Description>

          <div className="flex items-center gap-2 border-b border-line-subtle px-3">
            <MagnifyingGlass size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
            <input
              ref={inputRef}
              autoFocus
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              role="combobox"
              aria-label="Search pages, projects and actions"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={activeOptionId}
              placeholder="Search projects, or run a command…"
              className="min-w-0 flex-1 bg-transparent py-3 text-sm text-text-primary outline-none! placeholder:text-text-faint"
            />
            {isTouchOnly() ? null : <Kbd>{isApple ? "⌘K" : "Ctrl K"}</Kbd>}
            <Dialog.Close asChild>
              <Button variant="quiet" iconOnly size="sm" aria-label="Close">
                <X size={13} />
              </Button>
            </Dialog.Close>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-1.5">
            {/* `option` has no native element outside <select>, so the listbox and
                its options are ARIA roles on plain elements.
                a11y-ok: they are deliberately NOT focusable, in the ARIA combobox
                pattern focus stays on the input above and movement is announced via
                aria-activedescendant. Giving the options tabIndex would add a stop
                for every result and break that pattern. */}
            <div role="listbox" id={listId} aria-label="Search results">
              {sections.map((section) => (
                <div key={section.group} role="group" aria-labelledby={`${uid}-group-${section.group}`} className="py-1">
                  <div id={`${uid}-group-${section.group}`} className="section-label px-3 py-1 text-text-faint">
                    {section.group}
                  </div>
                  {section.entries.map(({ entry, index }) => (
                    <div
                      key={entry.id}
                      id={optionIds[index]}
                      role="option"
                      aria-selected={index === activePosition}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => activate(entry)}
                      className="palette-item cursor-pointer"
                    >
                      <span className="shrink-0 text-text-muted" aria-hidden="true">
                        {entry.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{entry.label}</span>
                      </span>
                      {entry.hint && !isTouchOnly() ? <span className="shrink-0 whitespace-nowrap text-xs text-text-faint">{entry.hint}</span> : null}
                      {entry.status === "needs-you" || entry.status === "needs-review" ? (
                        <>
                          <span className="sidebar-dot" aria-hidden="true" />
                          <span className="sr-only">{STATUS_LABEL[entry.status]}</span>
                        </>
                      ) : null}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {filtered.length === 0 ? <p className="px-3 py-8 text-center text-sm text-text-muted">No matches</p> : null}
          </div>

          <div className="flex items-center gap-2 border-t border-line-subtle px-3 py-2 text-xs text-text-muted">
            <span className="ml-auto flex items-center gap-3">
              <span className="flex items-center gap-1">
                <ArrowUp size={12} aria-hidden="true" />
                <ArrowDown size={12} aria-hidden="true" /> Move
              </span>
              <span className="flex items-center gap-1">
                <ArrowElbowDownLeft size={12} aria-hidden="true" /> Run
              </span>
              <span className="flex items-center gap-1">
                <Kbd>esc</Kbd> Close
              </span>
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
