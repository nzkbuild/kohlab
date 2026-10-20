import type { ReactNode } from "react";
import { Dialog } from "./ui";
import { Warning } from "@phosphor-icons/react";
import { Button } from "./ui";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  /** Optional detail under the description, such as a list of files. Kept out of the description paragraph. */
  details?: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  /** `danger` destroys something (delete, discard, revoke). `commit` is final but
   *  keeps work (commit, merge): it still asks, but must not look like delete. */
  tone?: "danger" | "commit";
  onConfirm: () => void;
}

/**
 * Irreversible-action confirm.
 *
 * Radix owns the semantics: `role="alertdialog"`, focus trap, focus restore,
 * Escape, and `aria-labelledby` / `aria-describedby` wired from Title and
 * Description: which is why those must be Dialog.Title / Dialog.Description
 * and not plain headings.
 *
 * The caller is responsible for naming the specific object in `description`
 * ("ws-3 / home/user/app.ts"), never "this item".
 */
export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  details,
  confirmLabel = "Delete",
  busy = false,
  tone = "danger",
  onConfirm,
}: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        {/* Radix defaults Content to role="dialog"; an alert dialog must interrupt.
            Spread order in DialogContentImpl puts ...contentProps after that
            default, so this override is what actually lands on the element. */}
        <Dialog.Content role="alertdialog" className="dialog-content p-4">
          <div className="flex items-start gap-3">
            {/* Only a danger confirm carries an icon; a commit reads as plain text. */}
            {tone === "danger" ? (
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-hover text-status-danger" aria-hidden="true">
                <Warning size={16} />
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold text-text-primary">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-5 text-text-muted">
                {description}
              </Dialog.Description>
              {details ? <div className="mt-2 max-h-48 overflow-y-auto text-xs text-text-secondary">{details}</div> : null}
            </div>
          </div>

          <div className="mt-4 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary" size="sm" className="max-md:w-full">
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              variant={tone === "danger" ? "danger" : "primary"}
              size="sm"
              className="max-md:w-full"
              disabled={busy}
              aria-busy={busy}
              onClick={onConfirm}
            >
              {busy ? "Working…" : confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
