#!/usr/bin/env bun
/**
 * The chat's standing notes, the "Worked for" line, and the project download.
 *
 * Pure parts first: how the notes reach Claude's system prompt and an ACP
 * agent's first message, and the worked-time line. Then a throwaway server, on
 * its own port, socket and data dir: the download route (401 without a key, a
 * zip of the last kept version), the notes route, and the note a Keep or an
 * Undo leaves in a chat.
 *
 * Run:  bun scripts/check-chat-notes.mjs
 */
import { spawn, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { notesMessagePrefix, notesOf, systemPromptFor } from "../chat.ts";
import { killDaemonOn } from "./kill-daemon.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7823;
const KEY = "chat-notes-check-key";
let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

// ── notes: what a chat is given ──────────────────────────────────────────────
check("notes are trimmed", notesOf({ chat: true, notes: "  be kind \n" }), "be kind");
check("a terminal project gets no notes", notesOf({ chat: false, notes: "be kind" }), "");
check("a chat with no notes gets none", notesOf({ chat: true }), "");

const plain = systemPromptFor("");
check("no notes: the chat's prompt has no notes line", plain.includes("standing notes"), false);
check("the prompt says to point at Preview, not at files", plain.includes("Never tell the person to open a file in their browser; tell them to press Preview."), true);
check("the prompt ends the reply with what to look at in Preview", plain.includes("When you finish, end with one short sentence saying what to look at in Preview."), true);
check(
  "notes are appended to the system prompt",
  systemPromptFor("Use blue headings."),
  `${plain} The person's standing notes for this project (always follow them): Use blue headings.`,
);
check("an ACP agent's first message carries the notes", notesMessagePrefix("Use blue."), "Project notes from the person (always follow them):\nUse blue.\n\n");
check("no notes, no ACP prefix", notesMessagePrefix(""), "");

// ── the worked-time line ─────────────────────────────────────────────────────
// ChatView.tsx cannot be imported here (it needs a browser), so its two pure
// functions are cut out of the source and transpiled. They are self-contained.
const view = readFileSync(join(ROOT, "web/src/components/ChatView.tsx"), "utf8");
function grab(name) {
  const start = view.indexOf(`export function ${name}(`);
  const end = view.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`${name} is not in ChatView.tsx`);
  return view.slice(start, end + 3).replace("export function", "function");
}
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`${grab("formatElapsed")}\n${grab("workedLine")}\nexport { formatElapsed, workedLine };`);
const formatterDir = mkdtempSync(join(tmpdir(), "kohlab-formatter-"));
writeFileSync(join(formatterDir, "worked.mjs"), js);
const { formatElapsed, workedLine } = await import(pathToFileURL(join(formatterDir, "worked.mjs")).href);
rmSync(formatterDir, { recursive: true, force: true });

check("a turn of 72 s", workedLine({ worked: 72000 }), "Worked for 1m 12s");
check("with the plan share", workedLine({ worked: 72000, planDelta: 3 }), "Worked for 1m 12s · 3% of your plan");
check("0% of the plan: not shown", workedLine({ worked: 72000, planDelta: 0.3 }), "Worked for 1m 12s");
check("5 s or less: no line", workedLine({ worked: 5000 }), null);
check("just over 5 s", workedLine({ worked: 5001 }), "Worked for 5s");
check("no time, no line", workedLine({}), null);
check("under a minute", formatElapsed(59999), "59s");
check("a whole minute", formatElapsed(60000), "1m 00s");

