import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, WarningCircle } from "@phosphor-icons/react";
import { api, type ReleaseState } from "../api";
import { announce } from "../lib/announce";
import ConfirmDialog from "./ConfirmDialog";
import UpdatePanel from "./UpdatePanel";
import { Button, SkeletonRows } from "./ui";

const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;

/** What stops a change from being sent, in plain words. The server refuses the same things. */
export function releaseProblems(r: ReleaseState): string[] {
  const problems: string[] = [];
  if (r.dirty) problems.push("Some changes are not kept yet. Keep or undo them first.");
  if (r.ahead === 0) problems.push("Nothing to release yet. Ask Claude to make the change first.");
  else if (r.version === r.base.version) problems.push(`The version is still ${r.version}. Bump the version and add a CHANGELOG entry first.`);
  return problems;
}

/** The pull request's checks, in words. */
function checkWords(r: ReleaseState): string {
  const pr = r.pr;
  if (!pr) return "Not sent yet.";
  if (pr.state === "merged") return "Merged.";
  if (pr.state === "closed") return "Closed on GitHub without merging. Send it again to open a new check.";
  if (pr.checks === "pending") return "Checking…";
  if (pr.checks === "passing") return "Passed";
  if (pr.checks === "failing") return "Failed";
  return "GitHub hasn't reported any checks yet.";
}

/** Step 3's sentence: what the primary button will do, or what it waits for. */
function liveWords(r: ReleaseState): string {
  const pr = r.pr;
  if (!pr) return "Send it for checking first.";
  if (pr.state === "merged") return "Merged to GitHub's main.";
  if (pr.checks === "passing") return "Merging puts it on GitHub's main and updates this server.";
  if (pr.checks === "failing") return "GitHub's checks failed. Ask Claude to fix the problem, then send it again.";
  return "Waits for GitHub's checks to pass.";
}

/**
 * The Release tab of a "Change Kohlab itself" project (owner only). Three steps in plain words: the change,
 * the check on GitHub, and putting it live. The checks are polled every 5 s while they are pending.
 */
export default function ReleasePanel({ workspaceId }: { workspaceId: string }) {
  const [rel, setRel] = useState<ReleaseState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"open" | "merge" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    try {
      setRel(await api.releaseState(workspaceId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = rel?.pr?.state === "open" && rel.pr.checks === "pending";
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending, load]);

  const send = async () => {
    setBusy("open");
    setError(null);
    try {
      setRel(await api.releaseAction(workspaceId, "open"));
      announce("Sent for checking");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const merge = async () => {
    setConfirming(false);
    setBusy("merge");
    setError(null);
    try {
      setRel(await api.releaseAction(workspaceId, "merge"));
      announce("Merged. Updating Kohlab.");
      try {
        await api.applyUpdate();
        setUpdating(true);
      } catch (e) {
        setError(`Merged, but the update did not start. ${(e as Error).message}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!rel) {
    return (
      <div className="mx-auto w-full max-w-[720px] p-4">
        {error ? (
          <p className="flex items-start gap-2 text-sm text-text-secondary">
            <WarningCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : (
          <SkeletonRows rows={3} />
        )}
      </div>
    );
  }

  const problems = releaseProblems(rel);
  const pr = rel.pr;
  const merged = pr?.state === "merged";
  const canSend = problems.length === 0 && !merged && busy === null;
  const canMerge = pr?.state === "open" && pr.checks === "passing" && busy === null;

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-4 py-6 text-left">
      <section aria-labelledby="release-change" className="flex flex-col gap-2">
        <h2 id="release-change" className="text-lg font-semibold text-text-primary">
          Your change
        </h2>
        <p className="text-base text-text-primary">
          {rel.ahead > 0 ? `${plural(rel.ahead, "change")} ready to send.` : "No changes yet."}
        </p>
        <p className="text-sm text-text-secondary">{`Version ${rel.base.version} → ${rel.version}`}</p>
        <p className="text-sm text-text-secondary">{`CHANGELOG updated: ${rel.changelogTouched ? "yes" : "no"}`}</p>
        {rel.behind > 0 ? (
          <p className="text-sm text-text-secondary">{`GitHub's main has ${plural(rel.behind, "newer change")}. They are brought in when you send it.`}</p>
        ) : null}
        {problems.map((problem) => (
          <p key={problem} className="flex items-start gap-2 text-sm text-text-secondary">
            <WarningCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {problem}
          </p>
        ))}
      </section>

      <section aria-labelledby="release-check" className="flex flex-col gap-2">
        <h2 id="release-check" className="text-lg font-semibold text-text-primary">
          Check on GitHub
        </h2>
        <p className="text-base text-text-primary">{checkWords(rel)}</p>
        <div className="flex flex-wrap items-center gap-2">
          {merged ? null : pr?.state === "open" ? (
            <Button variant="secondary" disabled={!canSend} onClick={() => void send()}>
              Send the latest changes
            </Button>
          ) : (
            <Button variant="primary" disabled={!canSend} onClick={() => void send()}>
              {busy === "open" ? "Sending…" : "Send for checking"}
            </Button>
          )}
          {pr?.state === "open" && pr.checks === "none" ? (
            <Button variant="quiet" onClick={() => void load()}>
              Check again
            </Button>
          ) : null}
          {pr ? (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-sm text-text-secondary underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:min-h-12"
            >
              Open on GitHub
              <ArrowSquareOut size={14} aria-hidden="true" />
            </a>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="release-live" className="flex flex-col gap-2">
        <h2 id="release-live" className="text-lg font-semibold text-text-primary">
          Put it live
        </h2>
        <p className="text-base text-text-primary">{liveWords(rel)}</p>
        {rel.live.behind > 0 && !merged ? (
          <p className="text-sm text-text-secondary">{`This server is ${plural(rel.live.behind, "change")} behind GitHub's main.`}</p>
        ) : null}
        {pr?.state === "open" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!canMerge} onClick={() => setConfirming(true)}>
              {busy === "merge" ? "Merging…" : "Merge and update"}
            </Button>
          </div>
        ) : null}
        {merged || updating ? (
          <div className="mt-2">
            <UpdatePanel />
          </div>
        ) : null}
      </section>

      {error ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-text-secondary">
          <WarningCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Merge and update Kohlab?"
        description="This puts the change on GitHub's main branch and updates this server. Running sessions keep going."
        confirmLabel="Merge and update"
        tone="commit"
        busy={busy === "merge"}
        onConfirm={() => void merge()}
      />
    </div>
  );
}
