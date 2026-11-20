import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useApp } from "../store";
import { announce } from "./announce";

/** How many days a deleted project waits, read when a confirm opens. Null when unknown: the copy then says less. */
export function useTrashDays(open: boolean): number | null {
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    api.trash().then((r) => setDays(r.days), () => undefined);
  }, [open]);
  return days;
}

/** The confirm's words for moving a project to Recently deleted. Days are unknown until the list has been read. */
export function trashConfirmText(name: string, days: number | null, terminalLive: boolean): string {
  const back = days ? `You can bring it back for ${days} ${days === 1 ? "day" : "days"}.` : "You can bring it back from Settings, under Recently deleted.";
  return `${name} moves to Recently deleted. ${back}${terminalLive ? " Its terminal will stop." : ""}`;
}

/** Brings a project back from Recently deleted, then says so with a link to open it. Throws when the server refuses. */
export async function restoreProject(id: string, name: string): Promise<void> {
  await api.restoreTrashed(id);
  await useApp.getState().refresh();
  announce(`${name} is back`);
  toast.success(`${name} is back`, { action: { label: "Open", onClick: () => useApp.getState().navigate({ kind: "workspace", id }) } });
}

/** Moves a project to Recently deleted, with Undo for ten seconds. Throws when the server refuses; the caller says so. */
export async function moveToTrash(id: string, name: string): Promise<void> {
  await api.deleteWorkspace(id);
  await useApp.getState().refresh();
  announce(`${name} moved to Recently deleted`);
  toast.success(`${name} moved to Recently deleted`, {
    duration: 10_000,
    action: {
      label: "Undo",
      onClick: () => void restoreProject(id, name).catch((e: Error) => toast.error(`Undo failed, ${e.message}`)),
    },
  });
}
