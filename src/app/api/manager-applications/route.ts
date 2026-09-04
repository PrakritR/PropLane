import { NextResponse } from "next/server";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { prepareGuestApplicationUpsert } from "@/lib/auth/guest-application-upsert";
import { buildResidentSetupHref } from "@/lib/auth/resident-setup-token";
import { linkResidentOnApplicationSubmit } from "@/lib/auth/link-resident-on-application-submit";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerCanAccessApplicationRecord, managerOwnedPropertyIdSet } from "@/lib/auth/manager-application-access";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { linkedOwnerForProperty, linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { provisionApprovedResidentAccount } from "@/lib/auth/provision-approved-resident";
import { isDraftApplicationRow, normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import {
  notifyManagerApplicationSubmitted,
  shouldNotifyManagerOfApplicationSubmit,
} from "@/lib/application-submitted-notification.server";
import { syncApplicationLifecycleTasks } from "@/lib/manager-default-tasks.server";
import { purgeApplicationPortalData } from "@/lib/auth/purge-portal-account-data";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { residentOwnsApplicationRow } from "@/lib/rental-application/resident-application-ownership";
import { tryAutoOrderScreening } from "@/lib/screening/order-screening";
import { runExistingResidentOnboarding } from "@/lib/existing-resident-onboarding.server";
import { SMS_CONSENT_WORDING_VERSION } from "@/lib/rental-application/sms-consent";
import { revokeApplicationScopedSmsConsentOnWithdrawal } from "@/lib/sms/application-consent.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { bestEffortFailed } from "@/lib/observability/best-effort";

export const runtime = "nodejs";

async function sessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

function normalizeRow(row: DemoApplicantRow): DemoApplicantRow {
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  const id = normalizeApplicationAxisId(row.id);
  return {
    ...row,
    id,
    propertyId: row.propertyId || propertyId || undefined,
    assignedPropertyId: row.assignedPropertyId || undefined,
    email: row.email?.trim().toLowerCase() || row.email,
  };
}

function idVariants(id: string): string[] {
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
async function persistDraftRow(
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
    if (updateError) throw new Error(`Could not persist the application draft: ${updateError.message}`);
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
  if (error) throw new Error(`Could not persist the application draft: ${error.message}`);
}

async function persistNormalizedRow(db: ReturnType<typeof createSupabaseServiceRoleClient>, oldId: string, row: DemoApplicantRow) {
  const values = {
    id: row.id,
    manager_user_id: row.managerUserId || null,
    resident_email: row.email?.trim().toLowerCase() || null,
    property_id: row.propertyId || row.application?.propertyId || null,
    assigned_property_id: row.assignedPropertyId || null,
    row_data: row,
    updated_at: new Date().toISOString(),
  };
  const incomingDraft = { ...row, withdrawnAt: undefined };
  if (isDraftApplicationRow(incomingDraft)) {
    await persistDraftRow(db, idVariants(row.id), values);
  } else {
    // Submit and every forward move stay authoritative and write unconditionally.
    const { error: upsertError } = await db
      .from("manager_application_records")
      .upsert(values, { onConflict: "id" });
    if (upsertError) throw new Error(`Could not persist the application: ${upsertError.message}`);
  }
  // Persist the normalized row before deleting an obsolete alias. Reversing
  // this order can erase the only durable copy if the upsert fails.
  if (oldId !== row.id) {
    const { error: deleteError } = await db.from("manager_application_records").delete().eq("id", oldId);
    if (deleteError) throw new Error(`Could not remove the obsolete application id: ${deleteError.message}`);
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
}

async function resolvePortalRole(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  user: NonNullable<Awaited<ReturnType<typeof sessionUser>>>,
) {
  const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
  const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
  return { role, email };
}

function isManagerPortalRole(role: string): boolean {
  return role === "manager" || role === "owner" || role === "pro";
}

async function assertManagerOrAdminWriteAccess(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  user: NonNullable<Awaited<ReturnType<typeof sessionUser>>>,
): Promise<NextResponse | null> {
  if (await isAdminUser(user.id)) return null;
  const { role } = await resolvePortalRole(db, user);
  if (!isManagerPortalRole(role)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
  }
  return null;
}

type StoredApplicationRecord = {
  id?: string | null;
  row_data?: DemoApplicantRow | null;
  manager_user_id?: string | null;
  property_id?: string | null;
  assigned_property_id?: string | null;
};

const STORED_APPLICATION_SELECT = "id, row_data, manager_user_id, property_id, assigned_property_id";

async function loadStoredApplicationRecord(
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
 * Batched read of every stored row a mirrored batch touches (never one query per
 * row). The mirror posts the manager's WHOLE cached set, so the id filter is
 * chunked: one `.in()` carrying several hundred ids overruns the URI buffer in
 * front of PostgREST, and because this read fails CLOSED that would reject the
 * entire mirror — silently, since the mirror is fire-and-forget.
 */
const STORED_APPLICATION_ID_CHUNK = 100;

async function loadStoredApplicationRecords(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  rows: DemoApplicantRow[],
): Promise<{ error: boolean; byId: Map<string, StoredApplicationRecord> }> {
  const byId = new Map<string, StoredApplicationRecord>();
  const ids = [...new Set(rows.flatMap((row) => idVariants(String(row.id ?? ""))))];
  if (ids.length === 0) return { error: false, byId };

  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += STORED_APPLICATION_ID_CHUNK) {
    chunks.push(ids.slice(index, index + STORED_APPLICATION_ID_CHUNK));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      db.from("manager_application_records").select(STORED_APPLICATION_SELECT).in("id", chunk),
    ),
  );
  for (const { data, error } of results) {
    if (error) return { error: true, byId };
    for (const record of (data ?? []) as StoredApplicationRecord[]) {
      const id = String(record.id ?? "").trim();
      if (!id) continue;
      byId.set(id, record);
      byId.set(id.toUpperCase(), record);
    }
  }
  return { error: false, byId };
}

function storedRecordForRow(
  byId: Map<string, StoredApplicationRecord>,
  row: DemoApplicantRow,
): StoredApplicationRecord | null {
  for (const variant of idVariants(String(row.id ?? ""))) {
    const hit = byId.get(variant) ?? byId.get(variant.toUpperCase());
    if (hit) return hit;
  }
  return null;
}

/**
 * `withdrawnAt` is SERVER-owned on a manager write. Both write paths mirror a
 * client-cached blob wholesale, so a manager whose panel went stale before the
 * resident withdrew would otherwise erase the stamp — and, because
 * `persistNormalizedRow` provisions the resident account for any row landing in
 * `approved`, approve the withdrawal it just erased.
 *
 * The refusal is keyed on the TRANSITION into `approved`, not on the row's state:
 * records that are already approved AND carry a stamp exist in production (the
 * residue of the gap this closes) and must stay editable.
 */
function anchorServerOwnedWithdrawal(
  row: DemoApplicantRow,
  stored: StoredApplicationRecord | null,
): { row: DemoApplicantRow; blockedApproval: boolean } {
  const storedRow = (stored?.row_data ?? null) as DemoApplicantRow | null;
  const next: DemoApplicantRow = { ...row, withdrawnAt: storedRow?.withdrawnAt ?? row.withdrawnAt };
  const blockedApproval =
    next.bucket === "approved" && storedRow?.bucket !== "approved" && isWithdrawnApplicationRow(next);
  return { row: next, blockedApproval };
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
function anchorServerOwnedSmsConsent(
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

async function revokeMaterializedApplicationConsentAfterWrite(
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

/**
 * Resolve the owner a manager write should be attributed to, and whether it is
 * allowed. A role-only gate previously trusted the client-supplied
 * `managerUserId`, letting any manager persist rows under another manager's id
 * (cross-tenant write hole) and letting a read-only co-manager edit an owner's
 * applications/residents. Rules (non-admin):
 *  - New row or the caller's own row → forced to the caller (ignore any forged id).
 *  - A FOREIGN existing row (owned by a linked owner) → writable only with the
 *    applications OR residents EDIT grant on the row's property; owner preserved.
 */
async function resolveApplicationWriteOwner(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  callerId: string,
  row: DemoApplicantRow,
  prefetched?: { record: StoredApplicationRecord | null },
): Promise<{ ok: boolean; owner: string | null }> {
  const ids = idVariants(String(row.id ?? ""));
  // Use .in() (parameterized) rather than interpolating the client-controlled id
  // variants into an .or() filter string. Fail CLOSED on a query error: treating
  // a transient failure as "no existing row" would attribute a foreign row to
  // the caller and skip the ownership check.
  let existing: StoredApplicationRecord | null;
  if (prefetched) {
    existing = prefetched.record;
  } else {
    const { data: existingRows, error: existingErr } = await db
      .from("manager_application_records")
      .select(STORED_APPLICATION_SELECT)
      .in("id", ids)
      .limit(1);
    if (existingErr) return { ok: false, owner: null };
    existing = (existingRows?.[0] as StoredApplicationRecord | undefined) ?? null;
  }
  const existingOwner = existing?.manager_user_id ? String(existing.manager_user_id) : null;

  const canEditProperty = async (pid: string): Promise<boolean> =>
    Boolean(pid) &&
    ((await managerHasCoManagerPermissionForProperty(db, callerId, pid, "applications", "edit")) ||
      (await managerHasCoManagerPermissionForProperty(db, callerId, pid, "residents", "edit")));

  if (existingOwner) {
    if (existingOwner === callerId) return { ok: true, owner: callerId };
    // Foreign existing row: anchor the permission check on the STORED property,
    // never the client-supplied row (which could be spoofed to a property the
    // caller can edit). The owner is always preserved.
    const pid = String(existing?.property_id || existing?.assigned_property_id || "").trim();
    if (!pid) return { ok: false, owner: existingOwner };
    return { ok: await canEditProperty(pid), owner: existingOwner };
  }

  // New row: attribution follows the ACTUAL grant. If the property was assigned
  // to the caller by a linked owner, require edit and attribute the row to that
  // owner (so it lands in their queue); otherwise it is the caller's own new row.
  const pid = String(row.propertyId || row.application?.propertyId || row.assignedPropertyId || "").trim();
  const linkedOwner = pid ? await linkedOwnerForProperty(db, callerId, pid) : null;
  if (!linkedOwner) return { ok: true, owner: callerId };
  return { ok: await canEditProperty(pid), owner: linkedOwner };
}

async function fetchApplicationsForManagerUser(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
) {
  // This route feeds BOTH the Applications and Residents tabs (the client filters
  // each tab by its own module grant). So a co-manager's linked rows are included
  // when EITHER `applications` OR `residents` is granted on the property — a
  // co-manager with neither grant gets none of the owner's linked rows.
  const [appIds, resIds, ownedPropertyIds] = await Promise.all([
    linkedPropertyIdsForModule(db, userId, "applications"),
    linkedPropertyIdsForModule(db, userId, "residents"),
    // Same helper the by-id action guard (`managerCanAccessApplicationRecord`)
    // uses, so the list and the guards resolve direct ownership identically.
    managerOwnedPropertyIdSet(db, userId),
  ]);
  // Every property this manager owns TODAY, unioned with co-manager-linked ones,
  // is a second, attribution-INDEPENDENT way in: the primary `manager_user_id ===
  // userId` query below only finds rows whose stored attribution still matches.
  // An application's `manager_user_id` is resolved once at submit time and never
  // re-resolved once the resident stops touching the draft (nothing re-runs
  // `linkResidentOnApplicationSubmit` for an abandoned "Incomplete" application),
  // so a property that changed hands (ownership transfer, a re-assigned
  // co-manager grant, or a historical resolution bug) would otherwise permanently
  // hide that resident's application from the property's CURRENT owner — exactly
  // the "manager's own empty-state copy promises Incomplete shows up here, and it
  // doesn't" gap. Property ownership (not the frozen attribution stamp) is the
  // source of truth for who should see the row.
  const propertyScopedIds = new Set<string>([...ownedPropertyIds, ...appIds, ...resIds]);
  const select = "id, row_data, updated_at, manager_user_id, property_id, assigned_property_id";

  const { data: ownedRows, error: ownedError } = await db
    .from("manager_application_records")
    .select(select)
    .eq("manager_user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (ownedError) throw ownedError;

  const byId = new Map<string, (typeof ownedRows)[number]>();
  for (const row of ownedRows ?? []) {
    if (row.id) byId.set(row.id, row);
  }

  if (propertyScopedIds.size > 0) {
    const propertyIds = [...propertyScopedIds];
    const [{ data: byProperty, error: propertyError }, { data: byAssigned, error: assignedError }] = await Promise.all([
      db
        .from("manager_application_records")
        .select(select)
        .in("property_id", propertyIds)
        .order("updated_at", { ascending: false })
        .limit(500),
      db
        .from("manager_application_records")
        .select(select)
        .in("assigned_property_id", propertyIds)
        .order("updated_at", { ascending: false })
        .limit(500),
    ]);
    if (propertyError) throw propertyError;
    if (assignedError) throw assignedError;
    for (const row of [...(byProperty ?? []), ...(byAssigned ?? [])]) {
      if (!row.id || byId.has(row.id)) continue;
      byId.set(row.id, row);
    }
  }

  return [...byId.values()].sort((a, b) => {
    const aTs = Date.parse(String(a.updated_at ?? ""));
    const bTs = Date.parse(String(b.updated_at ?? ""));
    return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
  });
}

type ApplicationRecordForDelete = {
  id: string;
  row_data: unknown;
  manager_user_id?: string | null;
  resident_email?: string | null;
  property_id?: string | null;
  assigned_property_id?: string | null;
};

async function assertCanDeleteApplicationRecords(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  user: NonNullable<Awaited<ReturnType<typeof sessionUser>>>,
  records: ApplicationRecordForDelete[],
): Promise<string | null> {
  if (records.length === 0) return null;

  const admin = await isAdminUser(user.id);
  if (admin) return null;

  const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
  const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();

  if (role === "resident") {
    for (const record of records) {
      const row = normalizeRow(record.row_data as DemoApplicantRow);
      const rowEmail = (row.email ?? record.resident_email ?? "").trim().toLowerCase();
      if (!email || rowEmail !== email) {
        return "You can only withdraw your own application.";
      }
      if (row.bucket !== "pending") {
        return "This application can no longer be withdrawn.";
      }
    }
    return null;
  }

  if (role === "manager" || role === "owner" || role === "pro") {
    for (const record of records) {
      const row = normalizeRow(record.row_data as DemoApplicantRow);
      // Authorize by the application's PROPERTY, through the SAME shared predicate
      // the Applications list and the other by-id action guards use — not the
      // frozen `manager_user_id` stamp / co-manager-only check this branch used
      // before, which refused a direct owner whose stamp was stale (or zero) on
      // an "Incomplete" draft they could plainly see in their list. Destructive,
      // so a co-manager needs the granular "delete" level; a direct owner always
      // passes regardless of the stamp.
      const accessRecord = {
        manager_user_id: record.manager_user_id ?? row.managerUserId ?? null,
        property_id: (record.property_id ?? row.propertyId ?? row.application?.propertyId ?? "").trim() || null,
        assigned_property_id: (record.assigned_property_id ?? row.assignedPropertyId ?? "").trim() || null,
      };
      if (await managerCanAccessApplicationRecord(db, user.id, accessRecord, { level: "delete" })) continue;
      return "You do not have permission to delete this application.";
    }
    return null;
  }

  return "Unauthorized.";
}

export async function GET(req?: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    const { role, email } = await resolvePortalRole(db, user);

    // `?scope=self` returns ONLY the caller's own applicant rows (by their
    // authenticated email), regardless of their primary role — a signed-in
    // manager/vendor who applied somewhere as a guest resumes their own draft
    // through this, since the manager read below is property-scoped and never
    // includes their own applicant row.
    let selfScope = false;
    try {
      selfScope = Boolean(req?.url) && new URL(req!.url).searchParams.get("scope") === "self";
    } catch {
      selfScope = false;
    }
    if (!email && (selfScope || (!admin && role === "resident"))) {
      return NextResponse.json({ rows: [] });
    }

    let data: { id: string; row_data: unknown }[] | null = null;
    let error: { message: string } | null = null;

    if (selfScope || (!admin && role === "resident")) {
      const result = await db
        .from("manager_application_records")
        .select("id, row_data, resident_email, updated_at")
        .eq("resident_email", email)
        .order("updated_at", { ascending: false })
        .limit(500);
      data = result.data;
      error = result.error;
    } else if (!admin && (role === "manager" || role === "owner" || role === "pro")) {
      try {
        data = await fetchApplicationsForManagerUser(db, user.id);
        error = null;
      } catch (e) {
        error = { message: e instanceof Error ? e.message : "Failed to load applications." };
      }
    } else if (admin) {
      const result = await db
        .from("manager_application_records")
        .select("id, row_data, updated_at")
        .order("updated_at", { ascending: false })
        .limit(500);
      data = result.data;
      error = result.error;
    } else {
      return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
    }

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const byId = new Map<string, DemoApplicantRow>();
    const recordEmailByRowId = new Map<string, string>();
    const rowsNeedingNormalization: Array<{ recordId: string; row: DemoApplicantRow }> = [];
    for (const record of data ?? []) {
      if (!record.row_data) continue;
      const recordEmail =
        typeof (record as { resident_email?: string | null }).resident_email === "string"
          ? (record as { resident_email?: string | null }).resident_email!.trim().toLowerCase()
          : "";
      let row = normalizeRow(record.row_data as DemoApplicantRow);
      if ((selfScope || role === "resident") && recordEmail) {
        row = { ...row, email: recordEmail };
      }
      if (recordEmail) recordEmailByRowId.set(row.id, recordEmail);
      byId.set(row.id, { ...byId.get(row.id), ...row });
      if (record.id !== row.id || (record.row_data as DemoApplicantRow).id !== row.id) {
        rowsNeedingNormalization.push({ recordId: record.id, row });
      }
    }
    await Promise.allSettled(rowsNeedingNormalization.map(({ recordId, row }) => persistNormalizedRow(db, recordId, row)));

    const rows = [...byId.values()];

    const scopedRows =
      selfScope || role === "resident"
        ? rows.filter((row) =>
            residentOwnsApplicationRow(row, { email, userId: user.id }, {
              recordEmail: recordEmailByRowId.get(row.id),
            }),
          )
        : rows;

    // Provision approved residents that were never provisioned (e.g. restored via SQL migration).
    // One batch profiles query finds which are missing; parallel provisioning handles only those.
    // This runs synchronously so accounts exist by the time the client fetches portal statuses.
    const approved = scopedRows.filter((r) => r.bucket === "approved" && r.email?.trim().includes("@"));
    if (approved.length > 0) {
      const emails = [...new Set(approved.map((r) => r.email!.trim().toLowerCase()))];
      const { data: existing } = await db.from("profiles").select("email").in("email", emails);
      const existingSet = new Set((existing ?? []).map((p) => (p.email ?? "").trim().toLowerCase()).filter(Boolean));
      const unprovisioned = approved.filter((r) => !existingSet.has(r.email!.trim().toLowerCase()));
      if (unprovisioned.length > 0) {
        await Promise.allSettled(unprovisioned.map((row) => provisionApprovedResidentAccount(db, row).catch(
            bestEffortFailed("approved resident account provisioning", { application: row.id }),
          )));
      }
    }

    return NextResponse.json({ rows: scopedRows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load applications.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action?: "upsert" | "delete" | "replace" | "withdraw";
      id?: string;
      row?: DemoApplicantRow;
      rows?: DemoApplicantRow[];
      setupToken?: string;
      existingResidentOnboarding?: { sendWelcomeEmail?: boolean };
    };
    const db = createSupabaseServiceRoleClient();
    const user = await sessionUser();

    if (body.action === "replace") {
      if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const rows = Array.isArray(body.rows) ? body.rows.map(normalizeRow) : [];
      const writeGate = await assertManagerOrAdminWriteAccess(db, user);
      if (writeGate) return writeGate;
      const replaceAdmin = await isAdminUser(user.id);
      // This mirror — not the single-row upsert — is the path the manager panel's
      // Approve actually takes, so the withdrawn-approval guard has to bite here.
      // One batched read of the stored blobs; fail CLOSED if it cannot be read.
      const storedBatch = await loadStoredApplicationRecords(db, rows);
      if (storedBatch.error) {
        return NextResponse.json({ error: "Could not load existing applications." }, { status: 500 });
      }
      let blockedWithdrawnApprovals = 0;
      for (const row of rows) {
        // Attribute each row to its correct owner and enforce edit access on
        // foreign (linked-owner) rows. Admins keep the client-supplied owner.
        const stored = storedRecordForRow(storedBatch.byId, row);
        if (!replaceAdmin) {
          const gate = await resolveApplicationWriteOwner(db, user.id, row, { record: stored });
          if (!gate.ok) continue;
          row.managerUserId = gate.owner ?? user.id;
        }
        const guarded = anchorServerOwnedWithdrawal(row, stored);
        if (guarded.blockedApproval) {
          blockedWithdrawnApprovals += 1;
          continue;
        }
        const anchored = anchorServerOwnedSmsConsent(
          guarded.row,
          (stored?.row_data ?? null) as DemoApplicantRow | null,
        );
        const previousRow = (stored?.row_data ?? null) as DemoApplicantRow | null;
        await persistNormalizedRow(db, anchored.id, anchored);
        await revokeMaterializedApplicationConsentAfterWrite(db, stored, anchored);
        void syncApplicationLifecycleTasks(db, previousRow, anchored).catch(
          bestEffortFailed("application lifecycle task sync", { application: anchored.id }),
        );
        if (anchored.bucket === "pending" && anchored.application?.consentCredit) {
          void tryAutoOrderScreening(db, anchored);
        }
      }
      if (blockedWithdrawnApprovals > 0) {
        return NextResponse.json(
          {
            ok: false,
            error: "This application was withdrawn by the applicant and can no longer be approved.",
            blockedWithdrawnApprovals,
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === "delete") {
      if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const id = body.id?.trim();
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const ids = idVariants(id);
      const { data: records, error: loadError } = await db
        .from("manager_application_records")
        .select("id, row_data, manager_user_id, resident_email, property_id, assigned_property_id")
        .in("id", ids);
      if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });

      const idsToDelete = new Set<string>();
      for (const record of records ?? []) {
        if (record.id) idsToDelete.add(record.id);
      }

      const { data: allRecords, error: allLoadError } = await db
        .from("manager_application_records")
        .select("id, row_data, manager_user_id, resident_email, property_id, assigned_property_id");
      if (allLoadError) return NextResponse.json({ error: allLoadError.message }, { status: 500 });

      for (const record of allRecords ?? []) {
        const row = record.row_data as Partial<DemoApplicantRow> | null;
        const rowId = typeof row?.id === "string" ? row.id : "";
        if (rowId && ids.includes(rowId.trim())) idsToDelete.add(record.id);
        if (rowId && ids.includes(normalizeApplicationAxisId(rowId))) idsToDelete.add(record.id);
      }

      if (idsToDelete.size > 0) {
        const { data: recordsToDelete, error: fetchError } = await db
          .from("manager_application_records")
          .select("id, row_data, manager_user_id, resident_email, property_id, assigned_property_id")
          .in("id", [...idsToDelete]);
        if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
        const authError = await assertCanDeleteApplicationRecords(db, user, recordsToDelete ?? []);
        if (authError) return NextResponse.json({ error: authError }, { status: 403 });

        const purgeIds = new Set<string>();
        for (const record of recordsToDelete ?? []) {
          if (record.id) purgeIds.add(record.id);
          const row = record.row_data as Partial<DemoApplicantRow> | null;
          const axisId = typeof row?.id === "string" ? row.id.trim() : "";
          if (axisId) purgeIds.add(axisId);
        }
        await Promise.all([...purgeIds].map((appId) => purgeApplicationPortalData(db, appId)));
      }
      return NextResponse.json({ ok: true, deleted: idsToDelete.size });
    }

    // Resident self-service WITHDRAW: a reversible, non-destructive state change.
    // Never a hard delete — the record, screening, documents and bucket stay intact;
    // only `row_data.withdrawnAt` is stamped so the row leaves the resident's active
    // list while the manager keeps it (labelled "Withdrawn"). Ownership is enforced
    // from the AUTHENTICATED session's email (the request carries only the id), so a
    // resident can never withdraw another applicant's application.
    if (body.action === "withdraw") {
      if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const id = body.id?.trim();
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const ids = idVariants(id);
      const { data: records, error: loadError } = await db
        .from("manager_application_records")
        .select("id, row_data, resident_email")
        .in("id", ids);
      if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
      if (!records || records.length === 0) {
        return NextResponse.json({ error: "Application not found." }, { status: 404 });
      }

      const admin = await isAdminUser(user.id);
      const { email } = await resolvePortalRole(db, user);
      // Ownership here is by EMAIL, never by active/primary portal role. A
      // multi-role account (a manager or vendor who ALSO applied as a resident)
      // keeps its legacy `profiles.role` = manager/owner even while acting in
      // its resident portal, yet it still owns any application carrying its own
      // email — and the resident applications list shows the row on exactly that
      // email match. Gating on `role === "resident"` contradicted the list: it
      // rejected the genuine applicant with "Only the applicant can withdraw"
      // whenever their primary role wasn't resident (the self-contradictory
      // "it's in my list but I can't withdraw it" bug). The authoritative gate
      // is the per-record `rowEmail === email` check below — a manager
      // withdrawing SOMEONE ELSE's application still fails there and uses Reject.

      const withdrawnAt = new Date().toISOString();
      let withdrawn = 0;
      for (const record of records) {
        const stored = (record.row_data ?? {}) as DemoApplicantRow;
        if (!admin) {
          const rowEmail = (stored.email ?? record.resident_email ?? "").trim().toLowerCase();
          if (!email || rowEmail !== email) {
            return NextResponse.json({ error: "You can only withdraw your own application." }, { status: 403 });
          }
          if (stored.bucket !== "pending") {
            return NextResponse.json({ error: "This application can no longer be withdrawn." }, { status: 409 });
          }
        }
        if (stored.withdrawnAt) {
          withdrawn += 1; // already withdrawn — idempotent
          continue;
        }
        const nextRowData: DemoApplicantRow = { ...stored, withdrawnAt };
        const { error: updateError } = await db
          .from("manager_application_records")
          .update({ row_data: nextRowData, updated_at: withdrawnAt })
          .eq("id", record.id);
        if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
        withdrawn += 1;
      }
      return NextResponse.json({ ok: true, withdrawn });
    }

    if (!body.row?.id) return NextResponse.json({ error: "row required" }, { status: 400 });
    let row = normalizeRow(body.row);
    let residentSelfWrite = false;
    if (!user) {
      const ids = idVariants(row.id);
      const { data: records, error: loadError } = await db
        .from("manager_application_records")
        .select("id, row_data, manager_user_id")
        .in("id", ids)
        .limit(1);
      if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
      const existingRecord = records?.[0] as StoredApplicationRecord | undefined;
      const existing = existingRecord?.row_data as DemoApplicantRow | undefined;
      const guest = await prepareGuestApplicationUpsert(db, {
        row,
        existing: existing ?? null,
        clientSetupToken: typeof body.setupToken === "string" ? body.setupToken : null,
      });
      if (!guest.ok) {
        // `existingApplicationId` rides along on a duplicate so the client can
        // open the application the person already has, instead of stopping at
        // an error about work they have already done.
        return NextResponse.json(
          { error: guest.error, existingApplicationId: guest.existingApplicationId },
          { status: guest.status },
        );
      }
      row = anchorServerOwnedSmsConsent(guest.row, existing ?? null);
      const previousRow = existing ?? null;
      await persistNormalizedRow(db, row.id, row);
      await revokeMaterializedApplicationConsentAfterWrite(db, existingRecord ?? null, row);
      if (shouldNotifyManagerOfApplicationSubmit(previousRow, row)) {
        void notifyManagerApplicationSubmitted(db, row).catch(
          bestEffortFailed("manager application-submitted notice", { application: row.id, manager: row.managerUserId }),
        );
      }
      void syncApplicationLifecycleTasks(db, previousRow, row).catch(
        bestEffortFailed("application lifecycle task sync", { application: row.id }),
      );
      if (row.bucket === "pending" && row.application?.consentCredit) {
        void tryAutoOrderScreening(db, row);
      }
      // Return the setup handoff built from the token just minted on the row, so
      // the guest finish screen can offer "Create your resident account" without
      // depending on the follow-up email route succeeding.
      return NextResponse.json({
        ok: true,
        setupTokenIssued: true,
        setupToken: guest.setupToken,
        setupHref: buildResidentSetupHref(guest.setupToken, row.id),
        axisId: row.id,
      });
    }
    const { role, email } = await resolvePortalRole(db, user);
    // SELF-APPLICATION by a signed-in NON-resident (a manager/owner/pro/vendor
    // who continued as guest on the public apply page, or a multi-role login
    // applying somewhere they do not manage): the write is the APPLICANT's own,
    // keyed strictly on the authenticated email matching the row's email and the
    // application still being pending — never on manager write access. The
    // stored row (when one exists) must itself be pending AND carry the same
    // email, so this path can never touch a DIFFERENT applicant's row or reopen
    // a decided one; those still require manager edit access below.
    let selfApplicationWrite = false;
    if (role !== "resident") {
      const rowEmail = (row.email ?? "").trim().toLowerCase();
      if (Boolean(email) && rowEmail === email && row.bucket === "pending") {
        const selfStored = await loadStoredApplicationRecord(db, row.id);
        if (selfStored.error) {
          return NextResponse.json({ error: "Could not load the existing application." }, { status: 500 });
        }
        const stored = (selfStored.record?.row_data ?? null) as DemoApplicantRow | null;
        const storedEmail = (stored?.email ?? "").trim().toLowerCase();
        selfApplicationWrite = !stored || (stored.bucket === "pending" && (!storedEmail || storedEmail === email));
      }
    }
    if (role === "resident" || selfApplicationWrite) {
      residentSelfWrite = true;
      const rowEmail = (row.email ?? "").trim().toLowerCase();
      if (!email || rowEmail !== email) {
        return NextResponse.json({ error: "You can only update your own application." }, { status: 403 });
      }
      const ids = idVariants(row.id);
      const { data: records, error: loadError } = await db
        .from("manager_application_records")
        .select("id, row_data")
        .in("id", ids)
        .limit(1);
      if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
      const existing = records?.[0]?.row_data as DemoApplicantRow | undefined;
      if (existing && existing.bucket !== "pending") {
        return NextResponse.json({ error: "This application can no longer be edited." }, { status: 403 });
      }
      if (row.bucket !== "pending") {
        return NextResponse.json({ error: "Residents cannot change application status." }, { status: 403 });
      }
      row = {
        ...row,
        bucket: "pending",
        withdrawnAt: existing?.withdrawnAt ?? row.withdrawnAt,
        assignedPropertyId: existing?.assignedPropertyId ?? row.assignedPropertyId,
        assignedRoomChoice: existing?.assignedRoomChoice ?? row.assignedRoomChoice,
        signedMonthlyRent: existing?.signedMonthlyRent ?? row.signedMonthlyRent,
        managerUserId: existing?.managerUserId ?? null,
        backgroundCheckStatus: existing?.backgroundCheckStatus ?? row.backgroundCheckStatus,
        screening: existing?.screening ?? row.screening,
        manuallyAdded: existing?.manuallyAdded ?? row.manuallyAdded,
        moveInInstructions: existing?.moveInInstructions ?? row.moveInInstructions,
        application:
          row.application && existing?.application
            ? {
                ...row.application,
                managerRentOverride: existing.application.managerRentOverride,
                managerUtilitiesOverride: existing.application.managerUtilitiesOverride,
                managerSecurityDepositOverride: existing.application.managerSecurityDepositOverride,
                managerMoveInFeeOverride: existing.application.managerMoveInFeeOverride,
                managerOtherCostLabel: existing.application.managerOtherCostLabel,
                managerOtherCostAmount: existing.application.managerOtherCostAmount,
              }
            : row.application,
      };
      const linked = await linkResidentOnApplicationSubmit(db, {
        userId: user.id,
        row,
        isNewSubmit: !existing,
        existingManagerUserId: existing?.managerUserId ?? null,
        linkProfile: role === "resident",
      });
      if (!linked.ok) {
        return NextResponse.json(
          { error: linked.error, existingApplicationId: linked.existingApplicationId },
          { status: linked.status },
        );
      }
      row = linked.row;
      row = anchorServerOwnedSmsConsent(row, existing ?? null);
    } else {
      const writeGate = await assertManagerOrAdminWriteAccess(db, user);
      if (writeGate) return writeGate;
      const storedLoad = await loadStoredApplicationRecord(db, row.id);
      if (storedLoad.error) {
        return NextResponse.json({ error: "Could not load the existing application." }, { status: 500 });
      }
      if (!(await isAdminUser(user.id))) {
        const gate = await resolveApplicationWriteOwner(db, user.id, row, { record: storedLoad.record });
        if (!gate.ok) {
          return NextResponse.json(
            { error: "You do not have edit access to this property's applications." },
            { status: 403 },
          );
        }
        row.managerUserId = gate.owner ?? user.id;
      }
      const guarded = anchorServerOwnedWithdrawal(row, storedLoad.record);
      if (guarded.blockedApproval) {
        return NextResponse.json(
          { error: "This application was withdrawn by the applicant and can no longer be approved." },
          { status: 409 },
        );
      }
      row = anchorServerOwnedSmsConsent(
        guarded.row,
        (storedLoad.record?.row_data ?? null) as DemoApplicantRow | null,
      );
    }
    const priorLoad = await loadStoredApplicationRecord(db, row.id);
    if (priorLoad.error) {
      // The previous consent snapshot decides whether an append-only revoke is
      // required. Persisting smsConsent=false without that evidence could leave
      // a materialized grant active while falsely acknowledging the opt-out.
      return NextResponse.json(
        { error: "Could not load the existing application." },
        { status: 500 },
      );
    }
    const previousRow = (priorLoad.record?.row_data ?? null) as DemoApplicantRow | null;
    await persistNormalizedRow(db, row.id, row);
    await revokeMaterializedApplicationConsentAfterWrite(db, priorLoad.record, row);
    if (shouldNotifyManagerOfApplicationSubmit(previousRow, row)) {
      void notifyManagerApplicationSubmitted(db, row).catch(
          bestEffortFailed("manager application-submitted notice", { application: row.id, manager: row.managerUserId }),
        );
    }
    void syncApplicationLifecycleTasks(db, previousRow, row).catch(
        bestEffortFailed("application lifecycle task sync", { application: row.id }),
      );
    if (row.bucket === "pending" && row.application?.consentCredit) {
      void tryAutoOrderScreening(db, row);
    }

    if (row.manuallyAdded && body.existingResidentOnboarding) {
      const { data: profile } = await db.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
      const onboarding = await runExistingResidentOnboarding(
        db,
        {
          userId: user.id,
          email: user.email ?? null,
          managerName: String(profile?.full_name ?? ""),
        },
        row,
        { sendWelcomeEmail: body.existingResidentOnboarding.sendWelcomeEmail !== false },
      );
      if (!onboarding.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: onboarding.error,
            mailtoHref: onboarding.mailtoHref,
            leaseId: onboarding.leaseId,
          },
          { status: onboarding.status },
        );
      }
      return NextResponse.json({
        ok: true,
        existingResidentOnboarding: {
          leaseId: onboarding.leaseId,
          welcomeEmailSent: onboarding.welcomeEmailSent,
          axisId: onboarding.axisId,
        },
      });
    }

    return NextResponse.json(residentSelfWrite ? { ok: true, row } : { ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save application.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
