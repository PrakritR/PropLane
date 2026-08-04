import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isClawSharedLineBridgeEnabled,
  isLegacyClawSharedSmsNumber,
  isPlaceholderManagerWorkNumber,
} from "@/lib/claw-leasing-links";
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
    serviceSuspendedAt: (row.service_suspended_at as string | null) ?? null,
    suspensionWarnedAt: (row.suspension_warned_at as string | null) ?? null,
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

  // 1. Idempotent short-circuit — already has a real active number.
  if (record && normalizeProvisionState(record.provisionState) === "active" && record.phoneNumber) {
    return { ok: true, number: record.phoneNumber, state: "active", alreadyProvisioned: true };
  }

  // 2a. Paid feature + deliberate enablement: only an allowlisted or
  //     actively-paid Pro/Business account may hold a number (trial is not
  //     payment). Fails CLOSED on an unreadable plan — this is the money path,
  //     and parking is retryable: the signup hook, the daily sweep, and the
  //     on-demand tab load all re-check, so a trial that converts (or an
  //     account the captain enables) provisions on the next touch.
  {
    const { resolveManagerNumberAccess } = await import("@/lib/sms/manager-number-access.server");
    const access = await resolveManagerNumberAccess(db, id);
    if (!access.allowed) {
      await db
        .from(TABLE)
        .update({
          provision_state: "pending_registration",
          last_error: `access:${access.reason}`,
          updated_at: nowIso(),
        })
        .eq("manager_user_id", id)
        .neq("provision_state", "active")
        .then(() => undefined, () => undefined);
      return { ok: false, error: `access:${access.reason}`, state: "pending_registration" };
    }
  }

  // 2b. Money guard — parked until an operator enables real purchases.
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
  await db
    .from(TABLE)
    .update({
      provision_state: "provisioning",
      attempts: (record?.attempts ?? 0) + 1,
      last_error: null,
      updated_at: nowIso(),
    })
    .eq("manager_user_id", id)
    .then(() => undefined, () => undefined);

  // 3b. Clear a legacy Claw shared-line / placeholder stamp BEFORE buying, so the
  //     atomic `.is("sms_from_number", null)` claim can succeed. Without this the
  //     claim always fails against a Claw-stamped profile and we churn
  //     buy→release→failed every sweep tick. (The bridge keeps the Claw line on
  //     purpose, so only clear when real provisioning is active.)
  if (!isClawSharedLineBridgeEnabled()) {
    const { data: prof0 } = await db.from("profiles").select("sms_from_number").eq("id", id).maybeSingle();
    const cur = String(prof0?.sms_from_number ?? "").trim();
    if (cur && (isLegacyClawSharedSmsNumber(cur) || isPlaceholderManagerWorkNumber(cur))) {
      await db
        .from("profiles")
        .update({ sms_from_number: null })
        .eq("id", id)
        .eq("sms_from_number", cur)
        .then(() => undefined, () => undefined);
    }
  }

  // 4. Provider purchase (all Twilio SDK usage lives in twilio-provisioning).
  const { purchaseManagerTwilioNumber, releaseTwilioNumber } = await import("@/lib/twilio-provisioning");
  const purchase = await purchaseManagerTwilioNumber({ areaCode: opts?.areaCode });
  if (!purchase.ok) {
    await recordProvisionFailure(db, id, purchase.error);
    return { ok: false, error: purchase.error, state: "failed" };
  }

  // 5. Atomically claim the profile slot; on race, release the bought number so
  //    it is not orphaned/billed, then reconcile to the winner.
  const { data: claimed, error: claimErr } = await db
    .from("profiles")
    .update({ sms_from_number: purchase.number, updated_at: nowIso() })
    .eq("id", id)
    .is("sms_from_number", null)
    .select("sms_from_number");

  if (claimErr || !claimed || claimed.length === 0) {
    await releaseTwilioNumber(purchase.sid).catch(() => undefined);
    // Reconcile to a stored number ONLY if it is a real owned number — never a
    // legacy Claw shared line or placeholder stamp, which would otherwise mark
    // the state row `active` with the SHARED line as the manager's own number.
    const { data: prof } = await db.from("profiles").select("sms_from_number").eq("id", id).maybeSingle();
    const stored = String(prof?.sms_from_number ?? "").trim();
    const storedIsReal = stored && !isLegacyClawSharedSmsNumber(stored) && !isPlaceholderManagerWorkNumber(stored);
    if (storedIsReal) {
      await db
        .from(TABLE)
        .update({ provision_state: "active", phone_number: stored, provisioned_at: nowIso(), last_error: null, updated_at: nowIso() })
        .eq("manager_user_id", id)
        .then(() => undefined, () => undefined);
      return { ok: true, number: stored, state: "active", alreadyProvisioned: true };
    }
    await recordProvisionFailure(db, id, claimErr?.message ?? "Could not persist the work number.");
    return { ok: false, error: claimErr?.message ?? "Could not persist the work number.", state: "failed" };
  }

  // 6. Record the active number + provider ids.
  await db
    .from(TABLE)
    .update({
      provision_state: "active",
      phone_number: purchase.number,
      phone_number_sid: purchase.sid,
      messaging_service_sid: purchase.messagingServiceSid ?? null,
      area_code: opts?.areaCode ?? null,
      provisioned_at: nowIso(),
      last_error: null,
      updated_at: nowIso(),
    })
    .eq("manager_user_id", id)
    .then(() => undefined, () => undefined);

  return { ok: true, number: purchase.number, state: "active", alreadyProvisioned: false };
}

