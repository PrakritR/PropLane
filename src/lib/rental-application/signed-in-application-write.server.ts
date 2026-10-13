/**
 * The signed-in applicant's write of `manager_application_records`, shared by
 * `POST /api/manager-applications` and `POST /api/portal/quick-apply` so a Quick
 * apply is the SAME submit the wizard makes (validation, fee guard, resident link,
 * linked forms, manager notice, move-in forms, screening) and not a copy of it.
 *
 * `prepareResidentSelfWrite` is everything that decides whether the row may be
 * written and what it becomes; `persistApplicationWrite` stores it and fires the
 * submit side effects. The route keeps the guest and manager branches.
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { isMissingColumnError } from "@/lib/db-missing-column";
import { persistRenamedApplicationRecord, type ApplicationRecordSnapshot } from "@/lib/security/application-record-normalization.server";
import { prepareApplicantIdentityWrite, sealApplicantRow } from "@/lib/security/applicant-identity";
import { applicantRoomChoicesForListing } from "@/lib/auth/guest-application-upsert";
import { linkResidentOnApplicationSubmit } from "@/lib/auth/link-resident-on-application-submit";
import { recordResidentWorkspaceBinding } from "@/lib/auth/resident-workspace-binding";
import { provisionApprovedResidentAccount } from "@/lib/auth/provision-approved-resident";
import { isDraftApplicationRow, normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { createLinkedFormRequestsForSubmit } from "@/lib/application-linked-form-requests.server";
import { applicationEventForTransition, emitApplicationTransition } from "@/lib/domain-action-events.server";
import { dispatchMoveInFormsForResidencyAfterResponse } from "@/lib/move-in-forms/server";
import {
  notifyManagerApplicationSubmitted,
  shouldNotifyManagerOfApplicationSubmit,
} from "@/lib/application-submitted-notification.server";
import { isSubmittedPendingApplicationRow } from "@/lib/rental-application/in-progress-application";
import { syncApplicationLifecycleTasks } from "@/lib/manager-default-tasks.server";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";
import { tryAutoOrderScreening } from "@/lib/screening/order-screening";
import { SMS_CONSENT_WORDING_VERSION } from "@/lib/rental-application/sms-consent";
import { revokeApplicationScopedSmsConsentOnWithdrawal } from "@/lib/sms/application-consent.server";
import {
  validateResidentApplicationRowForPersistence,
  type EffectiveApplicationPropertyLoader,
} from "@/lib/rental-application/validate-application-submit.server";
import { fillApplicantIdentityFromAccount } from "@/lib/rental-application/applicant-identity.server";
import type { ApplicantAuthUser } from "@/lib/rental-application/applicant-identity";
import { authorizeApplicationFeeSubmission } from "@/lib/rental-application/application-fee-submit-guard.server";
import { assertManagerResidentQuota, MANAGER_RESIDENT_LIMIT_ERROR_CODE } from "@/lib/manager-resident-quota.server";
import { bestEffortFailed } from "@/lib/observability/best-effort";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type ApplicationWriteRefusal = { ok: false; status: number; body: Record<string, unknown> };

export function idVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [
    ...new Set(
      [trimmed, trimmed.toUpperCase(), normalized, normalized.toUpperCase()].filter(Boolean),
    ),
  ];
}

/**
 * Persist a draft (in-progress) snapshot without ever walking a submitted
 * application backwards.
 *
 * The wizard fires draft syncs unawaited, so a draft request routinely reads the
 * pre-submit state and only commits after the submit write landed. Read-then-write
 * cannot close that window no matter where the check sits — the check and the
 * write must be ONE statement. So the draft goes out as a conditional UPDATE the
 * database itself refuses unless the stored row is still a LIVE draft — a
 * withdrawn one (bucket stays `pending`, stage stays "In progress") refuses too,
 * so a debounced autosave landing after the resident withdrew can never clear
 * `withdrawnAt` or revive the row. Only when no row exists at all do we insert,
 * and a unique violation there means a row appeared concurrently, so we re-run
 * the same conditional update rather than clobbering it.
 */
