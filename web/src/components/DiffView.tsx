import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import {
  ArrowsClockwise,
  CheckSquare,
  Files,
  GitCommit,
  WarningCircle,
} from "@phosphor-icons/react";
import { api } from "../api";
import { useApp } from "../store";
import { announce } from "../lib/announce";
import { diffStats } from "../lib/format";
import { languageForFile, splitUnifiedDiff } from "../lib/diff";
import { cn } from "../lib/utils";
import type { DiffFile } from "../types";
import { Button, EmptyState, Skeleton, SkeletonRows } from "./ui";

interface Props {
  workspaceId: string;
}

type Filter = "all" | "unreviewed" | "reviewed";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "all" },
  { value: "unreviewed", label: "unreviewed" },
  { value: "reviewed", label: "reviewed" },
];

/** Narrow column: the changed-file rows. */
const LIST_CLASS =
  "flex max-h-64 shrink-0 flex-col border-b border-line-subtle shell:max-h-none shell:w-72 shell:border-b-0 shell:border-r";

/** The diff/verdict pane. */
const PANE_CLASS = "flex min-h-72 min-w-0 flex-1 flex-col shell:min-h-0";

function Totals({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="tnum shrink-0 text-xs">
      <span className="text-status-running">+{added}</span>{" "}
      <span className="text-status-danger">−{removed}</span>
    </span>
  );
}

/**
 * Diff review — the headline surface: what changed, sign it off, commit once.
 *
 * Two payloads arrive in the same shape: real unified diffs, and prose stubs
 * (binary files, and untracked files over the preview ceiling). `diffStats`
 * is the discriminator — it returns null for anything that is not a parseable
 * diff, and those must be rendered as text: handing the stub to Monaco shows a
 * broken editor.
 */
