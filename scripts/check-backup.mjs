// Backup drill: every step runs against throwaway WORKS_DIRs and a throwaway server. No AI, no live state.
//
// The drill: three workspaces (a path-repo project with commits and uncommitted work, a project repo with
// an uncommitted file, a chat project with a brain note and a chat log) -> backup -> verify -> a corrupted
// bundle and a truncated copy must fail verify -> restore into a SECOND empty WORKS_DIR -> files, commits,
// brain and chat identical. Then hostile archives, secrets, exclusions, the daily job and the routes.
import { spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync, copyFileSync, truncateSync, lstatSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";
import { makeCheck, startKit } from "./ai-check-kit.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const { check, finish } = makeCheck();
const base = mkdtempSync(join(tmpdir(), "kohlab-backup-check-"));
const works = join(base, "works");
const works2 = join(base, "works2");
const works3 = join(base, "works3");
const archive = join(base, "drill.tar.gz");
const CANARY = `CANARY-${randomBytes(8).toString("hex")}`;
const gitEnv = { GIT_AUTHOR_NAME: "check", GIT_AUTHOR_EMAIL: "check@kohlab.local", GIT_COMMITTER_NAME: "check", GIT_COMMITTER_EMAIL: "check@kohlab.local" };

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
const gitOut = (cwd, args) => git(cwd, args).stdout.trim();
const cli = (dir, args) => {
  // KOHLAB_KEY set: without it the CLI writes a generated key into WORKS_DIR at startup, which would look like a restore side effect.
  const r = spawnSync("bun", ["run", "cli.ts", ...args], { cwd: ROOT, env: { ...process.env, WORKS_DIR: dir, KOHLAB_KEY: "check-cli-key" }, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const tarList = (file) => spawnSync("tar", ["-tzf", file], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
const job = (dir, code, env = {}) => {
  const r = spawnSync("bun", ["-e", `const b = await import(${JSON.stringify(join(ROOT, "backup.ts"))});\n${code}`], {
    cwd: ROOT,
    env: { ...process.env, WORKS_DIR: dir, ...env },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const pyTar = (out, spec) => spawnSync("python3", ["-I", join(base, "mk-tar.py"), out, JSON.stringify(spec)], { encoding: "utf8" });
function walkFiles(root, skip = () => false) {
  const out = [];
  const go = (rel) => {
    for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (skip(r)) continue;
      if (d.isDirectory()) go(r);
      else out.push(r);
    }
  };
  go("");
  return out;
}

// The archiver for the hostile-archive checks. Written once, outside every WORKS_DIR.
writeFileSync(
  join(base, "mk-tar.py"),
  `import json, sys, tarfile, io
out, spec = sys.argv[1], json.loads(sys.argv[2])
mode = "w:gz" if out.endswith(".gz") else "w"
with tarfile.open(out, mode) as t:
  for m in spec:
    ti = tarfile.TarInfo(m["name"])
    if m.get("type") == "symlink":
      ti.type = tarfile.SYMTYPE; ti.linkname = m["link"]; t.addfile(ti)
    elif m.get("type") == "from":
      data = open(m["path"], "rb").read(); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
    else:
      data = m.get("data", "").encode(); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
`,
);

try {
  // ── 0. the three workspaces ──────────────────────────────────────────────
  mkdirSync(works, { recursive: true });
  // A: a path repo with two commits, uncommitted work, a symlink in and out, a big file, node_modules.
  const srcA = join(base, "src-app");
  mkdirSync(join(srcA, "lib"), { recursive: true });
  git(srcA, ["init", "-q", "-b", "main"]);
  writeFileSync(join(srcA, "README.md"), "# app\n");
  writeFileSync(join(srcA, "lib", "a.txt"), "first\n");
  git(srcA, ["add", "-A"]);
  git(srcA, ["commit", "-q", "-m", "one"]);
  writeFileSync(join(srcA, "lib", "a.txt"), "second\n");
  git(srcA, ["commit", "-q", "-am", "two"]);
  const idA = "app-a";
  mkdirSync(join(works, idA), { recursive: true });
  git(srcA, ["worktree", "add", "-q", "-b", `kohlab/${idA}`, join(works, idA, "tree")]);
  const treeA = join(works, idA, "tree");
  writeFileSync(join(treeA, "lib", "a.txt"), "uncommitted edit\n");
  writeFileSync(join(treeA, "new.txt"), "never committed\n");
  mkdirSync(join(treeA, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(treeA, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
  writeFileSync(join(treeA, "big.bin"), Buffer.alloc(51 * 1024 * 1024, 7));
  symlinkSync("lib/a.txt", join(treeA, "inside.txt"));
  symlinkSync("/etc/hostname", join(treeA, "outside.txt"));

  // B: a project repo under projects/ with only its empty first commit, and an uncommitted file.
  const idB = "proj-b";
  const repoB = join(works, "projects", idB);
  mkdirSync(repoB, { recursive: true });
  git(repoB, ["init", "-q", "-b", "main"]);
  git(repoB, ["commit", "-q", "--allow-empty", "-m", "First version"]);
  mkdirSync(join(works, idB), { recursive: true });
  git(repoB, ["worktree", "add", "-q", "-b", `kohlab/${idB}`, join(works, idB, "tree")]);
  writeFileSync(join(works, idB, "tree", "notes.md"), "drafted, not committed\n");

  // C: a chat project with a brain note and a chat log.
  const idC = "chat-c";
  const repoC = join(works, "projects", idC);
  mkdirSync(repoC, { recursive: true });
  git(repoC, ["init", "-q", "-b", "main"]);
  git(repoC, ["commit", "-q", "--allow-empty", "-m", "First version"]);
  mkdirSync(join(works, idC), { recursive: true });
  git(repoC, ["worktree", "add", "-q", "-b", `kohlab/${idC}`, join(works, idC, "tree")]);
  mkdirSync(join(works, idC, "brain"), { recursive: true });
  writeFileSync(join(works, idC, "brain", "Goal.md"), "# Goal\nship it\n");
  mkdirSync(join(works, "chats"), { recursive: true });
  writeFileSync(join(works, "chats", `${idC}.jsonl`), `${JSON.stringify({ role: "user", text: "hi" })}\n${JSON.stringify({ role: "ai", text: "hello" })}\n`);
  writeFileSync(join(works, "chats", `${idC}.cursor.json`), JSON.stringify({ at: 2 }));

  const ws = (id, repo, extra = {}) => ({ id, repo, task: id, agent: "sh", created: 1, started: null, stopped: null, ownerId: "", ...extra });
  writeFileSync(
    join(works, "state.json"),
    JSON.stringify({ schemaVersion: 1, workspaces: [ws(idA, srcA), ws(idB, repoB), ws(idC, repoC, { chat: true })], agents: { sh: "sh" } }, null, 2),
  );
  // Secrets that must never travel.
  mkdirSync(join(works, "accounts", "acc1"), { recursive: true, mode: 0o700 });
  writeFileSync(join(works, "accounts", "secrets.json"), JSON.stringify({ router: CANARY }));
  writeFileSync(join(works, "accounts", "accounts.json"), JSON.stringify({ accounts: [{ id: "acc1", label: "work" }] }));
  writeFileSync(join(works, "accounts", "acc1", "login.json"), JSON.stringify({ token: CANARY }));
  writeFileSync(join(works, "users.json"), JSON.stringify({ users: [] }));
  writeFileSync(join(works, "key"), "k\n");

  // ── 1. backup ────────────────────────────────────────────────────────────
  const b = cli(works, ["backup", archive]);
  check("backup succeeds", b.status === 0, b.out);
  check("the summary counts 3 projects, 1 chat, 1 brain", /3 projects, 1 chats, 1 brains/.test(b.out), b.out);
  const names = tarList(archive);
  check("the archive has meta, state and each workspace's repo, tree, brain and chat",
    ["meta.json", "state.json", `ws/${idA}/repo.bundle`, `ws/${idA}/tree.tar`, `ws/${idC}/brain.tar`, `ws/${idC}/chats/${idC}.jsonl`].every((n) => names.includes(n)), names.join(" "));
  check("no accounts/ folder and no secrets.json in the default archive", !names.some((n) => n.startsWith("accounts")), names.join(" "));
  check("a planted secret appears nowhere in the archive", !gunzipSync(readFileSync(archive)).includes(CANARY));

  // ── 2. verify ────────────────────────────────────────────────────────────
  const v = cli(works, ["backup", "verify", archive]);
  check("verify passes with a plain summary", v.status === 0 && v.out.includes("3 projects, 1 chats, all verified"), v.out);

  const ext = join(base, "extracted");
  mkdirSync(ext);
  spawnSync("tar", ["-xzf", archive, "-C", ext]);
  const meta = JSON.parse(readFileSync(join(ext, "meta.json"), "utf8"));
  const mA = meta.workspaces.find((w) => w.id === idA);
  check("the big file is skipped and counted", mA.skipped.large === 1, JSON.stringify(mA.skipped));
  check("the link that leaves the tree is skipped and counted", mA.skipped.symlinks === 1, JSON.stringify(mA.skipped));
  const treeList = spawnSync("tar", ["-tf", join(ext, "ws", idA, "tree.tar")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  check("node_modules, .git and the big file are not in tree.tar",
    !treeList.some((n) => /node_modules|\.git|big\.bin/.test(n)) && treeList.includes("lib/a.txt") && treeList.includes("new.txt") && treeList.includes("inside.txt"), treeList.join(" "));

  // A corrupted bundle: flip bytes in the middle of the pack, repack, and verify must name it.
  const bad = join(base, "bad-bundle.tar.gz");
  const badDir = join(base, "bad-dir");
  mkdirSync(badDir);
  spawnSync("tar", ["-xzf", archive, "-C", badDir]);
  const bundle = join(badDir, "ws", idA, "repo.bundle");
  const buf = readFileSync(bundle);
  for (let i = Math.floor(buf.length / 2); i < Math.floor(buf.length / 2) + 64; i++) buf[i] ^= 0xff;
  writeFileSync(bundle, buf);
  spawnSync("tar", ["-czf", bad, "-C", badDir, ...readdirSync(badDir)]);
  const vb = cli(works, ["backup", "verify", bad]);
  check("a corrupted bundle fails verify with a clear message", vb.status !== 0 && /verify failed/.test(vb.out) && /repo|bundle|object|git/i.test(vb.out), vb.out);

  // A truncated copy must fail too.
  const cut = join(base, "cut.tar.gz");
  copyFileSync(archive, cut);
  truncateSync(cut, Math.floor(statSync(cut).size / 2));
  const vc = cli(works, ["backup", "verify", cut]);
  check("a truncated archive fails verify", vc.status !== 0 && /verify failed|cannot read|not a readable/.test(vc.out), vc.out);

  // ── 3. restore into a SECOND empty WORKS_DIR ─────────────────────────────
  mkdirSync(works2);
  const r = cli(works2, ["restore", archive]);
  check("restore into an empty WORKS_DIR succeeds", r.status === 0, r.out);
  const st2 = JSON.parse(readFileSync(join(works2, "state.json"), "utf8"));
  const repoA2 = join(works2, idA, "repo");
  check("state points the restored repo at the restored copy", st2.workspaces.find((w) => w.id === idA).repo === repoA2, JSON.stringify(st2.workspaces.map((w) => w.repo)));
  check("commits are identical (HEAD and history)",
    gitOut(repoA2, ["rev-parse", "HEAD"]) === gitOut(srcA, ["rev-parse", "main"]) && gitOut(repoA2, ["rev-list", "--count", "HEAD"]) === "2",
    gitOut(repoA2, ["log", "--oneline"]));
  const tree2 = join(works2, idA, "tree");
  check("the workspace branch is back as a worktree", gitOut(tree2, ["rev-parse", "--abbrev-ref", "HEAD"]) === `kohlab/${idA}`);
  const srcFiles = walkFiles(treeA, (r) => r === ".git" || r.startsWith("node_modules") || r === "big.bin" || r === "outside.txt");
  const sameFiles = srcFiles.every((f) => existsSync(join(tree2, f)) && sha(join(treeA, f)) === sha(join(tree2, f)));
  check("every file of the tree is identical, uncommitted work included", sameFiles && srcFiles.length >= 3, srcFiles.join(" "));
  check("the link inside the tree is a link again", lstatSync(join(tree2, "inside.txt")).isSymbolicLink() && readlinkSync(join(tree2, "inside.txt")) === "lib/a.txt");
  check("node_modules and the big file are not restored", !existsSync(join(tree2, "node_modules")) && !existsSync(join(tree2, "big.bin")));
  const repoB2 = join(works2, idB, "repo");
  check("project repo commits and uncommitted file restored",
    gitOut(repoB2, ["rev-list", "--count", "HEAD"]) === "1" && readFileSync(join(works2, idB, "tree", "notes.md"), "utf8") === "drafted, not committed\n");
  check("brain note identical", readFileSync(join(works2, idC, "brain", "Goal.md"), "utf8") === "# Goal\nship it\n");
  check("chat log and cursor identical",
    sha(join(works, "chats", `${idC}.jsonl`)) === sha(join(works2, "chats", `${idC}.jsonl`)) && sha(join(works, "chats", `${idC}.cursor.json`)) === sha(join(works2, "chats", `${idC}.cursor.json`)));
  check("secrets are not restored", !existsSync(join(works2, "accounts")));

  // ── 4. dry run changes nothing ───────────────────────────────────────────
  mkdirSync(works3);
  const dr = cli(works3, ["restore", archive, "--dry-run"]);
  check("dry run says so and lists what it would do", dr.status === 0 && /dry run/.test(dr.out) && dr.out.includes(`ws/${idA}`), dr.out);
  check("dry run leaves the target empty", readdirSync(works3).length === 0, readdirSync(works3).join(" "));

  // ── 5. replacing: kept without --projects, moved aside with it ───────────
  const kept = cli(works2, ["restore", archive]);
  check("an existing workspace folder is kept without --projects", kept.status === 0 && kept.out.includes(`kept: ws/${idA}`), kept.out);
  check("the state files it replaced are moved aside", readdirSync(works2).some((n) => n.startsWith("state.json.before-restore-")));
  const proj = cli(works2, ["restore", archive, "--projects"]);
  check("--projects moves the existing folder aside and restores it", proj.status === 0 && readdirSync(works2).some((n) => n.startsWith(`${idA}.before-restore-`)) && existsSync(join(works2, idA, "tree", "new.txt")), proj.out);

  // ── 6. hostile archives: refused, nothing written ─────────────────────────
  const hostile = [
    ["a ../ member", [{ name: "state.json", data: JSON.stringify({ workspaces: [] }) }, { name: "../escape.txt", data: "x" }]],
    ["an absolute member", [{ name: "state.json", data: JSON.stringify({ workspaces: [] }) }, { name: `/tmp/kohlab-abs-${CANARY}`, data: "x" }]],
    ["a link escape in tree.tar", null],
  ];
  for (const [label, spec] of hostile) {
    const dir = join(base, `evil-${label.replace(/\W+/g, "-")}`);
    const out = join(dir, "evil.tar.gz");
    const target = join(base, `works-evil-${label.replace(/\W+/g, "-")}`);
    mkdirSync(dir);
    mkdirSync(target);
    if (spec) {
      pyTar(out, spec);
    } else {
      const inner = join(dir, "tree.tar");
      pyTar(inner, [{ name: "evil", type: "symlink", link: "/etc/passwd" }]);
      const size = statSync(inner).size;
      const meta2 = { format: 2, kohlabVersion: "x", createdAt: "x", worksDir: "x", includes: { projects: true }, workspaces: [{ id: "evil", kind: "project", repoKind: "none", head: null, repo: "none", files: 1, bytes: 0, repoBytes: 0, tree: { entries: 1, bytes: 0, tarBytes: size }, brain: null, images: null, chats: [], skipped: { symlinks: 0, large: 0, special: 0 } }] };
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta2));
      writeFileSync(join(dir, "state.json"), JSON.stringify({ workspaces: [{ id: "evil", repo: "", task: "evil", agent: "sh", created: 1, started: null, stopped: null, dir: join(target, "evil") }] }));
      spawnSync("mkdir", ["-p", join(dir, "ws", "evil")]);
      copyFileSync(inner, join(dir, "ws", "evil", "tree.tar"));
      spawnSync("tar", ["-czf", out, "-C", dir, "meta.json", "state.json", "ws"]);
    }
    const rr = cli(target, ["restore", out]);
    check(`restore refuses ${label}`, rr.status !== 0 && /refusing/.test(rr.out), rr.out.slice(0, 300));
    check(`${label}: nothing was written`, !existsSync(join(target, "state.json")) && !existsSync(join(base, "escape.txt")) && !existsSync(`/tmp/kohlab-abs-${CANARY}`) && !existsSync(join(target, "evil")), readdirSync(target).join(" "));
  }

  // Paths that only state.json / meta.json name: recomputed or refused, nothing written outside the state directory.
{
  const mkMeta = (w) => ({ format: 2, kohlabVersion: "x", createdAt: "x", worksDir: "x", includes: { projects: true }, workspaces: [{ id: "evil", kind: "project", repoKind: "none", head: null, repo: "none", files: 0, bytes: 0, repoBytes: 0, tree: null, brain: null, images: null, chats: [], skipped: { symlinks: 0, large: 0, special: 0 }, ...w }] });
  const build = (name, meta, wsState) => {
    const dir = join(base, `evil2-${name}`);
    const target = join(base, `works-evil2-${name}`);
    mkdirSync(dir);
    mkdirSync(target);
    mkdirSync(join(dir, "ws", "evil", "chats"), { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ workspaces: [{ id: "evil", repo: "/etc", task: "t", agent: "sh", created: 1, started: null, stopped: null, ...wsState }] }));
    writeFileSync(join(dir, "ws", "evil", "chats", "evil.json"), "{}");
    const out = join(dir, "evil.tar.gz");
    spawnSync("tar", ["-czf", out, "-C", dir, "meta.json", "state.json", "ws"]);
    return { out, target };
  };
  const outside = join(base, "outside-dir");
  const a1 = build("dir", mkMeta({ chats: ["evil.json"] }), { dir: outside, brainDir: outside });
  const r1 = cli(a1.target, ["restore", a1.out, "--projects"]);
  const st = existsSync(join(a1.target, "state.json")) ? JSON.parse(readFileSync(join(a1.target, "state.json"), "utf8")).workspaces[0] : {};
  check("a state.json dir or brainDir outside the state directory is recomputed, never used", !existsSync(outside) && st.dir === join(a1.target, "evil") && st.brainDir === undefined, `${r1.out.slice(0, 200)} ${JSON.stringify(st)}`);
  const a2 = build("chat", mkMeta({ chats: ["../../../../escape-chat.txt"] }), {});
  const r2 = cli(a2.target, ["restore", a2.out]);
  check("a chat name with ../ in meta.json is refused", r2.status !== 0 && /refusing/.test(r2.out) && !existsSync(join(base, "escape-chat.txt")), r2.out.slice(0, 200));
  const a3 = build("head", mkMeta({ head: "--upload-pack=touch x", repo: "empty" }), {});
  check("a branch name that looks like an option is refused", cli(a3.target, ["restore", a3.out]).status !== 0);
  const a4 = build("id", mkMeta({ id: "../x" }), { id: "../x" });
  check("a workspace id with ../ is refused", cli(a4.target, ["restore", a4.out]).status !== 0);
}

// ── 7. --no-projects and an old format-1 archive ──────────────────────────
  const np = join(base, "state-only.tar.gz");
  const npRun = cli(works, ["backup", np, "--no-projects"]);
  check("--no-projects writes a state-only archive that verifies", npRun.status === 0 && cli(works, ["backup", "verify", np]).status === 0 && !tarList(np).some((n) => n.startsWith("ws/")));
  const npDir = join(base, "works-np");
  mkdirSync(npDir);
  check("a state-only archive restores the state only", cli(npDir, ["restore", np]).status === 0 && existsSync(join(npDir, "state.json")) && !existsSync(join(npDir, idA)));
  const f1 = join(base, "format1.tar.gz");
  const f1dir = join(base, "format1");
  mkdirSync(f1dir);
  writeFileSync(join(f1dir, "state.json"), JSON.stringify({ workspaces: [] }));
  writeFileSync(join(f1dir, "users.json"), JSON.stringify({ users: [] }));
  spawnSync("tar", ["-czf", f1, "-C", f1dir, "state.json", "users.json"]);
  const f1Dir = join(base, "works-f1");
  mkdirSync(f1Dir);
  check("a format 1 archive still restores", cli(f1Dir, ["restore", f1]).status === 0 && existsSync(join(f1Dir, "users.json")));

  // ── 8. --with-logins adds only the account list ──────────────────────────
  const wl = join(base, "logins.tar.gz");
  cli(works, ["backup", wl, "--with-logins"]);
  const wln = tarList(wl);
  check("--with-logins adds accounts/accounts.json and never secrets", wln.includes("accounts/accounts.json") && !wln.some((n) => /secrets|login/.test(n)) && !gunzipSync(readFileSync(wl)).includes(CANARY));

  // ── 9. the daily job (engine level, in throwaway dirs) ───────────────────
  const dj = join(base, "works-daily");
  mkdirSync(dj);
  writeFileSync(join(dj, "key"), `${CANARY}-key`);
  const d1 = job(dj, `const r1 = await b.runIfDue(); const r2 = await b.runIfDue();
const last = JSON.parse(require("fs").readFileSync(${JSON.stringify(join(dj, "backups", "last.json"))}, "utf8"));
console.log(JSON.stringify({ a: r1.ran, aOk: r1.last?.ok, aVerified: r1.last?.verified, b: r2.ran, bReason: r2.reason, lastOk: last.ok, name: last.name }));`);
  let d1j = {};
  try { d1j = JSON.parse(d1.out.split("\n").filter((l) => l.startsWith("{")).pop()); } catch { /* reported below */ }
  check("the first daily run makes one verified backup", d1j.a === true && d1j.aOk === true && d1j.aVerified === true && d1j.lastOk === true, d1.out.slice(-400));
  const dailyArchive = readdirSync(join(dj, "backups")).find((n) => n.endsWith(".tar.gz"));
  check("the daily archive leaves the access key out", dailyArchive && !tarList(join(dj, "backups", dailyArchive)).includes("key") && !gunzipSync(readFileSync(join(dj, "backups", dailyArchive))).includes(`${CANARY}-key`));
  check("the CLI archive keeps the access key, as before", tarList(archive).includes("key") || !existsSync(join(works, "key")));
  check("a second call within 24 h does nothing", d1j.b === false && /recent/.test(d1j.bReason ?? ""), d1.out.slice(-400));
  const backupsD = join(dj, "backups");
  const fakes = [];
  for (let i = 1; i <= 8; i++) {
    const n = `kohlab-2020010${i}-000000.tar.gz`;
    writeFileSync(join(backupsD, n), "x");
    fakes.push(n);
  }
  const pr = job(dj, `const r = await b.runBackup({ actor: "check", reason: "manual" }); console.log(JSON.stringify({ ok: r.ok }));`);
  const left = readdirSync(backupsD).filter((n) => /^kohlab-\d{8}-\d{6}\.tar\.gz$/.test(n));
  check("pruning keeps the newest 7", pr.out.includes('"ok":true') && left.length === 7 && !left.includes(fakes[0]), `${left.length} left: ${left.join(" ")}`);
  const before = readdirSync(backupsD).length;
  const low = job(dj, `const r = await b.runBackup({ actor: "check", reason: "auto", freeBytes: async () => 1 }); console.log(JSON.stringify({ ok: r.ok, error: r.error }));`);
  check("low disk is a recorded skip with a reason, no archive made", low.out.includes('"ok":false') && /skipped/.test(low.out) && readdirSync(backupsD).length === before, low.out.slice(-300));
  const brokenWorks = join(base, "works-broken");
  mkdirSync(brokenWorks);
  const srcBroken = join(base, "src-broken");
  mkdirSync(srcBroken);
  git(srcBroken, ["init", "-q", "-b", "main"]);
  git(srcBroken, ["commit", "-q", "--allow-empty", "-m", "x"]);
  writeFileSync(join(brokenWorks, "state.json"), JSON.stringify({ schemaVersion: 1, workspaces: [ws("broken", srcBroken)], agents: { sh: "sh" } }));
  writeFileSync(join(srcBroken, ".git", "HEAD"), "garbage\n");
  const fail = job(brokenWorks, `const r = await b.runBackup({ actor: "system", reason: "auto" }); console.log(JSON.stringify({ ok: r.ok, error: r.error }));`);
  check("a failing backup is recorded, never thrown", fail.status === 0 && fail.out.includes('"ok":false') && /"error":"[^"]+"/.test(fail.out), fail.out.slice(-300));
  const auditTxt = existsSync(join(dj, "audit.log")) ? readFileSync(join(dj, "audit.log"), "utf8") : "";
  check("audit records backup.auto and backup.run", auditTxt.includes('"backup.auto"') && auditTxt.includes('"backup.run"'), auditTxt.slice(-300));

  // ── 10. the routes, on a throwaway server ─────────────────────────────────
  const kit = await startKit({ key: "backup-check-key", env: { KOHLAB_BACKUP_DAILY: "0" } });
  try {
    const pid = await kit.project();
    writeFileSync(join(kit.works, pid, "tree", "big-random.bin"), randomBytes(30 * 1024 * 1024));
    const addUser = (id, role) => {
      const out = spawnSync("bun", ["run", "cli.ts", "user", "add", id, "--role", role], { cwd: ROOT, env: { ...process.env, WORKS_DIR: kit.works }, encoding: "utf8" }).stdout;
      return /key \(shown once, store it now\): (\S+)/.exec(out)?.[1] ?? "";
    };
    const memberKey = addUser("m1", "member");
    const viewerKey = addUser("v1", "viewer");

    const g = await kit.req("GET", "/api/backups");
    check("owner GET /api/backups is 200 with the shape", g.status === 200 && ["last", "keep", "daily", "items", "running"].every((k) => k in g.body), g.text.slice(0, 200));
    check("member is refused (403)", memberKey && (await kit.req("GET", "/api/backups", undefined, memberKey)).status === 403);
    check("viewer is refused (403)", viewerKey && (await kit.req("GET", "/api/backups", undefined, viewerKey)).status === 403);
    const anon = await fetch(`${kit.base}/api/backups`);
    check("no key is 401", anon.status === 401, anon.status);
    const share = await kit.req("POST", `/api/workspaces/${pid}/share`, {});
    const shared = await fetch(`${kit.base}/api/backups?share=${encodeURIComponent(share.body?.share ?? "none")}`);
    check("a share link is refused (403)", share.body?.share && shared.status === 403, shared.status);

    const p1 = await kit.req("POST", "/api/backups");
    const p2 = await kit.req("POST", "/api/backups");
    check("POST runs a backup (200), a second POST while running is 409", p1.status === 200 && p2.status === 409, `${p1.status} ${p2.status}`);
    const idle = async () => {
      for (let i = 0; i < 300; i++) {
        const s = await kit.req("GET", "/api/backups");
        if (!s.body.running) return s.body;
        await new Promise((res) => setTimeout(res, 200));
      }
      return null;
    };
    const done = await idle();
    check("the run finishes verified", done?.last?.ok === true && done?.last?.verified === true && done?.items.length === 1, JSON.stringify(done?.last));
    const name = done?.items[0]?.name ?? "none";
    const dl = await fetch(`${kit.base}/api/backups/${name}/download?key=backup-check-key`);
    const bodyLen = (await dl.arrayBuffer()).byteLength;
    check("download streams the archive as an attachment, not cached",
      dl.status === 200 && /gzip/.test(dl.headers.get("content-type") ?? "") && /attachment/.test(dl.headers.get("content-disposition") ?? "") && dl.headers.get("cache-control") === "no-store" && bodyLen > 0, `${dl.status} ${bodyLen}`);
    for (const bad of ["kohlab-nope.tar.gz", "..%2Fstate.json", "%2e%2e%2fstate.json"]) {
      const res = await fetch(`${kit.base}/api/backups/${bad}/download?key=backup-check-key`);
      check(`download of a bad name (${bad}) is 404`, res.status === 404, res.status);
    }
    const del = await kit.req("DELETE", `/api/backups/${name}`);
    const del2 = await kit.req("DELETE", `/api/backups/${name}`);
    check("DELETE removes it, a second DELETE is 404", del.status === 200 && del.body.items.length === 0 && del2.status === 404, `${del.status} ${del2.status}`);
  } finally {
    await kit.stop();
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
finish("backup drill");

function symlinkSync(target, path) {
  spawnSync("ln", ["-s", target, path]);
}