export async function persistDraftRow(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  ids: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const updateIfStillDraft = async (): Promise<boolean> => {
    const { data: existingRows, error: loadError } = await db
      .from("manager_application_records")
      .select("id, row_data")
      .in("id", ids);
    if (loadError) throw new Error(`Could not inspect the existing application draft: ${loadError.message}`);
    const draftIds = (existingRows ?? [])
      .filter((row) => isDraftApplicationRow((row.row_data ?? {}) as DemoApplicantRow))
      .map((row) => String(row.id));
    if (draftIds.length === 0) return false;
    const { data, error: updateError } = await db
      .from("manager_application_records")
      .update(values)
      .in("id", draftIds)
      .eq("row_data->>bucket", "pending")
      .is("row_data->>withdrawnAt", null)
      .select("id");
    if (updateError) {
      throw Object.assign(new Error(`Could not persist the application draft: ${updateError.message}`), {
        code: updateError.code,
        cause: updateError,
      });
    }
    return (data?.length ?? 0) > 0;
  };

  if (await updateIfStillDraft()) return;
  const { error } = await db.from("manager_application_records").insert(values);
  // Only a unique conflict proves a row appeared concurrently. Every other
  // insert failure is a real persistence failure and must reach the route so an
  // smsConsent=false update is never falsely acknowledged.
  if (error?.code === "23505") {
    await updateIfStillDraft();
    return;
  }
  if (error) {
    throw Object.assign(new Error(`Could not persist the application draft: ${error.message}`), {
      code: error.code,
      cause: error,
    });
  }
}

/** A submitted, pending application the applicant is writing again: re-check the forms its answers owe (idempotent). */
export function owesLinkedFormCheck(row: DemoApplicantRow): boolean {
  return isSubmittedPendingApplicationRow(row) && Boolean(row.managerUserId?.trim());
}

export async function persistNormalizedRow(
  db: ReturnType<typeof createSupabaseServiceRoleClient>, oldId: string, row: DemoApplicantRow,
  authorizedExisting: (Omit<Partial<ApplicationRecordSnapshot>, "id"> & { id?: string | null }) | null,
  sourceChannel: string | null = null,
) {
  // Carry the exact snapshot whose actor/property/token access was checked.
  // Re-reading it here could adopt a concurrent transfer without reauthorizing.
  if (authorizedExisting && (typeof authorizedExisting.id !== "string" || !authorizedExisting.id || !authorizedExisting.row_data)) {
    throw new Error("Application normalization source is unavailable.");
  }
  const existing = authorizedExisting ? { ...authorizedExisting, id: authorizedExisting.id as string, row_data: authorizedExisting.row_data } : null;
  if (oldId !== row.id && !existing) throw new Error("Application normalization source is unavailable.");
  row = prepareApplicantIdentityWrite(row, existing?.row_data, String(existing?.id ?? row.id));
  const renaming = Boolean(existing && existing.id !== row.id);
  if (renaming) row = { ...row, managerUserId: existing!.manager_user_id ?? null };
  const core = {
    id: row.id,
    manager_user_id: row.managerUserId || null,
    resident_email: row.email?.trim().toLowerCase() || null,
    property_id: row.propertyId || row.application?.propertyId || null,
    assigned_property_id: row.assignedPropertyId || null,
    row_data: sealApplicantRow(row, row.id, existing?.manager_user_id || row.managerUserId),
    updated_at: new Date().toISOString(),
  };
  // First touch only: a brand-new row records the listing site the applicant came from. An
  // existing row keeps whatever it already has, and the rename path never carries the column.
  const tagged = !existing && sourceChannel ? { ...core, source_channel: sourceChannel } : core;
  const incomingDraft = { ...row, withdrawnAt: undefined };
  const writeValues = async (values: typeof core & { source_channel?: string }) => {
    if (renaming) {
      // The source snapshot check is the draft downgrade guard for this atomic
      // ID transition; an intervening submit/withdrawal/transfer rejects it.
      await persistRenamedApplicationRecord(db, existing!, values);
    } else if (isDraftApplicationRow(incomingDraft)) {
      await persistDraftRow(db, idVariants(row.id), values);
    } else {
      // Submit and every forward move stay authoritative and write unconditionally.
      const { error: upsertError } = await db
        .from("manager_application_records")
        .upsert(values, { onConflict: "id" });
      if (upsertError) throw Object.assign(new Error(`Could not persist the application: ${upsertError.message}`), { code: upsertError.code, cause: upsertError });
    }
  };
  try {
    await writeValues(tagged);
  } catch (cause) {
    // The lead-source column only tags the row; a database still waiting on
    // `20261008180000_listing_lead_source.sql` must never cost the applicant their submission.
    if (tagged === core || !isMissingColumnError(cause, "source_channel")) throw cause;
    await writeValues(core);
  }
  if (row.bucket === "approved") {
    try {
      const provisioned = await provisionApprovedResidentAccount(db, row);
      if (!provisioned.ok) {
        console.error("Approved application persisted but resident provisioning failed:", {
          applicationId: row.id,
          error: provisioned.error,
        });
      }
    } catch (error) {
      console.error("Approved application persisted but resident provisioning crashed:", {
        applicationId: row.id,
        error: error instanceof Error ? error.message : "Unknown provisioning error",
      });
    }
  }
  return row;
}

