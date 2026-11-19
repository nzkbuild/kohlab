/**
 * What GitHub's checks say about the upstream commit an update would take.
 *
 * The updater itself is not gated (scripts/update.sh has its own rollback). The
 * people who see this are the owner, in Settings → Updates and in `kohlab update`:
 * "GitHub's checks passed", "still checking", "failed" or nothing when unknown.
 *
 * Everything here fails soft: gh missing, not logged in, offline, a non-GitHub
 * origin, or an answer that does not parse all come back as "unknown", never an error.
 */
import { execFile } from "child_process";
import { repoSlug, withoutUserinfo } from "./kohlab";

export type CheckState = "passed" | "pending" | "failed" | "unknown";
export type UpstreamChecks = { state: CheckState; url?: string; sha: string };
/** Runs `gh` with a fixed argument list and resolves its stdout. Injected by the check suite. */
export type GhRunner = (args: string[]) => Promise<string>;

const PASSED = new Set(["success", "neutral", "skipped"]);
const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required"]);
const CHECK_MEMO_MS = 60_000;
const memo = new Map<string, { at: number; value: UpstreamChecks }>();

/** Only a GitHub commit page is ever shown: a link in a response is never a host we did not ask for. */
function githubLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = withoutUserinfo(value);
  return /^https:\/\/github\.com\//.test(clean) ? clean : undefined;
}

/**
 * GitHub's check runs for one commit, as one word. Failing beats pending beats
 * passed, and a run whose state is not recognised counts as pending: when unsure,
 * never claim "passed". No usable runs at all is "unknown".
 */
export function parseCheckRuns(json: string): { state: CheckState; url?: string } {
  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch {
    return { state: "unknown" };
  }
  const runs = (body as { check_runs?: unknown } | null)?.check_runs;
  if (!Array.isArray(runs)) return { state: "unknown" };
  const list = runs.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
  if (!list.length) return { state: "unknown" };

  const failing = list.find((r) => typeof r.conclusion === "string" && FAILED.has(r.conclusion));
  if (failing) return { state: "failed", url: githubLink(failing.html_url) };
  const settled = (r: Record<string, unknown>) =>
    r.status === "completed" && typeof r.conclusion === "string" && PASSED.has(r.conclusion);
  if (list.every(settled)) return { state: "passed" };
  return { state: "pending" };
}

/** The owner's words for a state; null when there is nothing honest to say. */
export function checksSentence(checks: UpstreamChecks | null | undefined): string | null {
  switch (checks?.state) {
    case "passed":
      return "GitHub's checks passed";
    case "pending":
      return "GitHub is still checking this version";
    case "failed":
      return "GitHub's checks failed for this version";
    default:
      return null;
  }
}

/** owner/name when the origin is a GitHub repository, else null. */
export function githubSlug(origin: string): string | null {
  const clean = withoutUserinfo(origin.trim());
  if (!/^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/.test(clean)) return null;
  return repoSlug(clean);
}

/** The real gh, fixed argv, 8 s, no shell. Rejects when gh is missing, signed out, or slow. */
export function ghRunner(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 8000, maxBuffer: 4 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** The checks for the upstream commit `sha`, read from GitHub for the repo `origin` points at. Cached per commit for a minute; never throws. */
export async function upstreamChecks(origin: string, sha: string, run: GhRunner = ghRunner): Promise<UpstreamChecks> {
  const slug = githubSlug(origin);
  if (!slug || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug) || slug.split("/").some((p) => p === "." || p === "..") || !/^[0-9a-f]{40}$/.test(sha)) return { state: "unknown", sha };
  const key = `${slug}@${sha}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < CHECK_MEMO_MS) return hit.value;
  try {
    const value: UpstreamChecks = { ...parseCheckRuns(await run(["api", `repos/${slug}/commits/${sha}/check-runs?per_page=100`])), sha };
    memo.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // Not cached: the next look asks GitHub again.
    return { state: "unknown", sha };
  }
}
