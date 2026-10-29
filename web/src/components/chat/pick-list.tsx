/** A numbered pick list for asks. */
import { useEffect, type ReactNode } from "react";
import { cn } from "../../lib/utils";

/** A menu of options the arrow keys move through, and a press picks: the "/" commands and the "@" files. Same surface and items as the Radix menus. */
interface PickOption {
  key: string;
  title: ReactNode;
  detail?: string;
}
export function PickList({ id, label, options, active, onPick }: { id: string; label: string; options: PickOption[]; active: number; onPick: (i: number) => void }) {
  // Keep the arrow-key row in view. Mounts with the list, so the first row is in view too.
  useEffect(() => {
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [id, active]);
  return (
    <ul id={id} role="listbox" aria-label={label} className="menu mb-2 max-h-80 w-full overflow-x-hidden overflow-y-auto text-left">
      {options.map((o, i) => (
        <li
          key={o.key}
          id={`${id}-opt-${i}`}
          role="option"
          aria-selected={i === active}
          // a pointer press picks the option without taking focus from the composer
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(i);
          }}
          className={cn(
            "menu-item min-h-9 min-w-0 cursor-pointer items-center text-left pointer-coarse:min-h-11 max-md:my-0.5 max-md:py-2",
            i === active && "bg-surface-hover text-text-primary",
          )}
        >
          {/* One line on desktop: name, then detail. On phones the detail drops under the name. */}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-baseline md:gap-2">
            <span className="min-w-0 truncate text-text-primary md:max-w-[60%] md:shrink-0">{o.title}</span>
            {o.detail ? <span className="min-w-0 truncate text-text-muted md:flex-1">{o.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