export type StoredApplicationRecord = {
  id?: string | null;
  row_data?: DemoApplicantRow | null;
  manager_user_id?: string | null;
  resident_email?: string | null;
  property_id?: string | null;
  assigned_property_id?: string | null;
};

export const STORED_APPLICATION_SELECT = "id, row_data, manager_user_id, resident_email, property_id, assigned_property_id";

export async function loadStoredApplicationRecord(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  id: string,
): Promise<{ error: boolean; record: StoredApplicationRecord | null }> {
  const { data, error } = await db
    .from("manager_application_records")
    .select(STORED_APPLICATION_SELECT)
    .in("id", idVariants(id))
    .limit(1);
  if (error) return { error: true, record: null };
  return { error: false, record: (data?.[0] as StoredApplicationRecord | undefined) ?? null };
}

/**
 * SMS consent evidence is SERVER-owned, like `withdrawnAt`. Every write path
 * mirrors a client blob wholesale, so the client-supplied `smsConsentAt` /
 * `smsConsentWordingVersion` are never trusted: while `smsConsent` is true the
 * server keeps the FIRST stamp it recorded (draft rows re-upsert on every
 * keystroke) or mints a fresh timestamp + current wording version; an EXPLICIT
 * `smsConsent: false` (a genuine uncheck/opt-out) clears both. A blob that
 * simply lacks the field (a legacy client, a manager mirror captured before the
 * field existed, an unrelated re-upsert) preserves whatever the server already
 * recorded — absence is not an opt-out and must never destroy evidence.
 */
export function anchorServerOwnedSmsConsent(
  row: DemoApplicantRow,
  stored: DemoApplicantRow | null,
): DemoApplicantRow {
  if (!row.application) return row;
  if (row.application.smsConsent === true) {
    const storedApp = stored?.application;
    const firstStampAt = storedApp?.smsConsent === true ? storedApp.smsConsentAt?.trim() || undefined : undefined;
    return {
      ...row,
      application: {
        ...row.application,
        smsConsentAt: firstStampAt ?? new Date().toISOString(),
        smsConsentWordingVersion:
          (firstStampAt ? storedApp?.smsConsentWordingVersion : undefined) ?? SMS_CONSENT_WORDING_VERSION,
      },
    };
  }
  const storedApp = stored?.application;
  if (row.application.smsConsent === undefined && storedApp?.smsConsent !== undefined) {
    return {
      ...row,
      application: {
        ...row.application,
        smsConsent: storedApp.smsConsent,
        smsConsentAt: storedApp.smsConsentAt,
        smsConsentWordingVersion: storedApp.smsConsentWordingVersion,
      },
    };
  }
  if (row.application.smsConsentAt === undefined && row.application.smsConsentWordingVersion === undefined) {
    return row;
  }
  return {
    ...row,
    application: { ...row.application, smsConsentAt: undefined, smsConsentWordingVersion: undefined },
  };
}

