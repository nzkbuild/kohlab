/** Continue fresh: the handoff note dialog, and the handoff note as a card in the chat. */
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Button, Dialog } from "../ui";
import { friendly } from "./text";

/** Continue fresh, by hand: the AI writes a handoff note first and it is shown here, ready to read or change; "Use this note" starts the fresh session from it. */
export function FreshDialog({ workspaceId, who, onClose, onDone }: { workspaceId: string; who: string; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let alive = true;
    api.chatFresh(workspaceId, { draft: true }).then(
      (r) => {
        if (!alive) return;
        if (typeof r.note === "string" && r.note.trim() !== "") setNote(r.note);
        else setError("");
      },
      (e: unknown) => {
        if (alive) setError(friendly(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  const start = async (text: string | null) => {
    setStarting(true);
    try {
      await api.chatFresh(workspaceId, text === null ? undefined : { note: text });
      onDone();
    } catch (e) {
      setError(friendly(e));
      setStarting(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(v) => !v && !starting && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex max-h-[85vh] w-[90vw] max-w-[640px] flex-col gap-3 p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">Continue with a fresh memory</Dialog.Title>
          <p className="text-small text-text-muted">{`${who} writes a short note about where you are. The new memory starts from it. Your chat stays as it is.`}</p>
          {note === null && error === null ? <p role="status" className="text-small text-text-muted">Writing a handoff note…</p> : null}
          {note !== null ? (
            <textarea
              aria-label="Handoff note"
              className="field-input mono min-h-48 flex-1 resize-y text-xs leading-5"
              maxLength={8000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          ) : null}
          {error !== null && note === null ? (
            <p role="alert" className="text-small text-text-secondary">
              {error ? `${error} You can still continue; Kohlab will use a short summary of the chat.` : `${who} did not write a note. You can still continue; Kohlab will use a short summary of the chat.`}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={starting} onClick={onClose}>
              Cancel
            </Button>
            {note !== null ? (
              <Button variant="primary" disabled={starting || note.trim() === ""} onClick={() => void start(note.trim())}>
                {starting ? "Starting…" : "Use this note"}
              </Button>
            ) : error !== null ? (
              <Button variant="primary" disabled={starting} onClick={() => void start(null)}>
                {starting ? "Starting…" : "Continue fresh"}
              </Button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The handoff note as a card in the chat: a disclosure that shows the note's text. */
export function HandoffCard({ text }: { text: string }) {
  return (
    <details className="rounded-card bg-surface-raised px-4 py-2.5 text-sm">
      <summary className="flex min-h-8 cursor-pointer items-center text-text-secondary pointer-coarse:min-h-11">Handoff note</summary>
      <pre className="mono mt-2 max-h-80 overflow-auto text-xs leading-5 whitespace-pre-wrap break-words text-text-secondary">{text}</pre>
    </details>
  );
}
