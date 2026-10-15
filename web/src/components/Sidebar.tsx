import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  CaretDoubleLeft,
  CaretDoubleRight,
  DotsThree,
  DownloadSimple,
  GearSix,
  MagnifyingGlass,
  PencilSimple,
  Trash,
  X,
} from "@phosphor-icons/react";
import { api } from "../api";
import { useApp, useCan } from "../store";
import { STATUS_LABEL, workspaceStatus } from "../lib/status";
import { sidebarOrder } from "../lib/sidebarOrder";
import { projectTitle } from "../lib/format";
import { toastAction } from "../lib/actions";
import { announce } from "../lib/announce";
import { restoreFocusAfterClose } from "../lib/inputModality";
import { cn } from "../lib/utils";
import { isPhone } from "../lib/viewport";
import ConfirmDialog from "./ConfirmDialog";
import { disposeWorkspaceTerminals } from "./terminalCache";
import { Button, Dialog, MenuItem, Tooltip } from "./ui";

const COLLAPSE_KEY = "kohlab_sidebar_collapsed";

/** Chromium's install prompt. Not in the DOM typings, so the one member used is spelled out. */
type InstallEvent = Event & { prompt: () => Promise<void> };

/**
 * Saves a project's name. A blank or unchanged name is not sent. Returns false
 * only when the server refused the name; the toast says why.
 */
export async function saveProjectName(id: string, next: string, shown: string): Promise<boolean> {
  const name = next.trim();
  if (!name || name === shown) return true;
  try {
    await api.rename(id, name);
    await useApp.getState().refresh();
    announce(`Project renamed to ${name}`);
    return true;
  } catch (e) {
    toast.error(`Could not rename, ${(e as Error).message}`);
    return false;
  }
}

/** A name edited in place. Enter or leaving the field saves; Escape cancels (`onDone(null)`). */
export function RenameField({
  initial,
  className,
  onDone,
}: {
  initial: string;
  className?: string;
  onDone: (next: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  // Enter and blur can both arrive as the field unmounts: only the first counts.
  const settle = (next: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(next);
  };

  return (
    <input
      ref={field}
      type="text"
      aria-label="Project name"
      className={cn("field-input min-w-0 flex-1", className)}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          settle(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          settle(null);
        }
      }}
      onBlur={() => settle(value)}
    />
  );
}

