import { shortStayApprovalBlocker } from "@/lib/short-stay-pricing-gate.server";
import { resolveAdminOversight } from "@/lib/auth/admin-oversight.server";
import { readListingSource } from "@/lib/listing-channels/lead-source.server";
import { openApplicantRow, prepareApplicantIdentityWrite, sealApplicantRow } from "@/lib/security/applicant-identity";
import { NextResponse, after } from "next/server";
import { verifiedSessionEmail } from "@/lib/auth/verified-session-email";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { loadOccupancyAuthors, occupancyAuthorTrusted } from "@/lib/occupancy/row-authorship.server";
import { prepareGuestApplicationUpsert } from "@/lib/auth/guest-application-upsert";
import { buildResidentSetupHref } from "@/lib/auth/resident-setup-token";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerCanAccessApplicationRecord, managerOwnedPropertyIdSet } from "@/lib/auth/manager-application-access";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { linkedOwnerForProperty, linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import {
  anchorServerOwnedSmsConsent,
  applicationWriteErrorResponse,
  idVariants,
  loadStoredApplicationRecord,
  owesLinkedFormCheck,
  persistApplicationWrite,
  persistNormalizedRow,
  prepareResidentSelfWrite,
  revokeMaterializedApplicationConsentAfterWrite,
  STORED_APPLICATION_SELECT,
  type StoredApplicationRecord,
} from "@/lib/rental-application/signed-in-application-write.server";
import { createLinkedFormRequestsForSubmit } from "@/lib/application-linked-form-requests.server";
import { emitApplicationTransition } from "@/lib/domain-action-events.server";
import { dispatchMoveInFormsForResidencyAfterResponse } from "@/lib/move-in-forms/server";
import {
  notifyManagerApplicationSubmitted,
  shouldNotifyManagerOfApplicationSubmit,
} from "@/lib/application-submitted-notification.server";
import { syncApplicationLifecycleTasks } from "@/lib/manager-default-tasks.server";
import { purgeOrphanHousingRecordsForManager } from "@/lib/auth/clear-property-housing-access";
import { purgeApplicationPortalData } from "@/lib/auth/purge-portal-account-data";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { residentOwnsApplicationRow } from "@/lib/rental-application/resident-application-ownership";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";
import {
  skippedApplicationTargetFromRecord,
  type SkippedApplicationTarget,
} from "@/lib/rental-application/skipped-application-target";
import { tryAutoOrderScreening } from "@/lib/screening/order-screening";
import { runExistingResidentOnboarding } from "@/lib/existing-resident-onboarding.server";
import { validateResidentApplicationRowForPersistence } from "@/lib/rental-application/validate-application-submit.server";
import { fillApplicantIdentityFromAccount } from "@/lib/rental-application/applicant-identity.server";
import { realApplicantName } from "@/lib/rental-application/applicant-name";
import { isApplicantWizardRow } from "@/lib/rental-application/applicant-identity";
import { authorizeApplicationFeeSubmission } from "@/lib/rental-application/application-fee-submit-guard.server";
import { isViewAsSessionOpen } from "@/lib/auth/view-as.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { bestEffortFailed } from "@/lib/observability/best-effort";
import { parseRoomChoiceValue } from "@/lib/rental-application/data";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";
import { APPROVAL_BLOCKED_BY_FORM_MESSAGE, APPROVAL_FORMS_CHECK_FAILED_MESSAGE, loadApplicationBlockingForms } from "@/lib/move-in-forms/blocking";
import {
  openResidentSlots,
  type RoomResidentSlotPlacement,
} from "@/lib/rental-application/room-occupancy";
import {
  isTestWorkspaceFeatureEnabled,
  resolveTestWorkspaceClassification,
} from "@/lib/test-workspaces/index.server";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import { assertManagerCommunicationAllowedForActiveWorkspace } from "@/lib/manager-communication-access.server";

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


/**
 * Approval is refused while a form sent with "Blocks: Approval" is unsubmitted. Keyed on the TRANSITION
 * into `approved` (an already-approved row stays editable) and read from the forms table, never from
 * the request. A read that fails refuses too (fail closed) but answers `"unchecked"`, so the caller can
 * say "could not check" instead of naming a form that may not exist.
 */
async function approvalBlockedByForm(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  next: DemoApplicantRow,
  stored: StoredApplicationRecord | null,
): Promise<"no" | "blocked" | "unchecked"> {
  const storedRow = (stored?.row_data ?? null) as DemoApplicantRow | null;
  if (next.bucket !== "approved" || storedRow?.bucket === "approved") return "no";
  const ids = [...idVariants(String(stored?.id ?? "")), ...idVariants(String(next.id ?? ""))];
  const blocking = await loadApplicationBlockingForms(db, ids);
  if (blocking.readFailed) return "unchecked";
  return blocking.approval ? "blocked" : "no";
}

function storedResidentSlot(row: DemoApplicantRow): number | undefined {
  const slot = Number(row.application?.residentSlot);
  return Number.isInteger(slot) && slot >= 1 ? slot : undefined;
}

function residentSlotAlreadyPlaced(previous: DemoApplicantRow, row: DemoApplicantRow, choice: string): boolean {
  if (previous.bucket !== "approved" || previous.withdrawnAt) return false;
  const previousChoice = (previous.assignedRoomChoice || previous.application?.roomChoice1 || "").trim();
  if (previousChoice !== choice) return false;
  return storedResidentSlot(previous) === storedResidentSlot(row);
}

/**
 * The one server-side re-check for a resident-slot pick (PLAN-0920-0631):
 * given a row about to be written into `approved`, re-derive which slot of
 * its room is actually open — from the SAME `openResidentSlots` decision the
 * browser's picker previews — and refuse a slot the browser's stale picker
 * would have shown taken.
 *
 * A no-op for a room that does not price per resident (never touches
 * `row.application`). For one that does, this NEVER trusts the client's own
 * rent/utilities/deposit: it always overwrites them from the slot's resolved
 * price, so a tampered or stale request can only ever land the server's own
 * figures.
 */
async function resolveApprovedResidentSlot(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  row: DemoApplicantRow,
  previous: DemoApplicantRow | null,
): Promise<
  | { ok: true; row: DemoApplicantRow }
  | { ok: false; error: string; conflict?: { slot: number; holderName: string | null } }
> {
  if (row.bucket !== "approved" || row.withdrawnAt) return { ok: true, row };
  const choice = (row.assignedRoomChoice || row.application?.roomChoice1 || "").trim();
  if (!choice) return { ok: true, row };
  if (previous && residentSlotAlreadyPlaced(previous, row, choice)) return { ok: true, row };
  const { propertyId, listingRoomId } = parseRoomChoiceValue(choice);
  if (!listingRoomId) return { ok: true, row };
  // Fail CLOSED like the DB-error paths below: a blank manager id means the
  // property lookup right after this (scoped by `manager_user_id`) can never
  // be verified, so letting the write through unchecked here would have let
  // an unverifiable approval land with whatever room/price the client sent —
  // exactly the unverified override this function exists to refuse.
  const managerUserId = row.managerUserId?.trim();
  if (!managerUserId) {
    return { ok: false, error: "Could not verify this room right now — try again." };
  }

  const { data: propertyRecord, error: propertyError } = await db
    .from("manager_property_records")
    .select("row_data")
    // Scoped to the manager this application is attributed to — `propertyId`
    // comes from the client-controlled room choice, so an unscoped lookup
    // would resolve (and then trust the pricing of) ANY manager's property
    // row, not just one the acting manager owns.
    .eq("id", propertyId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  // Fail CLOSED: a read failure here must never fall through to trusting
  // whatever rent/utilities/deposit the client already had on the row —
  // refuse the write rather than risk letting an unverified override land.
  if (propertyError) {
    return { ok: false, error: "Could not verify this room right now — try again." };
  }
  const property = (propertyRecord as { row_data?: { listingSubmission?: unknown } } | null)?.row_data;
  if (!property?.listingSubmission) return { ok: true, row };
  const sub = normalizeManagerListingSubmissionV1(
    property.listingSubmission as Parameters<typeof normalizeManagerListingSubmissionV1>[0],
  );
  const room = sub.rooms.find((r) => r.id === listingRoomId);
  if (!room) return { ok: true, row };

  const { data: siblingRecords, error: siblingError } = await db
    .from("manager_application_records")
    .select("id,row_data")
    .eq("manager_user_id", managerUserId)
    .eq("row_data->>bucket", "approved")
    .order("created_at", { ascending: true });
  // Fail CLOSED here too — without the sibling rows, a taken slot cannot be
  // detected, so a stale/tampered pick could land alongside an unverified
  // price override instead of being refused.
  if (siblingError) {
    return { ok: false, error: "Could not verify open resident slots right now — try again." };
  }

  const selfId = normalizeApplicationAxisId(String(row.id ?? ""));
  const placements: RoomResidentSlotPlacement[] = [];
  for (const record of siblingRecords ?? []) {
    const sibling = record.row_data as DemoApplicantRow | null;
    if (!sibling || sibling.withdrawnAt) continue;
    if (normalizeApplicationAxisId(String(sibling.id ?? record.id ?? "")) === selfId) continue;
    const siblingChoice = (sibling.assignedRoomChoice || sibling.application?.roomChoice1 || "").trim();
    if (!siblingChoice || siblingChoice !== choice) continue;
    const start =
      parseFlexibleLocalDate(sibling.manualResidentDetails?.moveInDate) ??
      parseFlexibleLocalDate(sibling.application?.leaseStart);
    if (!start) continue;
    const end =
      parseFlexibleLocalDate(sibling.manualResidentDetails?.moveOutDate) ??
      parseFlexibleLocalDate(sibling.application?.leaseEnd);
    placements.push({
      id: String(sibling.id ?? record.id ?? ""),
      start,
      end,
      residentSlot: sibling.application?.residentSlot,
      holderName: sibling.name || sibling.email || null,
    });
  }

  const slots = openResidentSlots({ room, placements, at: new Date(), term: row.application?.leaseTerm });
  if (slots.length === 0) return { ok: true, row }; // room does not price per resident

  const wantSlotRaw = Number(row.application?.residentSlot);
  const wantSlot = Number.isInteger(wantSlotRaw) && wantSlotRaw >= 1 ? wantSlotRaw : undefined;
  const chosen = wantSlot ? slots.find((s) => s.slot === wantSlot) : slots.find((s) => !s.holder);
  if (!chosen) {
    return {
      ok: false,
      error: "That rent is no longer open for this room — refresh and pick another resident slot.",
    };
  }
  if (chosen.holder) {
    return {
      ok: false,
      error: `That rent is already held by ${chosen.holder.name} — refresh and pick another resident slot.`,
      // Structured so the Approve popup can say which bed and who holds it, and offer another.
      conflict: { slot: chosen.slot, holderName: chosen.holder.name || null },
    };
  }
  if (!row.application) return { ok: true, row };
  const price = chosen.price;
  return {
    ok: true,
    row: {
      ...row,
      application: {
        ...row.application,
        residentSlot: price.slot,
        managerRentOverride: String(price.monthlyRent),
        managerUtilitiesOverride: price.utilitiesEstimate ?? row.application.managerUtilitiesOverride,
        managerSecurityDepositOverride: price.securityDeposit ?? row.application.managerSecurityDepositOverride,
      },
    },
  };
}

async function applicationWorkspaceGate(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  user: Awaited<ReturnType<typeof sessionUser>>,
  row: DemoApplicantRow,
): Promise<NextResponse | null> {
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  const classification = user ? await resolveTestWorkspaceClassification(user.id, db) : { kind: "normal" as const };
  if (!propertyId) {
    return classification.kind === "classified"
      ? NextResponse.json({ error: "A private test-workspace property is required." }, { status: 403 })
      : null;
  }
  const { data, error } = await db.from("manager_property_records")
    .select("test_workspace_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not verify application workspace." }, { status: 503 });
  const propertyWorkspaceId = String(data?.test_workspace_id ?? "").trim() || null;
  if (!propertyWorkspaceId) {
    return classification.kind === "classified"
      ? NextResponse.json({ error: "Test accounts cannot apply to customer listings." }, { status: 403 })
      : null;
  }
  if (
    classification.kind !== "classified" ||
    classification.workspaceId !== propertyWorkspaceId ||
    classification.state !== "active" ||
    !isTestWorkspaceFeatureEnabled()
  ) {
    return NextResponse.json({ error: "Property not found." }, { status: 404 });
  }
  return null;
}



/**
 * The listing site THIS request's applicant arrived from, or null when the request is not the
 * applicant writing their own application. A manager who once opened one of their own tagged
 * listing links carries `pl_src` for 30 days, so a manager-initiated create or draft save must
 * never be credited to that site.
 */
async function applicantLeadSource(req: Request, applicantFacing: boolean): Promise<string | null> {
  if (!applicantFacing) return null;
  return await readListingSource(req);
}


async function resolvePortalRole(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  user: NonNullable<Awaited<ReturnType<typeof sessionUser>>>,
) {
  const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
  const { data: roleRows, error } = await db.from("profile_roles").select("role").eq("user_id", user.id);
  const roles = error ? [] : (roleRows ?? []).map((row) => String(row.role).toLowerCase());
  const primary = String(profile?.role ?? "").toLowerCase();
  const role = roles.includes(primary) ? primary : roles.includes("resident") ? "resident" : roles.find(isManagerPortalRole) ?? "";
  const email = verifiedSessionEmail(user, profile?.email);
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
  const { data, error } = await db.from("profile_roles").select("role").eq("user_id", user.id);
  if (error || !(data ?? []).some((row) => isManagerPortalRole(String(row.role).toLowerCase()))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
  }
  return null;
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
 * Resolve the owner a manager write should be attributed to, and whether it is
 * allowed. A role-only gate previously trusted the client-supplied
 * `managerUserId`, letting any manager persist rows under another manager's id
 * (cross-tenant write hole) and letting a read-only co-manager edit an owner's
 * applications/residents. Rules (non-admin):
 *  - New row or the caller's own row → forced to the caller (ignore any forged id).
 *  - A FOREIGN existing row (owned by a linked owner) → writable only with the
 *    applications OR residents EDIT grant on the row's property; owner preserved.
 */
/**
 * Refuse a manager write whose property lies outside the caller's ACTIVE
 * workspace. `null` scope (no workspaces, or the load failed) never narrows,
 * same as every read above. A blank `propertyId` is passed through here —
 * that mirrors the read path, where a property-less application never
 * appears in any workspace-scoped list regardless, so there is nothing a
 * property-less write could leak by going ungated.
 */
async function assertPropertyInActiveWorkspace(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  callerId: string,
  propertyId: string,
): Promise<boolean> {
  if (!propertyId) return true;
  const scope = await activeWorkspacePropertyScope(db, callerId);
  if (scope === null) return true;
  return scope.includes(propertyId);
}

/**
 * A row readers turn into occupancy: approved, or a resident the manager added by hand. ONE
 * predicate for the write gate and the read filter — they have to agree for the author-trust rule
 * to hold at all.
 */
function isResidentSlotRow(row: { bucket?: unknown; manuallyAdded?: unknown } | null | undefined): boolean {
  return row?.bucket === "approved" || row?.manuallyAdded === true;
}

/** Every property id a row names: its property columns and the property part of each room-choice value. */
function applicationReferencedPropertyIds(row: Partial<DemoApplicantRow> | null | undefined): Set<string> {
  const out = new Set<string>();
  const add = (value: unknown) => {
    const id = typeof value === "string" ? value.trim() : "";
    if (id) out.add(id);
  };
  const application = (row?.application ?? {}) as Record<string, unknown>;
  add(row?.propertyId);
  add(application.propertyId);
  add(row?.assignedPropertyId);
  add(parseRoomChoiceValue(String(row?.assignedRoomChoice ?? "")).propertyId);
  for (const [key, value] of Object.entries(application)) {
    if (/^roomChoice\d*$/.test(key)) add(parseRoomChoiceValue(String(value ?? "")).propertyId);
  }
  return out;
}

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

  // Every house the row NAMES must be one the writer runs. Readers count an approved row toward
  // each property it names (assigned / room-choice values included), so a row filed under the
  // caller's own house but pointing a room at someone else's would show that room occupied.
  // References the stored row already carried are not re-checked for an ordinary application (a house
  // that changed hands must not lock an old row), but a row that is, or becomes, a resident slot
  // (approved / manually added) has every house it names checked. A house that does not exist has no
  // occupancy to plant on.
  const alreadyNamed = applicationReferencedPropertyIds({
    ...(existing?.row_data ?? {}),
    propertyId: existing?.property_id ?? undefined,
    assignedPropertyId: existing?.assigned_property_id ?? undefined,
  } as DemoApplicantRow);
  const writesResidentSlot = isResidentSlotRow(row);
  const newlyNamed = [...applicationReferencedPropertyIds(row)].filter((id) => writesResidentSlot || !alreadyNamed.has(id));
  if (newlyNamed.length > 0) {
    const { data: namedRows, error: namedErr } = await db
      .from("manager_property_records")
      .select("id, manager_user_id")
      .in("id", newlyNamed);
    if (namedErr) return { ok: false, owner: existingOwner };
    for (const named of namedRows ?? []) {
      if (!newlyNamed.includes(String(named.id))) continue;
      if (String(named.manager_user_id ?? "") === callerId) continue;
      if (!(await canEditProperty(String(named.id)))) return { ok: false, owner: existingOwner };
    }
  }

  if (existingOwner) {
    if (existingOwner === callerId) {
      // An update to the caller's own row must still refuse a row the
      // caller's active workspace does not hold (e.g. a direct API replay
      // against a row that belongs to a workspace they have since switched
      // away from) — checked on the STORED property, the row as it exists.
      const ownPid = String(existing?.property_id || existing?.assigned_property_id || "").trim();
      if (!(await assertPropertyInActiveWorkspace(db, callerId, ownPid))) return { ok: false, owner: callerId };
      return { ok: true, owner: callerId };
    }
    // Foreign existing row: anchor the permission check on the STORED property,
    // never the client-supplied row (which could be spoofed to a property the
    // caller can edit). The owner is always preserved.
    const pid = String(existing?.property_id || existing?.assigned_property_id || "").trim();
    if (!pid) return { ok: false, owner: existingOwner };
    if (!(await canEditProperty(pid))) return { ok: false, owner: existingOwner };
    if (!(await assertPropertyInActiveWorkspace(db, callerId, pid))) return { ok: false, owner: existingOwner };
    return { ok: true, owner: existingOwner };
  }

  // New row: attribution follows the ACTUAL grant. If the property was assigned
  // to the caller by a linked owner, require edit and attribute the row to that
  // owner (so it lands in their queue); otherwise it is the caller's own new row.
  const pid = String(row.propertyId || row.application?.propertyId || row.assignedPropertyId || "").trim();
  const linkedOwner = pid ? await linkedOwnerForProperty(db, callerId, pid) : null;
  if (!linkedOwner) {
    // A create must land in the active workspace: a new row on a property
    // outside it is refused rather than silently created somewhere the
    // caller cannot currently see it.
    if (!(await assertPropertyInActiveWorkspace(db, callerId, pid))) return { ok: false, owner: null };
    return { ok: true, owner: callerId };
  }
  if (!(await canEditProperty(pid))) return { ok: false, owner: linkedOwner };
  if (!(await assertPropertyInActiveWorkspace(db, callerId, pid))) return { ok: false, owner: linkedOwner };
  return { ok: true, owner: linkedOwner };
}

/**
 * The row cap every application read shares. A read that comes back AT the cap
 * is partial, and the client is told so (`truncated`) rather than inferring
 * completeness from the length it received — this list is de-duplicated and
 * workspace-filtered after the queries, so a truncated read can answer with
 * fewer than the cap and still be missing rows.
 */
const APPLICATIONS_READ_LIMIT = 500;

/**
 * Phase durations (ms) for one GET, emitted as `Server-Timing` and, when the request is slow, one
 * `console.warn` line. Names only and numbers: no ids, emails or row content.
 */
type ApplicationsPhaseTimer = {
  phases: Record<string, number>;
  /** Run `work`, adding its wall time to `name` (overlapping phases are each measured on their own). */
  timed: <T>(name: string, work: () => Promise<T>) => Promise<T>;
  total: () => number;
};

function createApplicationsPhaseTimer(): ApplicationsPhaseTimer {
  const startedAt = performance.now();
  const phases: Record<string, number> = {};
  const add = (name: string, ms: number) => {
    phases[name] = Math.round(((phases[name] ?? 0) + ms) * 10) / 10;
  };
  return {
    phases,
    async timed(name, work) {
      const at = performance.now();
      try {
        return await work();
      } finally {
        add(name, performance.now() - at);
      }
    },
    total: () => Math.round((performance.now() - startedAt) * 10) / 10,
  };
}

const SLOW_APPLICATIONS_READ_MS = 3000;

const SERVER_TIMING_PHASES = ["auth", "role", "links", "owned", "workspace", "rows", "authors", "normalize"] as const;

/** `Server-Timing` value: the known phases that ran, then `total`. */
function serverTimingHeader(phases: Record<string, number>, total: number): string {
  const parts: string[] = [];
  for (const name of SERVER_TIMING_PHASES) {
    if (typeof phases[name] === "number") parts.push(`${name};dur=${phases[name]}`);
  }
  parts.push(`total;dur=${total}`);
  return parts.join(", ");
}

/**
 * The orphan-housing sweep may delete rows and costs ~14 sequential reads: never part of the response's wait.
 *
 * It is a write inside a GET, so a View-as session (read-only) never schedules it. The live set is
 * resolved INSIDE the sweep, right before it deletes: the co-manager lookup is strict (a failed read
 * skips the sweep rather than reading as "no co-managed houses"), and the owned ids are re-read so a
 * property created after the response was sent never has its rows purged.
 */
async function purgeOrphansAfterResponse(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
): Promise<void> {
  if (await isViewAsSessionOpen()) return;
  const run = async () => {
    let live: Set<string>;
    try {
      const [owned, applications, residents] = await Promise.all([
        managerOwnedPropertyIdSet(db, userId),
        linkedPropertyIdsForModule(db, userId, "applications", { strict: true }),
        linkedPropertyIdsForModule(db, userId, "residents", { strict: true }),
      ]);
      live = new Set<string>([...owned, ...applications, ...residents]);
    } catch (error) {
      // A failed scope lookup is not an empty portfolio: delete nothing.
      bestEffortFailed("orphan housing purge scope", { manager: userId })(error);
      return;
    }
    await purgeOrphanHousingRecordsForManager(db, userId, live).then(
      () => undefined,
      bestEffortFailed("orphan housing purge", { manager: userId }),
    );
  };
  try {
    after(run);
  } catch {
    // Outside a request scope (no `after` context): still never awaited by the caller.
    void run();
  }
}

/**
 * The manager's rows, and whether ANY of the reads behind them hit its cap.
 *
 * `rows.length` is not a truncation test here: three independent capped queries
 * are unioned and then narrowed to the active workspace, so a short answer can
 * still be missing rows. The client treats absence as deletion, so it has to be
 * told when the list is partial rather than inferring it from a count.
 */
async function fetchApplicationsForManagerUser(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  timer: ApplicationsPhaseTimer = createApplicationsPhaseTimer(),
) {
  const select = "id, row_data, occupancy_start, updated_at, manager_user_id, resident_email, property_id, assigned_property_id";
  // The manager's own rows depend on nothing else: start the read now, beside the link lookups.
  const ownedReadPromise = timer.timed("rows", async () =>
    db
      .from("manager_application_records")
      .select(select)
      .eq("manager_user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(APPLICATIONS_READ_LIMIT),
  );
  ownedReadPromise.catch(() => {});

  // This route feeds BOTH the Applications and Residents tabs (the client filters
  // each tab by its own module grant). So a co-manager's linked rows are included
  // when EITHER `applications` OR `residents` is granted on the property — a
  // co-manager with neither grant gets none of the owner's linked rows.
  const [appIds, resIds, ownedPropertyIds, workspaceScope] = await Promise.all([
    timer.timed("links", () => linkedPropertyIdsForModule(db, userId, "applications")),
    timer.timed("links", () => linkedPropertyIdsForModule(db, userId, "residents")),
    // Same helper the by-id action guard (`managerCanAccessApplicationRecord`)
    // uses, so the list and the guards resolve direct ownership identically.
    timer.timed("owned", () => managerOwnedPropertyIdSet(db, userId)),
    // The viewer's ACTIVE workspace, resolved server-side from the selection
    // cookie. This feeds BOTH the Applications tab and the Residents tab
    // (this one query backs both), plus the "approved" bucket the Leases tab
    // reads through this same function.
    timer.timed("workspace", () => activeWorkspacePropertyScope(db, userId)),
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
  // The sweep (14 sequential reads, may delete) runs after the response is sent, not before it.
  await purgeOrphansAfterResponse(db, userId);

  // Active-workspace narrowing, the same three rules everywhere:
  // `null` (no workspaces, or the load failed) never narrows; a resolved
  // array — even an empty one — restricts every property-scoped id to houses
  // the ACTIVE workspace actually holds. An application/lease/resident row
  // ties to its house by `property_id` OR `assigned_property_id` (assigned
  // after a room/bundle pick), so both are checked against this same set.
  // A group application's members are independent rows keyed by their own
  // property — this never treats the group specially, so a member whose
  // house the active workspace holds still shows even if a housemate's
  // different house does not (PLAN docs/agents/group-applications.md "a
  // group that spans houses"), and no member vanishes while the workspace
  // genuinely holds their house.
  const scopedPropertyIds =
    workspaceScope === null
      ? propertyScopedIds
      : new Set([...propertyScopedIds].filter((id) => workspaceScope.includes(id)));

  const { data: ownedRows, error: ownedError } = await ownedReadPromise;
  if (ownedError) throw ownedError;
  let truncated = (ownedRows ?? []).length >= APPLICATIONS_READ_LIMIT;

  const byId = new Map<string, (typeof ownedRows)[number]>();
  for (const row of ownedRows ?? []) {
    if (!row.id) continue;
    const liveIds = [
      String(row.property_id ?? "").trim(),
      String(row.assigned_property_id ?? "").trim(),
    ].filter(Boolean);
    // A draft with no property at all was already excluded here before
    // workspace scoping existed (the pre-property case is rarer than the
    // read-path table suggests — this route drops it outright, which is
    // already at least as narrow as the account-level default-workspace
    // rule, so no separate untagged-row handling is needed on this surface).
    if (liveIds.length === 0 || liveIds.every((id) => !scopedPropertyIds.has(id))) continue;
    byId.set(row.id, row);
  }

  if (scopedPropertyIds.size > 0) {
    const propertyIds = [...scopedPropertyIds];
    const [{ data: byProperty, error: propertyError }, { data: byAssigned, error: assignedError }] = await timer.timed(
      "rows",
      async () =>
        Promise.all([
          db
            .from("manager_application_records")
            .select(select)
            .in("property_id", propertyIds)
            .order("updated_at", { ascending: false })
            .limit(APPLICATIONS_READ_LIMIT),
          db
            .from("manager_application_records")
            .select(select)
            .in("assigned_property_id", propertyIds)
            .order("updated_at", { ascending: false })
            .limit(APPLICATIONS_READ_LIMIT),
        ]),
    );
    if (propertyError) throw propertyError;
    if (assignedError) throw assignedError;
    if ((byProperty ?? []).length >= APPLICATIONS_READ_LIMIT || (byAssigned ?? []).length >= APPLICATIONS_READ_LIMIT) {
      truncated = true;
    }
    for (const row of [...(byProperty ?? []), ...(byAssigned ?? [])]) {
      if (!row.id || byId.has(row.id)) continue;
      byId.set(row.id, row);
    }
  }

  // An approved / manually added row is a resident slot, which readers turn into occupancy. It belongs
  // to a house only when its author is that house's owner or a teammate linked to it, so a row some other
  // manager filed naming this viewer's house never reaches their Residents list or Bookings grid.
  // Applications in flight keep their submit-time attribution, and an unstamped legacy row still shows.
  const storedApplicationRow = (value: unknown): Partial<DemoApplicantRow> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<DemoApplicantRow>) : {};
  const slotRows = [...byId.values()].filter((row) => isResidentSlotRow(storedApplicationRow(row.row_data)));
  const authors =
    slotRows.length > 0 ? await timer.timed("authors", () => loadOccupancyAuthors(db, [...scopedPropertyIds])) : null;
  for (const row of slotRows) {
    // The houses that brought the row into this list, and the only ones its author has to be
    // trusted for: a room-choice house it also names cannot vouch for the house it is filed on.
    const houses = [String(row.property_id ?? "").trim(), String(row.assigned_property_id ?? "").trim()].filter(
      (id) => id && scopedPropertyIds.has(id),
    );
    if (houses.length === 0) continue;
    if (!houses.some((house) => occupancyAuthorTrusted(authors!, house, row.manager_user_id))) byId.delete(row.id);
  }

  const rows = [...byId.values()].sort((a, b) => {
    const aTs = Date.parse(String(a.updated_at ?? ""));
    const bTs = Date.parse(String(b.updated_at ?? ""));
    return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
  });
  return { rows, truncated };
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

  const { role } = await resolvePortalRole(db, user);

  if (role === "resident") {
    for (const record of records) {
      const row = normalizeRow(record.row_data as DemoApplicantRow);
      if (row.residentUserId !== user.id) {
        return "You can only withdraw your own application.";
      }
      if (row.bucket !== "pending") {
        return "This application can no longer be withdrawn.";
      }
    }
    return null;
  }

  if (role === "manager" || role === "owner" || role === "pro") {
    // A delete must refuse a row outside the caller's active workspace, the
    // same as every other write on this route. Resolved once for the batch;
    // `null` (no workspaces / load failure) never narrows.
    const workspaceScope = await activeWorkspacePropertyScope(db, user.id);
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
      const pid = accessRecord.property_id || accessRecord.assigned_property_id || "";
      if (workspaceScope !== null && pid && !workspaceScope.includes(pid)) {
        return "This application is not in your active workspace.";
      }
      if (await managerCanAccessApplicationRecord(db, user.id, accessRecord, { level: "delete" })) continue;
      return "You do not have permission to delete this application.";
    }
    return null;
  }

  return "Unauthorized.";
}

export async function GET(req: Request) {
  const timer = createApplicationsPhaseTimer();
  try {
    const user = await timer.timed("auth", () => sessionUser());
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const [admin, { role, email }] = await Promise.all([
      timer.timed("auth", () => isAdminUser(user.id)),
      timer.timed("role", () => resolvePortalRole(db, user)),
    ]);

    // `?scope=self` returns ONLY the caller's own applicant rows (by their
    // authenticated email), regardless of their primary role — a signed-in
    // manager/vendor who applied somewhere as a guest resumes their own draft
    // through this, since the manager read below is property-scoped and never
    // includes their own applicant row.
    let selfScope = false;
    try {
      selfScope = new URL(req.url).searchParams.get("scope") === "self";
    } catch {
      selfScope = false;
    }
    // The all-owners read is a different product surface (admin oversight), so it is
    // served only when the request ASKS for it (`?oversight=admin`) AND the server
    // confirms the admin role. The manager portal never sends it, so a platform admin
    // using their own workspace reads exactly what a manager does: their own and
    // granted houses, narrowed to the active workspace.
    const adminOversight = (await resolveAdminOversight(req, user.id, admin)) && !selfScope;

    let data: { id: string; row_data: unknown }[] | null = null;
    let error: { message: string } | null = null;
    // A read that hit its cap is partial. The client uses this to decide whether a
    // row the response omits was deleted or simply did not fit; it never infers
    // that from the row count, which de-duplication and workspace scoping shrink.
    let truncated = false;

    if (selfScope || (!admin && role === "resident")) {
      const result = await db
        .from("manager_application_records")
        .select("id, row_data, occupancy_start, resident_email, manager_user_id, property_id, assigned_property_id, updated_at")
        .eq("row_data->>residentUserId", user.id)
        .order("updated_at", { ascending: false })
        .limit(APPLICATIONS_READ_LIMIT);
      data = result.data;
      error = result.error;
      truncated = (result.data ?? []).length >= APPLICATIONS_READ_LIMIT;
    } else if (!adminOversight && (admin || role === "manager" || role === "owner" || role === "pro")) {
      try {
        const loaded = await fetchApplicationsForManagerUser(db, user.id, timer);
        data = loaded.rows;
        truncated = loaded.truncated;
        error = null;
      } catch (e) {
        error = { message: e instanceof Error ? e.message : "Failed to load applications." };
      }
    } else if (adminOversight) {
      const result = await db
        .from("manager_application_records")
        .select("id, row_data, occupancy_start, resident_email, manager_user_id, property_id, assigned_property_id, updated_at")
        .order("updated_at", { ascending: false })
        .limit(APPLICATIONS_READ_LIMIT);
      data = result.data;
      error = result.error;
      truncated = (result.data ?? []).length >= APPLICATIONS_READ_LIMIT;
    } else {
      return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
    }

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const byId = new Map<string, DemoApplicantRow>();
    const recordEmailByRowId = new Map<string, string>();
    const skippedRowIds: string[] = [];
    const skippedRows: SkippedApplicationTarget[] = [];
    const normalizedRows = await timer.timed("normalize", () => Promise.all((data ?? []).map(async (record) => {
      if (!record.row_data) return null;
      const recordEmail =
        typeof (record as { resident_email?: string | null }).resident_email === "string"
          ? (record as { resident_email?: string | null }).resident_email!.trim().toLowerCase()
          : "";
      const storedRow = record.row_data as DemoApplicantRow;
      if ((selfScope || role === "resident") && !residentOwnsApplicationRow(storedRow, { email, userId: user.id }, { recordEmail })) return null;
      // Resolve aliases in the lookup, but authenticate against the exact stored PK.
      // One inconsistent row (a protected row that also kept a plaintext identity copy, a malformed record)
      // must cost that row, never the whole list. It is logged by id (no identity) and counted in the response.
      let opened: DemoApplicantRow;
      try {
        opened = openApplicantRow(storedRow, record.id, undefined, { soft: true });
      } catch (error) {
        skippedRowIds.push(record.id);
        skippedRows.push(skippedApplicationTargetFromRecord(record));
        bestEffortFailed("applicant row skipped", { application: record.id })(error);
        return null;
      }
      let row = normalizeRow(opened);
      if ((selfScope || role === "resident") && recordEmail) {
        row = { ...row, email: recordEmail };
      }
      if (record.id !== row.id || (record.row_data as DemoApplicantRow).id !== row.id) {
        try {
          row = await persistNormalizedRow(db, record.id, row, record);
        } catch {
          // A migration not installed yet, ID collision or concurrent edit must
          // keep links on the original live PK, never return an unpersisted ID.
          row = { ...row, id: record.id };
        }
      }
      row.occupancyStartedOn = (record as { occupancy_start?: string }).occupancy_start || undefined;
      return { row, recordEmail };
    })));
    for (const result of normalizedRows) {
      if (!result) continue;
      const { row, recordEmail } = result;
      if (recordEmail) recordEmailByRowId.set(row.id, recordEmail);
      byId.set(row.id, { ...byId.get(row.id), ...row });
    }

    const rows = [...byId.values()];

    const scopedRows =
      selfScope || role === "resident"
        ? rows.filter((row) =>
            residentOwnsApplicationRow(row, { email, userId: user.id }, {
              recordEmail: recordEmailByRowId.get(row.id),
            }),
          )
        : rows;

    const total = timer.total();
    if (total > SLOW_APPLICATIONS_READ_MS) {
      console.warn(JSON.stringify({ route: "manager-applications", phases: { ...timer.phases, total }, rows: scopedRows.length }));
    }
    return NextResponse.json(
      { rows: scopedRows, truncated, ...(skippedRowIds.length > 0 ? { skippedRowIds, skippedRows } : {}) },
      { headers: { "Cache-Control": "private, no-store", "Server-Timing": serverTimingHeader(timer.phases, total) } },
    );
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
      let blockedResidentSlots = 0;
      let blockedFormApprovals = 0;
      let uncheckedFormApprovals = 0;
      let stayPricingError: string | null = null;
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
        const formGate = await approvalBlockedByForm(db, guarded.row, stored ?? null);
        if (formGate === "unchecked") {
          uncheckedFormApprovals += 1;
          continue;
        }
        if (formGate === "blocked") {
          blockedFormApprovals += 1;
          continue;
        }
        let anchored = anchorServerOwnedSmsConsent(
          guarded.row,
          (stored?.row_data ?? null) as DemoApplicantRow | null,
        );
        // Same re-check the single-row upsert applies (PLAN-0920-0631): a room
        // priced per resident re-derives openness here too, since a mirror
        // batch can carry a fresh approval same as the single-row path can.
        const slotCheck = await resolveApprovedResidentSlot(
          db,
          anchored,
          (stored?.row_data ?? null) as DemoApplicantRow | null,
        );
        if (!slotCheck.ok) {
          blockedResidentSlots += 1;
          continue;
        }
        anchored = slotCheck.row;
        const pricingError = await shortStayApprovalBlocker(db, anchored, (stored?.row_data ?? null) as DemoApplicantRow | null);
        if (pricingError) { stayPricingError = pricingError; continue; }
        const previousRow = (stored?.row_data ?? null) as DemoApplicantRow | null;
        await persistNormalizedRow(db, stored?.id ?? anchored.id, anchored, stored ?? null);
        await revokeMaterializedApplicationConsentAfterWrite(db, stored, anchored);
        void syncApplicationLifecycleTasks(db, previousRow, anchored).catch(
          bestEffortFailed("application lifecycle task sync", { application: anchored.id }),
        );
        if (anchored.bucket === "pending" && anchored.application?.consentCredit) {
          void tryAutoOrderScreening(db, anchored);
        }
      }
      if (stayPricingError) return NextResponse.json({ ok: false, error: stayPricingError, blocked: "stay-pricing" }, { status: 409 });
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
      if (uncheckedFormApprovals > 0) {
        return NextResponse.json(
          { ok: false, error: APPROVAL_FORMS_CHECK_FAILED_MESSAGE, blocked: "forms-check", uncheckedFormApprovals },
          { status: 503 },
        );
      }
      if (blockedFormApprovals > 0) {
        return NextResponse.json(
          { ok: false, error: APPROVAL_BLOCKED_BY_FORM_MESSAGE, blocked: "forms", blockedFormApprovals },
          { status: 409 },
        );
      }
      if (blockedResidentSlots > 0) {
        return NextResponse.json(
          {
            ok: false,
            error: "A resident's picked rent was already taken — refresh and pick another.",
            blocked: "capacity",
            blockedResidentSlots,
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
        .select(STORED_APPLICATION_SELECT)
        .in("id", ids);
      if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
      if (!records || records.length === 0) {
        return NextResponse.json({ error: "Application not found." }, { status: 404 });
      }

      const admin = await isAdminUser(user.id);
      // A resident may withdraw only an application bound to this Auth subject.

      const withdrawnAt = new Date().toISOString();
      let withdrawn = 0;
      for (const record of records) {
        const stored = (record.row_data ?? {}) as DemoApplicantRow;
        if (!admin) {
          if (stored.residentUserId !== user.id) {
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
          .update({ row_data: sealApplicantRow(nextRowData, record.id, stored.managerUserId), updated_at: withdrawnAt })
          .eq("id", record.id);
        if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
        withdrawn += 1;
      }
      return NextResponse.json({ ok: true, withdrawn });
    }

    if (!body.row?.id) return NextResponse.json({ error: "row required" }, { status: 400 });
    const requestedRowId = String(body.row.id);
    let row = normalizeRow(body.row);
    const workspaceGate = await applicationWorkspaceGate(db, user, row);
    if (workspaceGate) return workspaceGate;
    let residentSelfWrite = false;
    if (!user) {
      const ids = idVariants(requestedRowId);
      const { data: records, error: loadError } = await db
        .from("manager_application_records")
        .select(STORED_APPLICATION_SELECT)
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
          {
            error: guest.error,
            existingApplicationId: guest.existingApplicationId,
            fieldErrors: guest.fieldErrors,
          },
          { status: guest.status },
        );
      }
      // A guest has no account, so `fillApplicantIdentityFromAccount` (the signed-in branch below) has
      // nothing to read: a template that removed "Full legal name" would store an application identifying
      // nobody, and the lease's tenant name, screening and the manager's queue all read that value. The
      // wizard asks a signed-out applicant for it whatever the template says
      // (`withGuestIdentityQuestionsAsked`); this is the same rule, fail-closed, on the write. A draft is
      // still being filled in, so only a submitted row is refused.
      if (!isDraftShapedApplicationRow(guest.row)) {
        const guestName =
          realApplicantName(guest.row.name) || realApplicantName(guest.row.application?.fullLegalName);
        if (!guestName) {
          return NextResponse.json(
            {
              error: "Enter your full legal name to submit without an account.",
              fieldErrors: { fullLegalName: "Full legal name is required." },
            },
            { status: 400 },
          );
        }
      }
      row = prepareApplicantIdentityWrite(anchorServerOwnedSmsConsent({
        ...guest.row,
        manuallyAdded: existing?.manuallyAdded === true,
        manualResidentDetails: existing?.manualResidentDetails,
      }, existing ?? null), existing, String(existingRecord?.id ?? row.id));
      row = prepareApplicantIdentityWrite(row, existing, String(records?.[0]?.id ?? row.id));
      if (!existing || isDraftShapedApplicationRow(existing)) {
        const validation = await validateResidentApplicationRowForPersistence(db, row);
        if (!validation.ok) {
          return NextResponse.json(
            {
              error: validation.error,
              fieldErrors: validation.fieldErrors,
              ...(validation.step ? { step: validation.step } : {}),
            },
            { status: validation.status },
          );
        }
        if (!isDraftShapedApplicationRow(row)) {
          const fee = await authorizeApplicationFeeSubmission(db, row);
          if (!fee.ok) return NextResponse.json({ error: fee.error }, { status: fee.status });
        }
      }
      const previousRow = existing ?? null;
      const persistedGuestRow = await persistNormalizedRow(
        db, existingRecord?.id ?? row.id, row, existingRecord ?? null,
        await applicantLeadSource(req, true),
        // A guest applies on the website: the web channel (email + inbox by address, never a text).
        "portal",
      );
      await revokeMaterializedApplicationConsentAfterWrite(db, existingRecord ?? null, row);
      // Forms the published template's rules owe after this submit. The first submit creates them (the share
      // tokens are returned once, to the browser that just submitted); a later write by the applicant re-checks,
      // which is a no-op for a form already owed. The id is the one the row was stored under, which a rename can
      // change from the one the record was read under.
      const guestLinkedForms =
        shouldNotifyManagerOfApplicationSubmit(previousRow, row) || owesLinkedFormCheck(row)
          ? await createLinkedFormRequestsForSubmit(db, {
              applicationId: String(persistedGuestRow?.id ?? existingRecord?.id ?? row.id),
              row,
            })
          : [];
      if (shouldNotifyManagerOfApplicationSubmit(previousRow, row)) {
        void notifyManagerApplicationSubmitted(db, row).catch(
          bestEffortFailed("manager application-submitted notice", { application: row.id, manager: row.managerUserId }),
        );
        // Forms set to go out once the application is submitted (the default Intake form).
        dispatchMoveInFormsForResidencyAfterResponse(row.id, "application-submitted");
      }
      void syncApplicationLifecycleTasks(db, previousRow, row).catch(
        bestEffortFailed("application lifecycle task sync", { application: row.id }),
      );
      // The applicant's own side of every application transition. The manager's
      // submit notice stays with notifyManagerApplicationSubmitted above, which
      // is the only path that resolves property-scoped co-managers.
      if (row.managerUserId) {
        void emitApplicationTransition(db, {
          managerUserId: row.managerUserId,
          previous: previousRow,
          application: { ...row, noticeChannel: persistedGuestRow?.noticeChannel ?? row.noticeChannel },
        }).catch(bestEffortFailed("application action event", { application: row.id }));
      }
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
        ...(guestLinkedForms.length > 0 ? { linkedForms: guestLinkedForms } : {}),
      });
    }
    const { role, email } = await resolvePortalRole(db, user);
    // A template can drop "Email" like any other question, so the wizard row then carries none. A signed-in
    // applicant writing their OWN application takes the row's email from their ACCOUNT — never from the body
    // (a differing email is still refused below). Gated on the stored row being theirs or absent, so a
    // manager editing someone else's blank-email row never has their own address stamped onto it.
    if (!(row.email ?? "").trim() && email && isApplicantWizardRow(row)) {
      const identityStored = await loadStoredApplicationRecord(db, requestedRowId);
      if (identityStored.error) {
        return NextResponse.json({ error: "Could not load the existing application." }, { status: 500 });
      }
      const storedIdentityRow = (identityStored.record?.row_data ?? null) as DemoApplicantRow | null;
      const storedIdentityEmail = String(identityStored.record?.resident_email ?? storedIdentityRow?.email ?? "")
        .trim()
        .toLowerCase();
      const accountOwnsStored =
        !storedIdentityRow ||
        (storedIdentityRow.bucket === "pending" &&
          (storedIdentityRow.residentUserId === user.id || storedIdentityEmail === email));
      if (accountOwnsStored) {
        row = await fillApplicantIdentityFromAccount(db, user, row, { submitted: false });
      }
    }
    // An existing pending self-application must belong to this Auth subject.
    // A new application requires the verified session mailbox.
    let selfApplicationWrite = false;
    let authorizedWriteRecord: StoredApplicationRecord | null = null;
    if (role !== "resident") {
      const rowEmail = (row.email ?? "").trim().toLowerCase();
      if (row.bucket === "pending") {
        const selfStored = await loadStoredApplicationRecord(db, requestedRowId);
        if (selfStored.error) {
          return NextResponse.json({ error: "Could not load the existing application." }, { status: 500 });
        }
        const stored = (selfStored.record?.row_data ?? null) as DemoApplicantRow | null;
        selfApplicationWrite = stored ? stored.bucket === "pending" && stored.residentUserId === user.id : Boolean(email) && rowEmail === email;
      }
    }
    if (role === "resident" || selfApplicationWrite) {
      residentSelfWrite = true;
      const prepared = await prepareResidentSelfWrite(db, user, { row, requestedRowId, role, email });
      if (!prepared.ok) return NextResponse.json(prepared.body, { status: prepared.status });
      row = prepared.row;
      authorizedWriteRecord = prepared.authorizedWriteRecord;
    } else {
      const writeGate = await assertManagerOrAdminWriteAccess(db, user);
      if (writeGate) return writeGate;
      const storedLoad = await loadStoredApplicationRecord(db, requestedRowId);
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
      authorizedWriteRecord = storedLoad.record;
      const guarded = anchorServerOwnedWithdrawal(row, storedLoad.record);
      if (guarded.blockedApproval) {
        // The refusal names the record it matched and how, in the same shape
        // `/api/portal/resident-approval` uses, so the client can only stamp
        // `withdrawnAt` locally when the id lookup — never an email fallback —
        // is what matched. This lookup is by id only.
        return NextResponse.json(
          {
            error: "This application was withdrawn by the applicant and can no longer be approved.",
            blocked: "withdrawn",
            blockedApplicationId: String(storedLoad.record?.id ?? "").trim() || null,
            matchedBy: "id",
          },
          { status: 409 },
        );
      }
      const formGate = await approvalBlockedByForm(db, guarded.row, storedLoad.record ?? null);
      if (formGate === "unchecked") {
        return NextResponse.json({ error: APPROVAL_FORMS_CHECK_FAILED_MESSAGE, blocked: "forms-check" }, { status: 503 });
      }
      if (formGate === "blocked") {
        return NextResponse.json({ error: APPROVAL_BLOCKED_BY_FORM_MESSAGE, blocked: "forms" }, { status: 409 });
      }
      row = anchorServerOwnedSmsConsent(
        guarded.row,
        (storedLoad.record?.row_data ?? null) as DemoApplicantRow | null,
      );
      // Reserve the SLOT the same way the bed itself is reserved: re-derived
      // here, inside this same write, never trusted from the client. A room
      // that does not price per resident is untouched by this call.
      const slotCheck = await resolveApprovedResidentSlot(
        db,
        row,
        (storedLoad.record?.row_data ?? null) as DemoApplicantRow | null,
      );
      if (!slotCheck.ok) {
        return NextResponse.json(
          { error: slotCheck.error, blocked: "capacity", ...(slotCheck.conflict ? { conflict: slotCheck.conflict } : {}) },
          { status: 409 },
        );
      }
      row = slotCheck.row;
      const pricingError = await shortStayApprovalBlocker(db, row, (storedLoad.record?.row_data ?? null) as DemoApplicantRow | null);
      if (pricingError) return NextResponse.json({ error: pricingError, blocked: "stay-pricing" }, { status: 409 });
    }
    const persisted = await persistApplicationWrite(db, {
      user,
      row,
      requestedRowId,
      authorizedWriteRecord,
      residentSelfWrite,
      leadSource: await applicantLeadSource(req, residentSelfWrite),
    });
    if (!persisted.ok) return NextResponse.json(persisted.body, { status: persisted.status });
    row = persisted.row;
    const linkedForms = persisted.linkedForms;

    if (row.manuallyAdded && body.existingResidentOnboarding) {
      const { data: profile } = await db.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
      // A live signup trial has no Communication until it pays (the active workspace OWNER's plan):
      // the resident is still added, the welcome is skipped and the answer says why.
      let communicationBlocked: "trial" | "plan_unreadable" | undefined;
      if (body.existingResidentOnboarding.sendWelcomeEmail !== false) {
        const communication = await assertManagerCommunicationAllowedForActiveWorkspace(db, user.id);
        if (!communication.allowed) communicationBlocked = communication.reason;
      }
      const onboarding = await runExistingResidentOnboarding(
        db,
        {
          userId: user.id,
          email: user.email ?? null,
          managerName: String(profile?.full_name ?? ""),
        },
        row,
        { sendWelcomeEmail: body.existingResidentOnboarding.sendWelcomeEmail !== false && !communicationBlocked },
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
        residentAccess: "invitation_required",
        existingResidentOnboarding: {
          leaseId: onboarding.leaseId,
          welcomeEmailSent: onboarding.welcomeEmailSent,
          axisId: onboarding.axisId,
          ...(communicationBlocked ? { communicationBlocked } : {}),
        },
      });
    }

    return NextResponse.json(
      residentSelfWrite
        ? {
            ok: true,
            ...(row.bucket === "approved" ? { residentAccess: "invitation_required" } : {}),
            row: prepareApplicantIdentityWrite(row, null, row.id),
            ...(linkedForms.length > 0 ? { linkedForms } : {}),
          }
        : { ok: true, ...(row.bucket === "approved" ? { residentAccess: "invitation_required" } : {}) },
    );
  } catch (e) {
    const mapped = applicationWriteErrorResponse(e, "Failed to save application.");
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
