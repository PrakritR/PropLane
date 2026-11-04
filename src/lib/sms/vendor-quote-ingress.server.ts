import "server-only";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const PURPOSE = "proplane:vendor-quote-ingress:v1";
const MAX_AGE_MS = 10 * 60_000;
export const REDACTED_QUOTE_BODY = "QUOTE [redacted]";
export type QuoteIngressIdentity = Readonly<{
  messageSid: string; wireFrom: string; wireTo: string; accountSid: string;
  runtime: string; providerMessagingServiceSid: string | null; payloadDigest: string;
}>;
export type VendorQuoteCapsule = Readonly<{ version: 1; nonce: string; ciphertext: string; tag: string; issuedAt: number; expiresAt: number }>;
/** This context is constructed only from the claimed envelope, never provider fields. */
export type ClaimedSmsIngressContext = Readonly<QuoteIngressIdentity & {
  envelopeId: string; quoteCapsule: VendorQuoteCapsule | null; quoteCapsuleExpiresAt: string | null;
}>;

export function exactVendorQuoteCode(body: string): string | null { return /^QUOTE (\d{12})$/i.exec(body.trim())?.[1] ?? null; }
export function isVendorQuoteProofBody(body: string): boolean { return exactVendorQuoteCode(body) !== null || /^QUOTE \[redacted\]$/i.test(body.trim()); }
function key(purpose: "seal" | "wire-digest"): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Quote ingress unavailable");
  return Buffer.from(hkdfSync("sha256", secret, PURPOSE, `${PURPOSE}:${purpose}`, 32));
}
export function vendorQuoteWireDigest(raw: string): string { return createHmac("sha256", key("wire-digest")).update(raw, "utf8").digest("hex"); }
function aad(identity: QuoteIngressIdentity, issuedAt: number, expiresAt: number): Buffer {
  return Buffer.from(JSON.stringify([PURPOSE, 1, identity.messageSid, identity.wireFrom, identity.wireTo,
    identity.accountSid, identity.runtime, identity.providerMessagingServiceSid, identity.payloadDigest, issuedAt, expiresAt]));
}
export function sealVendorQuoteCode(code: string, identity: QuoteIngressIdentity, now = Date.now()): VendorQuoteCapsule {
  if (!/^\d{12}$/.test(code) || !Number.isSafeInteger(now) || now <= 0) throw new Error("Quote ingress unavailable");
  const expiresAt = now + MAX_AGE_MS;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("seal"), nonce, { authTagLength: 16 });
  cipher.setAAD(aad(identity, now, expiresAt));
  const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return Object.freeze({ version: 1, nonce: nonce.toString("hex"), ciphertext: ciphertext.toString("hex"), tag: cipher.getAuthTag().toString("hex"), issuedAt: now, expiresAt });
}
/** Invalid, expired and rotated-key capsules all have the same code-free refusal. */
export function openVendorQuoteCode(capsule: VendorQuoteCapsule, identity: QuoteIngressIdentity, deadline: string | null, now = Date.now()): string | null {
  try {
    if (!capsule || capsule.version !== 1 || !/^[a-f0-9]{24}$/.test(capsule.nonce) || !/^[a-f0-9]{24}$/.test(capsule.ciphertext) || !/^[a-f0-9]{32}$/.test(capsule.tag) ||
      !Number.isSafeInteger(capsule.issuedAt) || !Number.isSafeInteger(capsule.expiresAt) || !Number.isSafeInteger(now) || capsule.issuedAt <= 0 || capsule.issuedAt > now ||
      capsule.expiresAt <= now || capsule.expiresAt <= capsule.issuedAt || capsule.expiresAt - capsule.issuedAt > MAX_AGE_MS || Date.parse(deadline ?? "") !== capsule.expiresAt) return null;
    const decipher = createDecipheriv("aes-256-gcm", key("seal"), Buffer.from(capsule.nonce, "hex"), { authTagLength: 16 });
    decipher.setAAD(aad(identity, capsule.issuedAt, capsule.expiresAt));
    decipher.setAuthTag(Buffer.from(capsule.tag, "hex"));
    const code = Buffer.concat([decipher.update(Buffer.from(capsule.ciphertext, "hex")), decipher.final()]).toString("utf8");
    return /^\d{12}$/.test(code) ? code : null;
  } catch { return null; }
}
