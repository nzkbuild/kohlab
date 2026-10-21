import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useApp } from "../store";
import { announce } from "../lib/announce";
import { agentName, isAiAgent } from "../lib/agentName";
import { Button, Dialog } from "./ui";

/** The most notes the AI keeps in mind for one project. The server holds the same limit. */
export const NOTES_MAX = 4000;

/**
 * Notes for the AI: standing facts about one project (the business name, colours,
 * tone) that the AI keeps in mind. Opened from the project menu and the palette;
 * the project id is held in the store, so one dialog serves every project.
 */
export default function NotesDialog() {
  const id = useApp((s) => s.notesFor);
  const setNotesFor = useApp((s) => s.setNotesFor);
  const workspace = useApp((s) => (s.notesFor ? (s.workspaces.find((w) => w.id === s.notesFor) ?? null) : null));
  const refresh = useApp((s) => s.refresh);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  // Each opening starts from what is saved, not from the last edit.
  // Only a new opening resets the text; a save elsewhere must not overwrite what is typed.
  useEffect(() => {
    if (id) setValue(workspace?.notes ?? "");
  }, [id]);

  const ai = workspace && isAiAgent(workspace.agent) ? agentName(workspace.agent) : "the AI";

  const save = async () => {
    if (!id || busy) return;
    setBusy(true);
    try {
      await api.setNotes(id, value.trim());
      await refresh();
      announce(`Notes for ${ai} saved`);
      setNotesFor(null);
    } catch (e) {
      toast.error(`Couldn't save the notes. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={id !== null && workspace !== null} onOpenChange={(next) => !next && setNotesFor(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">Notes for {ai}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-5 text-text-muted">
            Things it should always remember for this project, like your business name, colours or tone.
          </Dialog.Description>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <textarea
              aria-label={`Notes for ${ai}`}
              className="field-input min-h-32 w-full resize-y"
              rows={6}
              maxLength={NOTES_MAX}
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="flex items-center gap-3">
              <span className="tnum mr-auto text-xs text-text-muted" aria-live="polite">
                {value.length} / {NOTES_MAX}
              </span>
              <Dialog.Close asChild>
                <Button variant="secondary" size="sm">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" size="sm" disabled={busy} aria-busy={busy}>
                Save
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
