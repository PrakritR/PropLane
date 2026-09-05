import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { readSmsSuppressionState } from "@/lib/sms-consent";
import { ensureApplicationScopedSmsConsent } from "@/lib/sms/application-consent.server";
import { getStoredManagerSmsEntitlement } from "@/lib/sms/manager-sms-entitlement.server";
import {
  estimateSmsSegments,
  evaluateManagerSmsNumberSendability,
  quietHoursBlocks,
  type SmsSendClass,
} from "@/lib/sms/number-registration-policy";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { sendSms } from "@/lib/twilio";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import {
  evaluateManagerCommsBillingGate,
} from "@/lib/comms-billing/eligibility.server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import { recordManagerCommsUsage } from "@/lib/comms-billing/record-usage.server";

type RuntimeRow = {
  mode: string;
  pilot_manager_user_ids: string[] | null;
};

type NumberRow = {
  manager_user_id: string;
  phone_number: string | null;
  phone_number_sid: string | null;
  messaging_service_sid: string | null;
  campaign_sid: string | null;
  provision_state: string;
  registration_state: string;
  registration_ref: string | null;
  attachment_state: string | null;
  number_registration_state: string | null;
  grace_started_at: string | null;
  grace_expires_at: string | null;
  quarantined_at: string | null;
  quarantine_reason: string | null;
};

export type OwnerSmsEnqueueInput = {
  managerUserId: string;
  actorUserId: string;
  recipientPhone: string;
  recipientUserId?: string | null;
  recipientEmail?: string | null;
  body: string;
  sendClass: SmsSendClass;
  purpose: string;
  conversationKey?: string | null;
  counterpartyRole?: SmsCounterpartyRole;
  propertyId?: string | null;
  recipientTimezone?: string | null;
  dedupeKey?: string | null;
  traceId?: string | null;
};

type SendPolicy =
  | { allowed: true; fromNumber: string; segmentCount: number; messagingServiceSid: string }
  | { allowed: false; reason: string; deferUntil?: string };

