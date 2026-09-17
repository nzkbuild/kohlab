#!/usr/bin/env node
/**
 * Screen-model check — the guarantee behind "reattach and see the screen".
 *
 * Run:  node scripts/check-screen.mjs
 *
 * The daemon used to replay a rolling byte window. A truncated byte stream
 * cannot rebuild a full-screen TUI, so reattaching showed a mangled screen, and
 * a finished agent's output was dropped outright. It now keeps a headless
 * terminal per session and replays the *screen*.
 *
 * This drives a real daemon over its real socket, so it tests the shipped path
 * rather than a model of it.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import headless from "@xterm/headless";

// @xterm/headless ships CommonJS (which is why the daemon can require() it), so
// ESM must take the default export and destructure.
const { Terminal } = headless;

const SOCKET = join(tmpdir(), `kohlab-screen-${process.pid}.sock`);
const SESSION = "screen-check";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

/** @xterm/headless v6 throws on write() without this — see the daemon comment. */
const newScreen = (cols, rows) =>
  new Terminal({ cols, rows, scrollback: 500, allowProposedApi: true });

/** Apply a replay payload exactly as the browser terminal does. */
function render(payload, cols = 40, rows = 10) {
  return new Promise((resolve) => {
    const term = newScreen(cols, rows);
    term.write("\x1b[2J\x1b[H" + payload, () => {
      const lines = [];
      const buf = term.buffer.active;
      for (let y = 0; y < buf.length; y++) {
        const text = buf.getLine(y)?.translateToString(true) ?? "";
        if (text.trim()) lines.push(text.trimEnd());
      }
      term.dispose();
      resolve(lines);
    });
  });
}

/** Ask and also return the concatenated output frames that preceded the reply. */
function askWithOutput(message) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET);
    let buf = "";
    const frames = [];
    const timer = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        /* gone */
      }
      reject(new Error(`timeout for ${message.type}`));
    }, 8000);
    sock.on("connect", () => sock.write(JSON.stringify(message) + "\n"));
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === "output") {
          frames.push(Buffer.from(msg.data, "base64").toString("utf8"));
          continue;
        }
        clearTimeout(timer);
        try {
          sock.destroy();
        } catch {
          /* gone */
        }
        resolve({ reply: msg, output: frames.join("") });
        return;
      }
    });
  });
}

/**
 * Poll until the daemon actually ACCEPTS a connection. Checking for the socket
 * file is not enough — it exists a moment before listen() starts accepting, and
 * that race shows up as a spurious ECONNREFUSED.
 */
async function waitForSocket() {
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection(SOCKET);
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Send a message that has no reply by design (resize) and move on. */
function fireAndForget(message) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET);
    sock.on("connect", () => {
      sock.write(JSON.stringify(message) + "\n", () => {
        sock.destroy();
        resolve();
      });
    });
    sock.on("error", reject);
  });
}

// A TUI that clears the screen and draws a box, then holds it.
const BOX = "\\033[2J\\033[H\\033[36m+--------+\\033[0m\\n\\033[36m|\\033[0m ready  \\033[36m|\\033[0m\\n\\033[36m+--------+\\033[0m\\n";
const tuiCmd = ["sh", "-c", `printf '${BOX}'; sleep 30`];

/** Accumulated daemon output, so a crash reports its cause, not just ECONNREFUSED. */
let daemonLog = "";
let daemonExit = null;

const daemon = spawn("node", ["pty-daemon.cjs"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, PTY_SOCKET: SOCKET },
  stdio: ["ignore", "pipe", "pipe"],
});
daemon.stdout.on("data", (d) => {
  daemonLog += d.toString();
});
daemon.stderr.on("data", (d) => {
  daemonLog += d.toString();
});
daemon.on("exit", (code) => {
  daemonExit = code;
});

/** Surfaced on any failure — a dead daemon must say why. */
function daemonReport() {
  return `daemon exit=${daemonExit}\n${daemonLog.trim().split("\n").slice(-6).join("\n")}`;
}

