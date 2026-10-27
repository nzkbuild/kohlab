import { useEffect, useState } from "react";
import { api, type ChatUsage, type ChatUsageWindow } from "../api";
import { isTouchOnly } from "../lib/platform";
import { resetsText, usageText } from "../lib/aiHub";
import { useApp, useCan } from "../store";
import { Button, Dialog, SkeletonRows } from "./ui";

type Load = { state: "loading" } | { state: "ready"; plan: NonNullable<ChatUsage["plan"]> } | { state: "none" } | { state: "error" };

export { resetsText };

/** The Usage dialog: the owner's plan limits, and this chat's context when a Claude chat is open. Ctrl/Cmd+U opens it. */
export default function UsageDialog() {
  const open = useApp((s) => s.usageOpen);
  const setOpen = useApp((s) => s.setUsageOpen);
  const chat = useApp((s) => s.chatContext);
  const { own } = useCan();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (isTouchOnly()) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.defaultPrevented) return;
      if (e.key.toLowerCase() !== "u") return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  // Read each time it opens (a fresh reading), and again on "Try again". Only the owner's account has plan usage.
  useEffect(() => {
    if (!open || !own) return;
    let alive = true;
    setLoad({ state: "loading" });
    api.usage().then(
      (r) => {
        if (!alive) return;
        setLoad(r.plan ? { state: "ready", plan: r.plan } : { state: "none" });
      },
      () => {
        if (alive) setLoad({ state: "error" });
      },
    );
    return () => {
      alive = false;
    };
  }, [open, own, attempt]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-5">
          <Dialog.Title className="text-base font-semibold text-text-primary">Usage</Dialog.Title>
          <Dialog.Description className="sr-only">How much of your Claude plan and this chat you have used.</Dialog.Description>
          <div className="mt-4 flex flex-col gap-5">
            {own ? (
              <section aria-label="Your Claude plan" className="flex flex-col gap-4">
                <h3 className="text-sm font-medium text-text-secondary">Your Claude plan</h3>
                {load.state === "loading" ? <SkeletonRows rows={2} /> : null}
                {load.state === "none" ? <p className="text-sm text-text-secondary">Your plan doesn't report usage limits.</p> : null}
              {load.state === "error" ? (
                  <div className="flex flex-col items-start gap-3">
                    <p className="text-sm text-text-secondary">Couldn't read your plan usage right now.</p>
                    <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                      Try again
                    </Button>
                  </div>
                ) : null}
                {load.state === "ready" ? (
                  <>
                    <UsageRow label="Next few hours" window={load.plan.fiveHour} />
                    <UsageRow label="This week" window={load.plan.week} />
                  </>
                ) : null}
              </section>
            ) : (
              <p className="text-sm text-text-muted">Only the server owner can see plan usage.</p>
            )}
            {chat ? (
              <section aria-label="This chat" className="flex flex-col gap-1">
                <p className="text-sm text-text-primary">{`This chat: ${chat.percent}% full`}</p>
                <p className="text-sm leading-5 text-text-muted">Long chats get summarised automatically. Start a fresh project chat for a new task.</p>
              </section>
            ) : null}
          </div>
          <div className="mt-5 flex justify-end">
            <Dialog.Close asChild>
              <Button variant="quiet" size="sm">
                Done
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One plan window: its name, a slim meter and "34% used · resets at 7:20 pm" (or "Limit reached. Resets …"). The AI hub shows the same rows. */
export function UsageRow({ label, window: w, limited = false }: { label: string; window: Pick<ChatUsageWindow, "percent" | "resetsAt"> | null; limited?: boolean }) {
  const pct = w ? Math.max(0, Math.min(100, Math.round(w.percent))) : null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-text-secondary">{label}</span>
      {pct === null || !w ? (
        <p className="text-xs text-text-muted">Not shown for this plan</p>
      ) : (
        <>
          <div
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-valuetext={`${pct}% used`}
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised"
          >
            <div className="h-full rounded-full bg-text-secondary" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-text-muted tabular-nums">{usageText(w.percent, w.resetsAt, limited)}</p>
        </>
      )}
    </div>
  );
}
