import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  Clock,
  DownloadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { api } from "../api";
import { announce } from "../lib/announce";
import { relativeTime } from "../lib/format";
import type { ReleaseStatus } from "../types";
import ConfirmDialog from "./ConfirmDialog";
import { Button, SkeletonRows } from "./ui";

/** What GitHub's checks say about this version, in the owner's words. Same wording as `kohlab update`. */
const CHECK_WORDS = {
  passed: { text: "GitHub's checks passed", Icon: CheckCircle },
  pending: { text: "GitHub is still checking this version", Icon: Clock },
  failed: { text: "GitHub's checks failed for this version", Icon: WarningCircle },
} as const;

/**
 * Settings → Updates.
 *
 * A release is published by pushing to the repo this server runs from; this
 * panel is where that push becomes visible and takeable. The changelog shown is
 * whatever sits above the running version in CHANGELOG.md upstream, so it is the
 * release notes for exactly the gap being closed.
 *
 * While an update runs the server restarts underneath the page, so the panel
 * polls rather than streams, and the outcome is read back from the run's log,
 * nothing in memory on either side survives the restart.
 */
export default function UpdatePanel() {
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askFirst, setAskFirst] = useState(false);
  const wasRunning = useRef(false);

  const load = useCallback(async (force = false) => {
    try {
      const next = await api.release(force);
      setStatus(next);
      setError(next.error);
      // announce the transition, not every poll
      if (wasRunning.current && !next.running && next.exit !== null) {
        announce(next.exit === 0 ? `Kohlab updated to version ${next.latest}` : "The last update did not work");
      }
      wasRunning.current = next.running;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while something is actually in flight and the page is visible.
  useEffect(() => {
    if (!status?.running) return;
    const loadWhenVisible = () => {
      if (!document.hidden) void load(true);
    };
    const timer = window.setInterval(loadWhenVisible, 3000);
    document.addEventListener("visibilitychange", loadWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", loadWhenVisible);
    };
  }, [status?.running, load]);

  const apply = async () => {
    setBusy(true);
    try {
      await api.applyUpdate();
      announce("Update started. Your projects keep running; this page reconnects on its own.");
      await load(true);
    } catch (e) {
      setError((e as Error).message);
      announce(`Could not start the update: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="p-4">
        <SkeletonRows rows={3} />
      </div>
    );
  }

  const checkState = status?.checks?.state;
  // Pending or failed checks ask first; passed and unknown go straight through.
  const gated = checkState === "pending" || checkState === "failed";
  const checkWords = checkState && checkState !== "unknown" ? CHECK_WORDS[checkState] : null;

  const failed =
    status?.unfinished === true || (status?.exit !== null && status?.exit !== undefined && status.exit !== 0);
  const lastRun = status?.unfinished
    ? { danger: true, text: "The last update did not finish. The details are below." }
    : status?.finishedAt
      ? failed
        ? { danger: true, text: `The last update ${relativeTime(status.finishedAt)} did not work.` }
        : { danger: false, text: `Last updated ${relativeTime(status.finishedAt)}.` }
      : null;

  return (
    <div className="flex flex-col gap-4 p-4 text-left">
      <div className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
        <span>Kohlab version {status?.current ?? "?"}</span>
        {status?.running ? (
          <span className="chip chip-review">
            <span className="chip-dot" aria-hidden="true" />
            Updating to {status.latest}
          </span>
        ) : status?.available ? (
          <span className="chip chip-review">
            <span className="chip-dot" aria-hidden="true" />
            Update ready
          </span>
        ) : (
          <span className="chip chip-running">
            <span className="chip-dot" aria-hidden="true" />
            Up to date
          </span>
        )}
        {status?.checkedAt ? <span className="text-sm text-text-muted">Checked {relativeTime(status.checkedAt)}</span> : null}
      </div>

      {status?.available ? <p className="text-sm text-text-primary">A new version of Kohlab is ready.</p> : null}

      {status?.available && checkWords ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
          <checkWords.Icon size={14} aria-hidden="true" />
          {checkWords.text}
          {checkState === "failed" && status.checks?.url ? (
            <a className="underline underline-offset-2 hover:text-text-primary" href={status.checks.url} target="_blank" rel="noopener noreferrer">
              See why
            </a>
          ) : null}
        </p>
      ) : null}

      {error ? (
        <p className="flex items-start gap-2 text-sm text-status-danger">
          <WarningCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      {status?.available && status.notes ? (
        <div>
          <p className="mb-1.5 text-sm font-semibold text-text-primary">What's new in {status.latest}</p>
          <div className="max-h-64 overflow-auto rounded-card bg-surface-sunken p-3">
            <pre className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">{status.notes}</pre>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {status?.available || failed ? (
          <Button variant="primary" size="sm" disabled={busy || status?.running} onClick={() => (gated ? setAskFirst(true) : void apply())}>
            {status?.running ? (
              "Updating…"
            ) : (
              <>
                <DownloadSimple size={14} aria-hidden="true" />
                {failed ? "Try again" : "Update now"}
              </>
            )}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void load(true)}>
            <ArrowsClockwise size={14} aria-hidden="true" />
            Check again
          </Button>
        )}
        {status?.available ? (
          <Button variant="quiet" size="sm" disabled={busy || status?.running} onClick={() => void load(true)}>
            Check again
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={askFirst}
        onOpenChange={setAskFirst}
        title="Update Kohlab?"
        description="GitHub hasn't passed this version yet. Update anyway?"
        confirmLabel="Update anyway"
        tone="commit"
        onConfirm={() => {
          setAskFirst(false);
          void apply();
        }}
      />

      <p className="text-sm leading-relaxed text-text-muted">
        Your projects keep running during the update. Kohlab restarts for a moment, and goes back to the old version by itself if the new one does not start.
      </p>

      {lastRun ? (
        <p
          className={
            lastRun.danger
              ? "flex items-center gap-2 text-sm text-status-danger"
              : "flex items-center gap-2 text-sm text-text-muted"
          }
        >
          {lastRun.danger ? <WarningCircle size={14} aria-hidden="true" /> : <CheckCircle size={14} aria-hidden="true" />}
          {lastRun.text}
        </p>
      ) : null}

      {status?.log && (failed || status?.running) ? (
        <details>
          <summary className="min-h-11 cursor-pointer select-none py-2 text-sm text-text-muted hover:text-text-primary">Show details</summary>
          <div className="max-h-56 overflow-auto rounded-card bg-surface-sunken p-3">
            <pre className="whitespace-pre-wrap text-sm leading-relaxed text-text-muted">{status.log}</pre>
          </div>
        </details>
      ) : null}
    </div>
  );
}
