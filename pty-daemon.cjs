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

function openSession(id, cwd, cmd, env, cols, rows) {
  if (SESSIONS.has(id)) {
    const existing = SESSIONS.get(id);
    if (existing.exited) SESSIONS.delete(id);
    else return { error: `session already exists: ${id}` };
  }
  try {
    const p = pty.spawn(cmd[0], cmd.slice(1), {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || os.homedir(),
      env: { ...process.env, ...(env || {}) },
    });
    const sess = { pty: p, buffer: [], exited: false, subs: 0 };
    SESSIONS.set(id, sess);
    // PTY output -> buffer (ring, keep last ~256KB) + stream to subscribers
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
      const r = openSession(msg.id, msg.cwd, msg.cmd, msg.env, msg.cols, msg.rows);
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
      if (s && s.pty) s.pty.resize(msg.cols, msg.rows);
      break;
    }
    case "close": {
      const s = SESSIONS.get(msg.id);
      if (s) {
        try { s.pty.kill(); } catch {}
        s.exited = true;
        SESSIONS.delete(msg.id);
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
    case "list": {
      const ids = [...SESSIONS.keys()].map((id) => {
        const s = SESSIONS.get(id);
        return { id, exited: s.exited };
      });
      sock.write(JSON.stringify({ type: "list-reply", sessions: ids }) + "\n");
      break;
    }
  }
}

// clean up socket file
try { fs.unlinkSync(SOCKET); } catch {}
server.listen(SOCKET, () => {
  console.error(`pty-daemon listening on ${SOCKET}`);
});
