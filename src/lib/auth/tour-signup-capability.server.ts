import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export function tourCapabilityDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Call only for a freshly created inquiry; the token is returned for original-recipient delivery. */
export async function issueTourSignupCapability(db: SupabaseClient, input: { inquiryId: string; email: string; managerUserId: string; propertyId: string; tourGroupId?: string | null }): Promise<string | null> {
  if (!input.inquiryId || !input.email.includes("@") || !input.managerUserId || !input.propertyId) return null;
  const cleanup = await db.rpc("purge_expired_tour_signup_capabilities");
  if (cleanup.error) return null;
  const token = randomBytes(32).toString("hex");
  const { data, error } = await db.rpc("issue_tour_signup_capability", { p_digest: tourCapabilityDigest(token), p_inquiry_id: input.inquiryId, p_email: input.email.trim().toLowerCase(), p_manager_id: input.managerUserId, p_property_id: input.propertyId, p_group_id: input.tourGroupId || null, p_expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() });
  return error || data !== true ? null : token;
}
