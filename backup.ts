// Backups: everything Kohlab keeps in one archive that is checked before anyone trusts it.
//
// Archive (tar.gz, format 2):
//   meta.json                 what is inside, and what was left out on purpose
//   state.json, users.json, audit.log, key, vapid.json, push.json   (as format 1 had them)
//   accounts/accounts.json    only with --with-logins: the account list, no secrets
//   ws/<id>/repo.bundle       git bundle --all of the workspace's repository
//   ws/<id>/tree.tar          the working tree, uncommitted work included; no .git, no build output
//   ws/<id>/brain.tar         the project brain's notes (brainRoot)
//   ws/<id>/images.tar        pasted screenshots (imagesDir)
//   ws/<id>/chats/<file>      the chat files for the workspace
// Never in an archive: accounts/secrets.json (router keys), the AI sign-in folders under accounts/.
//
// Restore moves what it replaces aside, never deletes, and refuses an archive with a path that escapes.

import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { open } from "fs/promises";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, statfs, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join, posix, resolve, sep } from "path";
import {
  WORKS_DIR,
  agentIdentity,
  audit,
  brainRoot,
  grantAgentAccess,
  imagesDir,
  loadState,
  osUserName,
  projectsDir,
  readUsers,
  SERVER_SHELL_ID,
  strictlyInside,
  worktreePath,
  wsDir,
} from "./lib";
import type { Workspace } from "./types";

export const BACKUP_FORMAT = 2;
/** The files the state directory keeps, the same six format 1 archived. */
const STATE_NAMES = ["state.json", "users.json", "audit.log", "key", "vapid.json", "push.json"] as const;
/** Directories that are rebuilt by tools, never work: left out of tree.tar. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", ".venv", "__pycache__", "target"]);
/** A single file over this is skipped and counted in the record: a model, a video, a dump. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const CHAT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
/** A branch name that is safe as a git argument and a path: no leading dash, no `..`. */
const SAFE_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/;
/** Extraction as nobody in particular: no owners, no setuid bits. */
const SAFE_X = ["--no-same-owner", "--no-same-permissions"];
/** What one archive may hold: bounds on a hostile or runaway archive. */
const MAX_MEMBERS = 500_000;
const MAX_TOTAL_BYTES = 32 * 1024 ** 3;
/** Backup archives in the backups folder: only these names are ever served, deleted or pruned. */
const BACKUP_NAME = /^kohlab-\d{8}-\d{6}\.tar\.gz$/;
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Git hardening: no hooks, no fsmonitor helper, and a repo owned by someone else is still readable. */
const GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "safe.directory=*"];

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

export type Counts = { projects: number; chats: number; brains: number };
export type Skipped = { symlinks: number; large: number; special: number };
export type RepoKind = "path" | "project" | "clone" | "none";
export type Part = { entries: number; bytes: number; tarBytes: number };
export type WsMeta = {
  id: string;
  kind: "chat" | "project";
  repoKind: RepoKind;
  head: string | null;
  repo: "bundle" | "empty" | "missing" | "none";
  /** entries in tree.tar (files, folders, links) */
  files: number;
  /** bytes of everything archived for this workspace */
  bytes: number;
  repoBytes: number;
  tree: Part | null;
  brain: Part | null;
  images: Part | null;
  chats: string[];
  skipped: Skipped;
  /** Recently deleted when the archive was made: its files are archived like a live project's, and restore puts it back in the trash. */
  trashed?: true;
};
type Meta = { format: number; kohlabVersion: string; createdAt: string; worksDir: string; includes: Record<string, unknown>; workspaces: WsMeta[] };

/** `key: false` leaves the owner's access key out: the daily archives are downloadable, so they never hold it. */
export type BackupOptions = { projects?: boolean; logins?: boolean; key?: boolean };
export type BackupResult = { path: string; bytes: number; entries: string[]; counts: Counts; workspaces: WsMeta[] };
export type VerifyResult = { ok: boolean; problems: string[]; counts: Counts; format: number | null };
export type RestoreOptions = { projects?: boolean; dryRun?: boolean };
export type RestoreResult = { restored: string[]; movedAside: string[]; kept: string[]; problems: string[] };
export type LastRun = {
  at: number;
  name: string | null;
  bytes: number;
  ok: boolean;
  verified: boolean;
  counts: Counts;
  error?: string;
};

const zero = (): Counts => ({ projects: 0, chats: 0, brains: 0 });
const lines = (s: string) => s.split("\n").filter(Boolean);
const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

// --- processes ---------------------------------------------------------------

type Out = { code: number; stdout: string; stderr: string };