/** Rename from the project header. A small dialog, so focus stays put while the header menu closes. */
export function RenameDialog({
  id,
  shown,
  open,
  onOpenChange,
}: {
  id: string;
  shown: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(shown);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setValue(shown);
  }, [open, shown]);

  const submit = async () => {
    setBusy(true);
    const saved = await saveProjectName(id, value, shown);
    setBusy(false);
    if (saved) onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">Rename project</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs leading-5 text-text-muted">
            This is the name shown in the project list and at the top of the project.
          </Dialog.Description>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              type="text"
              aria-label="Project name"
              className="field-input"
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
              <Dialog.Close asChild>
                <Button variant="secondary" size="sm" className="max-md:w-full">
                  cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" size="sm" disabled={busy} aria-busy={busy} className="max-md:w-full">
                {busy ? "saving…" : "save"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface Props {
  /** Mobile drawer visibility. On desktop the rail is always present. */
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: Props) {
  const route = useApp((s) => s.route);
  const workspaces = useApp((s) => s.workspaces);
  const navigate = useApp((s) => s.navigate);
  const setNewOpen = useApp((s) => s.setNewOpen);
  const navIndex = useApp((s) => s.navIndex);
  const navMax = useApp((s) => s.navMax);
  // Back needs an earlier entry in this app's history; Forward needs one we already left.
  const canBack = navIndex > 0;
  const canForward = navIndex < navMax;
  const refresh = useApp((s) => s.refresh);
  const can = useCan();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "true");
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  // The project whose More menu is open, the project being renamed in place, and the one awaiting delete.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // On a phone, Rename opens the sheet rather than an inline field in the drawer.
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The Back or Forward button that has focus. When it unmounts, focus goes to search (or the toggle when collapsed).
  const navArrow = useRef<HTMLButtonElement | null>(null);
  // Rename starts only once the menu has closed and released focus, or the field would lose it at once.
  const renameNext = useRef<string | null>(null);
  // Touch has no right-click, and iOS Safari sends no contextmenu, so a held finger opens the More menu.
  const holdTimer = useRef<number | null>(null);
  const holdFired = useRef(false);
  // Where focus returns when a More or account menu closes, so a pointer close can restore it without the ring.
  const moreButtons = useRef(new Map<string, HTMLButtonElement>());
  const accountTrigger = useRef<HTMLButtonElement>(null);

  useEffect(
    () => () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    },
    [],
  );

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  // An arrow that was focused has been removed: without this, focus falls to <body>.
  useEffect(() => {
    const arrow = navArrow.current;
    if (!arrow || arrow.isConnected) return;
    navArrow.current = null;
    if (document.activeElement === document.body || document.activeElement === null) {
      document.querySelector<HTMLButtonElement>(collapsed ? ".sidebar-toggle" : ".sidebar-search")?.focus();
    }
  }, [canBack, canForward, collapsed]);

  // The browser offers the install prompt once; hold it until the button uses it.
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallEvent);
    };
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    setInstallEvent(null);
  };

  // Same path as the project header's delete: drop the open terminals, delete, refresh.
  const removeProject = async (id: string) => {
    setDeleting(true);
    try {
      disposeWorkspaceTerminals(id);
      await toastAction(id, "delete");
      await refresh();
      announce("Project deleted");
      setConfirmDelete(null);
      if (route.kind === "workspace" && route.id === id) navigate({ kind: "workspaces" });
    } catch (e) {
      toast.error(`Delete failed, ${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  const holdStart = (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (e.pointerType !== "touch") return;
    holdFired.current = false;
    holdTimer.current = window.setTimeout(() => {
      holdFired.current = true;
      setMenuFor(id);
    }, 500);
  };
  const holdEnd = () => {
    holdTimer.current = null;
  };

  // Already running as an app: there is nothing to install.
  const standalone = window.matchMedia("(display-mode: standalone)").matches;

  // Me carries no display name yet, so the account row shows the owner.
  const accountName = "Owner";
  const accountInitial = accountName.charAt(0).toUpperCase();

  const projects = sidebarOrder(workspaces);
  const sheetWorkspace = workspaces.find((w) => w.id === sheetFor) ?? null;

  return (
    <aside className="sidebar" data-open={open} data-collapsed={collapsed} aria-label="Primary navigation">
      <div className="sidebar-head flex min-h-[3.25rem] items-center gap-1 px-3">
        <button
          type="button"
          className="sidebar-label min-h-8 min-w-0 truncate rounded-md text-start text-base font-semibold tracking-tight text-text-primary"
          onClick={() => navigate({ kind: "workspaces" })}
        >
          kohlab
        </button>
        <div className="sidebar-head-fill flex-1" />
        {canBack ? (
          <Tooltip content="Back (Alt+←)" side="bottom">
            <Button
              variant="quiet"
              iconOnly
              size="sm"
              className="sidebar-nav shrink-0"
              aria-label="Back"
              onFocus={(e) => (navArrow.current = e.currentTarget)}
              onBlur={(e) => {
                if (e.relatedTarget) navArrow.current = null;
              }}
              onClick={() => history.back()}
            >
              <ArrowLeft size={16} />
            </Button>
          </Tooltip>
        ) : null}
        {canForward ? (
          <Tooltip content="Forward (Alt+→)" side="bottom">
            <Button
              variant="quiet"
              iconOnly
              size="sm"
              className="sidebar-nav shrink-0"
              aria-label="Forward"
              onFocus={(e) => (navArrow.current = e.currentTarget)}
              onBlur={(e) => {
                if (e.relatedTarget) navArrow.current = null;
              }}
              onClick={() => history.forward()}
            >
              <ArrowRight size={16} />
            </Button>
          </Tooltip>
        ) : null}
        <Button
          variant="quiet"
          iconOnly
          size="sm"
          className={cn("sidebar-search", collapsed && "shell:hidden")}
          aria-label="Search projects"
          onClick={() => useApp.getState().setPaletteOpen(true)}
        >
          <MagnifyingGlass size={16} />
        </Button>
        {/* Desktop: collapse the rail. Mobile: dismiss the drawer. The collapsed
            rail has room for one control, so this one is the survivor: see
            .sidebar[data-collapsed="true"] .sidebar-head in index.css. */}
        <Button
          variant="quiet"
          iconOnly
          size="sm"
          className="sidebar-toggle hidden shell:inline-flex"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <CaretDoubleRight size={16} /> : <CaretDoubleLeft size={16} />}
        </Button>
        <Button
          variant="quiet"
          iconOnly
          size="sm"
          className="shell:hidden"
          aria-label="Close navigation"
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </div>

      {can.mutate ? (
        <div className="px-2.5 pb-1 pt-2">
          <Tooltip content="New project" disabled={!collapsed}>
            <button
              type="button"
              className="sidebar-row"
              aria-label="New project"
              onClick={() => {
                setNewOpen(true);
                onClose();
              }}
            >
              <PencilSimple size={18} className="shrink-0" aria-hidden="true" />
              <span className="sidebar-label flex-1 text-base">New project</span>
            </button>
          </Tooltip>
        </div>
      ) : null}

      <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2.5" aria-label="Projects">
        <p className="sidebar-section-title px-2.5 pb-1.5 pt-5 text-sm text-text-faint">Projects</p>
        {workspaces.length === 0 ? (
          <p className="sidebar-label px-2 pt-2 text-sm leading-relaxed text-text-muted">
            Nothing yet. Start a new project and Claude gets to work.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {/* Every row is a workspace: one task, one branch, one agent; it can
                hold several terminal sessions inside. */}
            {projects.map((workspace) => {
              const status = workspaceStatus(workspace);
              const needsYou = status === "needs-you";
              // The only status the rail shows: a dot for needs you, or ready to check.
              const dotLabel = status === "needs-you" || status === "needs-review" ? STATUS_LABEL[status] : null;
              const title = projectTitle(workspace);
              const selected = route.kind === "workspace" && route.id === workspace.id;
              const editing = renaming === workspace.id;
              // Viewers get no menu, so right-click keeps the browser's own.
              const canMenu = can.mutate;
              return (
                <DropdownMenu.Root
                  key={workspace.id}
                  open={canMenu && menuFor === workspace.id}
                  onOpenChange={(next) => setMenuFor(next ? workspace.id : null)}
                >
                  <div
                    className="sidebar-item"
                    data-selected={selected}
                    data-menu-open={menuFor === workspace.id}
                    onPointerDown={canMenu && !editing ? (e) => holdStart(e, workspace.id) : undefined}
                    onPointerUp={holdEnd}
                    onPointerCancel={holdEnd}
                    onContextMenu={
                      canMenu && !editing
                        ? (e) => {
                            e.preventDefault();
                            setMenuFor(workspace.id);
                          }
                        : undefined
                    }
                  >
                    {editing ? (
                      <div className="sidebar-row" data-selected={selected}>
                        <RenameField
                          initial={title}
                          onDone={(next) => {
                            setRenaming(null);
                            if (next !== null) void saveProjectName(workspace.id, next, title);
                          }}
                        />
                      </div>
                    ) : (
                      <Tooltip content={title} disabled={!collapsed}>
                        <button
                          type="button"
                          className="sidebar-row sidebar-link"
                          data-selected={selected}
                          aria-current={selected ? "page" : undefined}
                          onClick={() => {
                            // A long press has just opened the More menu: that press is not a visit.
                            if (holdFired.current) {
                              holdFired.current = false;
                              return;
                            }
                            navigate({ kind: "workspace", id: workspace.id });
                          }}
                        >
                          <span
                            className={cn("sidebar-initial", needsYou && "bg-surface-active text-text-primary")}
                            aria-hidden="true"
                          >
                            {title.charAt(0).toUpperCase()}
                          </span>
                          <span className="sidebar-label min-w-0 flex-1 truncate text-base text-text-primary" title={workspace.id}>
                            {title}
                          </span>
                          {dotLabel ? <span className="sr-only">{dotLabel}</span> : null}
                        </button>
                      </Tooltip>
                    )}
                    {/* The status dot and the More button share one slot at the pill's right edge: the button replaces the dot when the row is hovered, focused, selected or open. */}
                    {dotLabel && !editing ? (
                      <span className="sidebar-status sidebar-label" aria-hidden="true">
                        <span className="sidebar-dot" />
                      </span>
                    ) : null}
                    {canMenu && !editing ? (
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          ref={(el) => {
                            if (el) moreButtons.current.set(workspace.id, el);
                            else moreButtons.current.delete(workspace.id);
                          }}
                          aria-label={`More actions for ${title}`}
                          tabIndex={collapsed ? -1 : undefined}
                          className={cn("sidebar-more", collapsed && "shell:hidden")}
                        >
                          <DotsThree size={16} aria-hidden="true" />
                        </button>
                      </DropdownMenu.Trigger>
                    ) : null}
                  </div>
                  {canMenu ? (
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="menu"
                        align="end"
                        sideOffset={4}
                        collisionPadding={8}
                        onCloseAutoFocus={(e) => {
                          if (renameNext.current === null) {
                            restoreFocusAfterClose(e, moreButtons.current.get(workspace.id));
                            return;
                          }
                          e.preventDefault();
                          if (isPhone()) setSheetFor(renameNext.current);
                          else setRenaming(renameNext.current);
                          renameNext.current = null;
                        }}
                      >
                        <MenuItem
                          onSelect={() => {
                            renameNext.current = workspace.id;
                          }}
                        >
                          <PencilSimple size={16} aria-hidden="true" />
                          Rename
                        </MenuItem>
                        <MenuItem tone="danger" onSelect={() => setConfirmDelete(workspace.id)}>
                          <Trash size={16} aria-hidden="true" />
                          Delete project…
                        </MenuItem>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  ) : null}
                </DropdownMenu.Root>
              );
            })}
          </div>
        )}
      </nav>

      <div className="p-2.5">
        <DropdownMenu.Root>
          <Tooltip content={accountName} disabled={!collapsed}>
            <DropdownMenu.Trigger asChild>
              <button ref={accountTrigger} type="button" className="sidebar-row" aria-label={`Account, ${accountName}`}>
                <span
                  className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-active text-xs font-semibold text-text-primary"
                  aria-hidden="true"
                >
                  {accountInitial}
                </span>
                <span className="sidebar-label min-w-0 flex-1 truncate text-base text-text-primary">{accountName}</span>
              </button>
            </DropdownMenu.Trigger>
          </Tooltip>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="menu"
              align="start"
              side="top"
              sideOffset={4}
              collisionPadding={8}
              onCloseAutoFocus={(e) => restoreFocusAfterClose(e, accountTrigger.current)}
            >
              <MenuItem onSelect={() => navigate({ kind: "settings" })}>
                <GearSix size={16} aria-hidden="true" />
                Settings
              </MenuItem>
              {installEvent && !standalone ? (
                <MenuItem onSelect={() => void install()}>
                  <DownloadSimple size={16} aria-hidden="true" />
                  Install app
                </MenuItem>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <RenameDialog
        id={sheetFor ?? ""}
        shown={sheetWorkspace ? projectTitle(sheetWorkspace) : ""}
        open={sheetFor !== null}
        onOpenChange={(next) => {
          if (!next) setSheetFor(null);
        }}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmDelete(null);
        }}
        title="Delete this project?"
        description="Its files and chat are removed from the server."
        confirmLabel="Delete project"
        busy={deleting}
        onConfirm={() => {
          if (confirmDelete) void removeProject(confirmDelete);
        }}
      />
    </aside>
  );
}