async function loadSendPolicy(
  db: SupabaseClient,
  input: OwnerSmsEnqueueInput,
  now = new Date(),
): Promise<SendPolicy> {
  if (process.env.SMS_RUNTIME_ENABLED?.trim() !== "1") {
    return { allowed: false, reason: "runtime_env_paused" };
  }
  if (process.env.SMS_OUTBOX_SCHEDULER_READY?.trim() !== "1") {
    return { allowed: false, reason: "outbox_scheduler_unready" };
  }

  const ownerId = input.managerUserId.trim();
  const recipient = normalizeE164(input.recipientPhone);
  if (!ownerId || !recipient) return { allowed: false, reason: "invalid_dispatch_identity" };
  const segmentEstimate = estimateSmsSegments(input.body);
  if (segmentEstimate.segmentCount < 1 || segmentEstimate.segmentCount > 10) {
    return { allowed: false, reason: "segment_limit_exceeded" };
  }

  const [{ data: runtime, error: runtimeError }, { data: number, error: numberError }] = await Promise.all([
    db
      .from("sms_runtime_config")
      .select("mode, pilot_manager_user_ids")
      .eq("singleton", true)
      .maybeSingle(),
    db
      .from("manager_sms_numbers")
      .select(
        "manager_user_id, phone_number, phone_number_sid, messaging_service_sid, campaign_sid, provision_state, registration_state, registration_ref, attachment_state, number_registration_state, grace_started_at, grace_expires_at, quarantined_at, quarantine_reason",
      )
      .eq("manager_user_id", ownerId)
      .maybeSingle(),
  ]);
  if (runtimeError || numberError || !runtime || !number) {
    return { allowed: false, reason: "control_plane_unreadable" };
  }

  const runtimeRow = runtime as RuntimeRow;
  const numberRow = number as NumberRow;
  const allowlisted = (runtimeRow.pilot_manager_user_ids ?? []).includes(ownerId);
  const decision = evaluateManagerSmsNumberSendability(
    {
      provisionState: numberRow.provision_state as never,
      phoneNumber: numberRow.phone_number,
      registrationState: numberRow.registration_state as never,
      registrationRef: numberRow.registration_ref,
      attachmentState: numberRow.attachment_state,
      numberRegistrationState: numberRow.number_registration_state,
      graceStartedAt: numberRow.grace_started_at,
      graceExpiresAt: numberRow.grace_expires_at,
      quarantinedAt: numberRow.quarantined_at,
      quarantineReason: numberRow.quarantine_reason,
    },
    { runtimeMode: runtimeRow.mode, managerIsAllowlisted: allowlisted, now },
  );
  if (!decision.sendable) return { allowed: false, reason: decision.reason ?? "number_not_sendable" };

  const expectedServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const expectedCampaignSid = process.env.TWILIO_CAMPAIGN_SID?.trim();
  if (
    !expectedServiceSid ||
    !expectedCampaignSid ||
    numberRow.messaging_service_sid !== expectedServiceSid ||
    numberRow.campaign_sid !== expectedCampaignSid ||
    !numberRow.phone_number_sid
  ) {
    return { allowed: false, reason: "provider_identity_mismatch" };
  }

  const entitlement = await getStoredManagerSmsEntitlement(db, ownerId);
  if (isCommsPaygBillingEnabled()) {
    const billing = await evaluateManagerCommsBillingGate(db, ownerId);
    if (!billing.allowed) return { allowed: false, reason: `comms_billing_${billing.reason}` };
  } else if (!entitlement.eligible) {
    return { allowed: false, reason: `entitlement_${entitlement.reason}` };
  }

  const suppression = await readSmsSuppressionState(db, recipient, { userId: input.recipientUserId });
  if (!suppression.ok) return { allowed: false, reason: suppression.error };
  if (suppression.optedOut) return { allowed: false, reason: "recipient_opted_out" };

  if (input.sendClass !== "control") {
    const consent = await ensureApplicationScopedSmsConsent(db, {
      managerUserId: ownerId,
      recipientPhone: recipient,
      recipientEmail: input.recipientEmail,
      recipientUserId: input.recipientUserId,
      purpose: input.purpose,
      sendClass: input.sendClass,
      conversationKey: input.conversationKey,
      messagingServiceSid: expectedServiceSid,
    });
    if (!consent.ok) return { allowed: false, reason: consent.error };
    if (!consent.granted) return { allowed: false, reason: "scoped_consent_missing" };
  }

  if (quietHoursBlocks(input.sendClass, now, { tz: input.recipientTimezone ?? "America/Los_Angeles", startHour: 21, endHour: 8 })) {
    return { allowed: false, reason: "quiet_hours", deferUntil: new Date(now.getTime() + 60 * 60 * 1000).toISOString() };
  }

  return {
    allowed: true,
    fromNumber: String(numberRow.phone_number),
    segmentCount: segmentEstimate.segmentCount,
    messagingServiceSid: expectedServiceSid,
  };
}

