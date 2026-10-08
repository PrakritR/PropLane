import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadVendorBusinessProfile } from "@/lib/vendor-business-profile.server";
import { provisionVendorWorkNumberAtSignup } from "@/lib/vendor-work-number-signup.server";
import { isNumberSubscriptionEnabled } from "./constants";

export type VendorActivationResult = "provisioned" | "already" | "skipped" | "failed";

/**
 * Right after a vendor's PropLane Number subscription becomes `active`, give them their number
 * through the same gated signup path (verified phone, one number per vendor, provider and
 * provisioning switches). Called by the signed Stripe webhook only after the subscription write
 * was APPLIED, so the owner comes from our own row, never from the event's metadata.
 *
 * Idempotent: an existing number answers `already`, and the claim key is seeded with the Stripe
 * subscription id, so a replayed event never buys twice while a fresh subscription after a
 * released number does. Soft-fails: this never throws, because the webhook must acknowledge the
 * payment; the vendor can still claim from Settings.
 */
export async function provisionVendorNumberOnActivation(
  db: SupabaseClient,
  subscription: string | { id?: string | null } | null | undefined,
  deps: { provision?: typeof provisionVendorWorkNumberAtSignup } = {},
): Promise<VendorActivationResult> {
  try {
    if (!isNumberSubscriptionEnabled()) return "skipped";
    const subscriptionId = (typeof subscription === "string" ? subscription : subscription?.id)?.trim();
    if (!subscriptionId) return "skipped";
    const { data, error } = await db
      .from("number_subscriptions")
      .select("owner_user_id,owner_role,status")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();
    if (error) return "failed";
    const row = data as { owner_user_id?: string; owner_role?: string; status?: string } | null;
    if (!row?.owner_user_id || row.owner_role !== "vendor" || row.status !== "active") return "skipped";

    let serviceAreaZips: string[] = [];
    try {
      serviceAreaZips = (await loadVendorBusinessProfile(db, row.owner_user_id)).serviceAreaZips;
    } catch {
      // The phone's own area code is enough to search; zips only widen it.
    }
    const result = await (deps.provision ?? provisionVendorWorkNumberAtSignup)(db, row.owner_user_id, {
      serviceAreaZips,
      idempotencySeed: subscriptionId,
    });
    if (result.status === "provisioned" || result.status === "already") return result.status;
    return result.status === "failed" ? "failed" : "skipped";
  } catch (error) {
    console.error("[vendor number] activation provisioning failed", error instanceof Error ? error.message : "unknown");
    return "failed";
  }
}
