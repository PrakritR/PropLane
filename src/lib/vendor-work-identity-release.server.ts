import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { releaseTwilioNumber } from "@/lib/twilio-provisioning";
import { createTwilioRestClient } from "@/lib/twilio-client.server";
import { VENDOR_NUMBER_IDLE_RELEASE_DAYS } from "@/lib/vendor-work-number";
import { isNumberSubscriptionEnabled, NUMBER_LAPSED_RELEASE_DAYS } from "@/lib/number-subscription/constants";
import { numberServiceEntitled } from "@/lib/number-subscription/subscription.server";

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
      if (sid && !isDryRunSid(sid) && !(await releaseTwilioNumber(sid))) throw new Error("twilio_release_failed");
      const identityId = String(row.identity_id ?? "").trim();
      if (identityId) {
        const { error: identityError } = await db.from("vendor_work_identities").update({ lifecycle_state: "released", email_state: "released", sms_state: "released", released_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", identityId);
        if (identityError) throw new Error(identityError.message);
      }
      const { error: saved } = await db.from("vendor_work_identity_release_queue").update({ state: "released", released_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("id", id);
      if (saved) throw new Error(saved.message);
      released += 1;
    } catch (cause) {
      failed += 1;
      // A failed remove may mean a lost response after Twilio accepted it.
      // Reconciliation owns the next provider inspection; this worker never
      // blindly calls remove twice.
      const { error: reconcileError } = await db.from("vendor_work_identity_release_queue").update({ state: "reconciling", last_error: cause instanceof Error ? cause.message : "release_outcome_unknown", updated_at: new Date().toISOString() }).eq("id", id);
      if (reconcileError) throw new Error(reconcileError.message);
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
      const identityId = String(row.identity_id ?? "").trim();
      if (identityId) {
        // This may match no row after account deletion; that is expected. For
        // partial portal cleanup it closes the surviving identity lifecycle.
        const { error: identityError } = await db.from("vendor_work_identities").update({ lifecycle_state: "released", email_state: "released", sms_state: "released", released_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", identityId);
        if (identityError) throw new Error(identityError.message);
      }
      const { error: queueError } = await db.from("vendor_work_identity_release_queue").update({ state: "released", released_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("id", id);
      if (queueError) throw new Error(queueError.message);
      released += 1;
    } else if (status === "owned") {
      const { error: queueError } = await db.from("vendor_work_identity_release_queue").update({ state: "failed", last_error: "provider_resource_still_owned", updated_at: new Date().toISOString() }).eq("id", id);
      if (queueError) throw new Error(queueError.message);
      quarantined += 1;
    } else {
      unavailable += 1;
    }
  }
  return { released, quarantined, unavailable };
}

/** A dry-run "purchase" never existed at the provider, so there is nothing to remove. */
function isDryRunSid(sid: string): boolean {
  return sid.startsWith("PNdryrun");
}

/**
 * Release a vendor's number after 60 days with no texts through it. The number
 * only: the work email, the identity row and the vendor's history stay, and the
 * vendor can claim a new number any time. Provider remove is claim-then-call -
 * a conditional update takes the row out of `ready` first, so two runs never
 * remove twice - and a remove that cannot be confirmed leaves the row in
 * `reconciling` (never re-bought, never freed) for inspection.
 */
export async function releaseIdleVendorWorkNumbers(
  db: SupabaseClient,
  options: {
    now?: Date;
    days?: number;
    limit?: number;
    release?: (sid: string) => Promise<boolean>;
  } = {},
): Promise<{ released: number; failed: number; active: number }> {
  const now = options.now ?? new Date();
  const days = options.days ?? VENDOR_NUMBER_IDLE_RELEASE_DAYS;
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const release = options.release ?? releaseTwilioNumber;
  const { data, error } = await db.from("vendor_work_identities")
    .select("id,vendor_user_id,phone_number_sid")
    .eq("sms_state", "ready").not("phone_number_sid", "is", null).lt("updated_at", cutoff)
    .order("updated_at", { ascending: true }).limit(Math.max(1, Math.min(options.limit ?? 20, 50)));
  if (error) throw new Error(error.message);
  let released = 0;
  let failed = 0;
  let active = 0;
  for (const row of (data ?? []) as { id: string; vendor_user_id: string; phone_number_sid: string }[]) {
    const { data: usage, error: usageError } = await db.from("vendor_work_identity_usage_events")
      .select("id").eq("identity_id", row.id).gte("created_at", cutoff).limit(1);
    if (usageError) throw new Error(usageError.message);
    if ((usage ?? []).length > 0) { active += 1; continue; }
    // A conversation row newer than the cutoff is activity too (table may be absent before its migration).
    const { data: conversations, error: conversationError } = await db.from("vendor_work_number_conversations")
      .select("id").eq("identity_id", row.id).gte("last_activity_at", cutoff).limit(1);
    if (!conversationError && (conversations ?? []).length > 0) { active += 1; continue; }
    // PropLane Number (flag on): a vendor who is paying for the number keeps it however quiet it is.
    if (isNumberSubscriptionEnabled() && (await numberServiceEntitled(row.vendor_user_id, db))) { active += 1; continue; }
    const outcome = await claimThenReleaseVendorNumber(db, row, now, release, "idle_release_unconfirmed");
    if (outcome === "released") released += 1;
    else if (outcome === "failed") failed += 1;
  }
  return { released, failed, active };
}

/**
 * Take one ready number out of service and give it back to the provider: a conditional update takes the row out
 * of `ready` first (so two runs never remove twice), then the provider remove runs, and a remove that cannot be
 * confirmed leaves the row `reconciling` (never re-bought, never freed). `skipped` = another run got there first.
 */
async function claimThenReleaseVendorNumber(
  db: SupabaseClient,
  row: { id: string; phone_number_sid: string },
  now: Date,
  release: (sid: string) => Promise<boolean>,
  unconfirmedReason: string,
): Promise<"released" | "failed" | "skipped"> {
  const { data: claimed, error: claimError } = await db.from("vendor_work_identities")
    .update({ sms_state: "disabled", sms_send_ready: false, sms_receive_ready: false, updated_at: now.toISOString() })
    .eq("id", row.id).eq("sms_state", "ready").eq("phone_number_sid", row.phone_number_sid).select("id").maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimed) return "skipped";
  const ok = isDryRunSid(row.phone_number_sid) ? true : await release(row.phone_number_sid).catch(() => false);
  if (ok) {
    const { error: resetError } = await db.from("vendor_work_identities").update({
      phone_number: null, phone_number_sid: null, messaging_service_sid: null, carrier_ready: false,
      sms_registration_state: "not_submitted", sms_state: "not_started", attachment_state: "not_started",
      quarantined_at: null, quarantine_reason: null, last_error: null, updated_at: now.toISOString(),
    }).eq("id", row.id);
    if (resetError) throw new Error(resetError.message);
    return "released";
  }
  const { error: holdError } = await db.from("vendor_work_identities")
    .update({ sms_state: "reconciling", quarantined_at: now.toISOString(), quarantine_reason: unconfirmedReason, updated_at: now.toISOString() })
    .eq("id", row.id);
  if (holdError) throw new Error(holdError.message);
  return "failed";
}

/**
 * PropLane Number (flag on): a vendor whose subscription has been `canceled` or `incomplete` for more than 30
 * days loses the NUMBER (the email, the identity row and the history stay). While lapsed the number is already
 * paused (no outbound, no AI; managers' texts fall back to the vendor's own phone). The lapse clock is the
 * subscription row's `updated_at`, which Stripe's cancellation writes and nothing else touches afterwards.
 * Re-checks entitlement right before the remove, so a vendor who just re-subscribed keeps the number.
 * A vendor with a number from before the flag and NO subscription row is not "lapsed" and is left to the idle rule.
 */
export async function releaseLapsedVendorWorkNumbers(
  db: SupabaseClient,
  options: { now?: Date; days?: number; limit?: number; release?: (sid: string) => Promise<boolean> } = {},
): Promise<{ released: number; failed: number; kept: number }> {
  if (!isNumberSubscriptionEnabled()) return { released: 0, failed: 0, kept: 0 };
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.days ?? NUMBER_LAPSED_RELEASE_DAYS) * 86_400_000).toISOString();
  const release = options.release ?? releaseTwilioNumber;
  const { data: lapsed, error } = await db.from("number_subscriptions")
    .select("owner_user_id")
    .eq("owner_role", "vendor").in("status", ["canceled", "incomplete"]).lt("updated_at", cutoff)
    .order("updated_at", { ascending: true }).limit(Math.max(1, Math.min(options.limit ?? 20, 50)));
  if (error) throw new Error(error.message);
  let released = 0;
  let failed = 0;
  let kept = 0;
  for (const owner of (lapsed ?? []) as { owner_user_id: string }[]) {
    const { data: identity, error: identityError } = await db.from("vendor_work_identities")
      .select("id,phone_number_sid").eq("vendor_user_id", owner.owner_user_id).eq("sms_state", "ready").not("phone_number_sid", "is", null).maybeSingle();
    if (identityError) throw new Error(identityError.message);
    const row = identity as { id: string; phone_number_sid: string } | null;
    if (!row) continue;
    if (await numberServiceEntitled(owner.owner_user_id, db)) { kept += 1; continue; }
    const outcome = await claimThenReleaseVendorNumber(db, row, now, release, "lapsed_release_unconfirmed");
    if (outcome === "released") released += 1;
    else if (outcome === "failed") failed += 1;
  }
  return { released, failed, kept };
}
