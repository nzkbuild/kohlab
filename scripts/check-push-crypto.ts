/**
 * Web Push encryption against RFC 8291 appendix A: if `encrypt` reproduces the
 * standard's own ciphertext byte for byte, a phone's push service will decrypt it.
 * Run: bun scripts/check-push-crypto.ts
 */
import { createECDH } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKS_DIR = mkdtempSync(join(tmpdir(), "kohlab-pushc-"));
const { encrypt, vapidKey, vapidAuthorization } = await import("../push");
const { createPublicKey, createVerify } = await import("node:crypto");

const u = (s: string) => Buffer.from(s, "base64url");
const asKey = createECDH("prime256v1");
asKey.setPrivateKey(u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"));
const out = encrypt(
  Buffer.from("When I grow up, I want to be a watermelon"),
  u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
  u("BTBZMqHH6r4Tts7J_aSIgg"),
  asKey,
  u("DGv6ra1nlYgDCS1FRnbzlw"),
);
const want =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
};
check("matches the RFC 8291 test vector", out.toString("base64url") === want);
check("a VAPID public key is a 65-byte uncompressed point", u(vapidKey().publicKey).length === 65 && u(vapidKey().publicKey)[0] === 4);
check("a default (random) sender key and salt still produces a record", encrypt(Buffer.from("x"), u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"), u("BTBZMqHH6r4Tts7J_aSIgg")).length > 86);

// The JWT must verify under the public key we hand the push service.
const header = vapidAuthorization("https://web.push.apple.com/abc");
const [, jwt, k] = /t=([^,]+), k=(.+)$/.exec(header)!;
const [h, c, s] = jwt.split(".");
const pub = u(k);
const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
check("the VAPID JWT verifies under the advertised key", createVerify("SHA256").update(`${h}.${c}`).verify({ key, dsaEncoding: "ieee-p1363" }, u(s)));
check("and names the push service's origin", JSON.parse(u(c).toString()).aud === "https://web.push.apple.com");
process.exit(failed ? 1 : 0);
