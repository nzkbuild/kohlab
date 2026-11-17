/**
 * Change Kohlab itself (v2.9): a chat project whose files are Kohlab's own source, on its own branch off origin/main.
 *
 * The AI there edits and commits in a worktree of a server-owned clone (kohlab-source). It never pushes. Only the
 * owner's Release panel does: it fetches origin, merges main in, pushes the branch, opens (or updates) the pull request
 * with gh, and merges it once GitHub's checks pass. Putting it live is the existing update (POST /api/release/update).
 *
 * Every git and gh call is execFile with a fixed argument list, in the server's own environment, so root's GitHub login
 * stays in the server. The origin's credentials are taken out before the clone's config is written.
 */
import { execFile, execFileSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { WORKS_DIR, agentIdentity, createWorkspace, headingVersion, worktreePath } from "./lib";
import type { Workspace } from "./types";

export class KohlabError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Pr = { number: number; url: string; state: "open" | "merged" | "closed"; checks: "pending" | "passing" | "failing" | "none" };
export type ReleaseState = {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  version: string;
  base: { version: string };
  changelogTouched: boolean;
  pr: Pr | null;
  live: { behind: number };
};

/** Takes user:password (or a bare token) out of an http(s) URL. Other schemes keep theirs: ssh's user is a name, not a secret. */
export function withoutUserinfo(url: string): string {
  return url.replace(/^(https?:\/\/)[^\s/@]+@/, "$1");
}

/** owner/name of a GitHub URL (https or git@), or null. */
export function repoSlug(url: string): string | null {
  const m = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** One line of a git or gh message, safe to show or log: no URL credentials. */
export function scrub(text: string): string {
  return text.split("\n")[0].replace(/(https?:\/\/)[^\s/@]+@/g, "$1").slice(0, 300);
}

const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
/** GitHub's check rollup as one word: failing beats pending beats passing. A check run has status and conclusion; a status has state. */
export function checksOf(rollup: { status?: string; conclusion?: string; state?: string }[]): Pr["checks"] {
  if (!rollup.length) return "none";
  if (rollup.some((c) => FAILED.has(c.conclusion ?? "") || FAILED.has(c.state ?? ""))) return "failing";
  const pending = rollup.some((c) => (c.status !== undefined && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED");
  return pending ? "pending" : "passing";
}

/** The CHANGELOG section for `version` without its heading: the pull request's body. "" when there is none. */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const at = lines.findIndex((l) => headingVersion(l) === version);
  if (at < 0) return "";
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(at + 1, end).join("\n").trim();
}

const NOT_HERE = "This server's Kohlab checkout is not on GitHub, so Kohlab can't be changed from here.";
const CANT_REACH = "Could not reach GitHub. Try again in a moment.";

let originMemo: string | null | undefined;
/** The GitHub address of this server's own checkout (its origin), without credentials; null when it has none. Read once. KOHLAB_ORIGIN_OVERRIDE is for the check suite only. */
export function kohlabOrigin(): string | null {
  if (originMemo === undefined) {
    const raw = (process.env.KOHLAB_ORIGIN_OVERRIDE ?? spawnSync("git", ["-c", "safe.directory=*", "remote", "get-url", "origin"], { cwd: import.meta.dir, encoding: "utf8" }).stdout ?? "").trim();
    originMemo = raw ? withoutUserinfo(raw) : null;
  }
  return originMemo;
}

const sourceDir = () => join(WORKS_DIR, "clones", "kohlab-source");

// One git or gh operation on the source clone at a time: two projects starting together must not race the same fetch.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// Every git call runs with hooks and fsmonitor off. The AI's account can write inside the clone's .git, so the clone's config and
// hooks are locked first (lockSource) and the project's tree, which the AI owns outright, is only ever touched as the AI's own user.
const HARD = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "safe.directory=*", "-c", "user.name=Kohlab", "-c", "user.email=kohlab@localhost"];
function git(cwd: string, args: string[], asAgent = false): Promise<{ stdout: string }> {
  const a = asAgent ? agentIdentity() : null;
  // as the AI's user: its own HOME and no server secrets in the environment
  const who = a ? { uid: a.uid, gid: a.gid, env: { PATH: process.env.PATH, HOME: a.home, LANG: "C.UTF-8" } } : { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
  return new Promise((resolve, reject) =>
    execFile("git", [...HARD, ...args], { cwd, maxBuffer: 16 << 20, timeout: 120_000, ...who }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve({ stdout }))),
  );
}

/** The AI's account may not change the shared clone's config or hooks (a changed remote URL or credential helper would send root's GitHub login elsewhere). */
function lockSource(): void {
  const agent = agentIdentity();
  if (!agent) return;
  const g = join(sourceDir(), ".git");
  const acl = (...a: string[]) => execFileSync("setfacl", a, { stdio: "ignore" });
  try {
    acl("-k", g); // nothing new may be made in .git itself (objects, refs, worktrees keep their own grants)
    acl("-m", `u:${agent.name}:r-x`, g);
    for (const f of ["config", "hooks", "info"]) if (existsSync(join(g, f))) acl("-R", "-m", `u:${agent.name}:r-X`, join(g, f));
  } catch {
    console.error("kohlab: could not lock the source clone");
    throw new KohlabError(500, "Kohlab could not set the project up safely. Try again in a moment.");
  }
}

const FRESH_MS = 10_000;
let syncedAt = 0;
/** The clone, fetched and fast-forwarded to origin/main. Cloned on first use. `fresh: false` accepts a fetch from the last 10 seconds (the Release panel polls). Call only inside serial(). */
async function syncSource(fresh = true): Promise<string> {
  const origin = kohlabOrigin();
  if (!origin) throw new KohlabError(409, NOT_HERE);
  const dir = sourceDir();
  if (!existsSync(join(dir, ".git"))) {
    await mkdir(join(WORKS_DIR, "clones"), { recursive: true, mode: 0o700 });
    await git(WORKS_DIR, ["clone", "--quiet", "--", origin, dir]).catch(async (e) => {
      await rm(dir, { recursive: true, force: true });
      console.error(`kohlab: clone failed: ${scrub(String(e?.message ?? e))}`);
      throw new KohlabError(502, CANT_REACH);
    });
  } else if (!fresh && Date.now() - syncedAt < FRESH_MS) return dir;
  lockSource();
  await git(dir, ["fetch", "--quiet", "origin"]).catch((e) => {
    console.error(`kohlab: fetch failed: ${scrub(String(e?.message ?? e))}`);
    throw new KohlabError(502, CANT_REACH);
  });
  await git(dir, ["merge", "--ff-only", "--quiet", "origin/main"]).catch(() => {
    throw new KohlabError(409, "This server's copy of Kohlab has changes of its own, so it can't be brought up to date.");
  });
  syncedAt = Date.now();
  return dir;
}

function slugOrThrow(): string {
  const slug = repoSlug(kohlabOrigin() ?? "");
  if (!slug) throw new KohlabError(409, NOT_HERE);
  return slug;
}

/** The branch a Kohlab project pushes: the worktree's own, named by the server. */
const branchOf = (ws: Workspace) => `kohlab/${ws.id}`;

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    // cwd is the state folder, not a clone: gh takes the repo from --repo and must not touch any local branch.
    execFile("gh", args, { cwd: WORKS_DIR, env: process.env, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(scrub(String(stderr || err.message))));
      else resolve(stdout);
    }),
  );
}

