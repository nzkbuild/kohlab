/**
 * Agent-user workspaces get the operator's Claude config mirrored into the agent's
 * ~/.claude, minus credentials, history and settings that point into the operator's home.
 * Run: bun scripts/check-agent-config-sync.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.WORKS_DIR = mkdtempSync(join(tmpdir(), "kohlab-acs-state-"));
const { syncAgentClaudeConfig } = await import("../lib");
const stage = mkdtempSync(join(tmpdir(), "kohlab-acs-stage-"));

const root = mkdtempSync(join(tmpdir(), "kohlab-acs-"));
const srcHome = join(root, "src");
const destHome = join(root, "dest");
const src = join(srcHome, ".claude");
const dest = join(destHome, ".claude");

const put = (p: string, body: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};
const read = (p: string) => readFileSync(p, "utf8");
const has = (p: string) => existsSync(p);

put(join(src, "CLAUDE.md"), "# rules");
put(join(src, "statusline.sh"), "echo hi");
put(
  join(src, "settings.json"),
  JSON.stringify({
    statusLine: { type: "command", command: `bash ${src}/statusline.sh` },
    env: { XDG_RUNTIME_DIR: "/run/user/0", DBUS_SESSION_BUS_ADDRESS: "x", KEEP: "1" },
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${srcHome}/.local/bin/ctx sift` }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo ok" }] }],
    },
  }),
);
put(join(src, "agents/worker.md"), "worker");
put(join(src, "skills/foo/SKILL.md"), "foo");
put(join(src, "plugins/installed_plugins.json"), JSON.stringify({ p: `${src}/plugins/cache/p` }));
put(join(src, "plugins/synced/src-only"), "x");
put(join(src, ".credentials.json"), "operator-creds");
put(join(src, "projects/secret.txt"), "secret");
put(join(src, "history.jsonl"), "operator-history");

put(join(dest, ".credentials.json"), "agent-creds");
put(join(dest, "history.jsonl"), "agent-history");
put(join(dest, "agents/stale.md"), "stale");
put(join(dest, "skills/synced/keep"), "keep");

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
};

const uid = process.getuid!();
const gid = process.getgid!();
syncAgentClaudeConfig(src, destHome, { name: "unused", uid, gid }, stage);
const firstSettings = read(join(dest, "settings.json"));

const verify = (when: string) => {
  check(`${when}: CLAUDE.md, statusline.sh, agents, skills copied`,
    has(join(dest, "CLAUDE.md")) && has(join(dest, "statusline.sh")) && has(join(dest, "agents/worker.md")) && has(join(dest, "skills/foo/SKILL.md")));
  check(`${when}: stale agent file deleted`, !has(join(dest, "agents/stale.md")));
  check(`${when}: agent credentials untouched`, read(join(dest, ".credentials.json")) === "agent-creds");
  check(`${when}: agent history untouched`, read(join(dest, "history.jsonl")) === "agent-history");
  check(`${when}: projects not copied`, !has(join(dest, "projects")));
  check(`${when}: agent's own skills/synced kept`, has(join(dest, "skills/synced/keep")));
  check(`${when}: plugins/synced not copied`, !has(join(dest, "plugins/synced/src-only")));
  const plugins = read(join(dest, "plugins/installed_plugins.json"));
  check(`${when}: plugin paths rewritten to the agent home`, plugins.includes(destHome) && !plugins.includes(srcHome));
  const s = JSON.parse(read(join(dest, "settings.json")));
  check(`${when}: statusLine points at the agent's copy`, s.statusLine?.command === `bash ${dest}/statusline.sh`);
  check(`${when}: env keeps KEEP, drops XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS`,
    s.env?.KEEP === "1" && !("XDG_RUNTIME_DIR" in s.env) && !("DBUS_SESSION_BUS_ADDRESS" in s.env));
  check(`${when}: hook into the operator's home removed`, s.hooks?.PostToolUse === undefined);
  check(`${when}: harmless hook kept`, s.hooks?.Stop?.[0]?.hooks?.[0]?.command === "echo ok");
};

verify("first sync");
syncAgentClaudeConfig(src, destHome, { name: "unused", uid, gid }, stage);
check("second sync leaves settings.json byte-identical", read(join(dest, "settings.json")) === firstSettings);
verify("second sync");
check("rewrite happens in the root-owned stage, outside the agent home",
  !stage.startsWith(destHome) && read(join(stage, "plugins/installed_plugins.json")).includes(destHome));

rmSync(root, { recursive: true, force: true });
rmSync(stage, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
