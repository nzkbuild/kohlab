"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Search,
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  X,
  Play,
  CircleStop,
  RefreshCw,
  PlusCircle,
  FileDiff,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/store";
import { api } from "@/api";

type PaletteItem = {
  id: string;
  label: string;
  group: string;
  subtitle?: string;
  icon?: React.ReactNode;
  keywords?: string[];
  onAction?: () => void | Promise<unknown>;
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const { workspaces, select, refresh } = useApp();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const run = (fn: () => void | Promise<unknown>) => () => {
    void (async () => {
      try {
        await fn();
        await refresh();
      } catch (e) {
        console.error(e);
      }
    })();
    setOpen(false);
  };

  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q) || s.toLowerCase().includes(q.replace(/\s+/g, "-"));

  const items: PaletteItem[] = [
    {
      id: "new",
      label: "New workspace",
      group: "Actions",
      icon: <PlusCircle className="size-4" />,
      keywords: ["create", "start", "workspace", "task"],
      onAction: run(() => select(null)),
    },
    {
      id: "refresh",
      label: "Refresh workspaces",
      group: "Actions",
      icon: <RefreshCw className="size-4" />,
      keywords: ["reload", "sync", "update"],
      onAction: run(() => refresh()),
    },
    ...workspaces.flatMap((w): PaletteItem[] => {
      const base: PaletteItem = {
        id: w.id,
        label: w.id,
        group: w.running ? "Running" : w.stopped ? "Done" : "Stopped",
        subtitle: w.task,
        icon: <FileDiff className="size-4" />,
        keywords: [w.task, w.agent],
        onAction: run(async () => select(w.id)),
      };
      const control: PaletteItem[] = [];
      if (w.running) {
        control.push({
          id: `${w.id}-stop`,
          label: `Stop ${w.id}`,
          group: "Workspace actions",
          subtitle: w.task,
          icon: <CircleStop className="size-4" />,
          keywords: [w.id, "stop", "kill"],
          onAction: run(async () => api.action(w.id, "stop")),
        });
      } else {
        control.push({
          id: `${w.id}-start`,
          label: `Start ${w.id}`,
          group: "Workspace actions",
          subtitle: w.task,
          icon: <Play className="size-4" />,
          keywords: [w.id, "start", "run", "launch"],
          onAction: run(async () => api.action(w.id, "start")),
        });
      }
      return [base, ...control];
    }),
  ];

  const filtered = items.filter((i) => match(i.label) || i.keywords?.some((k) => match(k)));
  const groups = new Map<string, PaletteItem[]>();
  for (const i of filtered) {
    const g = groups.get(i.group) ?? [];
    g.push(i);
    groups.set(i.group, g);
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
        <Dialog.Content
          aria-label="Command palette"
          className="fixed z-[101] inset-x-2 top-[15vh] mx-auto w-[min(640px,100%-16px)] rounded-xl border border-[#232d42] bg-[#0f141d] shadow-2xl outline-none"
        >
          <div className="flex items-center gap-2 border-b border-[#232d42] px-3 py-2.5">
            <Search className="size-4 text-[#7a869c]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  filtered[activeIndex]?.onAction?.();
                }
              }}
              placeholder="Search workspaces or run a command…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-[#7a869c]"
            />
            <kbd className="rounded bg-[#182032] px-1.5 py-0.5 text-[10px] text-[#7a869c]">⌘K</kbd>
            <Dialog.Close asChild>
              <button className="rounded p-1 text-[#7a869c] hover:bg-[#182032] hover:text-[#d7e0ee]">
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-1.5">
            {filtered.length === 0 && (
              <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-[#7a869c]">
                <Loader2 className="size-3 animate-spin" /> no matches
              </div>
            )}
            {[...groups.entries()].map(([group, items]) => (
              <div key={group} className="py-1">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[#7a869c]">{group}</div>
                {items.map((item) => {
                  const globalIdx = filtered.indexOf(item);
                  return (
                    <button
                      key={item.id}
                      onMouseEnter={() => setActiveIndex(globalIdx)}
                      onClick={() => item.onAction?.()}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                        globalIdx === activeIndex
                          ? "bg-[#182032] text-[#d7e0ee]"
                          : "text-[#7a869c] hover:bg-[#131926] hover:text-[#d7e0ee]",
                      )}
                    >
                      <span className="shrink-0">{item.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{item.label}</span>
                        {item.subtitle && (
                          <span className="block truncate text-xs text-[#7a869c]">{item.subtitle}</span>
                        )}
                      </span>
                      {item.group === "Running" && <span className="size-1.5 shrink-0 rounded-full bg-[#34d399]" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-4 border-t border-[#232d42] px-3 py-2 text-xs text-[#7a869c]">
            <span className="flex items-center gap-1">
              <CornerDownLeft className="size-3" /> select
            </span>
            <span className="flex items-center gap-1">
              <ArrowUp className="size-3" />
              <ArrowDown className="size-3" /> navigate
            </span>
            <span className="ml-auto">esc to close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default CommandPalette;