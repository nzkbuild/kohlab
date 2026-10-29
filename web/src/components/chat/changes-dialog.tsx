/** The dialog that lists what a turn changed. */
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { TurnFile } from "../../types";
import { parsePatch, type PatchLine } from "../../lib/diff";
import { cn } from "../../lib/utils";
import { Button, Dialog } from "../ui";
import { friendly } from "./text";

const CHANGE_WORD: Record<TurnFile["status"], string> = { added: "New", deleted: "Removed", modified: "Changed" };

/** Each kind of patch line: its colour, and the mark it is shown with (the diff's + and -). */
const PATCH_LINE: Record<PatchLine["kind"], { cls: string; mark: string }> = {
  add: { cls: "text-status-running", mark: "+ " },
  del: { cls: "text-status-danger", mark: "- " },
  ctx: { cls: "text-text-secondary", mark: "  " },
  gap: { cls: "text-text-muted", mark: "" },
};

/** What one message changed: each file under its heading, then its lines. Read from the server when it opens. */
export function ChangesDialog({ workspaceId, n, onOpenChange }: { workspaceId: string; n: number; onOpenChange: (open: boolean) => void }) {
  const [turn, setTurn] = useState<{ files: TurnFile[]; diff: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.chatTurn(workspaceId, n).then(
      (t) => {
        if (alive) setTurn(t);
      },
      (e: unknown) => {
        if (alive) setError(friendly(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [workspaceId, n]);
  const count = turn?.files.length ?? 0;
  const files = turn ? parsePatch(turn.diff) : [];
  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="dialog-content flex max-h-[85vh] w-[90vw] max-w-[720px] flex-col gap-3 p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">What this changed</Dialog.Title>
          {error ? (
            <p role="alert" className="text-small text-status-danger">{`Couldn't read the changes. ${error}`}</p>
          ) : turn === null ? (
            <p className="text-small text-text-muted">Reading the changes…</p>
          ) : count === 0 ? (
            <p className="text-small text-text-muted">No project files changed after this message.</p>
          ) : (
            <>
              <p className="text-small text-text-muted">{`${count} ${count === 1 ? "file" : "files"} changed`}</p>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto">
                {files.map((f) => (
                  <section key={f.path} className="flex min-w-0 flex-col gap-2">
                    <h3 className="mono text-xs break-all text-text-secondary">
                      <span className="text-text-muted">{CHANGE_WORD[f.status]}</span> {f.path}
                    </h3>
                    {f.binary ? (
                      <p className="text-xs text-text-muted">Picture or other file changed</p>
                    ) : (
                      <pre className="mono overflow-x-auto rounded-lg bg-surface-base p-3 text-xs leading-5 whitespace-pre">
                        {f.lines.map((line, i) => (
                          <span key={i} className={cn("block", PATCH_LINE[line.kind].cls)}>
                            {`${PATCH_LINE[line.kind].mark}${line.text}` || " "}
                          </span>
                        ))}
                      </pre>
                    )}
                  </section>
                ))}
              </div>
            </>
          )}
          <div className="flex justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary">Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
