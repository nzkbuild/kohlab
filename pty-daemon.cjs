// kohlab PTY daemon - long-lived process owning real PTYs.
// Runs under Node (node-pty needs Node, not Bun - verified).
// The Bun server talks to this over a Unix socket: spawn sessions,
// stream bytes, resize, subscribe with replay.
//
// Protocol: newline-delimited JSON messages.
//   client -> { type: "open", id, cwd, cmd[], env? }
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
const SESSIONS = new Map(); // id -> { pty, buffer: Buffer[] , exited }

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

function openSession(id, cwd, cmd, env, cols, rows, meta, limits) {
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
    const p = pty.spawn(argv[0], argv.slice(1), {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || os.homedir(),
      env: { ...process.env, ...(env || {}) },
    });
    const sess = { pty: p, buffer: [], exited: false, subs: 0, meta: meta || {} };
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
      broadcast(id, { type: "output", id, data: b64(buf) });
    });
    p.onExit(({ exitCode }) => {
      sess.exited = true;
      broadcast(id, { type: "exit", id, code: exitCode });
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

function broadcast(id, msg) {
  // The daemon is single-client (the Bun server) for now; it fans out.
  if (client) client.write(JSON.stringify(msg) + "\n");
}
let client = null;

const server = net.createServer((sock) => {
  client = sock;
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
    // keep sessions alive - just detach
    client = null;
  });
});

function handle(msg, sock) {
  switch (msg.type) {
    case "open": {
      const r = openSession(msg.id, msg.cwd, msg.cmd, msg.env, msg.cols, msg.rows, msg.meta, msg.limits);
      sock.write(JSON.stringify({ type: "open-result", id: msg.id, ...r }) + "\n");
      break;
    }
    case "input": {
      const s = SESSIONS.get(msg.id);
      if (s && !s.exited) s.pty.write(Buffer.from(msg.data, "base64"));
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
        sock.write(JSON.stringify({ type: "error", id: msg.id, message: "unknown session" }) + "\n");
        break;
      }
      s.subs++;
      // replay: send buffered bytes
      if (msg.replay !== false && s.buffer.length) {
        const all = Buffer.concat(s.buffer);
        sock.write(JSON.stringify({ type: "output", id: msg.id, data: b64(all) }) + "\n");
      }
      if (s.exited) {
        sock.write(JSON.stringify({ type: "exit", id: msg.id }) + "\n");
      }
      sock.write(JSON.stringify({ type: "subscribed", id: msg.id }) + "\n");
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
