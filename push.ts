// Web Push: a phone hears that an agent finished even with Safari closed.
//
// Written against RFC 8030 (delivery), RFC 8291 (message encryption, aes128gcm)
// and RFC 8292 (VAPID), with node:crypto and no dependency. scripts/check-push-crypto.ts
// runs RFC 8291's own test vector through `encrypt`, so the part that is easy to
// get subtly wrong is checked against the standard, not against itself.

import { createCipheriv, createECDH, createHmac, createPrivateKey, createSign, generateKeyPairSync, randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Workspace } from "./types";
import { WORKS_DIR } from "./lib";

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** "" for the legacy key or an open server */
  userId: string;
  role: string | null;
}

// --- keys and subscriptions -------------------------------------------------

const VAPID_FILE = join(WORKS_DIR, "vapid.json");
const SUBS_FILE = join(WORKS_DIR, "push.json");

interface Vapid {
  publicKey: string; // base64url, 65-byte uncompressed point
  d: string; // base64url private scalar
}

let vapid: Vapid | null = null;
export function vapidKey(): Vapid {
  if (vapid) return vapid;
  if (existsSync(VAPID_FILE)) return (vapid = JSON.parse(readFileSync(VAPID_FILE, "utf8")) as Vapid);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string; y: string };
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  vapid = { publicKey: b64u(pub), d: jwk.d };
  writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 });
  return vapid;
}

function readSubs(): PushSub[] {
  try {
    return JSON.parse(readFileSync(SUBS_FILE, "utf8")) as PushSub[];
  } catch {
    return [];
  }
}
function writeSubs(subs: PushSub[]) {
  writeFileSync(SUBS_FILE, JSON.stringify(subs), { mode: 0o600 });
}

export function subscribe(sub: PushSub) {
  writeSubs([...readSubs().filter((s) => s.endpoint !== sub.endpoint), sub]);
}
export function unsubscribe(endpoint: string) {
  writeSubs(readSubs().filter((s) => s.endpoint !== endpoint));
}

// --- crypto -----------------------------------------------------------------

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
/** RFC 5869 HKDF-SHA256, one block is enough for every length used here (<= 32). */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

function freshKey() {
  const k = createECDH("prime256v1");
  k.generateKeys();
  return k;
}

/** RFC 8291 section 3.4. `asKey` and `salt` are only fixed by the test vector. */
export function encrypt(
  plaintext: Buffer,
  uaPublic: Buffer,
  authSecret: Buffer,
  asKey = freshKey(),
  salt = randomBytes(16),
): Buffer {
  const asPublic = asKey.getPublicKey();
  const shared = asKey.computeSecret(uaPublic);
  const key = hkdf(authSecret, shared, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, key, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, key, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // one record: the payload, then the 0x02 delimiter that marks the last record
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);
  return Buffer.concat([header, body]);
}

/** RFC 8292: a short-lived ES256 JWT naming the push service's origin. */
export function vapidAuthorization(endpoint: string): string {
  const v = vapidKey();
  const pub = unb64u(v.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: v.d, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) },
    format: "jwk",
  });
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:kohlab@localhost" }),
    ),
  );
  const sig = createSign("SHA256").update(`${head}.${claims}`).sign({ key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

// --- sending ----------------------------------------------------------------

/** true = delivered or at least accepted; false = the subscription is gone and was dropped. */
export async function sendPush(sub: PushSub, payload: object): Promise<boolean> {
  const body = encrypt(Buffer.from(JSON.stringify(payload)), unb64u(sub.p256dh), unb64u(sub.auth));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: vapidAuthorization(sub.endpoint),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "normal",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 410) {
    unsubscribe(sub.endpoint);
    return false;
  }
  if (!res.ok) throw new Error(`push service answered ${res.status}`);
  return true;
}

/** Everyone who may see this workspace hears that it needs review. */
export async function notifyDone(ws: Workspace): Promise<void> {
  const payload = {
    title: "kohlab, ready for review",
    body: ws.task || `${ws.id} finished`,
    // the same tag the open tab uses, so one ping replaces the other
    tag: `kohlab-${ws.id}`,
    url: `/w/${ws.id}`,
  };
  for (const sub of readSubs()) {
    const mayHear = !sub.userId || sub.role === "owner" || ws.ownerId === sub.userId;
    if (!mayHear) continue;
    await sendPush(sub, payload).catch((e) => console.warn(`push to a device failed: ${(e as Error).message}`));
  }
}

export function findSub(endpoint: string): PushSub | undefined {
  return readSubs().find((s) => s.endpoint === endpoint);
}
