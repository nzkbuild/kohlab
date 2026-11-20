#!/usr/bin/env node
/**
 * Recently deleted (v2.13): a project moves to the trash for KOHLAB_TRASH_DAYS days, keeping every file, and comes back
 * with restore. "forever" and the purge delete it for good.
 *
 * Throwaway server (own PORT, WORKS_DIR, PTY_SOCKET) with an owner, a member and a viewer (written straight into
 * users.json, no OS account). Sh projects only, no AI. Checks:
 *  - trash stops the project and keeps its worktree, brain note, chat file and images byte-identical; it leaves GET /api/workspaces
 *  - its preview and share links stop working while trashed and work again after restore; restore comes back stopped
 *  - a new project with the trashed one's name gets a different id; double trash, restore and purge are refused, not crashes
 *  - ownership: a member sees and restores only their own; the owner sees all; a viewer cannot mutate; a share link is refused
 *  - ids with ../, the server terminal and a hidden team member take the paths they should
 *  - "forever" and the purge remove the record, the chat file, the project folder and the project's files
 *  - the CLI: rm moves to the trash, trash lists it, restore-project brings it back, rm --forever deletes it
 *  - the auto purge, with an injected clock: KOHLAB_TRASH_DAYS=0 keeps everything, the cap is 20 a run, a fresh one stays
 *  - a state.json written before Recently deleted loads (GET /api/trash answers empty)
 *
 * Run:  node scripts/check-trash.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killDaemonOn } from "./kill-daemon.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7965;
const KEY = "trash-owner-key";
const MEMBER_KEY = "trash-member-key";
const VIEWER_KEY = "trash-viewer-key";
const base = `http://127.0.0.1:${PORT}`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const fileSha = (f) => (existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : "missing");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `  ${String(detail).slice(0, 300)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "kohlab-trash-"));
const works = join(tmp, "works");
const socket = join(tmp, "pty.sock");
mkdirSync(works, { recursive: true });
writeFileSync(
  join(works, "users.json"),
  JSON.stringify({
    users: [
      { id: "trash-member", name: "Trash member", role: "member", key: sha256(MEMBER_KEY) },
      { id: "trash-viewer", name: "Trash viewer", role: "viewer", key: sha256(VIEWER_KEY) },
    ],
  }),
);
// An old state file: no `trashed` key at all. It must load, and answer the trash list empty.
writeFileSync(join(works, "state.json"), JSON.stringify({ schemaVersion: 1, workspaces: [], agents: { sh: "sh" } }));

// A server already on this port would answer every request with its own state: refuse to run beside it.
if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) {
  console.log(`FAIL  port ${PORT} is already in use; stop the other server first`);
  process.exit(1);
}
const env = { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: socket };
const proc = spawn("bun", ["run", "server.ts"], { cwd: ROOT, env, stdio: "ignore" });

const api = async (method, path, { key, query = "", body } = {}) => {
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}${path}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const readState = () => JSON.parse(readFileSync(join(works, "state.json"), "utf8"));
/** The owner, member or viewer can see the project list; the owner's view is used for the record checks. */
const listIds = async (key = KEY) => ((await api("GET", "/api/workspaces", { key })).body ?? []).map((w) => w.id);
const trashIds = async (key = KEY) => ((await api("GET", "/api/trash", { key })).body?.items ?? []).map((i) => i.id);