type Found = Pr & { head: string };
async function prOf(slug: string, branch: string): Promise<Found | null> {
  const list = JSON.parse((await gh(["pr", "list", "--repo", slug, "--head", branch, "--state", "all", "--json", "number,url,state,headRefOid,statusCheckRollup"])) || "[]") as {
    number: number;
    url: string;
    state: string;
    headRefOid?: string;
    statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[];
  }[];
  // An open request wins; otherwise the newest one (gh lists newest first).
  const pr = list.find((p) => p.state === "OPEN") ?? list[0];
  if (!pr) return null;
  return { number: pr.number, url: pr.url, state: pr.state.toLowerCase() as Pr["state"], checks: checksOf(pr.statusCheckRollup ?? []), head: pr.headRefOid ?? "" };
}

type Facts = { dirty: boolean; ahead: number; behind: number; version: string; baseVersion: string; changelogTouched: boolean };

const versionIn = (text: string): string => {
  try {
    return String(JSON.parse(text).version ?? "");
  } catch {
    return "";
  }
};

/** The numbers come from the shared clone's branch (the AI can't bend those); only "uncommitted changes" needs the AI's own tree, read as the AI's user. Call only inside serial(). */
async function factsOf(ws: Workspace): Promise<Facts> {
  const ref = `refs/heads/${branchOf(ws)}`;
  const src = sourceDir();
  const text = async (args: string[]) => (await git(src, args)).stdout.trim();
  const count = async (range: string) => Number(await text(["rev-list", "--count", range])) || 0;
  const blob = (rev: string, file: string) => git(src, ["show", `${rev}:${file}`]).then((r) => r.stdout, () => "");
  return {
    dirty: (await git(worktreePath(ws), ["status", "--porcelain"], true)).stdout.trim() !== "",
    ahead: await count(`origin/main..${ref}`),
    behind: await count(`${ref}..origin/main`),
    version: versionIn(await blob(ref, "package.json")),
    baseVersion: versionIn(await blob("origin/main", "package.json")),
    changelogTouched: (await text(["diff", "--name-only", `origin/main...${ref}`, "--", "CHANGELOG.md"])) !== "",
  };
}

