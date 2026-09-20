import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { api } from "../api";
import { announce } from "../lib/announce";
import { relativeTime } from "../lib/format";
import type { ReleaseStatus } from "../types";
import { Button, SkeletonRows } from "./ui";

/**
 * Settings → Updates.
 *
 * A release is published by pushing to the repo this server runs from; this
 * panel is where that push becomes visible and takeable. The changelog shown is
 * whatever sits above the running version in CHANGELOG.md upstream, so it is the
 * release notes for exactly the gap being closed.
 *
 * While an update runs the server restarts underneath the page, so the panel
 * polls rather than streams, and the outcome is read back from the run's log —
 * nothing in memory on either side survives the restart.
 */
export default function UpdatePanel() {
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wasRunning = useRef(false);

  const load = useCallback(async (force = false) => {
    try {
      const next = await api.release(force);
      setStatus(next);
      setError(next.error);
      // announce the transition, not every poll
      if (wasRunning.current && !next.running && next.exit !== null) {
        announce(next.exit === 0 ? `kohlab updated to v${next.latest}` : "the last update failed");
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

  // Poll only while something is actually in flight.
  useEffect(() => {
    if (!status?.running) return;
    const timer = window.setInterval(() => void load(true), 3000);
    return () => window.clearInterval(timer);
  }, [status?.running, load]);

  const apply = async () => {
    setBusy(true);
    try {
      await api.applyUpdate();
      announce("update started — agents keep running; this page reconnects on its own");
      await load(true);
    } catch (e) {
      setError((e as Error).message);
      announce(`could not start the update: ${(e as Error).message}`);
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

  const failed =
    status?.unfinished === true || (status?.exit !== null && status?.exit !== undefined && status.exit !== 0);
  const lastRun = status?.unfinished
    ? { danger: true, text: "The last update did not finish — the log below is all it left" }
    : status?.finishedAt
      ? failed
        ? { danger: true, text: `Last update ${relativeTime(status.finishedAt)} failed (exit ${status.exit})` }
        : { danger: false, text: `Last update ${relativeTime(status.finishedAt)} succeeded` }
      : null;

  return (
    <div className="flex flex-col gap-4 p-4 text-left">
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-primary">
        <span className="mono">v{status?.current ?? "?"}</span>
        {status?.running ? (
          <span className="chip chip-review">
            <span className="chip-dot" aria-hidden="true" />
            updating to v{status.latest}
          </span>
        ) : status?.available ? (
          <span className="chip chip-review">
            <span className="chip-dot" aria-hidden="true" />
            v{status.latest} published
          </span>
        ) : (
          <span className="chip chip-running">
            <span className="chip-dot" aria-hidden="true" />
            up to date
          </span>
        )}
        {status?.upstream ? (
          <span className="text-2xs text-text-muted">
            {status.upstream}
            {status.head ? ` · at ${status.head}` : ""}
            {status.checkedAt ? ` · checked ${relativeTime(status.checkedAt)}` : ""}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="flex items-start gap-1.5 text-2xs text-status-danger">
          <WarningCircle size={13} className="mt-px shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      {status?.available && status.commits.length > 0 ? (
        <div>
          <p className="eyebrow mb-1.5">Coming in v{status.latest}</p>
          {status.notes ? (
            <div className="max-h-64 overflow-auto rounded-md border border-line-subtle bg-surface-sunken p-3">
              <pre className="whitespace-pre-wrap text-2xs leading-relaxed text-text-secondary">
                {status.notes}
              </pre>
            </div>
          ) : null}
          <ul className="mt-2 flex flex-col gap-0.5">
            {status.commits.slice(0, 12).map((c) => (
              <li key={c} className="mono text-2xs text-text-muted">
                {c}
              </li>
            ))}
          </ul>
          {status.commits.length > 12 ? (
            <p className="mt-1 text-2xs text-text-faint">+{status.commits.length - 12} more</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {status?.available || failed ? (
          <Button variant="primary" size="sm" disabled={busy || status?.running} onClick={() => void apply()}>
            {status?.running ? (
              <>
                <CircleNotch size={14} className="animate-spin" aria-hidden="true" />
                updating…
              </>
            ) : (
              <>
                <DownloadSimple size={14} aria-hidden="true" />
                {failed ? "retry update" : `update to v${status?.latest}`}
              </>
            )}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void load(true)}>
            <ArrowsClockwise size={14} aria-hidden="true" />
            check again
          </Button>
        )}
        {status?.available ? (
          <Button variant="quiet" size="sm" disabled={busy || status?.running} onClick={() => void load(true)}>
            re-check
          </Button>
        ) : null}
      </div>

      <p className="text-2xs leading-relaxed text-text-muted">
        Agents are not interrupted: this restarts the server only, and every running session
        survives. Your uncommitted changes are stashed first, and a release that fails to come up
        is rolled back automatically.
      </p>

      {lastRun ? (
        <p
          className={
            lastRun.danger
              ? "flex items-center gap-1.5 text-2xs text-status-danger"
              : "flex items-center gap-1.5 text-2xs text-text-muted"
          }
        >
          {lastRun.danger ? <WarningCircle size={13} aria-hidden="true" /> : <CheckCircle size={13} aria-hidden="true" />}
          {lastRun.text}
        </p>
      ) : null}

      {status?.log && (failed || status?.running) ? (
        <div>
          <p className="eyebrow mb-1.5">Update log</p>
          <div className="max-h-56 overflow-auto rounded-md border border-line-subtle bg-surface-sunken p-3">
            <pre className="whitespace-pre-wrap text-2xs leading-relaxed text-text-muted">{status.log}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
