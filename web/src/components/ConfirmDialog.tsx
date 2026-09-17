import * as Dialog from "@radix-ui/react-dialog";
import { Warning } from "@phosphor-icons/react";
import { Button } from "./ui";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
}

/**
 * Destructive-action confirm.
 *
 * Radix owns the semantics: `role="alertdialog"`, focus trap, focus restore,
 * Escape, and `aria-labelledby` / `aria-describedby` wired from Title and
 * Description — which is why those must be Dialog.Title / Dialog.Description
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
  confirmLabel = "delete",
  busy = false,
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
            <span
              className="grid size-8 shrink-0 place-items-center rounded-lg border border-line-strong text-status-danger"
              aria-hidden="true"
            >
              <Warning size={16} weight="bold" />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold text-text-primary">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-5 text-text-muted">
                {description}
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="secondary" size="sm">
                cancel
              </Button>
            </Dialog.Close>
            <Button variant="danger" size="sm" disabled={busy} aria-busy={busy} onClick={onConfirm}>
              {busy ? "working…" : confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
