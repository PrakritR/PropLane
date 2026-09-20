import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { releaseTwilioNumber } from "@/lib/twilio-provisioning";
import { createTwilioRestClient } from "@/lib/twilio-client.server";

/** Bounded account-deletion cleanup. Capacity stays reserved until this writes released. */
export async function releaseQueuedVendorWorkIdentities(db: SupabaseClient, limit = 20): Promise<{ released: number; failed: number }> {
  const { data, error } = await db.rpc("claim_vendor_work_identity_releases", { p_limit: Math.max(1, Math.min(limit, 50)) });
  if (error) throw new Error(error.message);
  let released = 0;
  let failed = 0;
  for (const row of data ?? []) {
    const id = String(row.id ?? "");
    if (!id) continue;
    try {
      const sid = String(row.phone_number_sid ?? "").trim();
      if (sid && !(await releaseTwilioNumber(sid))) throw new Error("twilio_release_failed");
      const { error: saved } = await db.from("vendor_work_identity_release_queue").update({ state: "released", released_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("id", id);
      if (saved) throw new Error(saved.message);
      released += 1;
    } catch (cause) {
      failed += 1;
      // A failed remove may mean a lost response after Twilio accepted it.
      // Reconciliation owns the next provider inspection; this worker never
      // blindly calls remove twice.
      await db.from("vendor_work_identity_release_queue").update({ state: "reconciling", last_error: cause instanceof Error ? cause.message : "release_outcome_unknown", updated_at: new Date().toISOString() }).eq("id", id);
    }
  }
  return { released, failed };
}

export async function inspectVendorReleaseSid(sid: string): Promise<"absent" | "owned" | "unavailable"> {
  const client = createTwilioRestClient();
  if (!client) return "unavailable";
  try {
    await client.incomingPhoneNumbers(sid).fetch();
    return "owned";
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status ?? 0);
    const code = Number((error as { code?: unknown })?.code ?? 0);
    return status === 404 || code === 20404 ? "absent" : "unavailable";
  }
}

/** Reconcile ambiguous removes by read only; this never performs another remove. */
export async function reconcileVendorWorkIdentityReleases(
  db: SupabaseClient,
  limit = 20,
  inspect: (sid: string) => Promise<"absent" | "owned" | "unavailable"> = inspectVendorReleaseSid,
): Promise<{ released: number; quarantined: number; unavailable: number }> {
  const { data, error } = await db.from("vendor_work_identity_release_queue")
    .select("id,identity_id,phone_number_sid").eq("state", "reconciling").order("updated_at", { ascending: true }).limit(Math.max(1, Math.min(limit, 50)));
  if (error) throw new Error(error.message);
  let released = 0; let quarantined = 0; let unavailable = 0;
  for (const row of data ?? []) {
    const id = String(row.id ?? ""); const sid = String(row.phone_number_sid ?? "").trim();
    const status = sid ? await inspect(sid) : "absent";
    if (status === "absent") {
      await db.from("vendor_work_identity_release_queue").update({ state: "released", released_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("id", id);
      const identityId = String(row.identity_id ?? "").trim();
      if (identityId) {
        // This may match no row after account deletion; that is expected. For
        // partial portal cleanup it closes the surviving identity lifecycle.
        await db.from("vendor_work_identities").update({ lifecycle_state: "released", email_state: "released", sms_state: "released", released_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", identityId);
      }
      released += 1;
    } else if (status === "owned") {
      await db.from("vendor_work_identity_release_queue").update({ state: "failed", last_error: "provider_resource_still_owned", updated_at: new Date().toISOString() }).eq("id", id);
      quarantined += 1;
    } else {
      unavailable += 1;
    }
  }
  return { released, quarantined, unavailable };
}