async function recordProvisionFailure(db: SupabaseClient, managerUserId: string, error: string): Promise<void> {
  await db
    .from(TABLE)
    .update({ provision_state: "failed", last_error: error.slice(0, 500), updated_at: nowIso() })
    .eq("manager_user_id", managerUserId)
    .then(() => undefined, () => undefined);
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
 * Why a manager can (or cannot) send from their own number right now. The two
 * refusals are NOT interchangeable: `unavailable` means "no own number yet"
 * (the caller may fall back to another from-number), while `suspended` means
 * the number exists and is approved but the account no longer pays for it — a
 * downgraded manager keeps the number and it must stop sending, so falling back
 * to `profiles.sms_from_number` (the very same number) would defeat the gate.
 */
export type ManagerSendNumberState =
  | { status: "ok"; phoneNumber: string }
  | { status: "suspended"; phoneNumber: string | null }
  | { status: "unavailable" };

export async function resolveManagerSendNumberState(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerSendNumberState> {
  const record = await getManagerNumberRecord(db, managerUserId);
  if (!managerCanSendFromOwnNumber(record)) return { status: "unavailable" };
  const { resolveManagerNumberAccess, sendAllowedByAccess } = await import(
    "@/lib/sms/manager-number-access.server"
  );
  const access = await resolveManagerNumberAccess(db, managerUserId);
  if (!sendAllowedByAccess(access)) {
    // Stamp the start of the 90-day grace the first time we notice — never
    // overwrite an existing stamp (the grace clock must not reset on every send).
    if (!record?.serviceSuspendedAt) {
      await db
        .from(TABLE)
        .update({ service_suspended_at: nowIso(), updated_at: nowIso() })
        .eq("manager_user_id", managerUserId.trim())
        .eq("provision_state", "active")
        .is("service_suspended_at", null)
        .then(() => undefined, () => undefined);
    }
    return { status: "suspended", phoneNumber: record?.phoneNumber ?? null };
  }
  // Re-entitlement clears the grace clock so a later downgrade starts fresh.
  if (record?.serviceSuspendedAt) {
    await db
      .from(TABLE)
      .update({
        service_suspended_at: null,
        suspension_warned_at: null,
        updated_at: nowIso(),
      })
      .eq("manager_user_id", managerUserId.trim())
      .not("service_suspended_at", "is", null)
      .then(() => undefined, () => undefined);
  }
  const phoneNumber = String(record?.phoneNumber ?? "").trim();
  return phoneNumber ? { status: "ok", phoneNumber } : { status: "unavailable" };
}

/**
 * The E.164 number a manager may SEND from right now, or null when they cannot
 * (no active number, registration not approved, or the account's number access
 * is suspended — a downgraded-to-Free manager keeps the number but its service
 * stops). Callers that must tell those apart use
 * {@link resolveManagerSendNumberState}.
 */
export async function resolveActiveManagerSendNumber(
  db: SupabaseClient,
  managerUserId: string,
): Promise<string | null> {
  const state = await resolveManagerSendNumberState(db, managerUserId);
  return state.status === "ok" ? state.phoneNumber : null;
}

export {
  effectiveRegistrationState,
  managerCanSendFromOwnNumber,
} from "@/lib/sms/number-registration-policy";
