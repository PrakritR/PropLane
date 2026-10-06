import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta's required data-deletion callback. Meta POSTs `signed_request=<sig>.<payload>` (both
 * base64url); the signature is HMAC-SHA256 of the encoded payload keyed with the app secret. The
 * response is `{ url, confirmation_code }`, where `url` is a page the person can open to see the
 * status. The confirmation code is stateless: it is signed, so the status page can verify it without
 * a table that would itself hold a Meta user's id.
 */
export type MetaSignedRequest = { user_id: string; algorithm?: string; issued_at?: number };

export function verifyMetaSignedRequest(signedRequest: string | null | undefined, appSecret: string): MetaSignedRequest | null {
  if (!signedRequest || !appSecret) return null;
  const [encodedSig, encodedPayload, ...rest] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload || rest.length > 0) return null;
  try {
    const given = Buffer.from(encodedSig, "base64url");
    const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<MetaSignedRequest>;
    if (typeof payload.user_id !== "string" || !payload.user_id.trim()) return null;
    if (payload.algorithm && String(payload.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    return { user_id: payload.user_id.trim(), algorithm: payload.algorithm, issued_at: payload.issued_at };
  } catch {
    return null;
  }
}

function codeSignature(body: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(`meta-data-deletion:${body}`).digest("base64url").slice(0, 32);
}

/** `<base64url({h,t})>.<sig>`: carries a one-way hash of the Meta id and the deletion time, never the id. */
export function mintDeletionConfirmationCode(metaUserId: string, appSecret: string, now = Date.now()): string {
  const h = createHash("sha256").update(metaUserId).digest("hex").slice(0, 12);
  const body = Buffer.from(JSON.stringify({ h, t: now })).toString("base64url");
  return `${body}.${codeSignature(body, appSecret)}`;
}

export function readDeletionConfirmationCode(code: string | null | undefined, appSecret: string): { deletedAt: string } | null {
  if (!code || !appSecret) return null;
  const [body, sig, ...rest] = code.split(".");
  if (!body || !sig || rest.length > 0) return null;
  const expected = Buffer.from(codeSignature(body, appSecret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { t?: number };
    if (typeof parsed.t !== "number") return null;
    return { deletedAt: new Date(parsed.t).toISOString() };
  } catch {
    return null;
  }
}