// ── the throwaway server: download, notes, and the Keep / Undo notes ────────
const dir = mkdtempSync(join(tmpdir(), "kohlab-notes-"));
const repo = join(dir, "repo");
const SOCKET = join(tmpdir(), `kohlab-notes-${process.pid}.sock`);
const base = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${KEY}` };
const jsonAuth = { ...auth, "content-type": "application/json" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function gitSync(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

mkdirSync(repo, { recursive: true });
gitSync(repo, ["-c", "init.defaultBranch=main", "init", "--quiet"]);
writeFileSync(join(repo, "index.html"), "<h1>hello</h1>\n");
gitSync(repo, ["add", "-A"]);
gitSync(repo, ["-c", "user.email=t@kohlab.local", "-c", "user.name=test", "commit", "--quiet", "-m", "initial"]);

const server = spawn("bun", ["run", "server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: dir, PTY_SOCKET: SOCKET },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (b) => (serverLog += b));
server.stderr.on("data", (b) => (serverLog += b));

const api = async (path, opts = {}) => {
  const res = await fetch(`${base}${path}`, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    up = await fetch(`${base}/api/auth/required`).then((r) => r.ok).catch(() => false);
    if (!up) await wait(250);
  }
  if (!up) throw new Error(`the throwaway server never came up: ${serverLog.trim().slice(-400)}`);

  await api("/api/agents", { method: "POST", headers: jsonAuth, body: JSON.stringify({ name: "sh", cmd: "sh" }) });
  // A chat with no first message: nothing is sent to an agent, so no process starts.
  const made = await api("/api/workspaces", { method: "POST", headers: jsonAuth, body: JSON.stringify({ repo, agent: "sh", chat: true }) });
  const id = made.body?.id;
  check("a chat project can be created", typeof id, "string");
  if (typeof id !== "string") throw new Error("no workspace id, cannot continue");

  const porcelain = gitSync(repo, ["worktree", "list", "--porcelain"]);
  const block = porcelain.split("\n\n").find((b) => b.includes(`kohlab/${id}`)) ?? "";
  const tree = block.split("\n").find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
  check("its worktree exists", typeof tree === "string", true);
  if (!tree) throw new Error("no worktree, cannot continue");

  // download: a zip of the last kept version, behind the read permission
  check("download without a key -> 401", (await fetch(`${base}/api/workspaces/${id}/download`)).status, 401);

  await api(`/api/workspaces/${id}/rename`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ title: "My Notes Site" }) });
  writeFileSync(join(tree, "draft.txt"), "not kept yet\n");
  const dl = await fetch(`${base}/api/workspaces/${id}/download`, { headers: auth });
  const zip = Buffer.from(await dl.arrayBuffer());
  check("download with a key -> 200", dl.status, 200);
  check("the zip has the zip magic bytes PK\\x03\\x04", zip.subarray(0, 4).toString("latin1"), "PK\x03\x04");
  check("content-type is application/zip", dl.headers.get("content-type"), "application/zip");
  check("filename is the project title's slug", dl.headers.get("content-disposition"), 'attachment; filename="my-notes-site.zip"');
  check("the zip holds the kept files", zip.includes("index.html"), true);
  check("uncommitted changes are left out", zip.includes("draft.txt"), false);

  // Keep leaves a note in the chat
  const kept = await api(`/api/workspaces/${id}/commit`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ message: "first" }) });
  check("keep (commit) is ok", kept.status, 200);
  const notesIn = async () => ((await api(`/api/workspaces/${id}/chat`, { headers: auth })).body?.events ?? []).filter((e) => e.kind === "note").map((e) => e.text);
  check("Keep leaves 'Kept this version' in the chat", (await notesIn()).includes("Kept this version"), true);

  // Undo all leaves its note too
  writeFileSync(join(tree, "second.txt"), "discard me\n");
  const undone = await api(`/api/workspaces/${id}/discard`, { method: "POST", headers: jsonAuth });
  check("undo (discard) is ok", undone.status, 200);
  check("Undo all leaves its note", (await notesIn()).includes("Undid the changes since the last keep"), true);

  // notes: the standing instructions
  const set = (notes) => api(`/api/workspaces/${id}/notes`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ notes }) });
  check("notes without a key -> 401", (await fetch(`${base}/api/workspaces/${id}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  check("notes that are not text -> 400", (await set(42)).status, 400);
  check("notes over 4000 characters -> 400", (await set("x".repeat(4001))).status, 400);
  check("notes are saved", (await set("  Keep it short  ")).body, { ok: true });
  const listed = async () => (await api("/api/workspaces", { headers: auth })).body.find((w) => w.id === id);
  check("the listing carries the trimmed notes", (await listed())?.notes, "Keep it short");
  await set("");
  check("empty notes clear them", (await listed())?.notes, undefined);
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.message}`);
} finally {
  server.kill("SIGKILL");
  killDaemonOn(SOCKET);
  rmSync(SOCKET, { force: true });
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all chat notes, worked-time and download checks passed");
