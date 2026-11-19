import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadSimple, WarningCircle } from "@phosphor-icons/react";
import { api } from "../api";
import { announce } from "../lib/announce";
import { byteSize } from "../lib/format";
import type { BackupList } from "../types";
import ConfirmDialog from "./ConfirmDialog";
import { Button, SkeletonRows } from "./ui";

const DAY = 86_400_000;
/** Past this many days without a good backup, a gentle line says so. Home never shows it. */
const STALE_DAYS = 3;

/** "today at 11:00", "yesterday at 9:12", or "on 3 Nov at 9:12". */
function whenWords(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return `today at ${time}`;
  if (d.toDateString() === new Date(now - DAY).toDateString()) return `yesterday at ${time}`;
  return `on ${d.toLocaleDateString([], { day: "numeric", month: "short" })} at ${time}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Settings → Backups (owner only). Plain words: the last good backup, whether
 * daily backups run, the saved copies with Download and Delete, and a quiet
 * disclosure about keeping a copy off this computer.
 */
export default function BackupsPanel() {
  const [data, setData] = useState<BackupList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [askDelete, setAskDelete] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await api.backups();
      setData(next);
      setError(null);
      // announce the end of a run, not every poll
      if (wasRunning.current && !next.running) {
        announce(next.last?.ok === false ? "The backup did not work" : "Backup finished");
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

  // While a run is going, look again every few seconds. Text only, no spinner.
  const running = data?.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const backUp = async () => {
    setBusy(true);
    try {
      setData(await api.backupNow());
      wasRunning.current = true;
      setError(null);
      announce("Backing up now");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const download = async (name: string) => {
    setWorking(name);
    try {
      await api.downloadBackup(name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };

  const remove = async (name: string) => {
    setWorking(name);
    try {
      await api.deleteBackup(name);
      announce("Backup deleted");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
      setAskDelete(null);
    }
  };

  if (loading) {
    return (
      <div className="p-4">
        <SkeletonRows rows={3} />
      </div>
    );
  }

  const last = data?.last ?? null;
  const items = [...(data?.items ?? [])].sort((a, b) => b.at - a.at);
  // The last good backup: the last run if it worked, else the newest archive on disk.
  const good = last?.ok ? { at: last.at, bytes: last.bytes, verified: last.verified } : items[0] ? { at: items[0].at, bytes: items[0].bytes, verified: false } : null;
  const staleDays = good ? Math.floor((Date.now() - good.at) / DAY) : 0;
  const askName = items.find((i) => i.name === askDelete) ?? null;

  return (
    <div className="flex flex-col gap-4 p-4 text-left">
      {good ? (
        <p className="text-sm text-text-primary">
          {capital(whenWords(good.at))}
          <span className="text-text-muted"> · {byteSize(good.bytes)}{good.verified ? " · checked" : ""}</span>
        </p>
      ) : (
        <p className="text-sm text-text-primary">No backup yet.</p>
      )}
      {!good ? (
        <p className="text-sm leading-relaxed text-text-muted">Back up now to make a copy of your projects, chats and notes.</p>
      ) : null}

      {last && !last.ok ? (
        <p className="flex items-start gap-2 text-sm text-text-muted">
          <WarningCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          The last backup did not work. {last.error ?? "Try again."}
        </p>
      ) : null}

      {good && staleDays >= STALE_DAYS ? (
        <p className="text-sm text-text-muted">It has been {staleDays} days since the last backup.</p>
      ) : null}

      <p className="text-sm text-text-muted">
        {data?.daily ? `Daily backups: on, keeps the last ${data.keep}.` : "Daily backups: off."}
        {running ? " Backing up now…" : null}
      </p>

      {error ? (
        <p className="flex items-start gap-2 text-sm text-text-muted">
          <WarningCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy || running} onClick={() => void backUp()}>
          Back up now
        </Button>
      </div>

      {items.length ? (
        <ul className="flex flex-col gap-2" aria-label="Saved backups">
          {items.map((it) => (
            <li key={it.name} className="flex flex-wrap items-center gap-2 rounded-row bg-surface-raised px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary">{capital(whenWords(it.at))}</p>
                <p className="truncate font-mono text-xs text-text-muted">{it.name}</p>
              </div>
              <span className="text-xs text-text-muted">{byteSize(it.bytes)}</span>
              <Button
                variant="secondary"
                size="sm"
                disabled={working !== null}
                aria-label={`Download the backup from ${whenWords(it.at)}`}
                onClick={() => void download(it.name)}
              >
                <DownloadSimple size={14} aria-hidden="true" />
                Download
              </Button>
              <Button
                variant="quiet"
                size="sm"
                disabled={working !== null}
                aria-label={`Delete the backup from ${whenWords(it.at)}`}
                onClick={() => setAskDelete(it.name)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={askName !== null}
        onOpenChange={(v) => {
          if (!v) setAskDelete(null);
        }}
        title="Delete this backup?"
        description={askName ? `The backup from ${whenWords(askName.at)} is removed. Your projects are not touched.` : ""}
        confirmLabel="Delete"
        busy={working !== null}
        tone="danger"
        onConfirm={() => askName && void remove(askName.name)}
      />

      <details>
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm text-text-muted hover:text-text-primary">
          Keep a copy off this computer
        </summary>
        <div className="flex flex-col gap-2 pb-2 text-sm leading-relaxed text-text-muted">
          <p>Download a backup now and keep it somewhere else, such as a USB drive or another computer.</p>
          <p>The person who runs this server can also copy the backups folder to another computer each night. docs/backup.md has the steps.</p>
        </div>
      </details>
    </div>
  );
}