export async function enqueueOwnerSms(
  input: OwnerSmsEnqueueInput,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<
  | { ok: true; outboxId: string; status: string; deduplicated: boolean }
  | { ok: false; error: string }
> {
  const body = input.body.trim();
  const recipient = normalizeE164(input.recipientPhone);
  if (!body || body.length > 1600 || !recipient) return { ok: false, error: "invalid_message" };
  if (!input.managerUserId.trim() || !input.actorUserId.trim() || !input.purpose.trim()) {
    return { ok: false, error: "invalid_dispatch_identity" };
  }

  const policy = await loadSendPolicy(db, { ...input, body, recipientPhone: recipient });
  const enqueuePolicy = policy.allowed ? policy : retryableDispatchPolicy(policy);
  // Pauses and rollout allowlists are deliberate operator controls: never
  // accumulate new messages behind them for surprise delivery after re-enable.
  if (
    !enqueuePolicy.allowed &&
    (!enqueuePolicy.deferUntil ||
      enqueuePolicy.reason === "runtime_env_paused" ||
      enqueuePolicy.reason === "runtime_paused" ||
      enqueuePolicy.reason === "outbox_scheduler_unready" ||
      enqueuePolicy.reason === "manager_not_allowlisted")
  ) {
    return { ok: false, error: enqueuePolicy.reason };
  }
  const segments = estimateSmsSegments(body).segmentCount;
  const dedupeKey = input.dedupeKey?.trim() || randomUUID();
  const status = enqueuePolicy.allowed ? "queued" : "deferred";
  const { data, error } = await db
    .from("sms_outbox")
    .insert({
      manager_user_id: input.managerUserId,
      actor_user_id: input.actorUserId,
      recipient_user_id: input.recipientUserId ?? null,
      recipient_email: input.recipientEmail?.trim().toLowerCase() || null,
      recipient_phone: recipient,
      body,
      send_class: input.sendClass,
      purpose: input.purpose,
      conversation_key: input.conversationKey ?? null,
      counterparty_role: input.counterpartyRole ?? null,
      property_id: input.propertyId ?? null,
      recipient_timezone: input.recipientTimezone ?? "America/Los_Angeles",
      dedupe_key: dedupeKey,
      trace_id: input.traceId ?? null,
      segment_count: segments,
      status,
      available_at: enqueuePolicy.allowed ? new Date().toISOString() : enqueuePolicy.deferUntil,
      blocked_reason: enqueuePolicy.allowed ? null : enqueuePolicy.reason,
    })
    .select("id, status")
    .single();
  if (!error && data) return { ok: true, outboxId: String(data.id), status: String(data.status), deduplicated: false };

  const { data: existing } = await db
    .from("sms_outbox")
    .select("id, status")
    .eq("manager_user_id", input.managerUserId)
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  return existing
    ? { ok: true, outboxId: String(existing.id), status: String(existing.status), deduplicated: true }
    : { ok: false, error: "outbox_unavailable" };
}

type ClaimedOutboxRow = {
  id: string;
  manager_user_id: string;
  actor_user_id: string | null;
  recipient_user_id: string | null;
  recipient_email: string | null;
  recipient_phone: string;
  body: string;
  send_class: SmsSendClass;
  purpose: string;
  conversation_key: string | null;
  counterparty_role: SmsCounterpartyRole | null;
  property_id: string | null;
  recipient_timezone: string;
  dedupe_key: string;
  trace_id: string | null;
  segment_count: number;
};

async function blockOrDeferClaim(
  db: SupabaseClient,
  row: ClaimedOutboxRow,
  policy: Exclude<SendPolicy, { allowed: true }>,
  workerId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("sms_outbox")
    .update({
      status: policy.deferUntil ? "deferred" : "blocked",
      blocked_reason: policy.reason,
      available_at: policy.deferUntil ?? new Date().toISOString(),
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("lease_owner", workerId)
    .eq("status", "claimed")
    .select("id")
    .maybeSingle();
  return !error && Boolean(data);
}

function retryableDispatchPolicy(
  policy: Exclude<SendPolicy, { allowed: true }>,
): Exclude<SendPolicy, { allowed: true }> {
  if (policy.deferUntil) return policy;
  const retryable =
    policy.reason === "control_plane_unreadable" ||
    policy.reason.endsWith("_unreadable") ||
    policy.reason === "runtime_env_paused" ||
    policy.reason === "outbox_scheduler_unready" ||
    policy.reason === "runtime_paused" ||
    policy.reason === "manager_not_allowlisted" ||
    policy.reason === "number_not_active" ||
    policy.reason === "number_not_attached" ||
    policy.reason === "number_not_registered" ||
    policy.reason === "provider_identity_mismatch" ||
    policy.reason === "entitlement_plan_unreadable";
  return retryable
    ? { ...policy, deferUntil: new Date(Date.now() + 5 * 60_000).toISOString() }
    : policy;
}

/**
 * Claim and dispatch a bounded batch. Once provider submission starts, an
 * ambiguous error becomes `unknown` and is never automatically retried.
 */
export async function dispatchOwnerSmsOutbox(
  options: { workerId?: string; limit?: number; outboxId?: string } = {},
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<{
  ok: boolean;
  claimed: number;
  submitted: number;
  blocked: number;
  unknown: number;
  infrastructureErrors: string[];
}> {
  const workerId = options.workerId?.trim() || `sms-${randomUUID()}`;
  // A process can die after the no-retry boundary but before persisting a SID.
  // Make those rows explicitly operator-reviewable instead of leaving them in
  // `submitting` forever; they are never automatically retried.
  const staleCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const { error: staleTransitionError } = await db
    .from("sms_outbox")
    .update({
      status: "unknown",
      blocked_reason: "dispatch_outcome_unknown",
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("status", "submitting")
    .is("provider_message_sid", null)
    .lt("dispatch_started_at", staleCutoff);
  if (staleTransitionError) {
    return {
      ok: false,
      claimed: 0,
      submitted: 0,
      blocked: 0,
      unknown: 0,
      infrastructureErrors: ["stale_submission_reconciliation_unavailable"],
    };
  }
  const { data, error } = await db.rpc("claim_sms_outbox", {
    p_worker_id: workerId,
    p_limit: options.outboxId ? 1 : Math.max(1, Math.min(options.limit ?? 5, 5)),
    p_lease_seconds: 120,
    p_outbox_id: options.outboxId ?? null,
  });
  if (error) {
    return {
      ok: false,
      claimed: 0,
      submitted: 0,
      blocked: 0,
      unknown: 0,
      infrastructureErrors: ["outbox_claim_unavailable"],
    };
  }
  const rows = (data ?? []) as ClaimedOutboxRow[];
  const result = {
    ok: true,
    claimed: rows.length,
    submitted: 0,
    blocked: 0,
    unknown: 0,
    infrastructureErrors: [] as string[],
  };

  const recordInfrastructureError = (code: string) => {
    result.ok = false;
    if (!result.infrastructureErrors.includes(code)) result.infrastructureErrors.push(code);
  };

  for (const row of rows) {
    const policy = await loadSendPolicy(db, {
      managerUserId: row.manager_user_id,
      actorUserId: row.actor_user_id ?? row.manager_user_id,
      recipientPhone: row.recipient_phone,
      recipientEmail: row.recipient_email,
      body: row.body,
      sendClass: row.send_class,
      purpose: row.purpose,
      conversationKey: row.conversation_key,
      counterpartyRole: row.counterparty_role ?? undefined,
      propertyId: row.property_id,
      recipientTimezone: row.recipient_timezone,
      dedupeKey: row.dedupe_key,
      traceId: row.trace_id,
    });
    if (!policy.allowed) {
      const nextPolicy = retryableDispatchPolicy(policy);
      const transitioned = await blockOrDeferClaim(db, row, nextPolicy, workerId);
      if (transitioned && !nextPolicy.deferUntil) result.blocked += 1;
      if (!transitioned) recordInfrastructureError("outbox_policy_transition_unavailable");
      continue;
    }

    const { data: priorAttempts } = await db
      .from("sms_delivery_attempts")
      .select("attempt_number")
      .eq("outbox_id", row.id)
      .order("attempt_number", { ascending: false })
      .limit(1);
    const attemptNumber = Number(priorAttempts?.[0]?.attempt_number ?? 0) + 1;
    const { data: attempt, error: attemptError } = await db
      .from("sms_delivery_attempts")
      .insert({ outbox_id: row.id, attempt_number: attemptNumber, state: "submitting" })
      .select("id")
      .single();
    if (attemptError || !attempt) {
      const released = await blockOrDeferClaim(
        db,
        row,
        {
          allowed: false,
          reason: "attempt_ledger_unavailable",
          deferUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
        workerId,
      );
      if (!released) recordInfrastructureError("attempt_ledger_recovery_unavailable");
      continue;
    }

    const dispatchStartedAt = new Date().toISOString();
    const { data: started, error: startError } = await db
      .from("sms_outbox")
      .update({ status: "submitting", dispatch_started_at: dispatchStartedAt, updated_at: dispatchStartedAt })
      .eq("id", row.id)
      .eq("lease_owner", workerId)
      .eq("status", "claimed")
      .gt("lease_expires_at", dispatchStartedAt)
      .select("id")
      .maybeSingle();
    if (startError || !started) {
      await db.from("sms_delivery_attempts").update({ state: "pre_dispatch_failed", finished_at: new Date().toISOString() }).eq("id", attempt.id);
      result.blocked += 1;
      recordInfrastructureError("outbox_submit_claim_unavailable");
      continue;
    }

    // Spend only after this worker atomically owns the submit transition. A
    // stale worker that loses the lease cannot burn the campaign budget and
    // then let a later claimant spend it again for the same attempt.
    const { data: budgetAvailable, error: budgetError } = await db.rpc("spend_sms_segment_budget", {
      p_segments: row.segment_count,
    });
    if (budgetError || budgetAvailable !== true) {
      const retryAt = new Date();
      if (budgetError) retryAt.setTime(Date.now() + 5 * 60_000);
      else {
        retryAt.setUTCDate(retryAt.getUTCDate() + 1);
        retryAt.setUTCHours(0, 0, 5, 0);
      }
      const reason = budgetError ? "campaign_budget_unavailable" : "campaign_segment_budget_exhausted";
      const { data: deferred } = await db
        .from("sms_outbox")
        .update({
          status: "deferred",
          available_at: retryAt.toISOString(),
          blocked_reason: reason,
          dispatch_started_at: null,
          lease_owner: null,
          lease_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("lease_owner", workerId)
        .eq("status", "submitting")
        .select("id")
        .maybeSingle();
      await db
        .from("sms_delivery_attempts")
        .update({ state: "pre_dispatch_failed", finished_at: new Date().toISOString() })
        .eq("id", attempt.id);
      if (!deferred) result.unknown += 1;
      if (!deferred) recordInfrastructureError("campaign_budget_transition_unavailable");
      continue;
    }

    const sent = await sendSms(row.recipient_phone, row.body, policy.fromNumber, { skipOptOutCheck: true });
    if (!sent.sent || !sent.sid) {
      const providerErrorCode = sent.error?.match(/\b\d{5}\b/)?.[0] ?? null;
      await db
        .from("sms_outbox")
        .update({
          status: "unknown",
          blocked_reason: "provider_submission_outcome_unknown",
          provider_error_code: providerErrorCode,
          lease_owner: null,
          lease_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await db
        .from("sms_delivery_attempts")
        .update({ state: "unknown", provider_error_code: providerErrorCode, finished_at: new Date().toISOString() })
        .eq("id", attempt.id);
      result.unknown += 1;
      continue;
    }

    const { error: attemptPersistError } = await db
      .from("sms_delivery_attempts")
      .update({
        state: "submitted",
        provider_message_sid: sent.sid,
        finished_at: new Date().toISOString(),
      })
      .eq("id", attempt.id);
    const { data: submittedRow, error: submitPersistError } = await db
      .from("sms_outbox")
      .update({
        status: "submitted",
        provider_message_sid: sent.sid,
        provider_status: "queued",
        provider_status_rank: 10,
        provider_status_at: new Date().toISOString(),
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .select("id")
      .maybeSingle();
    await logManagerSmsMessage(db, {
      managerUserId: row.manager_user_id,
      residentPhone: row.recipient_phone,
      residentUserId: row.recipient_user_id,
      direction: "outbound",
      body: row.body,
      fromPhone: policy.fromNumber,
      toPhone: row.recipient_phone,
      messageSid: sent.sid,
      source: row.send_class === "automated" ? "automated" : "work_number",
      counterpartyRole: row.counterparty_role ?? undefined,
    });
    if (isCommsPaygBillingEnabled()) {
      await recordManagerCommsUsage(db, {
        managerUserId: row.manager_user_id,
        meter: "sms_outbound_segment",
        quantity: row.segment_count,
        idempotencyKey: `sms_outbound:${row.id}`,
        metadata: { outboxId: row.id, messageSid: sent.sid },
      });
    }
    if (submitPersistError || !submittedRow) {
      // The provider accepted the message. Never resend. If the attempt SID was
      // saved, a callback can still correlate it through the atomic RPC.
      if (attemptPersistError) {
        console.error("sms provider SID persistence failed", { outboxId: row.id });
      }
      result.unknown += 1;
      continue;
    }

    // A very fast callback may have arrived before the SID was attached to the
    // outbox. Replay the latest durable event now that correlation exists.
    const { data: latestDelivery } = await db
      .from("sms_delivery_events")
      .select("status, status_rank, error_code, provider_occurred_at")
      .eq("message_sid", sent.sid)
      .order("provider_occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestDelivery) {
      await db.rpc("apply_sms_delivery_status", {
        p_message_sid: sent.sid,
        p_status: latestDelivery.status,
        p_status_rank: latestDelivery.status_rank,
        p_error_code: latestDelivery.error_code,
        p_provider_occurred_at: latestDelivery.provider_occurred_at,
      });
    }
    result.submitted += 1;
  }

  return result;
}

export type UnknownSmsInventory =
  | { ok: true; count: number; outboxIds: string[] }
  | { ok: false; error: string };

/**
 * Inventory every terminal/ambiguous submission for the operator monitor.
 * The bounded id list makes alerts actionable without exposing message bodies,
 * recipient data, or other PII. `count` still reports a backlog larger than
 * the returned sample.
 */
export async function loadUnknownSmsInventory(
  db: SupabaseClient = createSupabaseServiceRoleClient(),
  limit = 100,
): Promise<UnknownSmsInventory> {
  const { data, error, count } = await db
    .from("sms_outbox")
    .select("id", { count: "exact" })
    .eq("status", "unknown")
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (error) return { ok: false, error: error.message };
  const outboxIds = (data ?? [])
    .map((row) => String(row.id ?? "").trim())
    .filter(Boolean);
  return { ok: true, count: count ?? outboxIds.length, outboxIds };
}
