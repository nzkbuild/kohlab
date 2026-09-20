import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowDown,
  ArrowElbowDownLeft,
  ArrowUp,
  ArrowsClockwise,
  GearSix,
  MagnifyingGlass,
  PlusCircle,
  SquaresFour,
  Stack,
  TerminalWindow,
  X,
} from "@phosphor-icons/react";
import { useApp } from "../store";
import { announce } from "../lib/announce";
import { ROUTE_LABEL } from "../lib/route";
import { byReviewFirst, STATUS_LABEL, workspaceStatus, type WorkspaceStatus } from "../lib/status";
import { Button, Kbd, StatusChip } from "./ui";

type PaletteGroup = "Views" | "Workspaces" | "Actions";

/** Heading order is fixed: where you are, what you have, what you can do. */
const GROUP_ORDER: readonly PaletteGroup[] = ["Views", "Workspaces", "Actions"];

type PaletteItem = {
  id: string;
  label: string;
  group: PaletteGroup;
  subtitle?: string;
  icon: ReactNode;
  keywords?: string[];
  status?: WorkspaceStatus;
  onAction: () => void | Promise<unknown>;
};

/**
 * Focus is "busy typing" inside a form control or a live terminal; the ⌘K
 * accelerator belongs to the field there, not to the palette.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  // A key event can target the document itself; nothing is "typing" then.
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return true;
  return target.closest(".terminal-wrap, .xterm") !== null;
}

/**
 * Command palette — an APG combobox + listbox (popup) with grouped options.
 *
 * The combobox role lives on the input itself and DOM focus never leaves it:
 * the active option is expressed as `aria-activedescendant`, never as focus, so
 * arrowing through results cannot steal the caret out of the filter field.
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const workspaces = useApp((s) => s.workspaces);
  const route = useApp((s) => s.route);
  const navigate = useApp((s) => s.navigate);
  const refresh = useApp((s) => s.refresh);

  const inputRef = useRef<HTMLInputElement>(null);
  // `useId` keeps option ids unique if a second palette is ever mounted.
  const uid = useId().replace(/:/g, "");
  const listId = `${uid}-listbox`;

  // Global accelerator, bound on document so it works from any surface. It must
  // not fire while someone is typing elsewhere; the palette's own input is the
  // exception, because ⌘K there is the documented way to close it again.
  // Rebinding on `open` is what lets the open path reset filter and selection in
  // one place: Radix only ever closes this dialog, so a Radix-driven *open*
  // never happens and cannot be the reset hook.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      if (e.target !== inputRef.current && isTypingTarget(e.target)) return;
      e.preventDefault();
      if (open) {
        setOpen(false);
        return;
      }
      setQuery("");
      setActiveIndex(0);
      setOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Workspace data is store-owned (visibility-gated poll + push socket), so the
  // palette asks for a fresh read on open rather than polling itself.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q) || s.toLowerCase().includes(q.replace(/\s+/g, "-"));

  const items: PaletteItem[] = [
    {
      id: "view-dashboard",
      label: "Command center",
      group: "Views",
      icon: <SquaresFour size={16} />,
      keywords: ["dashboard", "home", "overview", "status"],
      onAction: () => navigate({ kind: "dashboard" }),
    },
    {
      id: "view-workspaces",
      label: "Workspaces",
      group: "Views",
      icon: <Stack size={16} />,
      keywords: ["all", "list", "queue"],
      onAction: () => navigate({ kind: "workspaces" }),
    },
    {
      id: "view-settings",
      label: "Settings",
      group: "Views",
      icon: <GearSix size={16} />,
      keywords: ["agents", "users", "team", "audit", "preferences"],
      onAction: () => navigate({ kind: "settings" }),
    },
    // One entry per workspace, ordered review → running → committed → stopped
    // and tagged with its status chip, so the group reads as a lifecycle.
    ...[...workspaces].sort(byReviewFirst).map((w) => {
      const status = workspaceStatus(w);
      return {
        id: `workspace-${w.id}`,
        label: w.id,
        group: "Workspaces" as const,
        subtitle: w.task,
        icon: <TerminalWindow size={16} />,
        status,
        keywords: [w.task, w.agent, w.repo, STATUS_LABEL[status], status],
        onAction: () => navigate({ kind: "workspace", id: w.id }),
      };
    }),
    {
      id: "action-new",
      label: "New workspace",
      group: "Actions",
      icon: <PlusCircle size={16} />,
      keywords: ["create", "launch", "start", "task", "clone"],
      // Creation is the command center's first-run affordance.
      onAction: () => navigate({ kind: "dashboard" }),
    },
    {
      id: "action-refresh",
      label: "Refresh workspaces",
      group: "Actions",
      icon: <ArrowsClockwise size={16} />,
      keywords: ["reload", "sync", "update"],
      onAction: () => refresh(),
    },
  ];

  const filtered = items.filter((i) => match(i.label) || i.keywords?.some((k) => match(k)));
  // Option ids are minted once, so the id attribute and the
  // `aria-activedescendant` reference can never drift apart.
  const optionIds = filtered.map((_, index) => `${uid}-option-${index}`);
  const sections = GROUP_ORDER.map((group) => ({
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

  const scope = route.kind === "workspace" ? route.id : ROUTE_LABEL[route.kind];

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search views, workspaces and actions. Move through the results with the arrow keys and press Enter to run
            the highlighted one.
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
              aria-label="Search views, workspaces and actions"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={activeOptionId}
              placeholder="Search workspaces or run a command…"
              className="min-w-0 flex-1 bg-transparent py-3 text-sm text-text-primary outline-none placeholder:text-text-faint"
            />
            <Kbd>⌘K</Kbd>
            <Dialog.Close asChild>
              <Button variant="quiet" iconOnly size="sm" aria-label="Close command palette">
                <X size={15} />
              </Button>
            </Dialog.Close>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-1.5">
            {/* `option` has no native element outside <select>, so the listbox and
                its options are ARIA roles on plain elements.
                a11y-ok: they are deliberately NOT focusable — in the ARIA combobox
                pattern focus stays on the input above and movement is announced via
                aria-activedescendant. Giving the options tabIndex would add a stop
                for every result and break that pattern. */}
            <div role="listbox" id={listId} aria-label="Search results">
              {sections.map((section) => (
                <div key={section.group} role="group" aria-labelledby={`${uid}-group-${section.group}`} className="py-1">
                  <div id={`${uid}-group-${section.group}`} className="eyebrow px-3 py-1 text-text-faint">
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
                        {entry.subtitle ? (
                          <span className="block truncate text-xs text-text-muted">{entry.subtitle}</span>
                        ) : null}
                      </span>
                      {entry.status ? <StatusChip status={entry.status} /> : null}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {filtered.length === 0 ? <p className="px-3 py-8 text-center text-sm text-text-muted">no matches</p> : null}
          </div>

          <div className="flex items-center gap-2 border-t border-line-subtle px-3 py-2 text-xs text-text-muted">
            <span className="eyebrow">scope</span>
            <span className="mono text-2xs text-text-secondary">{scope}</span>
            <span className="ml-auto flex items-center gap-3">
              <span className="flex items-center gap-1">
                <ArrowUp size={12} aria-hidden="true" />
                <ArrowDown size={12} aria-hidden="true" /> move
              </span>
              <span className="flex items-center gap-1">
                <ArrowElbowDownLeft size={12} aria-hidden="true" /> run
              </span>
              <span className="flex items-center gap-1">
                <Kbd>esc</Kbd> close
              </span>
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
