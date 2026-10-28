import type { ProviderAccount } from "../types";
import { EFFORT_CHOICES, EFFORT_LABEL, MODE_LABEL, modeChoices, modeDetail } from "../lib/aiHub";
import { Button, Dialog, MenuRadioGroup, MenuRadioItem } from "./ui";

/** The words under Full access when the server has none for this project. */
export const FULL_ACCESS_LINE = "Full access never asks. It can change and delete anything the AI can reach.";

/** What a refused Full access says. */
export const FULL_ACCESS_OWNER_ONLY = "Full access is only for the owner.";

/** The Mode menu's choices, shared by the composer, the Run panel and Settings. Picking Full access is the caller's to confirm. */
export function ModeChoices({ value, isClaude, onPick }: { value: string | null; isClaude: boolean; onPick: (mode: string) => void }) {
  return (
    <MenuRadioGroup value={value ?? ""} onValueChange={onPick}>
      {modeChoices(isClaude).map((m) => (
        <MenuRadioItem key={m} value={m}>
          <span className="block">{MODE_LABEL[m]}</span>
          <span className="block text-xs text-text-muted">{modeDetail(m, isClaude)}</span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/** The accounts of one AI as radio items: the one in use is ticked. Wait while it works. */
export function AccountChoices({ accounts, value, busy, onPick }: { accounts: ProviderAccount[]; value: string; busy: boolean; onPick: (id: string) => void }) {
  return (
    <>
      <MenuRadioGroup value={value} onValueChange={(v) => !busy && onPick(v)}>
        {accounts.map((a) => (
          <MenuRadioItem key={a.id} value={a.id} disabled={busy}>
            <span className="block">{a.id === "default" ? (a.email ?? "Main account") : a.label}</span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {busy ? <p className="px-2.5 pb-1.5 text-xs text-text-muted">Wait until the reply finishes</p> : null}
    </>
  );
}

/** The effort levels as radio items. */
export function EffortChoices({ value, levels = EFFORT_CHOICES, onPick }: { value: string | null; levels?: string[]; onPick: (effort: string) => void }) {
  return (
    <MenuRadioGroup value={value ?? ""} onValueChange={onPick}>
      {levels.map((l) => (
        <MenuRadioItem key={l} value={l}>
          {EFFORT_LABEL[l] ?? l}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/**
 * Full access asks once, in words. The button that allows it is not the primary one, and Cancel takes the focus.
 * `note` is what the server says about this project (who it runs as); without it the plain line says it.
 */
export function FullAccessDialog({ open, onOpenChange, note, onConfirm, busy = false }: { open: boolean; onOpenChange: (v: boolean) => void; note?: string | null; onConfirm: () => void; busy?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content role="alertdialog" className="dialog-content p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">Allow full access?</Dialog.Title>
          <Dialog.Description className="mt-1 text-small leading-5 text-text-muted">{note?.trim() || FULL_ACCESS_LINE}</Dialog.Description>
          <div className="mt-4 flex flex-col gap-2 md:flex-row-reverse md:justify-start">
            <Button variant="secondary" size="sm" className="max-md:w-full" disabled={busy} onClick={onConfirm}>
              Allow full access
            </Button>
            <Dialog.Close asChild>
              <Button variant="quiet" size="sm" className="max-md:w-full" autoFocus>
                Cancel
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
