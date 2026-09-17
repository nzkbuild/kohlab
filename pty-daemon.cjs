// kohlab PTY daemon - long-lived process owning real PTYs.
// Runs under Node (node-pty needs Node, not Bun - verified).
// The Bun server talks to this over a Unix socket: spawn sessions,
// stream bytes, resize, subscribe with replay.
//
// Protocol: newline-delimited JSON messages.
//   client -> { type: "open", id, cwd, cmd[], env?, uid?, gid?, home? }
//   client -> { type: "input", id, data }
//   client -> { type: "resize", id, cols, rows }
//   client -> { type: "close", id }
//   client -> { type: "subscribe", id, replay? }
//   client -> { type: "list" }
//   daemon  -> { type: "output", id, data }   (data is base64)
//   daemon  -> { type: "exit", id, code }
//   daemon  -> { type: "ok", ... } | { type: "error", id, message }

const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");

let pty;
try {
  pty = require("node-pty");
} catch (e) {
  console.error("node-pty unavailable:", e.message);
  process.exit(1);
}

const SOCKET = process.env.PTY_SOCKET || "/tmp/kohlab-pty.sock";
const SESSIONS = new Map(); // id -> { pty, buffer: Buffer[], screen, serializer, exited }

/**
 * Screen models, not byte windows.
 *
 * `sess.buffer` is a rolling window trimmed from the front, so replaying it
 * cannot rebuild a full-screen TUI — the screen's current state depends on bytes
 * that scrolled out. A headless terminal holds the rendered grid instead, so a
 * reattach can be handed the screen itself.
 *
 * Runs here rather than in the server because this process is already Node (a
 * hard requirement of node-pty) and @xterm/headless is Node-only.
 */
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

/** Lines of scrollback each screen keeps. Bounds memory per live session. */
const SCREEN_SCROLLBACK = 2000;
/** Final screens retained after exit, newest first. Bounds memory overall. */
const RETAINED_SCREEN_LIMIT = 32;
/** id -> serialized screen of a session that has already exited. */
const retainedScreens = new Map();

function retainScreen(id, payload) {
  if (!payload) return;
  retainedScreens.delete(id); // re-insert so Map order stays oldest-first
  retainedScreens.set(id, payload);
  while (retainedScreens.size > RETAINED_SCREEN_LIMIT) {
    const oldest = retainedScreens.keys().next().value;
    if (oldest === undefined) break;
    retainedScreens.delete(oldest);
  }
}

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

// POSIX shell-quote a single argv token (for the `sh -c` limits wrapper).
function quote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function killTree(pid, signal) {
  // Snapshot the table ONCE, synchronously, before anything dies.
  let table = [];
  try {
    const out = require("child_process").execFileSync("ps", ["-eo", "pid=,ppid=,sid="], { encoding: "utf8" });
    table = out.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((p) => p.length === 3);
  } catch {}
  // 1) descendants by PPID chain
  const childrenOf = new Map();
  let session = null;
  for (const [child, parent, sid] of table) {
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(child);
    if (child === pid) session = sid;
  }
  const all = new Set();
  const walk = (p) => {
    all.add(p);
    for (const c of childrenOf.get(p) || []) walk(c);
  };
  walk(pid);
  // 2) strays in the same session (background jobs get their own PGID but share SID)
  for (const [child, , sid] of table) {
    if (sid === session) all.add(child);
  }
  // kill children first, then roots
  const ordered = [...all].reverse();
  for (const p of ordered) {
    try { process.kill(p, signal); } catch {}
  }
  try { process.kill(-pid, signal); } catch {}
}

