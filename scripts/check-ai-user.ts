/**
 * The AI's own account (v2.9.4): the pure status rules, the one refusal every owner
 * spawn path routes through, the CLI dry-run and the install.sh function's dry run.
 * Run:  bun scripts/check-ai-user.ts
 *
 * KOHLAB_AGENT_USER and WORKS_DIR are read once at import, so each server mode runs
 * in a child process with its own environment, and WORKS_DIR is always a fresh temp
 * dir (never the live state). Nothing is created on the machine: the missing case
 * names an account that does not exist, and the status-only case reads `nobody`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL("..", import.meta.url).pathname;
const MODE = process.argv[2];
const MISSING = `kohlab-chk-nope-${process.pid}`; // the parent passes this as KOHLAB_AGENT_USER to children
const IS_ROOT = process.getuid?.() === 0;

let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};

/* ------------------------------------------------------------ child: one mode -- */
// The parent sets KOHLAB_AGENT_USER and a temp WORKS_DIR before this process starts.
if (MODE) {
  const lib = await import("../lib");
  try {
    if (MODE === "status") {
      const s = lib.aiUserStatus();
      check("configured and found: mode agent, named", s.mode === "agent" && s.name === "nobody", JSON.stringify(s));
    } else if (MODE === "missing") {
      const s = lib.aiUserStatus();
      const configured = process.env.KOHLAB_AGENT_USER!;
      check("configured but absent: mode missing, named", s.mode === "missing" && s.name === configured, JSON.stringify(s));
      check(
        "owner refusal is the plain sentence",
        lib.aiUserRefusal({ ownerId: undefined }) === `The AI user '${configured}' doesn't exist on this server. Create it with: kohlab ai-user setup`,
        String(lib.aiUserRefusal({ ownerId: undefined })),
      );
      check("members are not refused", lib.aiUserRefusal({ ownerId: "sam" }) === null);
      check("the server terminal is not refused", lib.aiUserRefusal({ serverShell: true }) === null);

      const repo = join(process.env.WORKS_DIR!, "repo");
      mkdirSync(repo);
      const git = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "start");
      let created: unknown = null;
      try {
        await lib.createWorkspace({ repo, task: "chk", agent: "sh" });
      } catch (e) {
        created = e;
      }
      check("createWorkspace refuses an owner project with a 409", created instanceof lib.AiUserError && created.status === 409, String(created));
      check("…and wrote nothing to state", readdirSync(process.env.WORKS_DIR!).sort().join(",") === "repo", readdirSync(process.env.WORKS_DIR!).join(","));

      // A workspace that already exists (made while the account was there) must refuse too, before any PTY is touched.
      let spawnErr: unknown = null;
      try {
        await lib.spawnAgentSession({ id: "chk-owner", repo, dir: repo, agent: "sh", chat: false } as any);
      } catch (e) {
        spawnErr = e;
      }
      check("spawnAgentSession refuses an owner project with a 409", spawnErr instanceof lib.AiUserError && (spawnErr as any).status === 409, String(spawnErr));
    } else if (MODE === "root") {
      const s = lib.aiUserStatus();
      check("nothing configured: mode root, allowed (legacy default)", s.mode === "root" && s.name === undefined, JSON.stringify(s));
      check("no refusal for owner work", lib.aiUserRefusal({ ownerId: undefined }) === null);
    } else if (MODE === "not-root") {
      const s = lib.aiUserStatus();
      check("not root: mode not-root, nothing to refuse", s.mode === "not-root" && lib.aiUserRefusal({ ownerId: undefined }) === null, JSON.stringify(s));
    }
  } finally {
    rmSync(process.env.WORKS_DIR!, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

/* ------------------------------------------------------------- parent: pure rules -- */
// lib reads its state dir when it loads (it may write a key there): point it at a temp dir first.
const PARENT_DIR = mkdtempSync(join(tmpdir(), "kohlab-ai-parent-"));
process.env.WORKS_DIR = PARENT_DIR;
process.env.KOHLAB_KEY = "ai-user-check-key"; // without it lib writes a generated key into WORKS_DIR
const lib = await import("../lib");
console.log("pure status rules");
check("not root wins, whatever is configured", lib.decideAiUser({ configured: "x", root: false, exists: false }).mode === "not-root");
check("root with nothing configured is root", JSON.stringify(lib.decideAiUser({ configured: "", root: true, exists: false })) === JSON.stringify({ mode: "root" }));
check("configured and found is agent", JSON.stringify(lib.decideAiUser({ configured: "a", root: true, exists: true })) === JSON.stringify({ mode: "agent", name: "a" }));
check("configured and absent is missing", JSON.stringify(lib.decideAiUser({ configured: "a", root: true, exists: false })) === JSON.stringify({ mode: "missing", name: "a" }));

console.log("env file line (upsertEnvLine)");
check("appends to a file without the key", lib.upsertEnvLine("KOHLAB_KEY=abc\n", "KOHLAB_AGENT_USER", "kohlab-agent") === "KOHLAB_KEY=abc\nKOHLAB_AGENT_USER=kohlab-agent\n");
check(
  "is idempotent",
  (() => {
    const once = lib.upsertEnvLine("KOHLAB_KEY=abc\n", "KOHLAB_AGENT_USER", "kohlab-agent");
    return lib.upsertEnvLine(once, "KOHLAB_AGENT_USER", "kohlab-agent") === once;
  })(),
);
check("replaces a different value in place, no duplicate", lib.upsertEnvLine("KOHLAB_AGENT_USER=old\nKOHLAB_KEY=abc\n", "KOHLAB_AGENT_USER", "new") === "KOHLAB_AGENT_USER=new\nKOHLAB_KEY=abc\n");
check("drops duplicate lines", lib.upsertEnvLine("KOHLAB_AGENT_USER=a\nKOHLAB_AGENT_USER=b\n", "KOHLAB_AGENT_USER", "c") === "KOHLAB_AGENT_USER=c\n");
check("empty file gets the line", lib.upsertEnvLine("", "KOHLAB_AGENT_USER", "kohlab-agent") === "KOHLAB_AGENT_USER=kohlab-agent\n");
check("does not touch a similarly named key", lib.upsertEnvLine("KOHLAB_AGENT_USER_EXTRA=1\n", "KOHLAB_AGENT_USER", "k") === "KOHLAB_AGENT_USER_EXTRA=1\nKOHLAB_AGENT_USER=k\n");

console.log("server modes (child processes, temp WORKS_DIR each)");
const run = (mode: string, agentUser: string | undefined) => {
  const dir = mkdtempSync(join(tmpdir(), "kohlab-ai-user-"));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), WORKS_DIR: dir, KOHLAB_KEY: "ai-user-check-key" };
  delete env.KOHLAB_AGENT_USER;
  if (agentUser !== undefined) env.KOHLAB_AGENT_USER = agentUser;
  try {
    const r = spawnSync(process.execPath, [import.meta.path, mode], { env, encoding: "utf8", cwd: HERE });
    process.stdout.write((r.stdout ?? "").replace(/^/gm, "    "));
    if (r.status !== 0) {
      failed++;
      console.log(`  FAIL child ${mode} exited ${r.status} ${(r.stderr ?? "").trim().slice(0, 300)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
if (IS_ROOT) {
  run("missing", MISSING);
  run("status", "nobody");
  run("root", undefined);
  console.log("  skip not-root: this run is root (the server would not be root)");
} else {
  console.log("  skip missing/status/root: those need root");
  run("not-root", MISSING);
}

console.log("CLI (dry run writes nothing)");
const cliDir = mkdtempSync(join(tmpdir(), "kohlab-ai-cli-"));
try {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), WORKS_DIR: cliDir, KOHLAB_KEY: "ai-user-check-key", KOHLAB_UNIT: `kohlab-chk-unit-${process.pid}` };
  delete env.KOHLAB_AGENT_USER;
  const dry = spawnSync(process.execPath, ["run", join(HERE, "cli.ts"), "ai-user", "setup", "--dry-run"], { env, encoding: "utf8", cwd: HERE });
  check("ai-user setup --dry-run exits 0", dry.status === 0, dry.stderr);
  check("dry run names the default account", /would create the account 'kohlab-agent'/.test(dry.stdout), dry.stdout);
  check("dry run says where it would set the line", /would set KOHLAB_AGENT_USER=kohlab-agent in /.test(dry.stdout) || /no EnvironmentFile found/.test(dry.stdout), dry.stdout);
  check("dry run prints the restart line", /Restart Kohlab to apply/.test(dry.stdout));
  const status = spawnSync(process.execPath, ["run", join(HERE, "cli.ts"), "ai-user", "status"], { env: { ...env, KOHLAB_AGENT_USER: MISSING }, encoding: "utf8", cwd: HERE });
  check("ai-user status reports missing", status.status === 0 && /AI user: missing/.test(status.stdout), status.stdout + status.stderr);
  if (!IS_ROOT) {
    const refused = spawnSync(process.execPath, ["run", join(HERE, "cli.ts"), "ai-user", "setup"], { env, encoding: "utf8", cwd: HERE });
    check("ai-user setup refuses to write when not root", refused.status !== 0 && /run this as root/.test(refused.stderr + refused.stdout), refused.stderr);
  } else {
    console.log("  skip non-root refusal: this run is root");
  }
  check("nothing was written to the work dir", readdirSync(cliDir).length === 0, readdirSync(cliDir).join(","));
} finally {
  rmSync(cliDir, { recursive: true, force: true });
}

console.log("install.sh setup_ai_user (dry run)");
const shDir = mkdtempSync(join(tmpdir(), "kohlab-ai-sh-"));
try {
  const fn = spawnSync("sed", ["-n", "/^setup_ai_user()/,/^}/p", join(HERE, "install.sh")], { encoding: "utf8" }).stdout;
  check("the function is in install.sh and closes", fn.includes("setup_ai_user()") && fn.trimEnd().endsWith("}"));
  const script = join(shDir, "harness.sh");
  writeFileSync(
    script,
    [
      "set -u",
      'log() { :; }; warn() { echo "WARN $*"; }; as_root() { "$@"; }',
      `KOHLAB_HOME=${HERE.replace(/\/$/, "")}`,
      "BUN=$(command -v bun)",
      `KOHLAB_BIN_DIR=${shDir}/nobin`,
      "WITH_COMMAND=0",
      "WITH_AI_USER=1",
      fn,
      "setup_ai_user",
      "WITH_AI_USER=0",
      "setup_ai_user",
    ].join("\n"),
  );
  const r = spawnSync("bash", [script], { encoding: "utf8", env: { ...(process.env as Record<string, string>), KOHLAB_AI_USER_DRY_RUN: "1", WORKS_DIR: shDir } });
  check("dry run of the installer step exits 0", r.status === 0, r.stderr);
  check("the dry run shows the plan", /would create the account 'kohlab-agent'/.test(r.stdout), r.stdout);
  check("--no-ai-user says the AI runs as root", /--no-ai-user/.test(r.stdout));
} finally {
  rmSync(shDir, { recursive: true, force: true });
}

rmSync(PARENT_DIR, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall AI user checks passed");
process.exit(failed ? 1 : 0);
