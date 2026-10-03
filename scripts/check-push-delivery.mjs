#!/usr/bin/env node
/**
 * Web Push, end to end against a fake push service on https://127.0.0.1.
 *
 * A device subscribes; an agent finishes; the "push service" must receive one
 * POST that carries a VAPID header and a body only that device's key can open,
 * and the body must say which workspace to open. Run: node scripts/check-push-delivery.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};

const dir = mkdtempSync(join(tmpdir(), "kohlab-pushd-"));
const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=127.0.0.1", "-days", "1"], { encoding: "utf8" });
if (cert.status !== 0) {
  console.log("  skip push delivery: needs openssl");
  process.exit(0);
}

const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
const hkdf = (salt, ikm, info, n) => hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, n);
function decrypt(body, ua, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const key = hkdf(authSecret, ua.computeSecret(asPub), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub]), 32);
  const d = createDecipheriv("aes-128-gcm", hkdf(salt, key, Buffer.from("Content-Encoding: aes128gcm\0"), 16), hkdf(salt, key, Buffer.from("Content-Encoding: nonce\0"), 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2));
}

const received = [];
const fake = createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201).end();
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fakePort = fake.address().port;

const PORT = 7871, KEY = "pk";
const repo = join(dir, "repo");
spawnSync("git", ["init", "-q", "-b", "main", repo]);
spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "s"]);
const proc = spawn("bun", ["run", "server.ts"], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: join(dir, "w"), PTY_SOCKET: join(dir, "p.sock"), NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  stdio: "ignore",
});
const api = (p, body) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const vapid = await (await api("/api/push/key")).json();
  check("the server hands out a VAPID public key", Buffer.from(vapid.key, "base64url").length === 65);

  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const authSecret = Buffer.from("0123456789abcdef");
  const endpoint = `https://127.0.0.1:${fakePort}/push/device-1`;
  const sub = { endpoint, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") } };
  check("a plain http endpoint is refused", (await api("/api/push/subscribe", { ...sub, endpoint: "http://x/y" })).status === 400);
  check("subscribing works", (await api("/api/push/subscribe", sub)).status === 200);

  const test = await api("/api/push/test", { endpoint });
  check("the test button reaches the push service", test.status === 200 && received.length === 1);
  const first = received[0];
  check("it carries a VAPID authorization", /^vapid t=.+, k=.+$/.test(first?.headers.authorization ?? ""));
  check("and is aes128gcm encrypted", first?.headers["content-encoding"] === "aes128gcm");
  check("only the device's key opens it", JSON.parse(decrypt(first.body, ua, authSecret).toString()).title === "kohlab");

  // an agent finishing sends the real one
  const ws = await (await api("/api/workspaces", { repo, task: "write the docs", agent: "sh" })).json();
  await api(`/api/workspaces/${ws.id}/start`, {});
  const term = new WebSocket(`ws://127.0.0.1:${PORT}/?key=${KEY}`);
  await new Promise((r) => (term.onopen = r));
  term.send(JSON.stringify({ type: "attach", id: ws.id, terminalId: "main" }));
  await new Promise((r) => setTimeout(r, 1500));
  term.send("exit\r");
  for (let i = 0; i < 40 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 500));
  check("a finished agent sends a push", received.length === 2);
  if (received[1]) {
    const msg = JSON.parse(decrypt(received[1].body, ua, authSecret).toString());
    check("saying what finished", msg.body === "write the docs");
    check("and where to open it", msg.url === `/w/${ws.id}`);
  }

  await api("/api/push/unsubscribe", { endpoint });
  check("after unsubscribing, the test refuses", (await api("/api/push/test", { endpoint })).status === 404);
} finally {
  proc.kill("SIGKILL");
  spawnSync("pkill", ["-f", join(dir, "p.sock")]);
  fake.close();
}
process.exit(failed ? 1 : 0);