/** How far this server's own checkout is behind origin/main: its commit against the source clone's origin/main (so it stays true after a merge, before the update). 0 when unknown. */
async function liveBehind(): Promise<number> {
  try {
    const live = (await git(import.meta.dir, ["rev-parse", "HEAD"])).stdout.trim();
    return Number((await git(sourceDir(), ["rev-list", "--count", `${live}..origin/main`])).stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/** The release state of a project. Call only inside serial(), after syncSource(). */
async function stateOf(ws: Workspace, slug: string): Promise<ReleaseState> {
  const f = await factsOf(ws);
  const found = await prOf(slug, branchOf(ws));
  const pr = found ? { number: found.number, url: found.url, state: found.state, checks: found.checks } : null;
  return { branch: branchOf(ws), ahead: f.ahead, behind: f.behind, dirty: f.dirty, version: f.version, base: { version: f.baseVersion }, changelogTouched: f.changelogTouched, pr, live: { behind: await liveBehind() } };
}

/** A new "Change Kohlab itself" chat project: its branch is kohlab/<id>, made from origin/main. */
export function newKohlabProject(name: string) {
  return serial(async () => {
    const made = await createWorkspace({ repo: await syncSource(), task: name, agent: "sh", inherit: true, chat: true, branch: "main", kohlab: true });
    lockSource(); // createWorkspace grants the AI's account the whole .git again
    return made;
  });
}

export function releaseState(ws: Workspace): Promise<ReleaseState> {
  return serial(async () => {
    await syncSource(false);
    return stateOf(ws, slugOrThrow());
  });
}

const cap = (text: string, n: number) => (text.length > n ? text.slice(0, n - 1) + "…" : text);

/** Send the change for checking: push the branch and open (or update) its pull request. */
export function openRelease(ws: Workspace): Promise<ReleaseState> {
  return serial(async () => {
    await syncSource();
    const slug = slugOrThrow();
    const tree = worktreePath(ws);
    const branch = branchOf(ws);
    const ref = `refs/heads/${branch}`;
    if ((await git(tree, ["rev-parse", "--abbrev-ref", "HEAD"], true).then((r) => r.stdout.trim(), () => "")) !== branch) throw new KohlabError(409, "This project is not on its own branch. Ask Claude to switch back to it.");
    const f = await factsOf(ws);
    if (f.dirty) throw new KohlabError(409, "Keep or undo the changes first.");
    if (f.ahead === 0) throw new KohlabError(409, "Nothing to release yet.");
    if (f.version === f.baseVersion) throw new KohlabError(409, "Bump the version and add a CHANGELOG entry first.");
    if (f.behind > 0) {
      await git(tree, ["merge", "--no-edit", "--quiet", "origin/main"], true).catch(async () => {
        await git(tree, ["merge", "--abort"], true).catch(() => {});
        throw new KohlabError(409, "Main moved on and overlaps this change. Ask Claude to bring it up to date.");
      });
    }
    // Pushed from the shared clone (not the AI's tree, whose git settings the AI controls), by the branch's name.
    await git(sourceDir(), ["push", "--quiet", "--", "origin", `${ref}:${ref}`]).catch((e) => {
      console.error(`kohlab: push failed: ${scrub(String(e?.message ?? e))}`);
      throw new KohlabError(502, "Could not send the change to GitHub. Try again in a moment.");
    });
    const open = await prOf(slug, branch);
    if (!open || open.state !== "open") {
      // The title and body are the AI's words: capped, one line for the title, and given as --title=… / --body=… so none can be read as a flag.
      const subject = (await git(sourceDir(), ["log", "-1", "--no-merges", "--format=%s", `origin/main..${ref}`])).stdout.trim().split("\n")[0] || `Change Kohlab ${f.version}`;
      const log = await git(sourceDir(), ["show", `${ref}:CHANGELOG.md`]).then((r) => r.stdout, () => "");
      await gh(["pr", "create", "--repo", slug, "--base", "main", "--head", branch, `--title=${cap(subject, 200)}`, `--body=${cap(changelogSection(log, f.version), 4000)}`]).catch((e) => {
        console.error(`kohlab: pr create failed: ${scrub(String(e?.message ?? e))}`);
        throw new KohlabError(502, "GitHub did not open the request. Try again in a moment.");
      });
    }
    return stateOf(ws, slug);
  });
}

/** Merge the pull request once GitHub's checks pass, then take the project's branch to main. Putting it live is the update, not this. */
export function mergeRelease(ws: Workspace): Promise<ReleaseState> {
  return serial(async () => {
    const slug = slugOrThrow();
    const pr = await prOf(slug, branchOf(ws));
    if (!pr || pr.state !== "open") throw new KohlabError(409, "Send it for checking first.");
    if (pr.checks === "pending") throw new KohlabError(409, "GitHub is still checking.");
    if (pr.checks === "failing") throw new KohlabError(409, "GitHub's checks failed. Ask Claude to fix them.");
    if (pr.checks === "none") throw new KohlabError(409, "GitHub has not run any checks on it yet.");
    // What GitHub checked must be what the project holds now, or newer work would be left behind (and then lost by the reset below).
    const tip = (await git(sourceDir(), ["rev-parse", `refs/heads/${branchOf(ws)}`])).stdout.trim();
    if (!pr.head || tip !== pr.head) throw new KohlabError(409, "The project changed after it was sent. Send it for checking again.");
    await gh(["pr", "merge", String(pr.number), "--repo", slug, "--squash", "--delete-branch", `--match-head-commit=${pr.head}`]).catch((e) => {
      console.error(`kohlab: pr merge failed: ${scrub(String(e?.message ?? e))}`);
      throw new KohlabError(502, "GitHub would not merge it. Check it on GitHub.");
    });
    // The squash commit is on main now. Take the branch there too, so the next release holds only new work. Only a clean tree, and only
    // the commit that was merged (checked above): nothing uncommitted or unsent can be lost.
    await syncSource();
    const tree = worktreePath(ws);
    const still = (await git(sourceDir(), ["rev-parse", `refs/heads/${branchOf(ws)}`])).stdout.trim() === pr.head;
    if (still && (await git(tree, ["status", "--porcelain"], true)).stdout.trim() === "") await git(tree, ["reset", "--hard", "--quiet", "origin/main"], true).catch(() => {});
    return stateOf(ws, slug);
  });
}