/** Every file the trash must keep, as a hash ("missing" when it is gone). */
const snapshot = (id) => ({
  tree: fileSha(join(works, id, "tree", "draft.md")),
  brain: fileSha(join(works, id, "brain", "Goal.md")),
  chat: fileSha(join(works, "chats", `${id}.jsonl`)),
  image: fileSha(join(works, id, "images", "pic.png")),
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b) && !Object.values(a).includes("missing");

// ptyDisconnect: the PTY socket the purge touches would keep this child alive forever (the CLI closes it the same way).
const CHILD_PURGE = `const l = await import(process.env.LIB_PATH); console.log(await l.purgeExpiredTrash(Number(process.env.NOW_MS))); l.ptyDisconnect();`;

try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }

  // ── the old state loads ──────────────────────────────────────────────────
  const empty = await api("GET", "/api/trash", { key: KEY });
  check("a state.json without `trashed` loads: GET /api/trash is 200, empty, 30 days", empty.status === 200 && empty.body?.items?.length === 0 && empty.body?.days === 30, JSON.stringify(empty));

  // ── a project with files, started, shared and previewed ─────────────────
  const made = await api("POST", "/api/workspaces", { key: KEY, body: { newProject: "trashcheck", task: "trashcheck", agent: "sh" } });
  check("the owner creates a sh project", made.status === 200 && made.body?.id === "trashcheck", JSON.stringify(made.body));
  const A = "trashcheck";
  writeFileSync(join(works, A, "tree", "draft.md"), "uncommitted, must survive\n");
  mkdirSync(join(works, A, "brain"), { recursive: true });
  writeFileSync(join(works, A, "brain", "Goal.md"), "# Goal\nkeep it\n");
  mkdirSync(join(works, A, "images"), { recursive: true });
  writeFileSync(join(works, A, "images", "pic.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  mkdirSync(join(works, "chats"), { recursive: true });
  writeFileSync(join(works, "chats", `${A}.jsonl`), `${JSON.stringify({ role: "user", text: "hi" })}\n`);
  const before = snapshot(A);
  check("the files exist before the trash", Object.values(before).every((h) => h !== "missing"), JSON.stringify(before));

  const started = await api("POST", `/api/workspaces/${A}/start`, { key: KEY });
  check("the project starts", started.status === 200, JSON.stringify(started.body).slice(0, 200));
  const prev = await api("POST", `/api/workspaces/${A}/preview`, { key: KEY });
  const previewPath = prev.body?.url;
  const share = await api("POST", `/api/workspaces/${A}/share`, { key: KEY });
  const token = share.body?.share;
  check("it has a preview and a share link", typeof previewPath === "string" && typeof token === "string", `${prev.status} ${share.status}`);

  // ── trash ────────────────────────────────────────────────────────────────
  const trashed = await api("DELETE", `/api/workspaces/${A}`, { key: KEY });
  check("DELETE /api/workspaces/:id moves it to Recently deleted (200, the item)", trashed.status === 200 && trashed.body?.ok === true && trashed.body?.item?.id === A, JSON.stringify(trashed.body).slice(0, 200));
  check("it leaves GET /api/workspaces", !(await listIds()).includes(A));
  check("its files are byte-identical", same(snapshot(A), before), JSON.stringify(snapshot(A)));
  check("its project folder is still on disk", existsSync(join(works, "projects", A)));
  const list = await api("GET", "/api/trash", { key: KEY });
  const item = list.body?.items?.find((i) => i.id === A);
  check("the list shows it with a purge date 30 days out", !!item && item.kind === "project" && typeof item.purgeAt === "number" && item.purgeAt - item.trashedAt === 30 * 86_400_000 && typeof item.trashedBy === "string" && item.trashedBy.length > 0, JSON.stringify(item));
  const deadPage = await fetch(`${base}${previewPath}`);
  check("a preview link is dead while trashed (404, not a valid link)", deadPage.status === 404 && /not valid/.test(await deadPage.text()));
  check("a share link finds nothing while trashed", ((await api("GET", "/api/workspaces", { query: `?share=${token}` })).body ?? []).length === 0);
  const again = await api("DELETE", `/api/workspaces/${A}`, { key: KEY });
  check("a second trash of the same project is 404, not a crash", again.status === 404, String(again.status));

  // ── the trashed name is taken: a new project from the same folder gets another id ──
  const dup = await api("POST", "/api/workspaces", { key: KEY, body: { repo: join(works, "projects", A), task: A, agent: "sh" } });
  check("a project from the trashed one's folder gets a different id", dup.status === 200 && dup.body?.id === `${A}-2`, JSON.stringify(dup.body).slice(0, 200));
  const B = dup.body?.id;

  // ── restore ──────────────────────────────────────────────────────────────
  const back = await api("POST", `/api/trash/${A}/restore`, { key: KEY });
  check("restore brings it back, stopped", back.status === 200 && back.body?.id === A && back.body?.running !== true, JSON.stringify(back.body).slice(0, 200));
  const live = (await api("GET", "/api/workspaces", { key: KEY })).body?.find((w) => w.id === A);
  check("it is in the list again, not running (its session did close)", !!live && live.running === false, JSON.stringify(live?.running));
  check("the chat, brain and images are as they were", same(snapshot(A), before));
  check("its share link works again", ((await api("GET", "/api/workspaces", { query: `?share=${token}` })).body ?? []).some((w) => w.id === A));
  const livePage = await fetch(`${base}${previewPath}`);
  check("its preview link is recognised again (the page says nothing to preview, not 'not valid')", !/not valid/.test(await livePage.text()));
  const twice = await api("POST", `/api/trash/${A}/restore`, { key: KEY });
  check("restore twice is 404 (no longer in Recently deleted), not a crash", twice.status === 404, String(twice.status));

  // ── ownership: a member's project, the owner's project, a viewer, a share link ──
  const C = (await api("POST", "/api/workspaces", { key: KEY, body: { newProject: "member-proj", task: "member-proj", agent: "sh" } })).body?.id;
  const st = readState();
  st.workspaces.find((w) => w.id === C).ownerId = "trash-member";
  writeFileSync(join(works, "state.json"), JSON.stringify(st, null, 2));
  check("a member cannot delete the owner's project (403)", (await api("DELETE", `/api/workspaces/${A}`, { key: MEMBER_KEY })).status === 403);
  check("a viewer cannot delete a project (403)", (await api("DELETE", `/api/workspaces/${A}`, { key: VIEWER_KEY })).status === 403);
  check("a share link cannot delete a project (403)", (await api("DELETE", `/api/workspaces/${A}`, { query: `?share=${token}` })).status === 403);
  check("a share link cannot see Recently deleted (403)", (await api("GET", "/api/trash", { query: `?share=${token}` })).status === 403);
  check("no credentials cannot delete (401)", (await api("DELETE", `/api/workspaces/${A}`)).status === 401);
  check("an unknown id is 404, and ../ in an id is 404", (await api("DELETE", "/api/workspaces/nope", { key: KEY })).status === 404 && (await api("DELETE", "/api/workspaces/..%2Fx", { key: KEY })).status === 404);
  check("the server terminal cannot be deleted (403)", (await api("DELETE", "/api/workspaces/server-shell", { key: KEY })).status === 403);
  const member = await api("DELETE", `/api/workspaces/${C}`, { key: MEMBER_KEY });
  check("a member trashes their own project (200)", member.status === 200, JSON.stringify(member.body).slice(0, 200));
  check("a member sees only their own trash", JSON.stringify(await trashIds(MEMBER_KEY)) === JSON.stringify([C]), JSON.stringify(await trashIds(MEMBER_KEY)));
  check("a viewer sees an empty trash", (await trashIds(VIEWER_KEY)).length === 0);
  check("the owner sees all of it", (await trashIds(KEY)).includes(C));
  check("a viewer cannot restore (403)", (await api("POST", `/api/trash/${C}/restore`, { key: VIEWER_KEY })).status === 403);
  check("a member cannot restore the owner's trashed project (403)", (await api("DELETE", `/api/workspaces/${B}`, { key: KEY })).status === 200 && (await api("POST", `/api/trash/${B}/restore`, { key: MEMBER_KEY })).status === 403);
  check("the owner restores it (200)", (await api("POST", `/api/trash/${B}/restore`, { key: KEY })).status === 200);
  check("a member restores their own (200)", (await api("POST", `/api/trash/${C}/restore`, { key: MEMBER_KEY })).status === 200);

  // ── a hidden team member keeps the hard path ─────────────────────────────
  const st2 = readState();
  st2.workspaces.push({ id: "trash-team-m", repo: "", task: "member", agent: "sh", created: 1, started: null, stopped: null, ownerId: "", team: { id: "t1", role: "builder" } });
  writeFileSync(join(works, "state.json"), JSON.stringify(st2, null, 2));
  const hidden = await api("DELETE", "/api/workspaces/trash-team-m", { key: KEY });
  check("a team member is deleted for good, not trashed", hidden.status === 200 && !(readState().trashed ?? []).some((w) => w.id === "trash-team-m") && !readState().workspaces.some((w) => w.id === "trash-team-m"));

  // ── forever, and the purge ───────────────────────────────────────────────
  const forever = await api("DELETE", `/api/workspaces/${B}?forever=1`, { key: KEY });
  check("?forever=1 deletes it for good", forever.status === 200 && !readState().workspaces.some((w) => w.id === B) && !existsSync(join(works, B)), forever.status);
  check("the project folder stays while another project still uses it", existsSync(join(works, "projects", A)));
  await api("DELETE", `/api/workspaces/${A}`, { key: KEY });
  const purged = await api("DELETE", `/api/trash/${A}`, { key: KEY });
  check("DELETE /api/trash/:id purges it (200)", purged.status === 200, JSON.stringify(purged.body));
  check("the purge removes the worktree, brain, images, chat file and project folder",
    !existsSync(join(works, A)) && !existsSync(join(works, "chats", `${A}.jsonl`)) && !existsSync(join(works, "projects", A)));
  check("a second purge is 404, and the record is gone", (await api("DELETE", `/api/trash/${A}`, { key: KEY })).status === 404 && !(readState().trashed ?? []).some((w) => w.id === A));
  const reuse = await api("POST", "/api/workspaces", { key: KEY, body: { newProject: "trashcheck", task: "trashcheck", agent: "sh" } });
  check("after the purge the name is free again", reuse.status === 200 && reuse.body?.id === "trashcheck", JSON.stringify(reuse.body).slice(0, 200));

  // ── the CLI: rm, trash, restore-project, rm --forever ────────────────────
  const cli = (args) => spawnSync("bun", ["cli.ts", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
  const rm = cli(["rm", "trashcheck"]);
  check("kohlab rm moves the project to Recently deleted", rm.status === 0 && /moved to Recently deleted/.test(rm.stdout), rm.stdout + rm.stderr);
  const tr = cli(["trash"]);
  check("kohlab trash lists it", tr.status === 0 && /trashcheck/.test(tr.stdout), tr.stdout + tr.stderr);
  const rp = cli(["restore-project", "trashcheck"]);
  check("kohlab restore-project brings it back, stopped", rp.status === 0 && /restored trashcheck, stopped/.test(rp.stdout), rp.stdout + rp.stderr);
  const rmf = cli(["rm", "trashcheck", "--forever"]);
  check("kohlab rm --forever deletes it for good", rmf.status === 0 && /deleted trashcheck for good/.test(rmf.stdout) && !existsSync(join(works, "trashcheck")), rmf.stdout + rmf.stderr);

  // ── the auto purge, with an injected clock ───────────────────────────────
  const libPath = join(ROOT, "lib.ts");
  const pw = join(tmp, "purge");
  mkdirSync(pw, { recursive: true });
  const T0 = 1700000000000;
  const DAY = 86_400_000;
  const old = Array.from({ length: 22 }, (_, i) => ({ id: `old-${i}`, repo: "", dir: join(pw, `old-${i}`), task: `old ${i}`, agent: "sh", created: 1, started: null, stopped: null, ownerId: "", trashedAt: T0, trashedBy: "owner" }));
  const fresh = { id: "fresh", repo: "", dir: join(pw, "fresh"), task: "fresh", agent: "sh", created: 1, started: null, stopped: null, ownerId: "", trashedAt: T0 + 29 * DAY, trashedBy: "owner" };
  writeFileSync(join(pw, "state.json"), JSON.stringify({ schemaVersion: 1, workspaces: [], trashed: [...old, fresh], agents: { sh: "sh" } }));
  const child = (days, nowMs) =>
    spawnSync("bun", ["-e", CHILD_PURGE], {
      cwd: ROOT,
      env: { ...process.env, WORKS_DIR: pw, HOST: "127.0.0.1", KOHLAB_KEY: "trash-purge-key", PTY_SOCKET: socket, LIB_PATH: libPath, NOW_MS: String(nowMs), KOHLAB_TRASH_DAYS: days },
      encoding: "utf8",
      timeout: 120_000,
    });
  const now31 = T0 + 31 * DAY;
  const keep = child("0", now31);
  check("KOHLAB_TRASH_DAYS=0 keeps everything", keep.status === 0 && keep.stdout.trim() === "0", keep.stdout + keep.stderr);
  const run1 = child("", now31);
  check("the first run purges 20 (the cap), not all 22", run1.status === 0 && run1.stdout.trim() === "20", run1.stdout + run1.stderr);
  const run2 = child("", now31);
  check("the second run purges the other 2", run2.status === 0 && run2.stdout.trim() === "2", run2.stdout + run2.stderr);
  const run3 = child("", now31);
  check("a third run has nothing left to purge", run3.status === 0 && run3.stdout.trim() === "0", run3.stdout + run3.stderr);
  const left = JSON.parse(readFileSync(join(pw, "state.json"), "utf8")).trashed.map((w) => w.id);
  check("the fresh one (29 days old) is still there", JSON.stringify(left) === JSON.stringify(["fresh"]), JSON.stringify(left));
} finally {
  proc.kill("SIGKILL");
  await sleep(300);
  killDaemonOn(socket);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall trash checks passed");
process.exit(failures ? 1 : 0);
