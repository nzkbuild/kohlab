#!/usr/bin/env node
// The pairing claim is throttled like a wrong key (v2.9.4). Against a throwaway server on its own PORT (7953):
//   - a source that makes many wrong claims is refused, with the same answer a wrong code gets;
//   - a right code still works from a clean source (127.0.0.2 on this box, a second loopback address);
//   - wrong, spent and expired claims all read the same: the same status and the same body.
// The short code TTL (8 s) is set for this check only; the server reads it at start.
//
//   node scripts/check-pair-throttle.mjs
import { request } from "node:http";
import { startFixture } from "./ui-fixture.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const KEY = "pair-throttle-check-key";
const SAME = { status: 400, body: '{"error":"that code was not accepted"}' };
const TTL_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST JSON from a chosen local address, so the server sees a different source. */
function post(base, path, body, { from = "127.0.0.1", auth = false } = {}) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(data) };
    if (auth) headers.authorization = `Bearer ${KEY}`;
    const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers, localAddress: from }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: text }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

process.env.KOHLAB_PAIR_TTL_MS = String(TTL_MS);
const fx = await startFixture({ port: 7953, key: KEY });
try {
  const same = (r) => r.status === SAME.status && r.body === SAME.body;

  // 1. Mint one code. It is the only live code, so it is the one every later claim aims at.
  const mint = await post(fx.base, "/api/pair", {}, { auth: true });
  const code = JSON.parse(mint.body).code;
  check("minted a code shaped XXXXX-XXXXX", /^[A-Z]{5}-[A-Z]{5}$/.test(code ?? ""), String(code));

  // 2. Wrong claims from one source. The per-source window allows 20 failures a minute.
  const wrong = [];
  for (let i = 0; i < 25; i++) wrong.push(await post(fx.base, "/api/pair/claim", { code: "BBBBB-BBBBB" }));
  check("wrong claims are all the same answer (400, one body)", wrong.every(same), wrong.map((r) => r.status).join(","));
  check("the right code is refused from that source too (throttled, same answer)", same(await post(fx.base, "/api/pair/claim", { code })));

  // 3. A clean source: the right code still works. The throttle is per source, so this is not locked out.
  const claimed = await post(fx.base, "/api/pair/claim", { code }, { from: "127.0.0.2" });
  check("a right code works from a clean source", claimed.status === 200 && /"key"/.test(claimed.body), `${claimed.status}`);

  // 4. Spent: the same code again, from the clean source.
  const spent = await post(fx.base, "/api/pair/claim", { code }, { from: "127.0.0.2" });
  check("a spent code reads the same as a wrong one", same(spent), `${spent.status} ${spent.body}`);

  // 5. Wrong, from the clean source.
  const wrongClean = await post(fx.base, "/api/pair/claim", { code: "BBBBB-BBBBB" }, { from: "127.0.0.2" });
  check("a wrong code from a clean source is the same answer", same(wrongClean), `${wrongClean.status} ${wrongClean.body}`);

  // 6. Expired: mint, wait past the TTL, claim the right code.
  const mint2 = await post(fx.base, "/api/pair", {}, { auth: true });
  const code2 = JSON.parse(mint2.body).code;
  await sleep(TTL_MS + 1000);
  const expired = await post(fx.base, "/api/pair/claim", { code: code2 }, { from: "127.0.0.2" });
  check("an expired code reads the same as a wrong one", same(expired), `${expired.status} ${expired.body}`);

  // 7. No code at all: the same answer again.
  const empty = await post(fx.base, "/api/pair/claim", {}, { from: "127.0.0.2" });
  check("a missing code reads the same", same(empty), `${empty.status} ${empty.body}`);
} finally {
  fx.stop();
}

console.log(failures ? `\n${failures} failed` : "\nall pair throttle checks passed");
process.exit(failures ? 1 : 0);