function openSession(id, cwd, cmd, env, cols, rows, meta, limits, uid, gid, home) {
  if (SESSIONS.has(id)) {
    const existing = SESSIONS.get(id);
    if (existing.exited) SESSIONS.delete(id);
    else return { error: `session already exists: ${id}` };
  }
  // apply resource caps: `timeout` for wall-clock; a wrapper shell applies
  // `ulimit -d` (memory, RLIMIT_DATA — constrains Node's heap, unlike -v which
  // Node's V8 reservation bypasses) and `ulimit -u` (max procs) before exec'ing.
  const lim = limits || {};
  let argv = cmd;
  if (lim.maxMemoryMb || lim.maxProcs) {
    let preamble = "";
    if (lim.maxMemoryMb) preamble += `ulimit -d ${Math.floor(lim.maxMemoryMb * 1024)}; `;
    if (lim.maxProcs) preamble += `ulimit -u ${Math.floor(lim.maxProcs)}; `;
    argv = ["sh", "-c", `${preamble}exec ${cmd.map(quote).join(" ")}`];
  }
  if (lim.timeoutSec) {
    argv = ["timeout", String(Math.floor(lim.timeoutSec)), ...argv];
  }
  try {
    // v1.8: when the owner is provisioned, uid/gid drop privileges for the
    // whole PTY process tree and $HOME points at the owner's home.
    const spawnEnv = { ...process.env, ...(env || {}) };
    if (home) spawnEnv.HOME = home;
    const p = pty.spawn(argv[0], argv.slice(1), {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || os.homedir(),
      env: spawnEnv,
      ...(uid ? { uid } : {}),
      ...(gid ? { gid } : {}),
    });
    // `allowProposedApi` is REQUIRED by @xterm/headless v6 — without it even a
    // plain write() throws, and SerializeAddon refuses to load at all.
    const screen = new Terminal({
      cols: cols || 80,
      rows: rows || 24,
      scrollback: SCREEN_SCROLLBACK,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);

    const sess = { pty: p, buffer: [], screen, serializer, exited: false, subs: 0, meta: meta || {} };
    SESSIONS.set(id, sess);
    p.onData((data) => {
      const buf = Buffer.from(data);
      sess.buffer.push(buf);
      let total = 0;
      while (sess.buffer.length > 8) {
        total += sess.buffer[0].length;
        if (total > 262144) sess.buffer.shift();
        else break;
      }
      // Second parse, into the screen model. Same parser major as the browser's
      // terminal, so what this produces is what the client reconstructs.
      sess.screen.write(data);
      broadcast(id, { type: "output", id, data: b64(buf) });
    });
    p.onExit(({ exitCode }) => {
      sess.exited = true;
      broadcast(id, { type: "exit", id, code: exitCode });
      // Keep the final screen: a finished workspace should still show what the
      // agent did, which the byte buffer never could — the session and its
      // buffer are dropped below.
      sess.screen.write("", () => {
        try {
          retainScreen(id, sess.serializer.serialize());
        } catch {
          /* nothing to retain */
        }
        try {
          sess.screen.dispose();
        } catch {
          /* already gone */
        }
      });
      // remove from the map promptly so re-open works; the buffer is dropped
      // here too (no replay after exit).
      setTimeout(() => {
        const cur = SESSIONS.get(id);
        if (cur && cur.exited) SESSIONS.delete(id);
      }, 50);
    });
    return { ok: true, pid: p.pid };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Every connected server, not one.
 *
 * This was a single `client` overwritten by each new connection, so an earlier
 * subscriber silently stopped receiving output. Worse, when a socket died the
 * reference lingered: the next write raised EPIPE, and with no 'error' handler
 * on the socket that became an unhandled event that KILLED THE DAEMON — taking
 * every live agent session with it. That is reachable in production whenever the
 * server dies abruptly (kill -9, OOM) and leaves the daemon holding a dead
 * subscriber.
 */
const clients = new Set();

function broadcast(id, msg) {
  const line = JSON.stringify(msg) + "\n";
  for (const c of clients) {
    try {
      c.write(line);
    } catch {
      clients.delete(c);
    }
  }
}

const server = net.createServer((sock) => {
  clients.add(sock);
  // An 'error' with no listener is fatal to the process. A subscriber dropping
  // must never be able to take the daemon — and every agent — down with it.
  sock.on("error", () => {
    clients.delete(sock);
  });
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line), sock);
      } catch (e) {
        sock.write(JSON.stringify({ type: "error", message: e.message }) + "\n");
      }
    }
  });
  sock.on("close", () => {
    // keep sessions alive - just detach this subscriber
    clients.delete(sock);
  });
});

