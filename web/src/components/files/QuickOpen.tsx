import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { FileText, MagnifyingGlass } from "@phosphor-icons/react";
import { Dialog } from "../ui";

const MAX_SHOWN = 200;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: string[];
  onPick: (path: string) => void;
}

/** Ctrl/⌘ P in the Files view: type part of a path, Enter opens the highlighted file. */
export default function QuickOpen({ open, onOpenChange, paths, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listId = useId();

  // Each time the dialog opens, start from an empty query.
  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const found = q ? paths.filter((p) => p.toLowerCase().includes(q)) : paths;
    return found.slice(0, MAX_SHOWN);
  }, [paths, query]);

  const current = Math.min(index, Math.max(matches.length - 1, 0));

  const pick = (path: string) => {
    onOpenChange(false);
    onPick(path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(current + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(current - 1, 0));
    } else if (e.key === "Enter" && matches[current]) {
      e.preventDefault();
      pick(matches[current]);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="sr-only">Open a file</Dialog.Title>
          <Dialog.Description className="sr-only">Type part of a file name, then press Enter to open it.</Dialog.Description>
          <div className="flex items-center gap-2 border-b border-line-subtle px-3">
            <MagnifyingGlass size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={matches[current] ? `${listId}-${current}` : undefined}
              aria-label="Find a file"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Find a file"
              className="min-w-0 flex-1 bg-transparent py-3 text-sm text-text-primary outline-none! placeholder:text-text-faint"
            />
          </div>
          <ul id={listId} role="listbox" aria-label="Files" className="max-h-[60vh] overflow-y-auto p-1.5">
            {matches.map((path, i) => (
              <li
                key={path}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(path)}
                className="palette-item cursor-pointer"
              >
                <FileText size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
                <span className="mono min-w-0 flex-1 truncate text-sm">{path}</span>
              </li>
            ))}
          </ul>
          {matches.length === 0 ? <p className="px-3 py-8 text-center text-sm text-text-muted">No matching files</p> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