export async function revokeMaterializedApplicationConsentAfterWrite(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  stored: StoredApplicationRecord | null,
  nextRow: DemoApplicantRow,
): Promise<void> {
  const previousRow = (stored?.row_data ?? null) as DemoApplicantRow | null;
  if (previousRow?.application?.smsConsent !== true || nextRow.application?.smsConsent !== false) return;
  const result = await revokeApplicationScopedSmsConsentOnWithdrawal(db, {
    applicationId: String(stored?.id ?? previousRow.id ?? nextRow.id),
    managerUserId: String(stored?.manager_user_id ?? previousRow.managerUserId ?? nextRow.managerUserId ?? ""),
    previousRow,
    nextRow,
  });
  if (!result.ok) throw new Error(result.error);
}

export type PreparedResidentSelfWrite =
  | { ok: true; row: DemoApplicantRow; authorizedWriteRecord: StoredApplicationRecord | null }
  | ApplicationWriteRefusal;

/**
 * A signed-in applicant writing their OWN application (a resident, or a non-resident login applying
 * somewhere they do not manage). Ownership is the authenticated email; the stored row, when there is
 * one, must be theirs and still pending.
 */
export async function prepareResidentSelfWrite(
  db: Db,
  // The whole auth user, not just its id: a template that no longer asks for a name or an email
  // resolves them from THIS account below, and a bare `{ id }` would silently store neither.
  user: ApplicantAuthUser & { id: string },
  input: {
    row: DemoApplicantRow;
    requestedRowId: string;
    role: string;
    email: string;
    /** Where the listing is read from, so one request reads it once (`memoizeEffectiveApplicationProperty`). */
    loadProperty?: EffectiveApplicationPropertyLoader;
  },
): Promise<PreparedResidentSelfWrite> {
  const { requestedRowId, role, email } = input;
  let row = input.row;
  const refuse = (status: number, body: Record<string, unknown>): ApplicationWriteRefusal => ({ ok: false, status, body });
  const rowEmail = (row.email ?? "").trim().toLowerCase();
  if (!email || rowEmail !== email) {
    return refuse(403, { error: "You can only update your own application." });
  }
  const ids = idVariants(requestedRowId);
  const { data: records, error: loadError } = await db
    .from("manager_application_records")
    .select(STORED_APPLICATION_SELECT)
    .in("id", ids)
    .limit(1);
  if (loadError) return refuse(500, { error: loadError.message });
  const existing = records?.[0]?.row_data as DemoApplicantRow | undefined;
  if (existing && String(records?.[0]?.resident_email ?? existing.email ?? "").trim().toLowerCase() !== email) {
    return refuse(403, { error: "You can only update your own application." });
  }
  if (existing && existing.bucket !== "pending") {
    return refuse(403, { error: "This application can no longer be edited." });
  }
  if (row.bucket !== "pending") {
    return refuse(403, { error: "Residents cannot change application status." });
  }
  const authorizedWriteRecord = (records?.[0] as StoredApplicationRecord | undefined) ?? null;
  row = {
    ...row,
    bucket: "pending",
    // The login bound to this application is the authenticated writer's own, never a client-supplied id.
    residentUserId: existing?.residentUserId ?? user.id,
    withdrawnAt: existing?.withdrawnAt ?? row.withdrawnAt,
    // Manager-assigned placement: never from the applicant, only what the manager stored.
    assignedPropertyId: existing?.assignedPropertyId,
    assignedRoomChoice: existing?.assignedRoomChoice,
    signedMonthlyRent: existing?.signedMonthlyRent ?? row.signedMonthlyRent,
    managerUserId: existing?.managerUserId ?? null,
    backgroundCheckStatus: existing?.backgroundCheckStatus ?? row.backgroundCheckStatus,
    screening: existing?.screening ?? row.screening,
    manuallyAdded: existing?.manuallyAdded === true,
    manualResidentDetails: existing?.manualResidentDetails,
    moveInInstructions: existing?.moveInInstructions ?? row.moveInInstructions,
    application:
      row.application && existing?.application
        ? {
            ...row.application,
            managerRentOverride: existing.application.managerRentOverride,
            managerUtilitiesOverride: existing.application.managerUtilitiesOverride,
            managerSecurityDepositOverride: existing.application.managerSecurityDepositOverride,
            managerMoveInFeeOverride: existing.application.managerMoveInFeeOverride,
            managerLeaseFeeWaiver: existing.application.managerLeaseFeeWaiver,
            managerOtherCostLabel: existing.application.managerOtherCostLabel,
            managerOtherCostAmount: existing.application.managerOtherCostAmount,
          }
        : row.application,
  };
  // A room choice may only name a room of the listing the applicant applied to.
  row = {
    ...row,
    application: applicantRoomChoicesForListing(row.application, String(row.propertyId || row.application?.propertyId || "")),
  };
  row = prepareApplicantIdentityWrite(row, existing, String(records?.[0]?.id ?? row.id));
  if (!existing || isDraftShapedApplicationRow(existing)) {
    const validation = await validateResidentApplicationRowForPersistence(db, row, {
      loadProperty: input.loadProperty,
    });
    if (!validation.ok) {
      return refuse(validation.status, {
        error: validation.error,
        fieldErrors: validation.fieldErrors,
        ...(validation.step ? { step: validation.step } : {}),
      });
    }
    if (!isDraftShapedApplicationRow(row)) {
      const fee = await authorizeApplicationFeeSubmission(db, row);
      if (!fee.ok) return refuse(fee.status, { error: fee.error });
    }
  }
  const linked = await linkResidentOnApplicationSubmit(db, {
    userId: user.id,
    row,
    isNewSubmit: !existing,
    existingManagerUserId: existing?.managerUserId ?? null,
    linkProfile: role === "resident",
  });
  if (!linked.ok) {
    return refuse(linked.status, {
      error: linked.error,
      existingApplicationId: linked.existingApplicationId,
      fieldErrors: linked.fieldErrors,
    });
  }
  row = linked.row;
  // The answers were validated above; whatever identity the template no longer asks for now comes
  // from the applicant's own account, so the stored row (resident_email, name, answers) is complete.
  if (!isDraftShapedApplicationRow(row)) {
    row = await fillApplicantIdentityFromAccount(db, user, row, { submitted: true });
  }
  row = anchorServerOwnedSmsConsent(row, existing ?? null);
  return { ok: true, row, authorizedWriteRecord };
}

