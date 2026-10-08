import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import {
  createVendorWorkIdentityProvider,
  getActiveVendorNumber,
  loadVendorVerifiedPhone,
  searchVendorWorkNumberCandidates,
  setupVendorWorkIdentity,
  type VendorWorkIdentityProvider,
} from "@/lib/vendor-work-identity.server";
import {
  isUsLocalSmsNumber,
  signVendorWorkNumberClaim,
  verifyVendorWorkNumberClaim,
} from "@/lib/vendor-work-number-claim-token.server";

/** Fixed namespace for the deterministic signup idempotency key (any constant UUID). */
const SIGNUP_NAMESPACE = "6f1d3f4a-2b0e-5c1a-9a52-7d1b8c0e4a11";

/**
 * `signup:<userId>` as a UUID. The claim RPC keys on a UUID, so the signup
 * intent is hashed (UUID v5) rather than stored verbatim: the same vendor always
 * derives the same key, which is what makes a retried signup unable to buy twice.
 */
export function vendorSignupIdempotencyKey(userId: string): string {
  const namespace = Buffer.from(SIGNUP_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespace).update(`signup:${userId}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The area code of a US/Canada E.164 number, or null for anything else. */
export function areaCodeOfPhone(e164: string | null | undefined): string | null {
  const match = /^\+1([2-9]\d{2})\d{7}$/.exec(e164 ?? "");
  return match ? match[1]! : null;
}

export type SignupWorkNumberResult =
  | { status: "provisioned" | "already"; phoneNumber: string }
  | { status: "skipped"; reason: "phone_unverified" | "no_candidate" | "not_ready" }
  | { status: "failed" };

/**
 * Give a vendor who just finished onboarding a PropLane number, picked on the
 * server near their VERIFIED phone's area code (falling back to their first
 * service zip). Never accepts a number from a client: the candidate comes from
 * the provider search, the claim is minted and verified here, and the purchase
 * runs through the same `setupVendorWorkIdentity` path as the Settings claim, so
 * every existing gate applies (runtime switch, provider env, provisioning flag or
 * dry run, verified phone, one number per vendor, idempotent claim, capacity).
 *
 * Soft-fails: any error resolves to `{ status: "failed" }` and the vendor simply
 * claims from Settings instead. It enables nothing: with the gates off this
 * returns "skipped" without spending anything.
 */
export async function provisionVendorWorkNumberAtSignup(
  db: SupabaseClient,
  vendorUserId: string,
  deps: { provider?: VendorWorkIdentityProvider; serviceAreaZips?: readonly string[] } = {},
): Promise<SignupWorkNumberResult> {
  try {
    const verified = await loadVendorVerifiedPhone(db, vendorUserId);
    if (!verified.verified || !verified.phone) return { status: "skipped", reason: "phone_unverified" };

    // A retried Finish never searches (or buys) again for a vendor who already has a number.
    const existing = await getActiveVendorNumber(db, vendorUserId);
    if (existing) return { status: "already", phoneNumber: existing.phoneNumber };

    const provider = deps.provider ?? createVendorWorkIdentityProvider();
    const areaCode = areaCodeOfPhone(normalizeE164(verified.phone)) ?? "";
    const zip = (deps.serviceAreaZips ?? []).map((z) => z.trim()).find((z) => /^\d{5}$/.test(z));

    let candidates = areaCode || zip ? await searchVendorWorkNumberCandidates(areaCode, provider, areaCode ? undefined : zip) : [];
    // The phone's own area code has nothing free: widen to the service zip.
    if (candidates.length === 0 && areaCode && zip) candidates = await searchVendorWorkNumberCandidates("", provider, zip);
    const phoneNumber = candidates.find((candidate) => isUsLocalSmsNumber(candidate));
    if (!phoneNumber) return { status: "skipped", reason: "no_candidate" };

    // Same chain as the Settings claim: a signed claim bound to THIS vendor and THIS number.
    const claim = verifyVendorWorkNumberClaim(signVendorWorkNumberClaim({ vendorUserId, phoneNumber }));
    if (!claim || claim.vendorUserId !== vendorUserId || claim.phoneNumber !== phoneNumber) return { status: "failed" };

    const identity = await setupVendorWorkIdentity(db, vendorUserId, vendorSignupIdempotencyKey(vendorUserId), "sms", provider, claim.phoneNumber);
    const number = identity.sms.value;
    if (number && identity.sms.state === "ready") {
      // `already` when an earlier call (a retried Finish) bought it: the number is not the one we picked.
      return { status: number === phoneNumber ? "provisioned" : "already", phoneNumber: number };
    }
    return { status: "skipped", reason: "not_ready" };
  } catch (error) {
    console.error("vendor signup work number failed", vendorUserId, error instanceof Error ? error.message : error);
    return { status: "failed" };
  }
}