function handle(msg, sock) {
  switch (msg.type) {
    case "open": {
      const r = openSession(msg.id, msg.cwd, msg.cmd, msg.env, msg.cols, msg.rows, msg.meta, msg.limits, msg.uid, msg.gid, msg.home);
      sock.write(JSON.stringify({ type: "open-result", id: msg.id, ...r }) + "\n");
      break;
    }
    case "input": {
      const s = SESSIONS.get(msg.id);
      if (s && !s.exited) s.pty.write(Buffer.from(msg.data, "base64"));
      break;
    }
    case "resize": {
      const s = SESSIONS.get(msg.id);
      // Documented in the protocol header but never implemented, so every
      // resize was silently dropped: the PTY stayed at its spawn size while the
      // browser fitted a different one, and the agent never received SIGWINCH.
      if (s && !s.exited && msg.cols > 0 && msg.rows > 0) {
        try { s.pty.resize(msg.cols, msg.rows); } catch {}
        // The screen model must resize in lockstep or it diverges from the PTY
        // and every subsequent replay restores a wrongly-wrapped screen.
        try { s.screen.resize(msg.cols, msg.rows); } catch {}
      }
      break;
    }
    case "close": {
      const s = SESSIONS.get(msg.id);

      if (s) {
        // kill the whole process tree (children first, with retries)
        killTree(s.pty.pid, "SIGKILL");
        setTimeout(() => killTree(s.pty.pid, "SIGKILL"), 80);
        try { s.pty.kill("SIGHUP"); } catch {}
        s.exited = true;
        SESSIONS.delete(msg.id);
        broadcast(msg.id, { type: "exit", id: msg.id, code: null });
      }
      sock.write(JSON.stringify({ type: "closed", id: msg.id }) + "\n");
      break;
    }
    case "subscribe": {
      const s = SESSIONS.get(msg.id);
      if (!s) {
        // A finished session is gone from SESSIONS, but its final screen is
        // retained — so a stopped workspace still shows its output instead of
        // replaying nothing.
        const retained = retainedScreens.get(msg.id);
        if (retained && msg.replay !== false) {
          sock.write(JSON.stringify({ type: "output", id: msg.id, data: b64(Buffer.from(retained, "utf8")) }) + "\n");
          sock.write(JSON.stringify({ type: "subscribed", id: msg.id }) + "\n");
          break;
        }
        sock.write(JSON.stringify({ type: "error", id: msg.id, message: "unknown session" }) + "\n");
        break;
      }
      s.subs++;
      if (msg.replay === false) {
        sock.write(JSON.stringify({ type: "subscribed", id: msg.id }) + "\n");
        break;
      }
      // Replay the SCREEN, not the byte window. An empty write flushes the
      // parser queue in order, so serialize() here reflects every byte received
      // so far rather than lagging behind the pending writes.
      s.screen.write("", () => {
        try {
          const payload = s.serializer.serialize();
          if (payload) {
            sock.write(JSON.stringify({ type: "output", id: msg.id, data: b64(Buffer.from(payload, "utf8")) }) + "\n");
          }
        } catch {
          // Fall back to the byte window if the model is unavailable; worse for
          // a TUI, but better than replaying nothing.
          if (s.buffer.length) {
            sock.write(JSON.stringify({ type: "output", id: msg.id, data: b64(Buffer.concat(s.buffer)) }) + "\n");
          }
        }
        if (s.exited) {
          sock.write(JSON.stringify({ type: "exit", id: msg.id }) + "\n");
        }
        sock.write(JSON.stringify({ type: "subscribed", id: msg.id }) + "\n");
      });
      break;
    }
    case "unsubscribe": {
      const s = SESSIONS.get(msg.id);
      if (s) s.subs = Math.max(0, s.subs - 1);
      break;
    }
    case "list": {
      const sessions = [...SESSIONS.keys()].map((id) => {
        const s = SESSIONS.get(id);
        return { id, exited: s.exited, meta: s.meta };
      });
      sock.write(JSON.stringify({ type: "list-reply", sessions }) + "\n");
      break;
    }
    case "log": {
      const s = SESSIONS.get(msg.id);
      if (!s) {
        // The session is gone from SESSIONS, but its final screen is retained.
        // Without this a finished workspace showed an empty log, because the
        // byte buffer is dropped with the session.
        const retained = retainedScreens.get(msg.id);
        if (retained) {
          sock.write(
            JSON.stringify({ type: "log-reply", id: msg.id, data: Buffer.from(retained, "utf8").toString("base64") }) + "\n",
          );
          break;
        }
        sock.write(JSON.stringify({ type: "error", id: msg.id, message: "unknown session" }) + "\n");
        break;
      }
      const all = s.buffer.length ? Buffer.concat(s.buffer) : Buffer.alloc(0);
      sock.write(JSON.stringify({ type: "log-reply", id: msg.id, data: all.toString("base64") }) + "\n");
      break;
    }
}
}

// clean up socket file
try { fs.unlinkSync(SOCKET); } catch {}
server.listen(SOCKET, () => {
  console.error(`pty-daemon listening on ${SOCKET}`);
});