export type PersistedApplicationWrite =
  | { ok: true; row: DemoApplicantRow; linkedForms: Awaited<ReturnType<typeof createLinkedFormRequestsForSubmit>> }
  | ApplicationWriteRefusal;

/** Store the row and fire the submit side effects. Shared by the applicant branch and the manager branch. */
export async function persistApplicationWrite(
  db: Db,
  input: {
    user: { id: string; email?: string | null };
    row: DemoApplicantRow;
    requestedRowId: string;
    authorizedWriteRecord: StoredApplicationRecord | null;
    residentSelfWrite: boolean;
    leadSource: string | null;
  },
): Promise<PersistedApplicationWrite> {
  const { user, requestedRowId, authorizedWriteRecord, residentSelfWrite } = input;
  let row = input.row;
  const priorLoad = await loadStoredApplicationRecord(db, requestedRowId);
  if (priorLoad.error) {
    // The previous consent snapshot decides whether an append-only revoke is
    // required. Persisting smsConsent=false without that evidence could leave
    // a materialized grant active while falsely acknowledging the opt-out.
    return { ok: false, status: 500, body: { error: "Could not load the existing application." } };
  }
  const previousRow = (priorLoad.record?.row_data ?? null) as DemoApplicantRow | null;
  const nextIsResidentSlot = row.bucket === "approved" || row.manuallyAdded === true;
  const priorWasResidentSlot = previousRow?.bucket === "approved" || previousRow?.manuallyAdded === true;
  if (nextIsResidentSlot && !priorWasResidentSlot) {
    const quota = await assertManagerResidentQuota(db, {
      ownerUserId: row.managerUserId || authorizedWriteRecord?.manager_user_id || null,
      occupiesNewSlot: true,
      excludeRecordId: String(authorizedWriteRecord?.id ?? row.id),
    });
    if (!quota.ok) {
      return {
        ok: false,
        status: quota.status,
        body: { error: quota.error, code: quota.code ?? MANAGER_RESIDENT_LIMIT_ERROR_CODE },
      };
    }
  }
  row = await persistNormalizedRow(
    db, authorizedWriteRecord?.id ?? row.id, row, authorizedWriteRecord,
    input.leadSource,
  );
  // The one writer of the proof that lets a manager's "Delete resident" also delete this
  // login: the id is the authenticated session's (`user.id`), the manager is the listing's.
  // Only a real submit binds — an abandoned draft is not the resident choosing this
  // workspace — and only after the row is stored, so the proof never outlives a failed save.
  if (residentSelfWrite && !isDraftShapedApplicationRow(row)) {
    await recordResidentWorkspaceBinding(db, {
      residentUserId: user.id,
      managerUserId: row.managerUserId ?? null,
      applicationId: row.id,
    });
  }
  await revokeMaterializedApplicationConsentAfterWrite(db, priorLoad.record, row);
  // `row.id` is the id the row was stored under (a rename may have changed it from the record's old id).
  const linkedForms =
    shouldNotifyManagerOfApplicationSubmit(previousRow, row) || (residentSelfWrite && owesLinkedFormCheck(row))
      ? await createLinkedFormRequestsForSubmit(db, {
          applicationId: String(row.id),
          row,
          applicantUserId: residentSelfWrite ? user.id : null,
        })
      : [];
  if (shouldNotifyManagerOfApplicationSubmit(previousRow, row)) {
    void notifyManagerApplicationSubmitted(db, row).catch(
      bestEffortFailed("manager application-submitted notice", { application: row.id, manager: row.managerUserId }),
    );
    dispatchMoveInFormsForResidencyAfterResponse(row.id, "application-submitted");
  }
  void syncApplicationLifecycleTasks(db, previousRow, row).catch(
    bestEffortFailed("application lifecycle task sync", { application: row.id }),
  );
  if (row.managerUserId) {
    void emitApplicationTransition(db, {
      managerUserId: row.managerUserId,
      previous: previousRow,
      application: row,
      actor: { userId: user.id, email: user.email ?? "" },
    }).catch(bestEffortFailed("application action event", { application: row.id }));
  }
  // Forms set to go out on approval (the manager chose "when the application is approved"
  // rather than the default "when the lease is signed"). Best-effort; never fails this save.
  if (row.managerUserId && applicationEventForTransition(previousRow, row) === "application_approved") {
    dispatchMoveInFormsForResidencyAfterResponse(row.id, "application-approved");
  }
  if (row.bucket === "pending" && row.application?.consentCredit) {
    void tryAutoOrderScreening(db, row);
  }
  return { ok: true, row, linkedForms };
}
