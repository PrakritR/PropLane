import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { featureSigningSecret } from "@/lib/feature-signing-secret.server";

/**
 * Signs which EXACT number a vendor may claim, so `POST
 * /api/vendor/work-identity` can never be made to purchase an arbitrary
 * Twilio number just by receiving a `phoneNumber` in the body — that field
 * was previously trusted outright ("came from our own search" was only a
 * comment, never enforced). The candidates search
 * (`/api/vendor/work-identity/candidates`) mints one of these per offered
 * number; the claim route verifies it before ever calling the provider.
 *
 * Same shape as the other self-contained HMAC tokens in this app
 * (`signMcpApproval`/`verifyMcpApproval` in `src/lib/mcp/oauth.server.ts`,
 * `signOAuthState`/`verifyOAuthState` in `src/lib/google-calendar/api.server.ts`):
 * JSON payload -> base64url -> HMAC-SHA256, expiry embedded in the signed
 * payload, `timingSafeEqual` compare. Following this repo's convention of
 * feature-scoped secrets (no generic app-wide signing key exists — see
 * rate-limit.ts and mcp/oauth.server.ts), the HMAC key reuses
 * `SUPABASE_SERVICE_ROLE_KEY`, which every real deployment already requires
 * for the service-role client this whole module runs under. Missing it is a
 * refusal to sign (`featureSigningSecret`), never a literal fallback: a
 * published key would let anyone mint a claim for an arbitrary number.
 */
export type VendorWorkNumberClaimPayload = {
  vendorUserId: string;
  phoneNumber: string;
  expiresAt: number;
};

const CLAIM_TOKEN_TTL_MS = 15 * 60_000;

function claimSigningSecret(): string {
  return featureSigningSecret("vendor-work-number-claim");
}

function hmac(encodedPayload: string): string {
  return createHmac("sha256", claimSigningSecret()).update(encodedPayload).digest("base64url");
}

export function signVendorWorkNumberClaim(input: { vendorUserId: string; phoneNumber: string }): string {
  const payload: VendorWorkNumberClaimPayload = {
    vendorUserId: input.vendorUserId,
    phoneNumber: input.phoneNumber,
    expiresAt: Date.now() + CLAIM_TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${hmac(encoded)}`;
}

/** Verifies signature + shape + expiry only. Callers must separately check vendor identity and number eligibility. */
export function verifyVendorWorkNumberClaim(token: string): VendorWorkNumberClaimPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  const expected = hmac(encoded);
  const provided = Buffer.from(signature, "base64url");
  const wanted = Buffer.from(expected, "base64url");
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as VendorWorkNumberClaimPayload).vendorUserId !== "string" ||
    typeof (payload as VendorWorkNumberClaimPayload).phoneNumber !== "string" ||
    typeof (payload as VendorWorkNumberClaimPayload).expiresAt !== "number"
  ) {
    return null;
  }
  const result = payload as VendorWorkNumberClaimPayload;
  if (result.expiresAt <= Date.now()) return null;
  return result;
}

/** US toll-free NPAs — never a purchasable "local" sponsored number. */
const US_TOLL_FREE_NPAS = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/**
 * True only for a plausible US/Canada NANP local number: +1, a real-shaped
 * area code (first digit 2-9, not toll-free), and a real-shaped exchange
 * (first digit 2-9). Rejects toll-free, premium-rate-shaped, and any
 * non-NANP (foreign) number before it ever reaches a Twilio purchase call.
 */
export function isUsLocalSmsNumber(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11 || !digits.startsWith("1")) return false;
  const npa = digits.slice(1, 4);
  const nxx = digits.slice(4, 7);
  if (!/^[2-9]\d{2}$/.test(npa) || !/^[2-9]\d{2}$/.test(nxx)) return false;
  if (US_TOLL_FREE_NPAS.has(npa)) return false;
  return true;
}