/** One process, fixed argv, no shell. `nice` puts it at low priority so a backup does not slow the server. */
function run(cmd: string, args: string[], opts: { cwd?: string; nice?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Out> {
  const file = opts.nice ? "nice" : cmd;
  const argv = opts.nice ? ["-n", "10", cmd, ...args] : args;
  return new Promise((done) => {
    execFile(file, argv, { cwd: opts.cwd, env: opts.env, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 127;
      done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

async function must(p: Promise<Out>, what: string, ok: number[] = []): Promise<Out> {
  const r = await p;
  if (r.code !== 0 && !ok.includes(r.code)) throw new Error(`${what} failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  return r;
}

/** No system or user git config and no prompts: a repo the AI wrote to cannot lean on the server's own settings. */
const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, args: string[], ok: number[] = []) => must(run("git", [...GIT, ...args], { cwd, nice: true, env: GIT_ENV }), `git ${args[0]}`, ok);
const tarRun = (args: string[], what: string) => must(run("tar", args, { nice: true }), `tar ${what}`);

async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await git(repo, ["rev-parse", "--verify", "-q", ref], [1])).code === 0;
}

// --- what is worth keeping --------------------------------------------------

function repoKindOf(ws: Workspace): RepoKind {
  if (!ws.repo) return ws.dir ? "clone" : "none";
  return strictlyInside(resolve(ws.repo), resolve(projectsDir())) ? "project" : "path";
}

type Scan = { entries: string[]; bytes: number; skipped: Skipped };

/**
 * The files under a folder that a backup keeps: everything except tool output
 * and .git, no links that leave the folder, no files over the size cap. Returns
 * relative names, folders included, for tar to take as they are listed.
 */
async function scanTree(root: string): Promise<Scan> {
  const rootAbs = resolve(root);
  const out: Scan = { entries: [], bytes: 0, skipped: { symlinks: 0, large: 0, special: 0 } };
  const walk = async (rel: string): Promise<void> => {
    for (const d of await readdir(join(rootAbs, rel), { withFileTypes: true })) {
      if (d.name === ".git" || (d.isDirectory() && SKIP_DIRS.has(d.name))) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const full = join(rootAbs, r);
      if (d.isSymbolicLink()) {
        const abs = resolve(dirname(full), await readlink(full));
        if (abs === rootAbs || abs.startsWith(rootAbs + sep)) out.entries.push(r);
        else out.skipped.symlinks++;
      } else if (d.isDirectory()) {
        out.entries.push(r);
        await walk(r);
      } else if (d.isFile()) {
        const { size } = await stat(full);
        if (size > MAX_FILE_BYTES) {
          out.skipped.large++;
          continue;
        }
        out.entries.push(r);
        out.bytes += size;
      } else {
        out.skipped.special++;
      }
    }
  };
  await walk("");
  return out;
}

/** Pack a folder into a plain tar holding exactly what scanTree chose. Null when there is nothing to keep. */
async function packDir(root: string, tarFile: string, listFile: string): Promise<{ part: Part; skipped: Skipped } | null> {
  if (!existsSync(root)) return null;
  const scan = await scanTree(root);
  if (!scan.entries.length) return null;
  await mkdir(dirname(listFile), { recursive: true, mode: 0o700 });
  await writeFile(listFile, scan.entries.join("\0") + "\0");
  await tarRun(["-cf", tarFile, "-C", resolve(root), "--no-recursion", "--null", "-T", listFile], "pack");
  return { part: { entries: scan.entries.length, bytes: scan.bytes, tarBytes: (await stat(tarFile)).size }, skipped: scan.skipped };
}

async function archiveWorkspace(ws: Workspace, staging: string): Promise<WsMeta> {
  if (!ID_RE.test(ws.id)) throw new Error(`workspace id '${ws.id}' cannot be archived`);
  const out = join(staging, "ws", ws.id);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const kind = repoKindOf(ws);
  const meta: WsMeta = {
    id: ws.id,
    kind: ws.chat ? "chat" : "project",
    repoKind: kind,
    head: null,
    repo: "none",
    files: 0,
    bytes: 0,
    repoBytes: 0,
    tree: null,
    brain: null,
    images: null,
    chats: [],
    skipped: { symlinks: 0, large: 0, special: 0 },
  };

  // The repository: a bundle carries every branch and commit. An empty one is recorded, not an error.
  const repoDir = kind === "clone" ? worktreePath(ws) : kind === "none" ? null : ws.repo;
  // A .git that is a file or a link is the AI's to point anywhere: only a real folder is read.
  const dotGit = repoDir ? await lstat(join(repoDir, ".git")).catch(() => null) : null;
  if (repoDir && !dotGit?.isDirectory()) {
    meta.repo = "missing";
  } else if (repoDir) {
    const commits = (await git(repoDir, ["rev-list", "-n", "1", "--all"])).stdout.trim();
    if (!commits) {
      meta.repo = "empty";
    } else {
      meta.head = (await git(repoDir, ["symbolic-ref", "-q", "--short", "HEAD"], [1])).stdout.trim() || null;
      const bundle = join(out, "repo.bundle");
      await git(repoDir, ["bundle", "create", "--quiet", bundle, "--all"]);
      meta.repo = "bundle";
      meta.repoBytes = (await stat(bundle)).size;
    }
  }

  // The working tree, uncommitted work included.
  const tree = await packDir(worktreePath(ws), join(out, "tree.tar"), join(staging, ".work", `${ws.id}-tree.list`));
  if (tree) {
    meta.tree = tree.part;
    meta.files = tree.part.entries;
    meta.skipped = tree.skipped;
  }
  const brain = await packDir(brainRoot(ws), join(out, "brain.tar"), join(staging, ".work", `${ws.id}-brain.list`));
  if (brain) meta.brain = brain.part;
  const images = await packDir(imagesDir(ws), join(out, "images.tar"), join(staging, ".work", `${ws.id}-images.list`));
  if (images) meta.images = images.part;

  // The chat files: one per conversation (the log, its cursor, its menus).
  const chatsDir = join(WORKS_DIR, "chats");
  if (existsSync(chatsDir)) {
    const names = (await readdir(chatsDir, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.startsWith(`${ws.id}.`) && CHAT_RE.test(d.name))
      .map((d) => d.name);
    if (names.length) {
      await mkdir(join(out, "chats"), { recursive: true, mode: 0o700 });
      for (const n of names) await copyFile(join(chatsDir, n), join(out, "chats", n));
      meta.chats = names;
    }
  }

  let chatBytes = 0;
  for (const n of meta.chats) chatBytes += (await stat(join(out, "chats", n))).size;
  meta.bytes =
    meta.repoBytes + (meta.tree?.tarBytes ?? 0) + (meta.brain?.tarBytes ?? 0) + (meta.images?.tarBytes ?? 0) + chatBytes;
  return meta;
}

// --- writing ----------------------------------------------------------------

/**
 * Write a backup to `target`. The archive is built in a staging folder beside
 * the target, written to a temp file there, then renamed into place (0600).
 */
export async function writeArchive(target: string, opts: BackupOptions = {}): Promise<BackupResult> {
  const release = await takeLock();
  try {
    return await writeArchiveLocked(target, opts);
  } finally {
    await release();
  }
}

/**
 * One backup at a time across the CLI and the server: a lock file holding the
 * owner's pid. A lock whose process is gone is stale and taken over.
 */
async function takeLock(): Promise<() => Promise<void>> {
  await mkdir(WORKS_DIR, { recursive: true, mode: 0o700 });
  const lock = join(WORKS_DIR, ".backup.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lock, "wx", 0o600);
      await fh.writeFile(String(process.pid));
      await fh.close();
      return () => rm(lock, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(await readFile(lock, "utf8").catch(() => ""));
      let alive = pid > 0;
      if (alive) {
        try {
          process.kill(pid, 0);
        } catch (k) {
          alive = (k as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (alive) throw new Error("another backup is already running");
      await rm(lock, { force: true });
    }
  }
  throw new Error("another backup is already running");
}

async function writeArchiveLocked(target: string, opts: BackupOptions = {}): Promise<BackupResult> {
  const file = resolve(target);
  const projects = opts.projects !== false;
  const logins = !!opts.logins;
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const state = await loadState();
  const staging = await mkdtemp(join(dir, ".kohlab-backup-"));
  const partial = `${file}.${process.pid}.partial`;
  try {
    const names: string[] = [];
    for (const f of STATE_NAMES) {
      if (f === "key" && opts.key === false) continue;
      const src = join(WORKS_DIR, f);
      if (existsSync(src)) {
        await copyFile(src, join(staging, f));
        names.push(f);
      }
    }
    if (!names.length) throw new Error(`nothing to back up in ${WORKS_DIR}`);
    const accounts = join(WORKS_DIR, "accounts", "accounts.json");
    if (logins && existsSync(accounts)) {
      await mkdir(join(staging, "accounts"), { recursive: true, mode: 0o700 });
      await copyFile(accounts, join(staging, "accounts", "accounts.json"));
      names.push("accounts");
    }

    const workspaces: WsMeta[] = [];
    if (projects) {
      const live: [Workspace, true | undefined][] = [
        ...state.workspaces.map((ws): [Workspace, true | undefined] => [ws, undefined]),
        ...(state.trashed ?? []).map((ws): [Workspace, true | undefined] => [ws, true]),
      ];
      for (const [ws, trashed] of live) {
        if (ws.serverShell || ws.id === SERVER_SHELL_ID) continue;
        const meta = await archiveWorkspace(ws, staging);
        if (trashed) meta.trashed = trashed;
        workspaces.push(meta);
      }
      if (workspaces.length) names.push("ws");
    }

    const meta: Meta = {
      format: BACKUP_FORMAT,
      kohlabVersion: VERSION,
      createdAt: new Date().toISOString(),
      worksDir: basename(WORKS_DIR),
      includes: {
        state: names.filter((n) => (STATE_NAMES as readonly string[]).includes(n)),
        projects,
        repositories: projects,
        trees: projects,
        brains: projects,
        images: projects,
        chats: projects,
        logins,
        accessKey: opts.key !== false,
        secrets: false,
        notIncluded: [
          "accounts/secrets.json (AI router keys)",
          "the AI sign-in folders under accounts/",
          ...(opts.key === false ? ["key (the access key; kohlab backup keeps it, the daily backups do not)"] : []),
          ...(logins ? [] : ["accounts/accounts.json (the account list; --with-logins adds it)"]),
          "build output, dependencies, .git inside trees, and files over 50 MB (counted in each workspace's skipped)",
        ],
      },
      workspaces,
    };
    await writeFile(join(staging, "meta.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
    names.unshift("meta.json");

    await tarRun(["-czf", partial, "-C", staging, ...names], "archive");
    await chmod(partial, 0o600);
    await rename(partial, file);
    const bytes = (await stat(file)).size;
    const counts = zero();
    for (const w of workspaces) {
      if (w.repo === "bundle" || w.tree) counts.projects++;
      if (w.chats.some((n) => n.includes(".jsonl"))) counts.chats++;
      if (w.brain) counts.brains++;
    }
    return { path: file, bytes, entries: names, counts, workspaces };
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** kohlab backup: write an archive and audit it. */
export async function backupTo(target: string, opts: BackupOptions = {}): Promise<BackupResult> {
  const r = await writeArchive(target, opts);
  await audit("cli", "backup", undefined, `${r.path} (${r.entries.length} entries, ${Math.round(r.bytes / 1024)} KiB)`);
  return r;
}

// --- reading and checking -------------------------------------------------

const TOP_FILES = new Set<string>(["meta.json", ...STATE_NAMES]);

/** The only names an archive may hold. Anything else is refused before extraction. */
function allowedMember(name: string): boolean {
  const p = name.split("/");
  if (p.length === 1) return TOP_FILES.has(p[0]) || p[0] === "ws" || p[0] === "accounts";
  if (p[0] === "accounts") return p.length === 2 && p[1] === "accounts.json";
  if (p[0] !== "ws" || !ID_RE.test(p[1] ?? "")) return false;
  if (p.length === 2) return true;
  if (p.length === 3) return ["repo.bundle", "tree.tar", "brain.tar", "images.tar", "chats"].includes(p[2]);
  return p.length === 4 && p[2] === "chats" && CHAT_RE.test(p[3]);
}

/** The sizes a `tar -tv` listing claims (the third column), summed. A non-number counts as 0. */
function sizeSum(verboseLines: string[]): number {
  let n = 0;
  for (const l of verboseLines) n += Number(l.split(/\s+/)[2]) || 0;
  return n;
}

/** Names and entry types of the archive itself, before anything is extracted. */
async function checkTopLevel(file: string): Promise<{ names: string[]; problems: string[] }> {
  const list = await run("tar", ["-tzf", file]);
  const verbose = list.code === 0 ? await run("tar", ["-tvzf", file]) : list;
  if (list.code !== 0 || verbose.code !== 0) {
    return { names: [], problems: [`not a readable archive: ${firstLine(list.stderr || verbose.stderr) || "unknown error"}`] };
  }
  const names = lines(list.stdout).map((n) => n.replace(/\/$/, ""));
  const types = lines(verbose.stdout).map((l) => l[0] ?? "");
  const problems: string[] = [];
  if (names.length !== types.length) problems.push("the archive listing does not line up");
  if (names.length > MAX_MEMBERS) problems.push(`too many entries in the archive (${names.length})`);
  if (sizeSum(lines(verbose.stdout)) > MAX_TOTAL_BYTES) problems.push("the archive claims more data than a backup may hold");
  names.forEach((n, i) => {
    if (!allowedMember(n)) problems.push(`unexpected entry in the archive: ${n}`);
    if (types[i] !== "-" && types[i] !== "d") problems.push(`refusing a link or special file: ${n}`);
  });
  return { names, problems };
}

/** A link inside a tree must stay inside it. */
function escapes(link: string, target: string): boolean {
  const p = posix.normalize(posix.join(posix.dirname(link), target));
  return p === ".." || p.startsWith("../") || p.startsWith("/");
}

/** A tree.tar (or brain/images tar): every name is relative and every link stays inside. Checked before it is extracted. */
async function checkInnerTar(file: string, label: string): Promise<{ entries: number; problems: string[] }> {
  const list = await run("tar", ["-tf", file]);
  if (list.code !== 0) return { entries: 0, problems: [`${label} is not a readable tar`] };
  const verbose = await run("tar", ["-tvf", file]);
  const names = lines(list.stdout);
  const vl = lines(verbose.stdout);
  const problems: string[] = [];
  if (verbose.code !== 0 || names.length !== vl.length) problems.push(`${label}: the listing does not line up`);
  if (names.length > MAX_MEMBERS || sizeSum(vl) > MAX_TOTAL_BYTES) problems.push(`${label}: more entries or data than a backup may hold`);
  for (const l of vl) if (l[0] === "-" && (Number(l.split(/\s+/)[2]) || 0) > MAX_FILE_BYTES) problems.push(`${label}: a file over 50 MB (a backup never holds one)`);
  names.forEach((raw, i) => {
    const n = raw.replace(/\/$/, "");
    if (!n || n.startsWith("/") || n.split("/").includes("..")) problems.push(`${label}: unsafe name ${raw}`);
    const line = vl[i] ?? "";
    const t = line[0];
    if (t === "l") {
      const at = line.lastIndexOf(" -> ");
      const target = at >= 0 ? line.slice(at + 4) : "";
      if (!target || target.startsWith("/") || escapes(n, target)) problems.push(`${label}: link ${raw} points outside the tree`);
    } else if (t !== "-" && t !== "d") {
      problems.push(`${label}: refusing ${t === "h" ? "a hard link" : "a special file"}: ${raw}`);
    }
  });
  return { entries: names.length, problems };
}

function validChat(name: string, text: string): boolean {
  try {
    if (name.endsWith(".json")) JSON.parse(text);
    else if (name.includes(".jsonl")) for (const l of lines(text)) JSON.parse(l);
    return true;
  } catch {
    return false;
  }
}

async function checkWorkspace(w: WsMeta, dir: string, gitDir: string, counts: Counts): Promise<string[]> {
  if (!w || typeof w.id !== "string" || !ID_RE.test(w.id)) return ["a workspace entry has a bad id"];
  const wd = join(dir, "ws", w.id);
  if (!existsSync(wd)) return [`${w.id}: its data is missing from the archive`];
  const problems: string[] = [];
  // meta.json is as untrusted as the rest: every string that becomes a path or a git argument is checked here.
  if (!["path", "project", "clone", "none"].includes(w.repoKind)) problems.push(`${w.id}: unknown repository kind`);
  if (!["bundle", "empty", "missing", "none"].includes(w.repo)) problems.push(`${w.id}: unknown repository state`);
  if (w.head !== null && !(typeof w.head === "string" && SAFE_REF.test(w.head))) problems.push(`${w.id}: unsafe branch name`);
  if (!Array.isArray(w.chats ?? [])) return [...problems, `${w.id}: bad chat list`];
  for (const n of w.chats ?? []) {
    if (typeof n !== "string" || !CHAT_RE.test(n) || !n.startsWith(`${w.id}.`)) problems.push(`${w.id}: unsafe chat file name`);
  }
  if (problems.length) return problems;
  if (w.repo === "bundle") {
    const f = join(wd, "repo.bundle");
    if (!existsSync(f)) problems.push(`${w.id}: repo.bundle is missing`);
    else {
      const size = (await stat(f)).size;
      if (size !== w.repoBytes) problems.push(`${w.id}: repo.bundle is ${size} bytes, the record says ${w.repoBytes}`);
      const r = await run("git", [...GIT, "bundle", "verify", f], { cwd: gitDir, env: GIT_ENV });
      if (r.code !== 0) problems.push(`${w.id}: git bundle verify failed: ${firstLine(r.stderr) || r.code}`);
      else {
        // verify checks only the header: fetching into a throwaway repo checks every object.
        const scratchRepo = join(gitDir, w.id);
        try {
          await mkdir(scratchRepo, { recursive: true });
          await git(scratchRepo, ["init", "-q"]);
          await git(scratchRepo, ["fetch", "--update-head-ok", "--quiet", f, "+refs/heads/*:refs/heads/*"]);
        } catch (e) {
          problems.push(`${w.id}: the repository's objects do not check out: ${(e as Error).message}`);
        }
      }
    }
  }
  const parts: [Part | null, string][] = [
    [w.tree, "tree.tar"],
    [w.brain, "brain.tar"],
    [w.images, "images.tar"],
  ];
  for (const [part, file] of parts) {
    if (!part) continue;
    const f = join(wd, file);
    if (!existsSync(f)) {
      problems.push(`${w.id}: ${file} is missing`);
      continue;
    }
    if ((await stat(f)).size !== part.tarBytes) problems.push(`${w.id}: ${file} size differs from the record`);
    const inner = await checkInnerTar(f, `${w.id}/${file}`);
    problems.push(...inner.problems);
    if (!inner.problems.length && inner.entries !== part.entries) {
      problems.push(`${w.id}/${file}: ${inner.entries} entries, the record says ${part.entries}`);
    }
  }
  for (const n of w.chats ?? []) {
    const f = join(wd, "chats", n);
    if (!existsSync(f)) problems.push(`${w.id}: chat file ${n} is missing`);
    else if (!validChat(n, await readFile(f, "utf8"))) problems.push(`${w.id}: chat file ${n} is not readable JSON`);
  }
  if ((w.chats ?? []).some((n) => n.includes(".jsonl"))) counts.chats++;
  if (w.brain) counts.brains++;
  if (w.repo === "bundle" || w.tree) counts.projects++;
  return problems;
}

/** Everything in an extracted archive: state, meta, and each workspace's parts. */
/** The part of state.json a backup reads: live projects and Recently deleted ones. */
type StateLike = { workspaces: Workspace[]; trashed?: Workspace[] };
const allRecords = (s: StateLike): Workspace[] => [...s.workspaces, ...(s.trashed ?? [])];

async function checkStaged(dir: string): Promise<{ state: StateLike | null; meta: Meta | null; problems: string[]; counts: Counts }> {
  const problems: string[] = [];
  const counts = zero();
  let state: StateLike | null = null;
  const sp = join(dir, "state.json");
  if (!existsSync(sp)) problems.push("no state.json in the archive");
  else {
    try {
      const parsed = JSON.parse(await readFile(sp, "utf8"));
      if (Array.isArray(parsed?.workspaces)) state = parsed;
      else problems.push("state.json has no workspace list");
    } catch {
      problems.push("state.json does not parse");
    }
  }
  let meta: Meta | null = null;
  const mp = join(dir, "meta.json");
  if (existsSync(mp)) {
    try {
      meta = JSON.parse(await readFile(mp, "utf8"));
    } catch {
      problems.push("meta.json does not parse");
    }
    if (meta && meta.format !== BACKUP_FORMAT) problems.push(`unknown archive format: ${meta.format}`);
    else if (meta && Array.isArray(meta.workspaces)) {
      const gitDir = join(dir, ".gitcheck");
      if (meta.workspaces.some((w) => w.repo === "bundle")) {
        await mkdir(gitDir, { recursive: true });
        await git(gitDir, ["init", "-q"]);
      }
      for (const w of meta.workspaces) problems.push(...(await checkWorkspace(w, dir, gitDir, counts)));
      if (meta.includes?.projects && state) {
        const have = new Set(meta.workspaces.map((w) => w.id));
        for (const ws of allRecords(state)) {
          if (ws.serverShell || ws.id === SERVER_SHELL_ID) continue;
          if (!have.has(ws.id)) problems.push(`the state lists ${ws.id} but the archive has no data for it`);
        }
      }
    }
  }
  return { state, meta, problems, counts };
}

/** Check an archive without changing anything: it is extracted to a throwaway folder and removed. */
export async function verifyArchive(archive: string): Promise<VerifyResult> {
  const file = resolve(archive);
  if (!existsSync(file)) return { ok: false, problems: [`no such archive: ${archive}`], counts: zero(), format: null };
  const top = await checkTopLevel(file);
  if (top.problems.length) return { ok: false, problems: top.problems, counts: zero(), format: null };
  const scratch = await mkdtemp(join(tmpdir(), "kohlab-verify-"));
  try {
    await tarRun(["-xzf", file, "-C", scratch, ...SAFE_X], "extract");
    const s = await checkStaged(scratch);
    return { ok: s.problems.length === 0, problems: s.problems, counts: s.counts, format: s.meta?.format ?? 1 };
  } catch (e) {
    return { ok: false, problems: [`cannot read the archive: ${(e as Error).message}`], counts: zero(), format: null };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// --- restoring --------------------------------------------------------------

async function tarX(file: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await tarRun(["-xf", file, "-C", dest, ...SAFE_X], "extract");
}

/** A repository from a bundle: every branch, the default branch checked out. */
async function restoreRepo(bundle: string, dest: string, head: string | null): Promise<void> {
  await mkdir(dest, { recursive: true });
  await git(dest, ["init", "-q"]);
  await git(dest, ["fetch", "--update-head-ok", "--quiet", bundle, "+refs/heads/*:refs/heads/*"]);
  if (head && (await refExists(dest, `refs/heads/${head}`))) {
    await git(dest, ["symbolic-ref", "HEAD", `refs/heads/${head}`]);
    await git(dest, ["reset", "--quiet", "--hard"]);
  }
}

/** The repo, its tree and the rest of one workspace, from its staged parts. */
async function restoreWorkspace(ws: Workspace, m: WsMeta, from: string): Promise<void> {
  const D = wsDir(ws);
  const tree = worktreePath(ws);
  const repo = m.repoKind === "clone" ? tree : join(D, "repo");
  const hasRepo = m.repoKind === "path" || m.repoKind === "project";
  if (m.repo === "bundle") await restoreRepo(join(from, "repo.bundle"), repo, m.head);
  else if (m.repo === "empty" && m.repoKind !== "none") {
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-q"]);
  }
  if (hasRepo && m.repo === "bundle") {
    // The workspace's own branch comes back as a worktree, the way createWorkspace made it.
    const branch = `kohlab/${ws.id}`;
    if (await refExists(repo, `refs/heads/${branch}`)) await git(repo, ["worktree", "add", "--quiet", tree, branch]);
    else if (m.head) await git(repo, ["worktree", "add", "--quiet", "-b", branch, tree, m.head]);
  }
  await mkdir(tree, { recursive: true });
  if (m.tree) await tarX(join(from, "tree.tar"), tree);
  if (m.brain) await tarX(join(from, "brain.tar"), brainRoot(ws));
  if (m.images) await tarX(join(from, "images.tar"), imagesDir(ws));
  if (m.chats.length) {
    const chats = join(WORKS_DIR, "chats");
    await mkdir(chats, { recursive: true, mode: 0o700 });
    for (const n of m.chats) {
      const dst = join(chats, n);
      if (existsSync(dst)) await rename(dst, `${dst}.before-restore-${stamp()}`);
      await copyFile(join(from, "chats", n), dst);
      await chmod(dst, 0o600);
    }
  }
}

/** The member an OS account really belongs to: its names are the ones Kohlab would have made, never what a file says. */
function realIsolatedUser(u: { id: string; uid?: number; gid?: number; home?: string; osUser?: string } | undefined) {
  return u && u.uid && u.gid && u.osUser && u.home && u.osUser === osUserName(u.id) && u.home === `/home/${u.osUser}` ? u : undefined;
}

/**
 * state.json came out of the archive: every path in it is recomputed here, never
 * believed. A workspace folder is where createWorkspace would put it (under the
 * state directory, or the member's own /home/<osUser>/works), and a brain folder
 * only counts when it sits below one of those.
 */
function sanitizeState(state: StateLike, usersFile: string): void {
  let users: { id: string; uid?: number; gid?: number; home?: string; osUser?: string }[] = [];
  try {
    users = JSON.parse(readFileSync(usersFile, "utf8")).users ?? [];
  } catch {}
  const roots = [resolve(WORKS_DIR), ...users.map((u) => realIsolatedUser(u)).filter(Boolean).map((u) => join(u!.home!, "works"))];
  for (const ws of allRecords(state)) {
    if (typeof ws?.id !== "string" || !ID_RE.test(ws.id)) throw new Error(`refusing the archive, nothing was changed: a workspace has a bad id`);
    if (ws.serverShell) continue;
    if (ws.dir !== undefined) {
      const u = ws.ownerId ? realIsolatedUser(users.find((x) => x.id === ws.ownerId)) : undefined;
      ws.dir = u ? join(u.home!, "works", ws.id) : join(WORKS_DIR, ws.id);
    }
    if (ws.brainDir !== undefined) {
      const b = resolve(String(ws.brainDir));
      if (!roots.some((r) => strictlyInside(b, r))) delete ws.brainDir;
    }
  }
}

/** Owner or agent access, the way createWorkspace leaves it. Only root can do this, so a non-root restore says so. */
async function fixOwnership(ws: Workspace, m: WsMeta): Promise<void> {
  const D = wsDir(ws);
  const owner = realIsolatedUser(ws.ownerId ? readUsers().find((u) => u.id === ws.ownerId) : undefined);
  if (owner) {
    await must(run("chown", ["-R", "-h", "--", owner.osUser!, D]), "chown");
    await must(run("chmod", ["700", "--", D]), "chmod");
    return;
  }
  if (ws.asAgent) {
    const agent = agentIdentity();
    if (!agent) return;
    if (m.repoKind === "path" || m.repoKind === "project") await grantAgentAccess(agent.name, join(D, "repo"), D);
    await must(run("chown", ["-R", "-h", "--", agent.name, D]), "chown");
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Restore an archive over the state directory. Everything is checked first, so a
 * refused archive changes nothing. Replaced files and folders are moved aside
 * with a `.before-restore-<time>` suffix; an existing workspace folder is kept
 * (and reported) unless `projects` is set.
 */
export async function restoreFrom(archive: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const file = resolve(archive);
  if (!existsSync(file)) throw new Error(`no such archive: ${archive}`);
  const top = await checkTopLevel(file);
  if (top.problems.length) throw new Error(`refusing the archive, nothing was changed: ${top.problems.join("; ")}`);
  const projects = !!opts.projects;
  // A dry run stays out of the state directory: its scratch lives in tmp.
  await mkdir(WORKS_DIR, { recursive: true });
  const scratch = await mkdtemp(join(opts.dryRun ? tmpdir() : WORKS_DIR, ".restore-"));
  const now = stamp();
  const restored: string[] = [];
  const movedAside: string[] = [];
  const kept: string[] = [];
  const problems: string[] = [];
  try {
    await tarRun(["-xzf", file, "-C", scratch, ...SAFE_X], "extract");
    const s = await checkStaged(scratch);
    if (s.problems.length) throw new Error(`refusing the archive, nothing was changed: ${s.problems.join("; ")}`);
    const state = s.state ?? { workspaces: [] };
    sanitizeState(state, join(scratch, "users.json"));
    const metaWs = new Map((s.meta?.workspaces ?? []).map((w) => [w.id, w]));
    const stateFiles = [...STATE_NAMES, "accounts/accounts.json"].filter((n) => existsSync(join(scratch, n)));

    const jobs: { ws: Workspace; m: WsMeta; D: string; replaces: boolean }[] = [];
    for (const ws of allRecords(state)) {
      if (ws.serverShell || ws.id === SERVER_SHELL_ID) continue;
      const m = metaWs.get(ws.id);
      if (!m) continue;
      const D = wsDir(ws);
      const replaces = existsSync(D);
      if (replaces && !projects) {
        kept.push(ws.id);
        continue;
      }
      jobs.push({ ws, m, D, replaces });
    }

    if (opts.dryRun) {
      for (const n of stateFiles) if (existsSync(join(WORKS_DIR, n))) movedAside.push(`${n}.before-restore-${now}`);
      for (const j of jobs) if (j.replaces) movedAside.push(`${basename(j.D)}.before-restore-${now}`);
      restored.push(...stateFiles, ...jobs.map((j) => `ws/${j.ws.id}`));
      return { restored, movedAside, kept, problems };
    }

    for (const n of stateFiles) {
      const dst = join(WORKS_DIR, n);
      await mkdir(dirname(dst), { recursive: true, mode: 0o700 });
      if (existsSync(dst)) {
        await rename(dst, `${dst}.before-restore-${now}`);
        movedAside.push(`${n}.before-restore-${now}`);
      }
      await copyFile(join(scratch, n), dst);
      await chmod(dst, 0o600);
      restored.push(n);
    }

    // A restored repository lives under the workspace now, so its record points there.
    let repoMoved = false;
    for (const j of jobs) {
      if ((j.m.repoKind === "path" || j.m.repoKind === "project") && (j.m.repo === "bundle" || j.m.repo === "empty")) {
        j.ws.repo = join(j.D, "repo");
        repoMoved = true;
      }
    }
    // state.json is always written from the checked copy, so a path the archive made up never reaches the live state.
    if (stateFiles.includes("state.json") || repoMoved) await writeFile(join(WORKS_DIR, "state.json"), JSON.stringify(state, null, 2), { mode: 0o600 });

    for (const j of jobs) {
      try {
        if (j.replaces) {
          await rename(j.D, `${j.D}.before-restore-${now}`);
          movedAside.push(`${basename(j.D)}.before-restore-${now}`);
        }
        await mkdir(j.D, { recursive: true, mode: 0o700 });
        await restoreWorkspace(j.ws, j.m, join(scratch, "ws", j.ws.id));
        await fixOwnership(j.ws, j.m);
        restored.push(`ws/${j.ws.id}`);
      } catch (e) {
        problems.push(`${j.ws.id}: ${(e as Error).message}`);
      }
    }
    await audit("cli", "restore", undefined, `${archive} (replaced ${movedAside.length}, restored ${restored.length})`);
    return { restored, movedAside, kept, problems };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// --- the daily job and the backups folder -----------------------------------

export const backupsDir = () => join(WORKS_DIR, "backups");
export const dailyOn = () => process.env.KOHLAB_BACKUP_DAILY !== "0";
/** How many archives to keep: at least 2, 7 by default. */
export const keepCount = () => {
  const n = Number(process.env.KOHLAB_BACKUP_KEEP ?? 7);
  return Number.isFinite(n) ? Math.max(2, Math.floor(n)) : 7;
};

let running = false;
export const isBackupRunning = () => running;

/** The archive for a name the client sent, or null. A name is never a path. */
export function backupFilePath(name: string): string | null {
  return BACKUP_NAME.test(name) ? join(backupsDir(), name) : null;
}

export async function listBackups(): Promise<{ name: string; at: number; bytes: number }[]> {
  let names: string[] = [];
  try {
    names = await readdir(backupsDir());
  } catch {
    return [];
  }
  const items: { name: string; at: number; bytes: number }[] = [];
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;
    const st = await stat(join(backupsDir(), name)).catch(() => null);
    if (st?.isFile()) items.push({ name, at: st.mtimeMs, bytes: st.size });
  }
  return items.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

export async function readLast(): Promise<LastRun | null> {
  try {
    return JSON.parse(await readFile(join(backupsDir(), "last.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeLast(last: LastRun): Promise<void> {
  const p = join(backupsDir(), "last.json");
  await writeFile(`${p}.tmp`, JSON.stringify(last, null, 2), { mode: 0o600 });
  await rename(`${p}.tmp`, p);
}

export async function backupStatus() {
  return { last: await readLast(), keep: keepCount(), daily: dailyOn(), items: await listBackups(), running };
}

/** Free bytes for an unprivileged user on the disk holding `dir`. Unknown reads as plenty: the job then tries. */
async function freeBytesDefault(dir: string): Promise<number> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity;
  }
}

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/**
 * One backup, verified, recorded in last.json, older ones pruned. It never
 * throws: a failure is recorded. Sets `running` before its first await.
 */
export async function runBackup(opts: { actor: string; reason: "auto" | "manual"; freeBytes?: (dir: string) => Promise<number> }): Promise<LastRun> {
  running = true;
  const at = Date.now();
  const action = opts.reason === "auto" ? "backup.auto" : "backup.run";
  let last: LastRun;
  try {
    const dir = backupsDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const prev = (await listBackups())[0];
    const free = await (opts.freeBytes ?? freeBytesDefault)(dir);
    if (prev && free < 3 * prev.bytes) {
      last = {
        at,
        name: null,
        bytes: 0,
        ok: false,
        verified: false,
        counts: zero(),
        error: `skipped: ${mb(free)} free, the backup needs 3x the last one (${mb(3 * prev.bytes)})`,
      };
    } else {
      // The name is to the second: a second run in the same second takes the next free second, never overwrites.
      let when = at;
      const nameFor = (t: number) => `kohlab-${new Date(t).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}.tar.gz`;
      while (existsSync(join(dir, nameFor(when)))) when += 1000;
      const name = nameFor(when);
      const file = join(dir, name);
      const made = await writeArchive(file, { projects: true, logins: false, key: false });
      const v = await verifyArchive(file);
      if (v.ok) {
        last = { at, name, bytes: made.bytes, ok: true, verified: true, counts: made.counts };
        for (const old of (await listBackups()).slice(keepCount())) await rm(join(dir, old.name), { force: true });
      } else {
        await rm(file, { force: true });
        last = { at, name: null, bytes: 0, ok: false, verified: false, counts: v.counts, error: `verify failed: ${v.problems[0] ?? "unknown"}` };
      }
    }
    await writeLast(last);
    await audit(opts.actor, action, undefined, last.name ?? last.error ?? "");
    return last;
  } catch (e) {
    last = { at, name: null, bytes: 0, ok: false, verified: false, counts: zero(), error: (e as Error).message };
    await writeLast(last).catch(() => {});
    await audit(opts.actor, action, undefined, last.error ?? "");
    return last;
  } finally {
    running = false;
  }
}

/** The daily job: a backup when the last one is a day old (six hours after a failure). Does nothing otherwise. */
export async function runIfDue(opts: { freeBytes?: (dir: string) => Promise<number> } = {}): Promise<{ ran: boolean; reason: string; last?: LastRun }> {
  if (running) return { ran: false, reason: "a backup is already running" };
  if (!dailyOn()) return { ran: false, reason: "daily backups are off (KOHLAB_BACKUP_DAILY=0)" };
  const last = await readLast();
  const gap = last && !last.ok ? 6 * HOUR_MS : DAY_MS;
  if (last && Date.now() - last.at < gap) return { ran: false, reason: "the last backup is recent" };
  const out = await runBackup({ actor: "system", reason: "auto", freeBytes: opts.freeBytes });
  return { ran: true, reason: "daily", last: out };
}

/** Start the daily job: first look two minutes after start, then hourly. Never blocks, never throws. */
export function startDailyBackups(): void {
  if (!dailyOn()) return;
  const tick = () => {
    runIfDue().catch((e) => console.warn(`[backup] ${(e as Error).message}`));
  };
  setTimeout(tick, 2 * 60_000).unref?.();
  setInterval(tick, HOUR_MS).unref?.();
}

/** Delete one archive by name. False when there is no such archive. */
export async function deleteBackup(name: string): Promise<boolean> {
  const file = backupFilePath(name);
  if (!file || !existsSync(file)) return false;
  await rm(file, { force: true });
  return true;
}
