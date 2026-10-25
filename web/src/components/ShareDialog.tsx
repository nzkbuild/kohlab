import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { copyText } from "../lib/clipboard";
import type { LinkInfo } from "../types";
import { Button, Dialog } from "./ui";

type Expiry = "1d" | "7d" | "never";

const CHOICES: { value: Expiry; label: string }[] = [
  { value: "1d", label: "Link works for 1 day" },
  { value: "7d", label: "Link works for 7 days" },
  { value: "never", label: "Until I turn it off" },
];

/** "28 Oct, 3:15 pm" for a time in ms. */
function until(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** The link as a full address, so it can be copied and pasted anywhere. */
const absolute = (url: string) => new URL(url, location.origin).href;

interface Props {
  /** The project the link is for. Null while no project is open. */
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project's preview address after its link is turned off: the pane moves to it. */
  onPreviewUrl: (url: string) => void;
}

/**
 * Share a link to the project's page. One link at a time: it works for a day, a
 * week or until it is turned off. Making a new one stops the old one working.
 */
export default function ShareDialog({ workspaceId, open, onOpenChange, onPreviewUrl }: Props) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [choice, setChoice] = useState<Expiry>("7d");
  const [confirmNew, setConfirmNew] = useState(false);
  const [busy, setBusy] = useState(false);

  // Each opening reads the link as it is now.
  useEffect(() => {
    if (!open || !workspaceId) return;
    setInfo(null);
    setConfirmNew(false);
    api
      .link(workspaceId)
      .then(setInfo)
      .catch((e: Error) => {
        toast.error(`Couldn't read the link. ${e.message}`);
        onOpenChange(false);
      });
    // Only a new opening reads the link: a state change in the parent must not reset what is typed here.
  }, [open, workspaceId]);

  const copy = async (url: string) => {
    try {
      await copyText(absolute(url));
      toast.success("Link copied. Anyone who can reach this Kohlab can open it.");
    } catch (e) {
      toast.error(`Couldn't copy the link. ${(e as Error).message}`);
    }
  };

  const copyAndClose = (url: string | null) => {
    if (!url) return;
    void copy(url);
    onOpenChange(false);
  };

  /** Makes the link (the same one, unless `fresh`), copies it and closes. */
  const make = async (fresh: boolean) => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const next = await api.setLink(workspaceId, choice, fresh);
      setInfo(next);
      if (next.url) await copy(next.url);
      onOpenChange(false);
    } catch (e) {
      toast.error(`Couldn't make the link. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const { previewUrl } = await api.linkOff(workspaceId);
      onPreviewUrl(previewUrl);
      toast.success("Link turned off. The old link no longer works.");
      onOpenChange(false);
    } catch (e) {
      toast.error(`Couldn't turn the link off. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const expiry = info?.expires ?? null;
  const body = (() => {
    if (!info) return <p className="mt-4 text-sm text-text-muted">Getting the link…</p>;
    if (info.kind === "unsupported") return <p className="mt-4 text-sm text-text-muted">Links for this kind of app aren't ready yet.</p>;

    const radios = (
      <fieldset className="mt-4 flex flex-col gap-1">
        <legend className="mb-1 text-sm text-text-muted">How long it works</legend>
        {CHOICES.map((c) => (
          <label key={c.value} className="flex min-h-11 cursor-pointer items-center gap-2 text-base text-text-primary">
            <input
              type="radio"
              name="share-expiry"
              value={c.value}
              checked={choice === c.value}
              onChange={() => setChoice(c.value)}
              className="size-4 accent-[var(--text-primary)]"
            />
            {c.label}
          </label>
        ))}
      </fieldset>
    );

    if (!info.url) {
      return (
        <>
          {radios}
          <div className="mt-4 flex justify-end">
            <Button variant="primary" size="sm" disabled={busy} aria-busy={busy} onClick={() => void make(false)}>
              Copy link
            </Button>
          </div>
        </>
      );
    }

    const status = expiry === null ? "Works until you turn it off" : `Works until ${until(expiry)}`;
    if (confirmNew) {
      return (
        <>
          <p className="mt-4 text-sm text-text-muted">The old link will stop working for anyone you sent it to.</p>
          {radios}
          <div className="mt-4 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button variant="secondary" size="sm" className="max-md:w-full" disabled={busy} onClick={() => setConfirmNew(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" className="max-md:w-full" disabled={busy} aria-busy={busy} onClick={() => void make(true)}>
              Make a new link
            </Button>
          </div>
        </>
      );
    }
    return (
      <>
        <p className="mt-4 text-sm text-text-secondary">{status}</p>
        <div className="mt-4 flex flex-col-reverse gap-2 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="quiet" size="sm" className="text-text-secondary" disabled={busy} onClick={() => setConfirmNew(true)}>
              Make a new link
            </Button>
            <Button variant="quiet" size="sm" className="text-status-danger" disabled={busy} onClick={() => void turnOff()}>
              Turn off link
            </Button>
          </div>
          <Button variant="primary" size="sm" className="max-md:w-full" disabled={busy} onClick={() => copyAndClose(info.url)}>
            Copy link
          </Button>
        </div>
      </>
    );
  })();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-4">
          <Dialog.Title className="text-base font-semibold text-text-primary">Share a link</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm leading-5 text-text-muted">
            Anyone with the link can see this project's page. Turn the link off to stop them.
          </Dialog.Description>
          {body}
          {confirmNew ? null : (
            <div className="mt-2 flex justify-end">
              <Dialog.Close asChild>
                <Button variant="quiet" size="sm">
                  Done
                </Button>
              </Dialog.Close>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
