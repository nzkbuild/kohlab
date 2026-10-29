/** The ready-to-check card, and the text and first-visit hint key it shares with the chat view. */
import type { ReactNode } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { Button } from "../ui";

/** The message "Check it works" sends: a fixed request, so the person needs no words of their own. */
export const CHECK_TEXT = "Please open the page in the shared browser and check that it works: click through it like a visitor would, look for errors, and fix anything broken. Then tell me what you checked in plain words.";

/** Set once the first "Ready to check" card has shown: after that, its hint line is not shown again. */
export const READY_HINT_KEY = "kohlab:ready-hint-seen";

interface ReadyCardProps {
  changed: number | null;
  previewPrimary: boolean;
  previewButton: ReactNode;
  keepButton: ReactNode;
  previewOpen: boolean;
  sending: boolean;
  undoing: boolean;
  readyHint: boolean;
  onCheck: () => void;
  onUndo: () => void;
}

/** The card after a turn that changed files: Preview and Keep, then Check it works and Undo. */
export function ReadyCard({ changed, previewPrimary, previewButton, keepButton, previewOpen, sending, undoing, readyHint, onCheck, onUndo }: ReadyCardProps) {
  return (
    <section aria-label="Ready to check" className="flex flex-col gap-3 rounded-card bg-surface-raised px-5 py-[18px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-base font-semibold text-text-primary">Ready to check</p>
        <p className="text-small text-text-muted">{changed === null ? "Changes to check" : `Changed ${changed} ${changed === 1 ? "file" : "files"}`}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {previewPrimary ? previewButton : null}
        {keepButton}
        {previewPrimary ? null : previewButton}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {previewOpen ? null : (
          <Button variant="quiet" className="text-text-secondary max-md:px-2.5" disabled={sending} onClick={onCheck}>
            Check it works
          </Button>
        )}
        <Button variant="quiet" className="text-text-secondary max-md:px-2.5" disabled={undoing} onClick={onUndo}>
          <ArrowCounterClockwise size={16} aria-hidden="true" />
          Undo these changes
        </Button>
      </div>
      {readyHint ? <p className="text-xs text-text-muted">Look at it in Preview, then keep it or undo it.</p> : null}
    </section>
  );
}
