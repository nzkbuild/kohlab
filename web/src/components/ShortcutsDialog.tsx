import { useEffect } from "react";
import { useApp } from "../store";
import { isApple, isTouchOnly, isTypingTarget } from "../lib/platform";
import { Button, Dialog, Kbd } from "./ui";

const MOD = isApple ? "⌘" : "Ctrl";

/** The shortcuts that exist. Keep this in step with the key handlers it describes. */
const GROUPS: { title: string; rows: { label: string; keys: string[] }[] }[] = [
  {
    title: "Anywhere",
    rows: [
      { label: "Open the command palette", keys: [`${MOD} K`, `${MOD} Shift P`] },
      { label: "Show plan usage", keys: [`${MOD} U`] },
      { label: "Show or hide the terminal", keys: ["Ctrl `"] },
      { label: "Show this list", keys: ["?"] },
      { label: "Close a menu or dialog", keys: ["Esc"] },
    ],
  },
  {
    title: "Chat",
    rows: [
      { label: "Send", keys: ["Enter"] },
      { label: "New line", keys: ["Shift Enter"] },
      { label: "Send now, while the AI works", keys: [`${MOD} Enter`] },
      { label: "Save for later", keys: [`${MOD} S`] },
    ],
  },
  {
    title: "Files and pages",
    rows: [
      { label: "Open a file by name", keys: [`${MOD} P`] },
      { label: "Save the file", keys: [`${MOD} S`] },
      { label: "Back and forward", keys: ["Alt ←", "Alt →"] },
    ],
  },
];

/** The "?" list of shortcuts. Opened by the key, the command palette or the account menu. */
export default function ShortcutsDialog() {
  const open = useApp((s) => s.shortcutsOpen);
  const setOpen = useApp((s) => s.setShortcutsOpen);

  // A bare "?" opens the list, except while someone is typing. Touch screens have no keys to list.
  useEffect(() => {
    if (isTouchOnly()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-5">
          <Dialog.Title className="text-base font-semibold text-text-primary">Keyboard shortcuts</Dialog.Title>
          <Dialog.Description className="sr-only">The keys that work in Kohlab.</Dialog.Description>
          <div className="mt-4 flex flex-col gap-4">
            {GROUPS.map((group) => (
              <section key={group.title} aria-label={group.title}>
                <h3 className="mb-1 text-xs font-medium text-text-muted">{group.title}</h3>
                <dl className="flex flex-col">
                  {group.rows.map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-6 py-1.5 text-sm">
                      <dt className="min-w-0 text-text-secondary">{row.label}</dt>
                      <dd className="flex shrink-0 gap-2 whitespace-nowrap">
                        {row.keys.map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          <div className="mt-5 flex justify-end">
            <Dialog.Close asChild>
              <Button variant="quiet" size="sm">
                Done
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
