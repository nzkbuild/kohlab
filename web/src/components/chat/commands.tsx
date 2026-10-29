/** Slash command choices in the composer. */
import { useEffect, useRef, useState } from "react";
import { MenuItem } from "../ui";

/** A slash command and a model, as the chat's snapshot lists them. */
export interface CommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}

/** Commands past this many get a search box at the top of the Commands menu. */
const COMMAND_SEARCH_AT = 12;

/** Marks the composer's textarea for the workspace page's focus (WorkspaceDetail finds it by this attribute, not by its label). */
export const COMPOSER_MARK = { "data-composer": "" };

/** The Commands menu's choices: each command's name and its one-line description. Past COMMAND_SEARCH_AT commands, a search box leads, as in the model menu. */
export function CommandChoices({ commands, onPick }: { commands: CommandInfo[]; onPick: (c: CommandInfo) => void }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const search = commands.length > COMMAND_SEARCH_AT;
  const q = query.trim().toLowerCase();
  const shown = search && q ? commands.filter((c) => `${c.name} ${c.description}`.toLowerCase().includes(q)) : commands;
  // The menu takes focus when it opens; the search box takes it a frame later.
  useEffect(() => {
    if (!search) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [search]);
  // The first item of this menu, for the keys that move into the list.
  const firstItem = (el: HTMLElement) => el.closest<HTMLElement>('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitem"]');
  return (
    <>
      {search ? (
        <input
          ref={searchRef}
          type="search"
          aria-label="Search commands"
          placeholder="Search commands"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // The menu's own keys (typeahead, arrows, Tab) would take these: the search box keeps them.
            e.stopPropagation();
            if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
              e.preventDefault();
              firstItem(e.currentTarget)?.focus();
            } else if (e.key === "Enter") {
              e.preventDefault();
              firstItem(e.currentTarget)?.click();
            }
          }}
          className="field-input mx-1 mb-1 block w-[calc(100%-0.5rem)] border-0 bg-surface-base"
        />
      ) : null}
      <div className="max-h-80 overflow-y-auto">
        {shown.map((c) => (
          <MenuItem key={c.name} onSelect={() => onPick(c)} className="min-w-0">
            <span className="block min-w-0 truncate">{`/${c.name}`}</span>
            {c.description ? <span className="block min-w-0 truncate text-xs text-text-muted">{c.description}</span> : null}
          </MenuItem>
        ))}
      </div>
      {search && shown.length === 0 ? <p className="px-2.5 py-1.5 text-small text-text-muted">No command matches "{query}".</p> : null}
    </>
  );
}
