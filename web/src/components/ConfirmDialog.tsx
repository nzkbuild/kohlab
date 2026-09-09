import * as Dialog from "@radix-ui/react-dialog";
import { Warning } from "@phosphor-icons/react";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
}

/** Destructive-action confirm (Base Alert Dialog grammar, Radix-based). */
export default function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "delete", busy, onConfirm }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[#333338] bg-[#151517] p-4 shadow-2xl">
          <div className="flex items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-red-400/10 text-red-400">
              <Warning size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold text-[#e4e4e7]">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-5 text-[#a1a1aa]">{description}</Dialog.Description>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="rounded-lg border border-[#27272a] px-3 py-1.5 text-xs text-zinc-300 transition hover:border-emerald-400">
                cancel
              </button>
            </Dialog.Close>
            <button
              onClick={onConfirm}
              disabled={busy}
              className="rounded-lg bg-red-400 px-3 py-1.5 text-xs font-semibold text-[#450a0a] transition hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "deleting..." : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}