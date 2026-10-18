import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isProvisioningEnabled } from "@/lib/sms/number-registration-policy";
import { createVendorWorkIdentityProvider, type VendorWorkIdentityProvider } from "@/lib/vendor-work-identity.server";
import { isVendorNumberDryRun } from "@/lib/vendor-work-number-dry-run.server";

/**
 * Whether a number can actually be PROVISIONED right now, for a new subscriber. A $5 subscription is
 * never sold for a number that cannot be delivered: the vendor/resident Subscribe path shows
 * "Unavailable" and the checkout route refuses, until the platform's switches are on:
 *  - `vendor_work_identity_runtime.enabled = true` with `max_active_identities > 0` (the kill switch + cap),
 *  - the SMS provider configured (`VENDOR_WORK_IDENTITY_PROVIDER_ENABLED=1`, Twilio, messaging service,
 *    inbound + status webhook URLs),
 *  - real provisioning on (`SMS_PROVISIONING_ENABLED=1`) or a non-production dry run.
 * Already-paying subscribers are never affected: this gates only a NEW checkout.
 */
export type NumberAvailability =
  | { available: true }
  | { available: false; reason: "provider_disabled" | "provider_unconfigured" | "capacity" | "unreadable" };

export async function getNumberAvailability(
  db: SupabaseClient,
  role: "vendor" | "resident" | "manager",
  deps: { provider?: Pick<VendorWorkIdentityProvider, "smsConfigured"> } = {},
): Promise<NumberAvailability> {
  if (role === "manager") {
    // A manager's personalized number is provisioned through the per-workspace path (the manager SMS
    // runtime kill switch and real provisioning), not the vendor work-identity provider.
    const { normalizeSmsRuntimeMode } = await import("@/lib/sms/number-registration-policy");
    const { data: runtimeRow, error: runtimeError } = await db.from("sms_runtime_config").select("mode").eq("singleton", true).maybeSingle();
    if (runtimeError) return { available: false, reason: "unreadable" };
    if (normalizeSmsRuntimeMode((runtimeRow as { mode?: string } | null)?.mode) === "paused") return { available: false, reason: "provider_disabled" };
    return isProvisioningEnabled(process.env) ? { available: true } : { available: false, reason: "provider_unconfigured" };
  }
  const { data, error } = await db
    .from("vendor_work_identity_runtime")
    .select("enabled,max_active_identities")
    .eq("singleton", true)
    .maybeSingle();
  if (error) return { available: false, reason: "unreadable" };
  const runtime = data as { enabled?: boolean; max_active_identities?: number } | null;
  if (!runtime?.enabled) return { available: false, reason: "provider_disabled" };
  // The cap counts vendor work identities only; a resident's number is gated by the kill switch alone.
  if (role === "vendor" && !((runtime.max_active_identities ?? 0) > 0)) return { available: false, reason: "capacity" };
  const provider = deps.provider ?? createVendorWorkIdentityProvider();
  if (!provider.smsConfigured() || (!isVendorNumberDryRun() && !isProvisioningEnabled(process.env))) {
    return { available: false, reason: "provider_unconfigured" };
  }
  return { available: true };
}
