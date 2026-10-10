import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadVendorBusinessProfile } from "@/lib/vendor-business-profile.server";
import { setupVendorWorkIdentity } from "@/lib/vendor-work-identity.server";
import { provisionVendorWorkNumberAtSignup, vendorSignupIdempotencyKey } from "@/lib/vendor-work-number-signup.server";
import { isNumberSubscriptionEnabled } from "./constants";

export type VendorActivationResult = "provisioned" | "already" | "skipped" | "failed";

function logOutcome(subscriptionId: string, what: string, outcome: string) {
  // A skipped or failed provisioning is never silent in the server log; the vendor sees the real state
  // in Settings (Setting up, Failed, or the claim flow to retry).
  if (outcome === "provisioned" || outcome === "already" || outcome === "ready") return;
  console.warn("[vendor number] activation", { subscription: subscriptionId, what, outcome });
}

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
  deps: { provision?: typeof provisionVendorWorkNumberAtSignup; setupEmail?: typeof setupVendorWorkIdentity } = {},
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
    logOutcome(subscriptionId, "number", result.status === "skipped" ? `skipped:${result.reason}` : result.status);

    // The plan is a work number AND a work email: the email half is set up under the same subscription
    // (its own idempotency key, so a replay never repeats it). Soft-fail and independent of the number:
    // an unverified phone or a number outage must not hold the email back. Settings still offers Claim.
    try {
      const identity = await (deps.setupEmail ?? setupVendorWorkIdentity)(
        db,
        row.owner_user_id,
        vendorSignupIdempotencyKey(row.owner_user_id, `email:${subscriptionId}`),
        "email",
      );
      logOutcome(subscriptionId, "email", identity.email.state === "ready" ? "ready" : `${identity.email.state}:${identity.email.blockedReason}`);
    } catch (error) {
      console.error("[vendor number] activation email failed", error instanceof Error ? error.message : "unknown");
    }

    if (result.status === "provisioned" || result.status === "already") return result.status;
    return result.status === "failed" ? "failed" : "skipped";
  } catch (error) {
    console.error("[vendor number] activation provisioning failed", error instanceof Error ? error.message : "unknown");
    return "failed";
  }
}
