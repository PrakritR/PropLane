import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  isClawSharedLineBridgeEnabled,
  isLegacyClawSharedSmsNumber,
  isPlaceholderManagerWorkNumber,
} from "@/lib/claw-leasing-links";
import { managerCarrierRegistrationNeedsAttention } from "@/lib/sms/manager-messaging-number";
import {
  isProvisioningEnabled,
  managerCanSendFromOwnNumber,
  needsProvisioning,
  normalizeProvisionState,
  normalizeRegistrationState,
  sharedRegistrationRef,
  type ManagerSmsNumberRecord,
  type ProvisionState,
  type RegistrationState,
} from "@/lib/sms/number-registration-policy";

/**
 * Per-manager SMS number provisioning + registration state machine (server).
 *
 * `manager_sms_numbers` is the source of truth for the number's lifecycle and
 * the manager's messaging-registration state; `profiles.sms_from_number` stays
 * as the denormalized "active number" cache every existing send/inbound path
 * already reads. Both are written together here so they never drift.
 *
 * Design invariants:
 * - Exactly one number per manager (PK is manager_user_id). Idempotent: a
 *   manager who already has an active number keeps it; re-running never buys a
 *   second number.
 * - Real Twilio purchases only happen when `SMS_PROVISIONING_ENABLED=1`. Off by
 *   default so a fleet parks in `pending_registration` at zero cost.
 * - Sending from the manager's own number is gated on that manager's OWN
 *   registration being approved (ISV/reseller model). The number can exist while
 *   registration is still pending — it just cannot send yet.
 * - Failures leave a retryable `failed` state (attempts + last_error), never a
 *   half-created record or a silently numberless manager.
 */

const TABLE = "manager_sms_numbers";

function nowIso(): string {
  return new Date().toISOString();
}

