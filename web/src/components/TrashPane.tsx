import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { announce } from "../lib/announce";
import { restoreProject } from "../lib/trash";
import { useCan } from "../store";
import type { TrashItem, TrashList } from "../types";
import ConfirmDialog from "./ConfirmDialog";
import { Button, EmptyState, SkeletonRows } from "./ui";

const DAY = 86_400_000;

/** "Deleted 3 Nov" and, when it is purged on a day, "· 12 days left". */
function deletedWords(item: TrashItem, now = Date.now()): string {
  const date = new Date(item.trashedAt).toLocaleDateString([], { day: "numeric", month: "short" });
  if (item.purgeAt === null) return `Deleted ${date}`;
  const left = Math.max(1, Math.ceil((item.purgeAt - now) / DAY));
  return `Deleted ${date} · ${left} ${left === 1 ? "day" : "days"} left`;
}

/**
 * Settings → Recently deleted (every signed-in role). Lists only what the server returns for this viewer.
 * Restore brings a project back stopped, exactly as it was. Delete forever removes it for good.
 */
export default function TrashPane() {
  const can = useCan();
  const [data, setData] = useState<TrashList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [askForever, setAskForever] = useState<TrashItem | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.trash());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (item: TrashItem) => {
    setBusy(item.id);
    try {
      await restoreProject(item.id, item.name);
      await load();
    } catch (e) {
      toast.error(`Restore failed, ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const deleteForever = async () => {
    const item = askForever;
    if (!item) return;
    setBusy(item.id);
    try {
      await api.deleteForever(item.id);
      setAskForever(null);
      announce(`${item.name} deleted for good`);
      toast.success(`${item.name} deleted for good`);
      await load();
    } catch (e) {
      setAskForever(null);
      toast.error(`Delete failed, ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-text-muted">Couldn't load Recently deleted. {error}</p>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!data) return <SkeletonRows rows={3} className="p-4" />;

  if (data.items.length === 0) {
    return (
      <EmptyState
        title="Nothing here."
        description={data.days > 0 ? `Deleted projects wait here for ${data.days} days.` : "Deleted projects wait here until you delete them for good."}
      />
    );
  }

  return (
    <>
      <ul aria-label="Recently deleted projects" className="flex flex-col gap-1 p-2">
        {data.items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-row px-3 py-3 hover:bg-surface-hover">
            <div className="min-w-0 flex-1">
              <p className="truncate text-base text-text-primary">{item.name}</p>
              <p className="mt-0.5 text-xs text-text-muted">{deletedWords(item)}</p>
            </div>
            {can.mutate ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="secondary" size="sm" aria-label={`Restore ${item.name}`} disabled={busy === item.id} onClick={() => void restore(item)}>
                  Restore
                </Button>
                <Button variant="quiet" size="sm" aria-label={`Delete ${item.name} forever`} disabled={busy === item.id} onClick={() => setAskForever(item)}>
                  Delete forever
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={askForever !== null}
        onOpenChange={(next) => {
          if (!next) setAskForever(null);
        }}
        title="Delete this project for good?"
        description={`${askForever?.name ?? "This project"}'s files, chat and notes are removed from the server. This can't be undone.`}
        confirmLabel="Delete forever"
        busy={busy !== null && busy === askForever?.id}
        onConfirm={() => void deleteForever()}
      />
    </>
  );
}
