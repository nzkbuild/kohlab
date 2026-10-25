// Shared by the browser UI checks (check-cold-load, check-design): a throwaway server on its own
// PORT, WORKS_DIR and PTY_SOCKET with two chat projects, and the playwright-core and Chromium
// already on the machine (KOHLAB_PLAYWRIGHT / KOHLAB_CHROME to point at them).
//   ready: three kept versions and one unkept change, so Changes, Preview and earlier versions exist
//   fresh: nothing yet, so its switch has one segment
import { spawn, execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const find = (list) => list.find((p) => p && existsSync(p));
const glob = (dir, prefix, suffix) => {
  try {
    return readdirSync(dir).filter((d) => d.startsWith(prefix)).map((d) => join(dir, d, suffix));
  } catch {
    return [];
  }
};

/** { chromium, chrome } or null (the caller prints a skip). */
export function findBrowser() {
  const pw = find([process.env.KOHLAB_PLAYWRIGHT, ...glob(join(homedir(), ".npm/_npx"), "", "node_modules/playwright-core")]);
  const chrome = find([
    process.env.KOHLAB_CHROME,
    ...glob(join(homedir(), ".cache/ms-playwright"), "chromium-", "chrome-linux64/chrome"),
    ...glob(join(homedir(), ".cache/ms-playwright"), "chromium-", "chrome-linux/chrome"),
  ]);
  if (!pw || !chrome) return null;
  return { chromium: createRequire(import.meta.url)(pw).chromium, chrome };
}

export async function startFixture({ port, key }) {
  const root = new URL("..", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "kohlab-ui-"));
  const socket = join(tmpdir(), `kohlab-ui-${process.pid}-${port}.sock`);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("bun", ["run", "server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", KOHLAB_KEY: key, WORKS_DIR: dir, PTY_SOCKET: socket },
    stdio: "ignore",
  });
  const stop = () => {
    proc.kill("SIGKILL");
    try {
      const pid = execSync(`ss -xlp 2>/dev/null | grep -F '${socket}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`, { encoding: "utf8" }).trim();
      if (pid) process.kill(Number(pid), "SIGKILL");
    } catch {
      /* no daemon was started */
    }
    rmSync(socket, { force: true });
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 80; i++) {
      if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    const make = async (name) => {
      const res = await fetch(`${base}/api/workspaces`, { method: "POST", headers, body: JSON.stringify({ newProject: name, chat: true, agent: "claude" }) });
      if (!res.ok) throw new Error(`create ${name}: ${res.status} ${await res.text()}`);
      return res.json();
    };
    const fresh = await make("fresh");
    const ready = await make("ready");
    const git = (...a) => execFileSync("git", ["-c", "user.name=ui", "-c", "user.email=ui@local", ...a], { cwd: ready.path, stdio: "ignore" });
    for (const [i, html] of ["<h1>One</h1>", "<h1>One</h1><p>Two</p>", "<h1>One</h1><p>Two</p><p>Three</p>"].entries()) {
      writeFileSync(join(ready.path, "index.html"), `${html}\n`);
      git("add", "-A");
      git("commit", "-q", "-m", `Version ${i + 1}`);
    }
    writeFileSync(join(ready.path, "index.html"), "<h1>One</h1><p>Two</p><p>Three</p><p>Four</p>\n");
    writeFileSync(join(ready.path, "about.html"), "<p>About</p>\n");
    return { base, key, ready: ready.id, fresh: fresh.id, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

/** A browser context that is already signed in and past the welcome. */
export async function openContext(browser, { width = 1280, height = 900, key, touch = false, scheme = "dark" }) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, colorScheme: scheme });
  await ctx.addInitScript((k) => {
    try {
      localStorage.setItem("kohlab_key", k);
      localStorage.setItem("kohlab.onboarded", "1");
    } catch {
      /* storage is off */
    }
  }, key);
  return ctx;
}