try {
  console.log("\nkohlab screen model\n");

  if (!(await waitForSocket())) throw new Error("daemon never created its socket");

  const opened = await askWithOutput({
    type: "open",
    id: SESSION,
    cwd: "/tmp",
    cmd: tuiCmd,
    cols: 40,
    rows: 10,
  });
  check("session opens", opened.reply.type === "open-result" && !opened.reply.error, JSON.stringify(opened.reply).slice(0, 120));

  await new Promise((r) => setTimeout(r, 700));

  // 1. Reattach to a LIVE full-screen TUI.
  const live = await askWithOutput({ type: "subscribe", id: SESSION, replay: true });
  const liveScreen = await render(live.output);
  check("live reattach replays a screen", live.output.length > 0, `replay was ${live.output.length} bytes`);
  check(
    "live reattach reconstructs the TUI box",
    liveScreen.some((l) => l.includes("ready")) && liveScreen.some((l) => l.includes("+--------+")),
    JSON.stringify(liveScreen),
  );

  // 3. The screen model must resize with the PTY, or every later replay restores
  //    a wrongly-wrapped screen. Asserted on the reported dimensions rather than
  //    behaviourally: the PTY's own width does the wrapping, so a divergent model
  //    still produces a byte-identical replay — a behavioural check cannot fail.
  const RESIZE_SESSION = "screen-resize";
  await askWithOutput({ type: "open", id: RESIZE_SESSION, cwd: "/tmp", cmd: ["sh"], cols: 20, rows: 8 });
  await new Promise((r) => setTimeout(r, 400));
  await fireAndForget({ type: "resize", id: RESIZE_SESSION, cols: 60, rows: 14 });
  await new Promise((r) => setTimeout(r, 600));
  const listed = await askWithOutput({ type: "list" });
  const entry = (listed.reply.sessions ?? []).find((s) => s.id === RESIZE_SESSION) ?? {};
  check(
    "the screen model resizes with the PTY",
    entry.cols === 60 && entry.rows === 14 && entry.ptyCols === 60 && entry.ptyRows === 14,
    `screen=${entry.cols}x${entry.rows} pty=${entry.ptyCols}x${entry.ptyRows}`,
  );
  await fireAndForget({ type: "close", id: RESIZE_SESSION });

  // 4. A finished session still serves its FINAL screen (retained, not dropped).
  await askWithOutput({ type: "close", id: SESSION });
  await new Promise((r) => setTimeout(r, 600));
  const gone = await askWithOutput({ type: "subscribe", id: SESSION, replay: true });
  const finalScreen = await render(gone.output);
  check(
    "a finished session still replays its final screen",
    gone.reply.type === "subscribed" && finalScreen.some((l) => l.includes("ready")),
    `reply=${gone.reply.type} screen=${JSON.stringify(finalScreen)}`,
  );

  // 5. The Log tab reads the same retained screen — otherwise a finished
  //    workspace showed an empty log, since the byte buffer dies with the
  //    session.
  const logReply = await askWithOutput({ type: "log", id: SESSION });
  const logText = Buffer.from(String(logReply.reply.data ?? ""), "base64").toString("utf8");
  check(
    "the log op serves the retained screen after exit",
    logReply.reply.type === "log-reply" && logText.includes("ready"),
    `reply=${logReply.reply.type} text=${JSON.stringify(logText.slice(0, 60))}`,
  );

  // 6. An unknown session is still reported, not silently empty.
  const unknown = await askWithOutput({ type: "subscribe", id: "no-such-session", replay: true });
  check("an unknown session reports an error", unknown.reply.type === "error", JSON.stringify(unknown.reply));
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.log(`  FAIL ${err.stack}`);
} finally {
  try {
    daemon.kill("SIGKILL");
  } catch {
    /* gone */
  }
  rmSync(SOCKET, { force: true });
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    // A dead daemon must say why. Without this a crash reads as a bare
    // ECONNREFUSED, which says nothing about the cause.
    console.log("\ndaemon output:\n" + daemonReport());
    process.exit(1);
  }
  console.log("screen model intact\n");
}