export default function DiffView({ workspaceId }: Props) {
  const task = useApp((s) => s.workspaces.find((w) => w.id === workspaceId)?.task ?? "");
  const refresh = useApp((s) => s.refresh);

  const [files, setFiles] = useState<DiffFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // null = untouched, so the workspace-task default stays live until the user types.
  const [draft, setDraft] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const next = await api.diff(workspaceId);
      setFiles(next);
      setError(null);
      setSelected((current) =>
        current && next.some((f) => f.name === current) ? current : (next[0]?.name ?? null),
      );
      // Drop review marks for files that no longer differ.
      setReviewed((prev) => new Set([...prev].filter((name) => next.some((f) => f.name === name))));
    } catch (e) {
      // Keep the files already loaded: a failed refresh must not cost the
      // reviewer the diffs they can still read.
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Re-read the diff when the surface is pointed at a different workspace.
  useEffect(() => {
    void load();
  }, [workspaceId]);

  const toggleReviewed = (name: string) =>
    setReviewed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const unreviewed = files.filter((f) => !reviewed.has(f.name));
  const visible = files.filter((f) =>
    filter === "all" ? true : filter === "reviewed" ? reviewed.has(f.name) : !reviewed.has(f.name),
  );

  const totals = files.reduce(
    (acc, f) => {
      const stats = diffStats(f.diff);
      if (stats) {
        acc.added += stats.added;
        acc.removed += stats.removed;
      }
      return acc;
    },
    { added: 0, removed: 0 },
  );

  const current = files.find((f) => f.name === selected) ?? files[0] ?? null;
  const currentStats = current ? diffStats(current.diff) : null;
  const currentReviewed = current ? reviewed.has(current.name) : false;
  // The API returns a unified diff (a patch), not two documents. Splitting it is
  // what lets the editor show the actual change instead of patch syntax.
  const split = current ? splitUnifiedDiff(current.diff) : { original: "", modified: "" };

  const defaultMessage = task.trim() ? task.trim().replace(/\s+/g, " ").slice(0, 72) : `${workspaceId} changes`;
  const message = draft ?? defaultMessage;
  const canCommit = files.length > 0 && message.trim().length > 0 && !committing;
  const firstRun = !loading && files.length === 0 && !error;
  /**
   * A workspace with no changes must still be able to leave the review queue,
   * and accepting it is the only exit: `workspaceStatus` keeps any stopped
   * workspace without a commit in `needs-review` indefinitely. Gating this on
   * `canCommit` — which requires at least one changed file — left the queue
   * impossible to empty from the UI.
   */
  const canAccept = firstRun && !committing;

  const runCommit = async (text: string) => {
    setCommitting(true);
    setCommitError(null);
    try {
      // Never optimistic: the list stays exactly as it was until the server
      // confirms, so a rejected commit cannot look like a successful one.
      await api.commit(workspaceId, text);
      announce(`accepted ${workspaceId}`);
      setDraft(null);
      setReviewed(new Set());
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setCommitError((e as Error).message);
    } finally {
      setCommitting(false);
    }
  };

  const commit = () => {
    if (!canCommit) return;
    return runCommit(message.trim());
  };

  const accept = () => {
    if (!canAccept) return;
    return runCommit(defaultMessage);
  };

  return (
    <div className="cockpit">
      <header className="cockpit-head">
        <Files size={15} className="shrink-0 text-text-muted" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-text-primary">
          {loading && files.length === 0
            ? "loading diff…"
            : error && files.length === 0
              ? "diff unavailable"
              : firstRun
                ? "nothing to commit"
                : `${files.length} file${files.length === 1 ? "" : "s"} changed`}
        </h2>
        {files.length > 0 ? <Totals added={totals.added} removed={totals.removed} /> : null}
        <div className="flex-1" />
        {files.length > 0 ? (
          <span className="tnum hidden text-2xs text-text-muted shell:inline">
            {reviewed.size}/{files.length} reviewed
          </span>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          aria-label="Refresh diff"
          disabled={loading}
          onClick={() => void load()}
        >
          <ArrowsClockwise size={15} />
        </Button>
      </header>

      {error ? (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-line-subtle px-3 py-2 text-xs text-status-danger"
        >
          <WarningCircle size={14} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            retry
          </Button>
        </div>
      ) : null}

      {loading && files.length === 0 ? (
        <div className="split-view flex-col shell:flex-row">
          <div className={LIST_CLASS}>
            <SkeletonRows rows={6} />
          </div>
          <div className={cn(PANE_CLASS, "p-3")}>
            <Skeleton className="min-h-64 w-full flex-1 rounded-lg" />
          </div>
        </div>
      ) : firstRun ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={<Files size={18} />}
            title="Nothing to commit"
            description="The working tree matches the last commit, so there is no diff to review. Accepting records that you are done with it and clears it out of the review queue."
            action={
              <>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!canAccept}
                  aria-busy={committing}
                  onClick={() => void accept()}
                >
                  <GitCommit size={15} weight="bold" aria-hidden="true" />
                  {committing ? "accepting…" : "accept"}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
                  check again
                </Button>
              </>
            }
          />
        </div>
      ) : error && files.length === 0 ? (
        // The whole list failed. Distinct from "nothing to commit": there may
        // well be changes, we simply could not read them.
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={<WarningCircle size={18} />}
            title="Could not load the diff"
            description="The changed-file list did not come back. The message above is the server's own; retry once the workspace is reachable."
            action={
              <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
                retry
              </Button>
            }
          />
        </div>
      ) : (
        <div className="split-view flex-col shell:flex-row">
          <div className={LIST_CLASS}>
            <div
              className="flex flex-wrap items-center gap-1.5 border-b border-line-subtle px-2 py-1.5"
              role="group"
              aria-label="Filter changed files by review state"
            >
              {FILTERS.map((f) => (
                <Button
                  key={f.value}
                  variant={filter === f.value ? "secondary" : "quiet"}
                  size="sm"
                  aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)}
                >
                  {f.label}
                </Button>
              ))}
              <div className="flex-1" />
              <Button
                variant="quiet"
                size="sm"
                disabled={unreviewed.length === 0}
                onClick={() => setReviewed(new Set(files.map((f) => f.name)))}
              >
                <CheckSquare size={13} aria-hidden="true" />
                mark all reviewed
              </Button>
            </div>

            {visible.length === 0 ? (
              <p className="px-3 py-3 text-xs leading-relaxed text-text-muted">
                No files in this filter.{" "}
                <button
                  type="button"
                  className="underline decoration-line-strong underline-offset-2 hover:text-text-primary"
                  onClick={() => setFilter("all")}
                >
                  show all {files.length}
                </button>
              </p>
            ) : (
              <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
                {visible.map((file) => {
                  const stats = diffStats(file.diff);
                  const isCurrent = current ? file.name === current.name : false;
                  const isReviewed = reviewed.has(file.name);
                  return (
                    <li key={file.name} className="file-row" data-selected={isCurrent}>
                      <label className="grid size-6 shrink-0 cursor-pointer place-items-center">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-accent"
                          checked={isReviewed}
                          onChange={() => toggleReviewed(file.name)}
                          aria-label={`Mark ${file.name} reviewed`}
                        />
                      </label>
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-xs text-inherit"
                        title={file.name}
                        aria-current={isCurrent ? "true" : undefined}
                        onClick={() => setSelected(file.name)}
                      >
                        {file.name}
                      </button>
                      {stats ? (
                        <span className="tnum shrink-0 text-2xs">
                          <span className="text-status-running">+{stats.added}</span>{" "}
                          <span className="text-status-danger">−{stats.removed}</span>
                        </span>
                      ) : (
                        <span className="shrink-0 text-2xs text-text-faint" title="no line stats">
                          —
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className={PANE_CLASS}>
            {current ? (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-1.5">
                  <span className="mono min-w-0 flex-1 truncate text-xs text-text-primary">{current.name}</span>
                  {currentStats ? (
                    <Totals added={currentStats.added} removed={currentStats.removed} />
                  ) : (
                    <span className="text-2xs text-text-muted">no line stats</span>
                  )}
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 py-1 text-2xs text-text-secondary">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-accent"
                      checked={currentReviewed}
                      onChange={() => toggleReviewed(current.name)}
                      aria-label={`Mark ${current.name} reviewed`}
                    />
                    reviewed
                  </label>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden bg-surface-sunken">
                  {currentStats ? (
                    <DiffEditor
                      height="100%"
                      language={languageForFile(current.name)}
                      original={split.original}
                      modified={split.modified}
                      theme="vs-dark"
                      options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        // Side-by-side on a wide pane, inline when it narrows —
                        // Monaco decides, so there is no breakpoint to maintain.
                        renderSideBySide: true,
                        useInlineViewWhenSpaceIsLimited: true,
                        scrollBeyondLastLine: false,
                        renderOverviewRuler: false,
                        fontSize: 12,
                      }}
                    />
                  ) : (
                    <div className="h-full overflow-y-auto overscroll-contain p-4">
                      <p className="flex items-center gap-1.5 text-xs font-medium text-status-review">
                        <WarningCircle size={14} aria-hidden="true" />
                        not a text diff
                      </p>
                      <pre className="mono mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-text-secondary">
                        {current.diff || "empty diff"}
                      </pre>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="grid flex-1 place-items-center text-xs text-text-muted">
                Select a changed file to review it.
              </div>
            )}
          </div>
        </div>
      )}

      <footer className="sticky bottom-0 z-10 border-t border-line-subtle bg-surface-raised px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="commit-message">
            Commit message
          </label>
          <input
            id="commit-message"
            className="field-input min-w-48 flex-1"
            value={message}
            placeholder={defaultMessage}
            disabled={files.length === 0 || committing}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={!canCommit}
            aria-busy={committing}
            onClick={() => void commit()}
          >
            <GitCommit size={15} weight="bold" aria-hidden="true" />
            {committing ? "committing…" : "commit"}
          </Button>
        </div>
        <p className="mt-1.5 text-2xs leading-relaxed text-text-muted">
          Commit stages every file in this workspace (<span className="mono">git add -A</span>) and is
          final — Kohlab cannot undo, amend or un-commit it.
        </p>
        {commitError ? (
          <p role="alert" className="mt-1.5 break-words text-2xs text-status-danger">
            commit failed: {commitError}
          </p>
        ) : null}
      </footer>
    </div>
  );
}