/** Map a raw DB row to the typed record (camelCase). */
export function mapNumberRow(row: Record<string, unknown> | null | undefined): ManagerSmsNumberRecord | null {
  if (!row) return null;
  return {
    managerUserId: String(row.manager_user_id ?? ""),
    phoneNumber: (row.phone_number as string | null) ?? null,
    phoneNumberSid: (row.phone_number_sid as string | null) ?? null,
    messagingServiceSid: (row.messaging_service_sid as string | null) ?? null,
    provider: String(row.provider ?? "twilio"),
    areaCode: (row.area_code as string | null) ?? null,
    provisionState: normalizeProvisionState(row.provision_state as string | null),
    registrationState: normalizeRegistrationState(row.registration_state as string | null),
    registrationRef: (row.registration_ref as string | null) ?? null,
    attempts: Number(row.attempts ?? 0) || 0,
    lastError: (row.last_error as string | null) ?? null,
    requestedAt: (row.requested_at as string | null) ?? null,
    provisionedAt: (row.provisioned_at as string | null) ?? null,
    releasedAt: (row.released_at as string | null) ?? null,
    registrationUpdatedAt: (row.registration_updated_at as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
    attachmentState: String(row.attachment_state ?? "not_attached") as ManagerSmsNumberRecord["attachmentState"],
    numberRegistrationState: String(row.number_registration_state ?? "not_submitted") as ManagerSmsNumberRecord["numberRegistrationState"],
    graceStartedAt: (row.grace_started_at as string | null) ?? null,
    graceExpiresAt: (row.grace_expires_at as string | null) ?? null,
    quarantinedAt: (row.quarantined_at as string | null) ?? null,
    quarantineReason: (row.quarantine_reason as string | null) ?? null,
  };
}

export async function getManagerNumberRecord(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerSmsNumberRecord | null> {
  const id = managerUserId.trim();
  if (!id) return null;
  const { data } = await db.from(TABLE).select("*").eq("manager_user_id", id).maybeSingle();
  return mapNumberRow(data as Record<string, unknown> | null);
}

/**
 * Idempotently ensure a state row exists for a manager (parked in
 * `pending_registration` with the shared registration ref by default so a
 * single-shared-registration deployment works with no extra wiring). Never buys
 * a number. Safe to call on every signup / activation.
 */
export async function ensureManagerNumberRecord(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerSmsNumberRecord | null> {
  const id = managerUserId.trim();
  if (!id) return null;
  const existing = await getManagerNumberRecord(db, id);
  if (existing) return existing;
  await db
    .from(TABLE)
    .upsert(
      {
        manager_user_id: id,
        provision_state: "pending_registration",
        registration_state: "pending",
        registration_ref: sharedRegistrationRef(),
        requested_at: nowIso(),
        updated_at: nowIso(),
      },
      { onConflict: "manager_user_id" },
    )
    .then(() => undefined, () => undefined);
  return getManagerNumberRecord(db, id);
}

export type ProvisionResult =
  | { ok: true; number: string; state: ProvisionState; alreadyProvisioned: boolean }
  | { ok: false; error: string; state: ProvisionState };

/**
 * Provision (or reuse) the manager's one number, respecting the money guard and
 * recording lifecycle state. Idempotent. When provisioning is disabled the
 * manager is parked in `pending_registration` and no purchase is attempted.
 */
export async function provisionManagerNumber(
  db: SupabaseClient,
  managerUserId: string,
  opts?: { areaCode?: string },
): Promise<ProvisionResult> {
  const id = managerUserId.trim();
  if (!id) return { ok: false, error: "Missing manager id.", state: "failed" };

  const record = await ensureManagerNumberRecord(db, id);
  if (!record) return { ok: false, error: "Could not initialize work-number state.", state: "failed" };

  // 1. Idempotent short-circuit — already has a real active number.
  if (record && normalizeProvisionState(record.provisionState) === "active" && record.phoneNumber) {
    return { ok: true, number: record.phoneNumber, state: "active", alreadyProvisioned: true };
  }

  // 2. Money guard — parked until an operator enables real purchases.
  if (!isProvisioningEnabled()) {
    await db
      .from(TABLE)
      .update({ provision_state: "pending_registration", updated_at: nowIso() })
      .eq("manager_user_id", id)
      .neq("provision_state", "active")
      .then(() => undefined, () => undefined);
    return { ok: false, error: "provisioning_disabled", state: "pending_registration" };
  }

  // 3. Mark provisioning in-flight (observable) and bump the attempt counter.
  const requestId = randomUUID();
  const { data: claimed, error: claimLockError } = await db.rpc("claim_manager_sms_provisioning", {
    p_manager_user_id: id,
    p_request_id: requestId,
  });
  if (claimLockError) return { ok: false, error: "Could not lock work-number setup.", state: "failed" };
  if (claimed !== true) {
    const current = await getManagerNumberRecord(db, id);
    if (current?.phoneNumber && current.provisionState === "active") {
      return { ok: true, number: current.phoneNumber, state: "active", alreadyProvisioned: true };
    }
    return { ok: false, error: "setup_in_progress", state: "provisioning" };
  }

  // 3b. Clear a legacy Claw shared-line / placeholder stamp BEFORE buying, so the
  //     atomic `.is("sms_from_number", null)` claim can succeed. Without this the
  //     claim always fails against a Claw-stamped profile and we churn
  //     buy→release→failed every sweep tick. (The bridge keeps the Claw line on
  //     purpose, so only clear when real provisioning is active.)
  if (!isClawSharedLineBridgeEnabled()) {
    const { data: prof0 } = await db.from("profiles").select("sms_from_number").eq("id", id).maybeSingle();
    const cur = String(prof0?.sms_from_number ?? "").trim();
    let safeToClear = cur && (isLegacyClawSharedSmsNumber(cur) || isPlaceholderManagerWorkNumber(cur));
    if (cur && !safeToClear) {
      const { twilioOwnsPhoneNumber } = await import("@/lib/twilio-provisioning");
      const providerOwns = await twilioOwnsPhoneNumber(cur);
      if (providerOwns === null) {
        return { ok: false, error: "Could not verify the existing messaging-number cache.", state: "failed" };
      }
      if (providerOwns) {
        return { ok: false, error: "An owned Twilio number must be reconciled before setup can continue.", state: "failed" };
      }
      safeToClear = true;
    }
    if (safeToClear) {
      const { error: clearError } = await db
        .from("profiles")
        .update({ sms_from_number: null })
        .eq("id", id)
        .eq("sms_from_number", cur);
      if (clearError) {
        await recordProvisionFailure(db, id, requestId, "Could not clear the legacy work-number cache.");
        return { ok: false, error: "Could not prepare work-number setup.", state: "failed" };
      }
    }
  }

  // 4. Provider purchase (all Twilio SDK usage lives in twilio-provisioning).
  const { purchaseManagerTwilioNumber, releaseTwilioNumber } = await import("@/lib/twilio-provisioning");
  const { error: operationError } = await db.from("sms_provisioning_operations").insert({
    request_id: requestId,
    manager_user_id: id,
    area_code: opts?.areaCode ?? null,
    state: "claimed",
  });
  if (operationError) {
    await recordProvisionFailure(db, id, requestId, "Could not persist the provider operation intent.");
    return { ok: false, error: "Could not initialize provider setup.", state: "failed" };
  }
  const purchase = await purchaseManagerTwilioNumber({ areaCode: opts?.areaCode, requestId });
  if (!purchase.ok) {
    await db.from("sms_provisioning_operations").update({
      state: purchase.cleanupConfirmed === true ? "released" : "failed",
      phone_number: purchase.purchasedNumber?.number ?? null,
      phone_number_sid: purchase.purchasedNumber?.sid ?? null,
      last_error: purchase.error.slice(0, 500),
      updated_at: nowIso(),
    }).eq("request_id", requestId);
    if (purchase.cleanupConfirmed === false) {
      await db.from(TABLE).update({
        provision_state: "provisioning",
        attachment_state: "failed",
        quarantined_at: nowIso(),
        quarantine_reason: "provider_release_unconfirmed",
        last_error: purchase.error.slice(0, 500),
        updated_at: nowIso(),
      }).eq("manager_user_id", id).eq("provision_request_id", requestId);
      return { ok: false, error: purchase.error, state: "provisioning" };
    }
    await recordProvisionFailure(db, id, requestId, purchase.error);
    return { ok: false, error: purchase.error, state: "failed" };
  }
  const { error: providerPersistError } = await db.from("sms_provisioning_operations").update({
    state: "attached",
    phone_number: purchase.number,
    phone_number_sid: purchase.sid,
    messaging_service_sid: purchase.messagingServiceSid,
    updated_at: nowIso(),
  }).eq("request_id", requestId);
  if (providerPersistError) {
    // Do not open the row for another purchase. The provider number carries the
    // request UUID in friendlyName and the reconciliation worker can recover it.
    await db.from(TABLE).update({
      quarantined_at: nowIso(),
      quarantine_reason: "provider_operation_persistence_failed",
      last_error: "Provider number purchased; awaiting reconciliation.",
      updated_at: nowIso(),
    }).eq("manager_user_id", id).eq("provision_request_id", requestId);
    return { ok: false, error: "Provider setup is awaiting reconciliation.", state: "provisioning" };
  }

  // 5. Atomically claim the profile slot; on race, release the bought number so
  //    it is not orphaned/billed, then reconcile to the winner.
  const { data: profileClaimed, error: claimErr } = await db
    .from("profiles")
    .update({ sms_from_number: purchase.number, updated_at: nowIso() })
    .eq("id", id)
    .is("sms_from_number", null)
    .select("sms_from_number");

  if (claimErr || !profileClaimed || profileClaimed.length === 0) {
    const released = await releaseTwilioNumber(purchase.sid).catch(() => false);
    await db.from("sms_provisioning_operations").update({
      state: released ? "released" : "failed",
      last_error: released ? null : "Provider release could not be confirmed.",
      updated_at: nowIso(),
    }).eq("request_id", requestId);
    // Reconcile to a stored number ONLY if it is a real owned number — never a
    // legacy Claw shared line or placeholder stamp, which would otherwise mark
    // the state row `active` with the SHARED line as the manager's own number.
    const { data: prof } = await db.from("profiles").select("sms_from_number").eq("id", id).maybeSingle();
    const stored = String(prof?.sms_from_number ?? "").trim();
    const storedIsReal = stored && !isLegacyClawSharedSmsNumber(stored) && !isPlaceholderManagerWorkNumber(stored);
    if (storedIsReal) {
      const winner = await getManagerNumberRecord(db, id);
      if (winner?.phoneNumber === stored && winner.provisionState !== "failed" && winner.provisionState !== "released") {
        return { ok: true, number: stored, state: winner.provisionState, alreadyProvisioned: true };
      }
    }
    if (!released) {
      await db.from(TABLE).update({
        quarantined_at: nowIso(),
        quarantine_reason: "provider_release_unconfirmed",
        last_error: "A purchased number could not be safely released; operator review is required.",
        updated_at: nowIso(),
      }).eq("manager_user_id", id).eq("provision_request_id", requestId);
      return { ok: false, error: "Provider cleanup requires review.", state: "provisioning" };
    }
    await recordProvisionFailure(db, id, requestId, claimErr?.message ?? "Could not persist the work number.");
    return { ok: false, error: claimErr?.message ?? "Could not persist the work number.", state: "failed" };
  }

  // 6. Persist the purchased/attached number. It remains `provisioning` until a
  // trusted carrier event marks this exact phone SID registered.
  const { data: persisted, error: persistError } = await db
    .from(TABLE)
    .update({
      provision_state: "provisioning",
      phone_number: purchase.number,
      phone_number_sid: purchase.sid,
      messaging_service_sid: purchase.messagingServiceSid ?? null,
      attachment_state: "attached",
      attached_at: nowIso(),
      number_registration_state: "pending",
      registration_submitted_at: nowIso(),
      // One PropLane-owned approved brand/campaign: workspace approval is the
      // shared PropLane approval. The individual number still cannot send until
      // its separate carrier event marks number_registration_state registered.
      registration_state: "approved",
      registration_ref: null,
      registration_updated_at: nowIso(),
      area_code: opts?.areaCode ?? null,
      provisioned_at: nowIso(),
      last_error: null,
      updated_at: nowIso(),
    })
    .eq("manager_user_id", id)
    .eq("provision_request_id", requestId)
    .select("manager_user_id");

  if (persistError || !persisted?.length) {
    const released = await releaseTwilioNumber(purchase.sid).catch(() => false);
    await db
      .from("profiles")
      .update({ sms_from_number: null })
      .eq("id", id)
      .eq("sms_from_number", purchase.number)
      .then(() => undefined, () => undefined);
    await db.from("sms_provisioning_operations").update({
      state: released ? "released" : "failed",
      last_error: released ? null : "Provider release could not be confirmed.",
      updated_at: nowIso(),
    }).eq("request_id", requestId);
    if (!released) {
      await db.from(TABLE).update({
        quarantined_at: nowIso(),
        quarantine_reason: "provider_release_unconfirmed",
        last_error: "Purchased number persistence failed and provider release is unconfirmed.",
        updated_at: nowIso(),
      }).eq("manager_user_id", id).eq("provision_request_id", requestId);
      return { ok: false, error: "Provider cleanup requires review.", state: "provisioning" };
    }
    await recordProvisionFailure(db, id, requestId, persistError?.message ?? "Could not persist the purchased work number.");
    return { ok: false, error: "Could not persist the purchased work number.", state: "failed" };
  }

  await db.from("sms_provisioning_operations").update({ state: "persisted", updated_at: nowIso() }).eq("request_id", requestId);

  return { ok: true, number: purchase.number, state: "provisioning", alreadyProvisioned: false };
}

async function recordProvisionFailure(
  db: SupabaseClient,
  managerUserId: string,
  requestId: string,
  error: string,
): Promise<void> {
  await db
    .from(TABLE)
    .update({ provision_state: "failed", attachment_state: "failed", last_error: error.slice(0, 500), updated_at: nowIso() })
    .eq("manager_user_id", managerUserId)
    .eq("provision_request_id", requestId)
    .then(() => undefined, () => undefined);
}

export type ProvisioningReconciliationResult = {
  considered: number;
  recovered: number;
  safelyReset: number;
  needsReview: number;
  attachmentChecked: number;
  attachmentDrifted: number;
};

/**
 * Recover a process crash between Twilio purchase and local persistence. The
 * provider number is found by the request UUID stamped into friendlyName, so a
 * retry never guesses by phone and never purchases a second number.
 */
export async function reconcilePendingManagerNumberOperations(
  db: SupabaseClient,
  limit = 5,
): Promise<ProvisioningReconciliationResult> {
  const result: ProvisioningReconciliationResult = {
    considered: 0,
    recovered: 0,
    safelyReset: 0,
    needsReview: 0,
    attachmentChecked: 0,
    attachmentDrifted: 0,
  };
  if (!isProvisioningEnabled()) return result;
  const { data: rows, error } = await db
    .from(TABLE)
    .select("manager_user_id, provision_request_id, updated_at")
    .eq("provision_state", "provisioning")
    .is("phone_number_sid", null)
    .not("provision_request_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 20)));
  if (error) return result;

  const { findManagerTwilioNumberByRequestId } = await import("@/lib/twilio-provisioning");
  for (const row of rows ?? []) {
    const managerUserId = String(row.manager_user_id ?? "").trim();
    const requestId = String(row.provision_request_id ?? "").trim();
    if (!managerUserId || !requestId) continue;
    result.considered += 1;
    const provider = await findManagerTwilioNumberByRequestId(requestId);
    if (!provider.ok) {
      await db.from(TABLE).update({
        quarantined_at: nowIso(),
        quarantine_reason: "provider_reconciliation_unavailable",
        last_error: provider.error.slice(0, 500),
        updated_at: nowIso(),
      }).eq("manager_user_id", managerUserId).eq("provision_request_id", requestId);
      result.needsReview += 1;
      continue;
    }
    if (!provider.number) {
      const updatedAt = Date.parse(String(row.updated_at ?? ""));
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt < 15 * 60_000) continue;
      await db.from("sms_provisioning_operations").update({
        state: "failed",
        last_error: "No provider number exists for the durable request identity.",
        updated_at: nowIso(),
      }).eq("request_id", requestId);
      await recordProvisionFailure(
        db,
        managerUserId,
        requestId,
        "No provider number was created; setup may be retried.",
      );
      result.safelyReset += 1;
      continue;
    }

    const recovered = provider.number;
    let { data: profileClaim } = await db
      .from("profiles")
      .update({ sms_from_number: recovered.number, updated_at: nowIso() })
      .eq("id", managerUserId)
      .is("sms_from_number", null)
      .select("id");
    if (!profileClaim?.length) {
      const { data: profile } = await db.from("profiles").select("sms_from_number").eq("id", managerUserId).maybeSingle();
      if (String(profile?.sms_from_number ?? "").trim() !== recovered.number) {
        await db.from(TABLE).update({
          quarantined_at: nowIso(),
          quarantine_reason: "profile_number_conflict",
          last_error: "Recovered provider number conflicts with the profile cache.",
          updated_at: nowIso(),
        }).eq("manager_user_id", managerUserId).eq("provision_request_id", requestId);
        result.needsReview += 1;
        continue;
      }
      profileClaim = [{ id: managerUserId }];
    }

    const { data: persisted } = await db.from(TABLE).update({
      phone_number: recovered.number,
      phone_number_sid: recovered.sid,
      messaging_service_sid: recovered.messagingServiceSid,
      attachment_state: "attached",
      attached_at: nowIso(),
      number_registration_state: "pending",
      registration_submitted_at: nowIso(),
      registration_state: "approved",
      registration_ref: null,
      provisioned_at: nowIso(),
      quarantined_at: null,
      quarantine_reason: null,
      last_error: null,
      updated_at: nowIso(),
    }).eq("manager_user_id", managerUserId).eq("provision_request_id", requestId).select("manager_user_id");
    if (!persisted?.length) {
      result.needsReview += 1;
      continue;
    }
    await db.from("sms_provisioning_operations").update({
      state: "persisted",
      phone_number: recovered.number,
      phone_number_sid: recovered.sid,
      messaging_service_sid: recovered.messagingServiceSid,
      last_error: null,
      updated_at: nowIso(),
    }).eq("request_id", requestId);
    result.recovered += 1;
  }

  const { listAttachedTwilioNumbers } = await import("@/lib/twilio-provisioning");
  const snapshot = await listAttachedTwilioNumbers();
  if (!snapshot.ok) return result;
  const { data: attachedRows } = await db
    .from(TABLE)
    .select(
      "manager_user_id, phone_number, provision_state, number_registration_state, registration_submitted_at, last_provider_event_at, quarantined_at, quarantine_reason",
    )
    .eq("attachment_state", "attached")
    .neq("provision_state", "released")
    .not("phone_number", "is", null)
    .order("provider_reconciled_at", { ascending: true, nullsFirst: true })
    .limit(20);
  for (const attachedRow of attachedRows ?? []) {
    const managerUserId = String(attachedRow.manager_user_id ?? "").trim();
    const phone = String(attachedRow.phone_number ?? "").trim();
    if (!managerUserId || !phone) continue;
    result.attachmentChecked += 1;
    if (!snapshot.phoneNumbers.has(phone)) {
      await db.from(TABLE).update({
        attachment_state: "failed",
        quarantined_at: nowIso(),
        quarantine_reason: "messaging_service_attachment_missing",
        last_error: "Twilio sender-pool attachment is missing.",
        provider_reconciled_at: nowIso(),
        updated_at: nowIso(),
      }).eq("manager_user_id", managerUserId).eq("phone_number", phone);
      result.attachmentDrifted += 1;
    } else {
      const reconciledAt = nowIso();
      const carrierRegistrationStale =
        managerCarrierRegistrationNeedsAttention({
          provisionState: String(attachedRow.provision_state ?? ""),
          carrierRegistrationState: String(
            attachedRow.number_registration_state ?? "",
          ),
          registrationSubmittedAt:
            typeof attachedRow.registration_submitted_at === "string"
              ? attachedRow.registration_submitted_at
              : null,
          lastProviderEventAt:
            typeof attachedRow.last_provider_event_at === "string"
              ? attachedRow.last_provider_event_at
              : null,
        });
      if (carrierRegistrationStale) {
        result.needsReview += 1;
        const alreadyQuarantined = Boolean(
          String(attachedRow.quarantined_at ?? "").trim(),
        );
        await db
          .from(TABLE)
          .update(
            alreadyQuarantined
              ? { provider_reconciled_at: reconciledAt }
              : {
                  quarantined_at: reconciledAt,
                  quarantine_reason: "carrier_registration_stale",
                  last_error:
                    "Carrier registration has not reported progress; operator review is required.",
                  provider_reconciled_at: reconciledAt,
                  updated_at: reconciledAt,
                },
          )
          .eq("manager_user_id", managerUserId)
          .eq("phone_number", phone);
      } else {
        // This is routine attachment observation, not lifecycle progress. Do
        // not refresh updated_at and accidentally hide registration staleness.
        await db
          .from(TABLE)
          .update({ provider_reconciled_at: reconciledAt })
          .eq("manager_user_id", managerUserId)
          .eq("phone_number", phone);
      }
    }
  }
  return result;
}

export type ActivateSweepResult = {
  considered: number;
  provisioned: number;
  parked: number;
  failed: number;
  errors: Array<{ managerUserId: string; error: string }>;
};

/**
 * Bounded, observable sweep that provisions managers still waiting on a number.
 * `limit` caps how many purchases run in one pass (default 10) so cost can never
 * run away. Only does anything when `SMS_PROVISIONING_ENABLED=1`.
 */
export async function activatePendingManagerNumbers(
  db: SupabaseClient,
  opts?: { limit?: number; managerUserIds?: string[] },
): Promise<ActivateSweepResult> {
  const limit = opts?.limit && opts.limit > 0 ? Math.min(opts.limit, 100) : 10;
  const result: ActivateSweepResult = { considered: 0, provisioned: 0, parked: 0, failed: 0, errors: [] };

  let query = db
    .from(TABLE)
    .select("manager_user_id, provision_state, phone_number")
    .in("provision_state", ["pending_registration", "failed"])
    .limit(limit);
  if (opts?.managerUserIds?.length) query = query.in("manager_user_id", opts.managerUserIds.slice(0, limit));

  const { data } = await query;
  const rows = (data ?? []) as Array<{ manager_user_id: string; provision_state: string; phone_number: string | null }>;
  result.considered = rows.length;

  for (const row of rows) {
    if (!needsProvisioning({ provisionState: normalizeProvisionState(row.provision_state) })) continue;
    const res = await provisionManagerNumber(db, String(row.manager_user_id));
    if (res.ok) result.provisioned++;
    else if (res.state === "pending_registration") result.parked++;
    else {
      result.failed++;
      result.errors.push({ managerUserId: String(row.manager_user_id), error: res.error });
    }
  }
  return result;
}

/**
 * Set a manager's messaging registration state (ISV/reseller model). Flipping to
 * `approved` makes an already-active number sendable with no other surgery.
 * `ref` links the row to a shared registration record when supplied.
 */
export async function setManagerRegistrationState(
  db: SupabaseClient,
  managerUserId: string,
  state: RegistrationState,
  opts?: { ref?: string | null },
): Promise<void> {
  const id = managerUserId.trim();
  if (!id) return;
  await ensureManagerNumberRecord(db, id);
  // A per-manager decision detaches the manager from any shared registration
  // record (ref → null) so their OWN state governs — that is the reseller
  // control. To keep a manager ON the shared registration, pass an explicit
  // `ref` (e.g. the shared ref); single-shared-registration mode instead flips
  // the env flag and never calls this per manager.
  const patch: Record<string, unknown> = {
    registration_state: state,
    registration_ref: opts?.ref ?? null,
    registration_updated_at: nowIso(),
    updated_at: nowIso(),
  };
  await db.from(TABLE).update(patch).eq("manager_user_id", id).then(() => undefined, () => undefined);
}

/**
 * Deliberately release a manager's number (on deactivation). Reversible: the row
 * and its message history are preserved; the number is kept assigned so it can
 * be restored by flipping the state back to `active`. Does NOT release at the
 * provider (that is a destructive, money-adjacent op left to an operator).
 */
export async function releaseManagerNumber(db: SupabaseClient, managerUserId: string): Promise<void> {
  const id = managerUserId.trim();
  if (!id) return;
  await db
    .from(TABLE)
    .update({ provision_state: "released", released_at: nowIso(), updated_at: nowIso() })
    .eq("manager_user_id", id)
    .then(() => undefined, () => undefined);
}

/** Restore a previously released number (reverse of {@link releaseManagerNumber}). */
export async function restoreManagerNumber(db: SupabaseClient, managerUserId: string): Promise<void> {
  const id = managerUserId.trim();
  if (!id) return;
  await db
    .from(TABLE)
    .update({ provision_state: "active", released_at: null, updated_at: nowIso() })
    .eq("manager_user_id", id)
    .eq("provision_state", "released")
    .then(() => undefined, () => undefined);
}

/**
 * The E.164 number a manager may SEND from right now, or null when they cannot
 * (no active number, or registration not approved). Callers fall back to the
 * shared transport while null.
 */
export async function resolveActiveManagerSendNumber(
  db: SupabaseClient,
  managerUserId: string,
): Promise<string | null> {
  const record = await getManagerNumberRecord(db, managerUserId);
  if (!managerCanSendFromOwnNumber(record)) return null;
  return record?.phoneNumber ?? null;
}

export {
  effectiveRegistrationState,
  managerCanSendFromOwnNumber,
} from "@/lib/sms/number-registration-policy";
