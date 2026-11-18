import "server-only";

import { createHash, createPublicKey, createVerify, timingSafeEqual, type JsonWebKey } from "node:crypto";
import { getPlaidClient } from "@/lib/plaid/client.server";

/** Plaid's documented replay window for a webhook JWT. */
export const PLAID_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;

export type PlaidVerificationKey = JsonWebKey & { alg?: string; kid?: string; expired_at?: number | null };
export type PlaidKeyFetcher = (kid: string) => Promise<PlaidVerificationKey | null>;

export type PlaidWebhookVerdict = { ok: true } | { ok: false; reason: string };

const keyCache = new Map<string, { key: PlaidVerificationKey; at: number }>();

/** Fetch (and cache for an hour) the verification key Plaid names by `kid`. */
export const fetchPlaidVerificationKey: PlaidKeyFetcher = async (kid) => {
  const hit = keyCache.get(kid);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.key;
  try {
    const res = await getPlaidClient().webhookVerificationKeyGet({ key_id: kid });
    const key = res.data.key as unknown as PlaidVerificationKey;
    keyCache.set(kid, { key, at: Date.now() });
    return key;
  } catch {
    return null;
  }
};

function b64urlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function parseJson(buf: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(buf.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Verify Plaid's `Plaid-Verification` JWT: ES256 signed by the key at `kid`, `iat` within five
 * minutes, and `request_body_sha256` equal to the SHA-256 of the RAW request body. Fails closed.
 */
export async function verifyPlaidWebhook(
  rawBody: string,
  header: string | null,
  options: { fetchKey?: PlaidKeyFetcher; nowSeconds?: number } = {},
): Promise<PlaidWebhookVerdict> {
  if (!header) return { ok: false, reason: "missing_signature" };
  const parts = header.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: "malformed_jwt" };
  const [encHeader, encPayload, encSignature] = parts as [string, string, string];

  const jwtHeader = parseJson(b64urlToBuffer(encHeader));
  if (!jwtHeader || jwtHeader.alg !== "ES256" || typeof jwtHeader.kid !== "string" || !jwtHeader.kid) {
    return { ok: false, reason: "bad_header" };
  }

  const key = await (options.fetchKey ?? fetchPlaidVerificationKey)(jwtHeader.kid);
  if (!key) return { ok: false, reason: "unknown_key" };
  if (key.expired_at != null) return { ok: false, reason: "expired_key" };

  let signatureOk = false;
  try {
    const publicKey = createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, format: "jwk" });
    const verifier = createVerify("SHA256");
    verifier.update(`${encHeader}.${encPayload}`);
    signatureOk = verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, b64urlToBuffer(encSignature));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: "bad_signature" };

  const payload = parseJson(b64urlToBuffer(encPayload));
  const iat = payload?.iat;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return { ok: false, reason: "missing_iat" };
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now - iat > PLAID_WEBHOOK_MAX_AGE_SECONDS || iat - now > 60) return { ok: false, reason: "stale" };

  const claimed = payload?.request_body_sha256;
  if (typeof claimed !== "string" || !/^[0-9a-f]{64}$/i.test(claimed)) return { ok: false, reason: "missing_body_hash" };
  const actual = createHash("sha256").update(rawBody, "utf8").digest();
  const expected = Buffer.from(claimed.toLowerCase(), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "body_mismatch" };
  return { ok: true };
}
