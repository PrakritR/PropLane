import { residentSubjectHasHouse } from "@/lib/auth/resident-subject-evidence.server";
import { resolveAdminOversight } from "@/lib/auth/admin-oversight.server";
import { NextResponse, after } from "next/server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { isLinkedVendorJob } from "@/lib/add-on-vendor-job";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  fetchRowsForManagerWithLinked,
  resolveManagerWorkspaceRowScope,
  rowInWorkspaceScope,
  type ManagerWorkspaceRowScope,
} from "@/lib/auth/co-manager-module-scope";
import { managerScopedPropertyIds } from "@/lib/work-order-record-access.server";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { resolveResidentScopedActorRole } from "@/lib/auth/resident-role-access";
import { isViewAsSessionOpen } from "@/lib/auth/view-as.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveResidentFilingScope } from "@/lib/resident-manager-scope";
import { deleteWorkOrderRecord } from "@/lib/resident-work-order-lifecycle.server";
import {
  repairWorkOrderScopesForManager,
  shouldRunScopeRepair,
} from "@/lib/repair-service-request-scopes.server";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { workOrderEvent } from "@/lib/work-order-events.server";
import { loadServiceAutomationSettings } from "@/lib/service-automation-settings.server";
import { responsePromisePhrase } from "@/lib/service-automation-settings";
import type { WorkOrderRowWithDispatch } from "@/lib/work-order-dispatch";
import { prepareDispatch } from "@/lib/work-order-dispatch.server";
import { emitVendorAssigned, offerNewServiceToPreferredVendor } from "@/lib/work-order-vendor-messages.server";
import {
  autoTimeNewWorkOrder,
  notifyVisitAutoBooked,
  willDispatchRun,
  type AutoTimeOutcome,
} from "@/lib/work-order-auto-time.server";
import {
  syncWorkOrderToGoogleCalendar,
  workOrderGoogleCalendarSyncChanged,
} from "@/lib/google-calendar/sync.server";
import { attachManagerNamesToWorkOrders } from "@/lib/work-order-manager-names.server";
import { projectWorkOrderForHiredVendor, projectWorkOrderForOfferedVendor } from "@/lib/work-order-vendor-privacy";
import { restoreServerPublishState } from "@/lib/service-publish-state";
import { alertPhonesOf } from "@/lib/one-number/ops-alerts.server";

export const runtime = "nodejs";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

type WorkOrderScopeRecord = { id: string; row_data: DemoManagerWorkOrderRow | null; updated_at: string | null };

async function sessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

async function vendorScopedWorkOrderRows(db: Db, vendorUserId: string): Promise<DemoManagerWorkOrderRow[]> {
  const { data: vendorDirectoryRows } = await db.from("manager_vendor_records").select("id").eq("vendor_user_id", vendorUserId);
  const vendorDirectoryIds = (vendorDirectoryRows ?? []).map((row) => String(row.id ?? "")).filter(Boolean);

  const offeredIds = new Set<string>();
  const { data: offersByUser } = await db
    .from("work_order_vendor_offers")
    .select("work_order_id")
    .eq("vendor_user_id", vendorUserId)
    .eq("status", "sent");
  for (const offer of offersByUser ?? []) offeredIds.add(offer.work_order_id as string);

  if (vendorDirectoryIds.length > 0) {
    const { data: offersByDirectory } = await db
      .from("work_order_vendor_offers")
      .select("work_order_id")
      .in("vendor_directory_id", vendorDirectoryIds)
      .eq("status", "sent");
    for (const offer of offersByDirectory ?? []) offeredIds.add(offer.work_order_id as string);
  }

  const { data: assigned } = await db
    .from("portal_work_order_records")
    .select("id, row_data, updated_at")
    .eq("vendor_user_id", vendorUserId)
    .order("updated_at", { ascending: false })
    .limit(500);

  const byId = new Map<string, DemoManagerWorkOrderRow>();
  for (const record of assigned ?? []) {
    const row = record.row_data as DemoManagerWorkOrderRow | null;
    if (row) byId.set(record.id as string, projectWorkOrderForHiredVendor(row));
  }

  // Everything above is a job this vendor HOLDS (`vendor_user_id` names them), so it is served
  // whole. Everything below is reachable on an open OFFER alone — including a stranger matched
  // by the local marketplace — so the site is projected away before the row leaves the server.
  // `work-order-vendor-privacy.ts` states the contract; the vendor panel's own redaction is
  // presentation on top of this, never instead of it.
  const missingIds = [...offeredIds].filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    const { data: offeredRows } = await db.from("portal_work_order_records").select("id, row_data").in("id", missingIds);
    for (const record of offeredRows ?? []) {
      const row = record.row_data as DemoManagerWorkOrderRow | null;
      if (row) byId.set(record.id as string, projectWorkOrderForOfferedVendor(row));
    }
  }

  return attachManagerNamesToWorkOrders(db, [...byId.values()]);
}

function normalizeRow(row: DemoManagerWorkOrderRow): DemoManagerWorkOrderRow {
  return {
    ...row,
    residentEmail: row.residentEmail?.trim().toLowerCase() || row.residentEmail,
  };
}

/** True when a non-resident account holds the vendor role AND the request came from the vendor portal. */
async function isVendorPortalRequest(role: string): Promise<boolean> {
  if (role === "resident") return false;
  try {
    const ctx = await getPortalAccessContext();
    return ctx.effectiveRole === "vendor" && ctx.roles.includes("vendor");
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    // The all-owners read is admin oversight: asked for with `?oversight=admin` AND confirmed by the
    // role. An admin in their own manager portal reads exactly what a manager does.
    const oversight = await resolveAdminOversight(req, user.id);
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const role = await resolveResidentScopedActorRole(db, {
      userId: user.id,
      legacyRole: profile?.role,
    });
    if (role === "denied" && !oversight) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

    // A manager+vendor account resolves to "manager" above (profiles.role is the role it was
    // created as); the portal the request came from decides, via profile_roles + the active-portal cookie.
    if (!oversight && (role === "vendor" || (await isVendorPortalRequest(role)))) {
      const rows = await vendorScopedWorkOrderRows(db, user.id);
      return NextResponse.json({ rows });
    }

    if (!oversight && role !== "resident") {
      // Heal orphans for this manager's residents before listing. TTL-gated so
      // nav-count polls and repeat page loads don't re-run the sweep.
      // (Skipped while an operator is viewing as this account: a read-only session writes nothing.)
      if (shouldRunScopeRepair(`work-orders:${user.id}`) && !(await isViewAsSessionOpen())) {
        await repairWorkOrderScopesForManager(db, user.id).catch(() => undefined);
      }

      // Managers see their own work orders (plus legacy unassigned rows), never
      // other landlords' — and additionally rows on properties they own or share
      // via an accepted co-manager link with services access (covers mis-stamped
      // manager_user_id when property_id is correct).
      const linkedPropertyIds = await managerScopedPropertyIds(db, user.id);
      // Narrows the owned + co-manager fan-out to the active workspace. The
      // legacy "unassigned but property-named" bucket below is deliberately
      // matched against the FULL `linkedPropertyIds` (never workspace-scoped)
      // — it belongs to no manager yet, let alone any workspace, until it is
      // claimed.
      const workspaceScope = await resolveManagerWorkspaceRowScope(db, user.id);
      const records = await fetchRowsForManagerWithLinked<WorkOrderScopeRecord>(
        db,
        "portal_work_order_records",
        user.id,
        linkedPropertyIds,
        { propertyColumns: ["property_id", "assigned_property_id"], workspaceScope },
      );
      const byId = new Map<string, WorkOrderScopeRecord>();
      for (const record of records) {
        if (record.id) byId.set(record.id, record);
      }
      // Legacy rows with no `manager_user_id`: visible to the manager who holds the house the row itself
      // names, and - when it names no house - only to the manager its own payload names. There is nothing
      // else to attribute such a row by, and broadcasting it showed one landlord's work orders to every
      // other manager; a platform admin still reads them all through the oversight read above.
      const { data: legacyRows, error: legacyError } = await db
        .from("portal_work_order_records")
        .select("id, row_data, updated_at")
        .is("manager_user_id", null)
        .order("updated_at", { ascending: false })
        .limit(500);
      if (legacyError) return NextResponse.json({ error: legacyError.message }, { status: 500 });
      for (const record of (legacyRows ?? []) as unknown as WorkOrderScopeRecord[]) {
        if (!record.id || byId.has(record.id)) continue;
        // A legacy row that names a property belongs to whoever holds that
        // property — showing it to every manager leaked one landlord's work
        // orders to all the others.
        const legacyPropertyId = String(
          (record.row_data as DemoManagerWorkOrderRow | null)?.assignedPropertyId ??
            (record.row_data as DemoManagerWorkOrderRow | null)?.propertyId ??
            "",
        ).trim();
        if (legacyPropertyId && !linkedPropertyIds.has(legacyPropertyId)) continue;
        if (!legacyPropertyId) {
          // No house to attribute it by: only the manager the payload itself names reads it.
          const named = String((record.row_data as DemoManagerWorkOrderRow | null)?.managerUserId ?? "").trim();
          if (named !== user.id) continue;
        }
        // Claimed by no manager yet, but still only ever shown in the workspace that holds its
        // house (an account with several workspaces would otherwise read it in all of them).
        if (!rowInWorkspaceScope(legacyPropertyId || null, workspaceScope)) continue;
        byId.set(record.id, record);
      }
      const rows = [...byId.values()]
        .sort((a, b) => {
          const aTs = Date.parse(String(a.updated_at ?? ""));
          const bTs = Date.parse(String(b.updated_at ?? ""));
          return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
        })
        .map((record) => record.row_data)
        .filter(Boolean) as DemoManagerWorkOrderRow[];
      return NextResponse.json({ rows });
    }

    let query = db
      .from("portal_work_order_records")
      .select("row_data, updated_at")
      .order("updated_at", { ascending: false })
      .limit(500);

    if (!oversight && role === "resident") {
      query = query.eq("resident_user_id", user.id);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? [])
      .map((record) => record.row_data)
      .filter(Boolean) as DemoManagerWorkOrderRow[];
    return NextResponse.json({ rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load work orders.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type Actor = { userId: string; email: string; admin: boolean; role: string };

type OwnerCols = { resident_user_id?: string | null; manager_user_id?: string | null; resident_email?: string | null; row_data?: { residentUserId?: string | null } | null };

/** Whether the caller POSITIVELY owns a row: the manager it is stamped to, the
 * resident it is addressed to, or an admin.
 *
 * This deliberately has no "…and legacy rows with no owner" clause. That clause
 * was `!rec.manager_user_id && actor.role !== "resident"` — a denylist, so it
 * admitted every other manager on the platform AND any account whose role
 * failed to resolve to a known string. Claiming a legacy row is a separate,
 * positive check: see `actorMayWriteRecord` in POST. */
function actorOwnsRecord(actor: Actor, rec: OwnerCols | null): boolean {
  if (actor.admin) return true;
  if (!rec) return false;
  if (actor.role === "manager" && rec.manager_user_id && rec.manager_user_id === actor.userId) return true;
  if (actor.role === "resident" && rec.resident_user_id === actor.userId) return true;
  return false;
}



/** Resolve a vendor directory row's linked auth user, so the record can be scoped
 * for the vendor's own GET query and inbox notifications without a join at read time.
 * Rejects (returns `rejected: true`) a vendorId that doesn't belong to `ownerManagerUserId`
 * and isn't marked shared — the same ownership gate the sibling work-order-vendor-offers
 * route applies — so a client can't attach an uninvited/other-manager's vendor to a work
 * order via a crafted vendorId. */
async function resolveVendorUserId(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  vendorId: string | null | undefined,
  ownerManagerUserId: string | null,
): Promise<{ vendorUserId: string | null; rejected: boolean }> {
  const id = vendorId?.trim();
  if (!id) return { vendorUserId: null, rejected: false };
  const { data } = await db
    .from("manager_vendor_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .eq("id", id)
    .maybeSingle();
  if (!data) return { vendorUserId: null, rejected: true };
  const rowData = (data.row_data ?? {}) as Record<string, unknown>;
  const shared = rowData.sharedWithManagers === true;
  const owned = Boolean(ownerManagerUserId) && (data.manager_user_id === ownerManagerUserId || shared);
  if (!owned) return { vendorUserId: null, rejected: true };
  return { vendorUserId: (data.vendor_user_id as string | null) ?? null, rejected: false };
}

/** Which manager's vendor directory a vendorId must belong to (or be shared with) for
 * this write. A manager actor always uses their own id, never client input. A resident's
 * `row.managerUserId` has already been verified as legitimate by residentMayTargetRowManager.
 * An admin trusts the row's managerUserId, falling back to a DB lookup when editing an
 * existing row whose body omitted it. */
async function resolveVendorOwnerManagerUserId(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  actor: Actor,
  row: DemoManagerWorkOrderRow,
): Promise<string | null> {
  if (actor.role === "resident") return row.managerUserId?.trim() || null;
  if (!actor.admin) return actor.userId;
  const fromRow = row.managerUserId?.trim();
  if (fromRow) return fromRow;
  const { data } = await db
    .from("portal_work_order_records")
    .select("manager_user_id")
    .eq("id", row.id)
    .maybeSingle();
  return (data?.manager_user_id as string | null) ?? null;
}

/** Build the persisted record, binding scope columns to the authenticated caller
 * so a client cannot spoof ownership. */
function recordForActor(actor: Actor, row: DemoManagerWorkOrderRow, vendorUserId: string | null, previous: OwnerCols | null) {
  const normalized = { ...normalizeRow(row), residentUserId: actor.role === "resident" && !actor.admin ? actor.userId : previous?.resident_user_id ?? null };
  const withManager: DemoManagerWorkOrderRow =
    actor.admin || actor.role === "resident"
      ? normalized
      : { ...normalized, managerUserId: actor.userId };
  const base = {
    id: withManager.id,
    manager_user_id: withManager.managerUserId || null,
    resident_user_id: normalized.residentUserId || null,
    resident_email: withManager.residentEmail?.trim().toLowerCase() || null,
    property_id: withManager.propertyId || null,
    assigned_property_id: withManager.assignedPropertyId || null,
    vendor_user_id: withManager.selfAssigned ? null : vendorUserId,
    row_data: withManager,
    updated_at: new Date().toISOString(),
  };
  if (actor.admin) return base;
  if (actor.role === "resident") {
    return { ...base, resident_email: actor.email || base.resident_email };
  }
  // Any other non-admin caller is the owning manager; never trust a
  // client-supplied manager_user_id.
  return { ...base, manager_user_id: actor.userId };
}

/** A newly persisted row emits exactly one canonical, idempotent lifecycle event. */
async function emitCreatedWorkOrder(
  db: Db,
  actor: Actor,
  row: DemoManagerWorkOrderRow,
  managerUserId: string | null | undefined,
): Promise<void> {
  if (actor.admin) return;
  // The vendor job behind an add-on is the manager's own record: no "new service" notice to the team, and
  // it has no resident to acknowledge (`add-on-vendor-job.ts`).
  if (isLinkedVendorJob(row)) return;
  const ownerId = managerUserId?.trim() || row.managerUserId?.trim() || (actor.role === "resident" ? "" : actor.userId);
  if (!ownerId) return;
  const managerRecipients = await resolvePropertyScopedManagerRecipientIds(db, {
    ownerManagerUserId: ownerId,
    propertyId: row.assignedPropertyId?.trim() || row.propertyId?.trim() || undefined,
    channel: "services",
  });
  const residentEmail = row.residentEmail?.trim().toLowerCase();
  const emergency = row.priority === "Emergency";
  const facts = {
    reference: row.reference || "Work order",
    title: row.title || "Work order",
    propertyLabel: row.propertyName || undefined,
    residentName: row.residentName?.trim() || undefined,
    emergency,
  };
  await workOrderEvent(db, {
    eventId: `${row.id}:created`,
    event: "created",
    managerUserId: ownerId,
    workOrderId: row.id,
    senderUserId: actor.userId,
    senderEmail: actor.email,
    senderName: row.residentName?.trim() || undefined,
    facts,
    recipients: managerRecipients.map((userId) => ({ audience: "manager" as const, userId })),
  }).catch(() => undefined);
  if (emergency) {
    await alertPhonesOf(db, {
      ownerUserId: ownerId,
      kind: "emergency_maintenance",
      entityId: row.id,
      propertyId: row.assignedPropertyId?.trim() || row.propertyId?.trim() || null,
      text: `Emergency service at ${row.propertyName || "a house"}: ${row.title || "needs attention"}.`,
    });
  }

  // The resident's acknowledgement carries the manager's response promise and
  // is sent AS the manager — a resident who filed it cannot be its own sender,
  // which is why, before PLAN-0915, a resident-filed request was acknowledged
  // by nobody.
  if (!residentEmail?.includes("@")) return;
  const [{ data: manager }, serviceSettings] = await Promise.all([
    db.from("profiles").select("email, full_name, sms_from_number").eq("id", ownerId).maybeSingle(),
    loadServiceAutomationSettings(db, ownerId).catch(() => null),
  ]);
  const managerEmail = String(manager?.email ?? "").trim().toLowerCase();
  if (!managerEmail) return;
  await workOrderEvent(db, {
    eventId: `${row.id}:created:resident`,
    event: "created",
    managerUserId: ownerId,
    workOrderId: row.id,
    senderUserId: ownerId,
    senderEmail: managerEmail,
    senderName: String(manager?.full_name ?? "").trim() || undefined,
    facts: {
      ...facts,
      responsePromise: serviceSettings ? responsePromisePhrase(serviceSettings.responsePromise) || undefined : undefined,
      emergencyPhone: String(manager?.sms_from_number ?? "").trim() || undefined,
    },
    recipients: [{ audience: "resident" as const, email: residentEmail }],
  }).catch(() => undefined);
}

export async function POST(req: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    // Writing with every owner's privileges (trusting the body's `managerUserId`, skipping the
    // ownership and workspace gates) is admin OVERSIGHT, the same explicit surface the read uses:
    // an admin writing from their own manager portal is the manager they are.
    const oversight = await resolveAdminOversight(req, user.id, await isAdminUser(user.id));
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const actor: Actor = {
      userId: user.id,
      email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
      admin: oversight,
      role: await resolveResidentScopedActorRole(db, {
        userId: user.id,
        legacyRole: profile?.role,
      }),
    };

    if (actor.role === "denied" && !oversight) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

    // Vendors see their offered/assigned work through GET; the record itself is
    // manager-authored (assignment, scheduling, billing), so vendor writes are rejected.
    if (!oversight && (actor.role === "vendor" || (await isVendorPortalRequest(actor.role)))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const isManagerActor = !oversight && actor.role !== "resident";
    // The active workspace refuses a write outside it: a create must land in
    // it, an update/delete of an OWNED row must refuse a row outside it. The
    // legacy "claimable, unassigned" bucket in `actorMayWriteRecord` below is
    // deliberately left unscoped — it belongs to no workspace until claimed,
    // matching the GET-side rule above.
    const workspaceScope: ManagerWorkspaceRowScope = isManagerActor
      ? await resolveManagerWorkspaceRowScope(db, user.id)
      : { propertyIds: null, untaggedOwnedVisible: true };

    const body = (await req.json()) as {
      action?: "upsert" | "delete" | "replace";
      id?: string;
      row?: DemoManagerWorkOrderRow;
      rows?: DemoManagerWorkOrderRow[];
    };

    type ExistingRecord = OwnerCols & { row_revision: number; dispatch?: unknown; row_data?: DemoManagerWorkOrderRow | null };
    const findExisting = async (id: string): Promise<ExistingRecord | null> => {
      const { data, error } = await db
        .from("portal_work_order_records")
        .select("manager_user_id, resident_user_id, resident_email, row_revision, dispatch:row_data->dispatch, row_data")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error("Could not verify service ownership.");
      return (data as ExistingRecord | null) ?? null;
    };

    const persistRecord = async (record: ReturnType<typeof recordForActor>, existing: ExistingRecord | null) => {
      if (!existing) {
        const { error } = await db.from("portal_work_order_records").insert(record);
        return !error;
      }
      let update = db.from("portal_work_order_records").update(record).eq("id", record.id).eq("row_revision", existing.row_revision);
      if (actor.role === "resident" && !actor.admin) update = update.eq("resident_user_id", actor.userId);
      else if (!actor.admin && existing.manager_user_id) update = update.eq("manager_user_id", existing.manager_user_id);
      const { data, error } = await update.select("id");
      return !error && Boolean(data?.length);
    };

    /** May this caller write or delete this existing row?
     *
     * Ownership first. Only then the narrow legacy claim: a row with no
     * `manager_user_id` is un-backfilled data, claimable ONLY by a manager who
     * holds the property the row itself names. A legacy row that names no
     * property is claimable by nobody here. Backfilling `manager_user_id`
     * retires this path outright.
     *
     * The replace sync walks every row, so the property lookup resolves once
     * per request. */
    let scopedPropertyIdsPromise: Promise<Set<string>> | null = null;
    const actorMayWriteRecord = async (rec: ExistingRecord | null): Promise<boolean> => {
      if (actorOwnsRecord(actor, rec)) {
        // An owned row is still narrowed by the active workspace — refuse an
        // update/delete of a row outside it, the same as it is simply absent
        // from GET. Admin and resident ownership are never workspace-scoped.
        if (isManagerActor && rec) {
          const propertyId = String(rec.row_data?.assignedPropertyId ?? rec.row_data?.propertyId ?? "").trim();
          if (!rowInWorkspaceScope(propertyId || null, workspaceScope)) return false;
        }
        return true;
      }
      if (!rec || rec.manager_user_id || actor.role === "resident") return false;
      const propertyId = String(rec.row_data?.assignedPropertyId ?? rec.row_data?.propertyId ?? "").trim();
      if (!propertyId) return false;
      scopedPropertyIdsPromise ??= managerScopedPropertyIds(db, actor.userId);
      return (await scopedPropertyIdsPromise).has(propertyId);
    };

    /** A brand-new row (no existing record) bypasses `actorMayWriteRecord`
     * entirely — this is the CREATE half of the workspace gate: a manager
     * actor's new row must land in the active workspace. Residents/admin are
     * unaffected. */
    const mayCreateInWorkspace = (row: DemoManagerWorkOrderRow): boolean => {
      if (!isManagerActor) return true;
      const propertyId = (row.assignedPropertyId?.trim() || row.propertyId?.trim() || "") || null;
      return rowInWorkspaceScope(propertyId, workspaceScope);
    };

    const maybeSyncWorkOrderGoogleCalendar = async (
      existing: ExistingRecord | null,
      persisted: { manager_user_id: string | null; row_data: DemoManagerWorkOrderRow },
    ): Promise<void> => {
      const managerUserId = persisted.manager_user_id?.trim();
      if (!managerUserId || actor.role === "resident") return;
      const previous = existing?.row_data ?? null;
      const next = persisted.row_data;
      if (!workOrderGoogleCalendarSyncChanged(previous, next)) return;
      const synced = await syncWorkOrderToGoogleCalendar(db, managerUserId, next).catch(() => next);
      if (synced.googleCalendarEventId === next.googleCalendarEventId) return;
      await db
        .from("portal_work_order_records")
        .update({ row_data: synced, updated_at: new Date().toISOString() })
        .eq("id", next.id);
    };

    /** row_data.dispatch is strictly server-owned (dispatch pipeline). Clients
     * can never set or change it: any incoming dispatch is dropped and replaced
     * with the persisted server copy (or removed when none exists), so a forged
     * proposal on a brand-new resident row can't spoof the manager UI or
     * suppress the real dispatch. */
    const preserveServerDispatch = (rowData: WorkOrderRowWithDispatch, existing: ExistingRecord | null): void => {
      const existingDispatch = existing?.dispatch as WorkOrderRowWithDispatch["dispatch"] | undefined;
      if (existingDispatch) {
        rowData.dispatch = existingDispatch;
      } else {
        delete rowData.dispatch;
      }
      // The work-board publish state is server-owned for the same reason: a stale browser copy must
      // not silently unpublish a service (or republish one the hire just took off), and a client
      // must not forge a publish ref (`/api/portal/service-publish` is the only writer).
      restoreServerPublishState(rowData, existing?.row_data ?? null);
    };

    /** New resident-filed rows kick off dispatch preparation after the response
     * is sent; the pipeline's audit dedupe key makes re-sync replays no-ops.
     * after() needs a live request scope — outside one (tests) run inline. */
    const maybePrepareDispatch = (existing: ExistingRecord | null, rowId: string): void => {
      if (existing || actor.role !== "resident") return;
      const task = () => prepareDispatch(db, rowId).catch((e) => console.error("prepareDispatch failed", rowId, e));
      try {
        after(task);
      } catch {
        void task();
      }
    };

    /** A newly filed resident service is offered to the manager's PREFERRED
     * vendor for that house and trade (comms-safety-0929, D3); with none set
     * nobody is messaged. Skipped when vendor dispatch is on — that pipeline
     * proposes the vendor and the manager approves it. Runs after the response
     * and is idempotent (one offer per service + vendor, one delivery key). */
    const maybeOfferToPreferredVendor = (
      existing: ExistingRecord | null,
      persisted: { manager_user_id: string | null; row_data: DemoManagerWorkOrderRow },
    ): void => {
      if (existing || actor.role !== "resident") return;
      const managerUserId = persisted.manager_user_id?.trim();
      if (!managerUserId) return;
      const task = async () => {
        if (await willDispatchRun(db, managerUserId, persisted.row_data)) return;
        await offerNewServiceToPreferredVendor(db, { workOrderId: persisted.row_data.id });
      };
      const guarded = () => task().catch((e) => console.error("offerNewServiceToPreferredVendor failed", persisted.row_data.id, e));
      try {
        after(guarded);
      } catch {
        void guarded();
      }
    };

    /** "You were assigned ..." to the vendor now on the service: the assignment
     * is a DIFF against the stored row, so a re-sync of an unchanged list, a
     * resident edit or a bid accept (which already told the vendor) sends nothing. */
    const maybeNotifyVendorAssigned = async (
      existing: ExistingRecord | null,
      persisted: { manager_user_id: string | null; row_data: DemoManagerWorkOrderRow },
    ): Promise<void> => {
      if (actor.role === "resident") return;
      const next = persisted.row_data;
      const vendorId = next.vendorId?.trim();
      const managerUserId = persisted.manager_user_id?.trim();
      if (!vendorId || !managerUserId || next.selfAssigned) return;
      if ((existing?.row_data?.vendorId ?? "").trim() === vendorId) return;
      await emitVendorAssigned(db, {
        workOrderId: next.id,
        managerUserId,
        row: next,
        vendorDirectoryId: vendorId,
        assignedAt: next.vendorAssignedAt?.trim() || new Date().toISOString(),
      }).catch((e) => console.error("emitVendorAssigned failed", next.id, e));
    };

    // Stamp manager + property from residency for residents; reject if none.
    const stampResidentWorkOrder = async (
      row: DemoManagerWorkOrderRow,
      existing: ExistingRecord | null,
    ): Promise<DemoManagerWorkOrderRow | null> => {
      if (actor.admin || actor.role !== "resident") return row;
      const scope = await resolveResidentFilingScope(db, {
        residentEmail: actor.email,
        claimedManagerUserId: row.managerUserId,
        claimedPropertyId: row.propertyId || row.assignedPropertyId,
      });
      if (!scope || !scope.propertyId || !(await residentSubjectHasHouse(db, actor.userId, actor.email, scope.managerUserId, scope.propertyId))) return null;
      // The link between a service and the add-on request that spawned a vendor job is manager-owned: a resident
      // who set it could hide their own service from the manager's lists and skip the manager notice. Only a
      // value the server already stored survives a resident write.
      const { linkedServiceRequestId: _clientLink, ...withoutClientLink } = row as DemoManagerWorkOrderRow & {
        linkedWorkOrderId?: string;
      };
      void _clientLink;
      delete (withoutClientLink as { linkedWorkOrderId?: string }).linkedWorkOrderId;
      const storedLink = existing?.row_data?.linkedServiceRequestId?.trim();
      return {
        ...withoutClientLink,
        ...(storedLink ? { linkedServiceRequestId: storedLink } : {}),
        managerUserId: scope.managerUserId,
        propertyId: scope.propertyId || row.propertyId || "",
        assignedPropertyId: row.assignedPropertyId || scope.propertyId || undefined,
        residentEmail: actor.email || row.residentEmail,
      };
    };

    /** A brand-new resident-filed row may already have a workable visit time —
     * Stage C's suggestion engine gets a chance to book (from painted
     * availability) or merely propose one BEFORE the row is persisted, so a
     * fresh service never opens to an empty "Not scheduled" field when the
     * manager's own availability already answers it. Never runs for an edit of
     * an existing row, a manager-authored row, or ahead of vendor auto-dispatch
     * (that pipeline books its own vendor's slot and stays the source of truth
     * for the row — see `willDispatchRun`, the same predicate `prepareDispatch`
     * itself gates on). */
    const maybeAutoTimeNewResidentRow = async (
      existing: ExistingRecord | null,
      row: DemoManagerWorkOrderRow,
    ): Promise<{ row: DemoManagerWorkOrderRow; outcome: AutoTimeOutcome }> => {
      const rowManagerUserId = row.managerUserId?.trim();
      if (existing || actor.role !== "resident" || !rowManagerUserId) {
        return { row, outcome: { kind: "none" } };
      }
      // Best-effort — a failed lookup here must never block filing the request
      // itself, so it falls back to "untimed" rather than throwing.
      try {
        const dispatchWillRun = await willDispatchRun(db, rowManagerUserId, row);
        return await autoTimeNewWorkOrder(db, rowManagerUserId, row, { dispatchWillRun });
      } catch (e) {
        console.error("autoTimeNewWorkOrder failed", row.id, e);
        return { row, outcome: { kind: "none" } };
      }
    };

    /** Best-effort resident notice, after the response is sent, for a row this
     * request just booked outright. A failed notification never fails the
     * request that just created the service. */
    const maybeNotifyAutoBookedVisit = (
      outcome: AutoTimeOutcome,
      managerUserId: string | null | undefined,
      row: DemoManagerWorkOrderRow,
    ): void => {
      if (outcome.kind !== "booked" || !managerUserId) return;
      const task = () =>
        notifyVisitAutoBooked(db, managerUserId, row).catch((e) =>
          console.error("notifyVisitAutoBooked failed", row.id, e),
        );
      try {
        after(task);
      } catch {
        void task();
      }
    };

    if (body.action === "replace") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      // The manager client mirrors its FULL local list through this replace
      // sync on every change — creating a work order arrives here too, never
      // as a single-row insert. "Newly created" is detected per row by the
      // `findExisting` lookup below (fetched before that row's upsert), so a
      // re-synced existing row never notifies.
      for (const row of rows) {
        if (!row?.id) continue;
        const existing = await findExisting(row.id);
        // A brand-new id (no existing row) may be created, subject to the
        // workspace gate a manager actor's create must land inside.
        if (existing ? !(await actorMayWriteRecord(existing)) : !mayCreateInWorkspace(row)) continue;
        const stamped = await stampResidentWorkOrder(row, existing);
        if (!stamped) continue;
        const { row: timedRow, outcome: autoTimeOutcome } = await maybeAutoTimeNewResidentRow(existing, stamped);
        const { vendorUserId, rejected } = await resolveVendorUserId(
          db,
          timedRow.vendorId,
          await resolveVendorOwnerManagerUserId(db, actor, timedRow),
        );
        if (rejected) continue;
        const persisted = recordForActor(actor, timedRow, vendorUserId, existing);
        preserveServerDispatch(persisted.row_data, existing);
        const saved = await persistRecord(persisted, existing);
        if (!saved) return NextResponse.json({ error: "The request changed; please retry." }, { status: 409 });
        if (saved) {
          if (!existing) {
            await emitCreatedWorkOrder(db, actor, timedRow, persisted.manager_user_id);
          }
          maybePrepareDispatch(existing, timedRow.id);
          maybeOfferToPreferredVendor(existing, persisted);
          await maybeNotifyVendorAssigned(existing, persisted);
          maybeNotifyAutoBookedVisit(autoTimeOutcome, persisted.manager_user_id, persisted.row_data);
          await maybeSyncWorkOrderGoogleCalendar(existing, persisted);
        }
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === "delete") {
      const id = body.id?.trim();
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { data: existing, error: readError } = await db
        .from("portal_work_order_records")
        .select("manager_user_id, resident_user_id, resident_email, row_data, row_revision")
        .eq("id", id)
        .maybeSingle();
      if (readError) return NextResponse.json({ error: "Could not verify the request; please retry." }, { status: 500 });
      if (!existing) return NextResponse.json({ ok: true });
      if (!(await actorMayWriteRecord(existing))) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      // The same calendar-release + delete the resident assistant's
      // cancel_work_order runs, so the two paths cannot drift.
      const { error } = await deleteWorkOrderRecord(db, {
        id,
        manager_user_id: (existing.manager_user_id as string | null) ?? null,
        row_data: existing.row_data as DemoManagerWorkOrderRow | null,
        row_revision: Number(existing.row_revision),
      }, actor.role === "resident" && !actor.admin ? actor.userId : undefined);
      if (error) return NextResponse.json({ error }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    if (!body.row?.id) return NextResponse.json({ error: "row required" }, { status: 400 });
    const existing = await findExisting(body.row.id);
    // A brand-new id (no existing row) may be created, subject to the
    // workspace gate a manager actor's create must land inside.
    if (existing) {
      if (!(await actorMayWriteRecord(existing))) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
    } else if (!mayCreateInWorkspace(body.row)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const stamped = await stampResidentWorkOrder(body.row, existing);
    if (!stamped) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const { row: timedRow, outcome: autoTimeOutcome } = await maybeAutoTimeNewResidentRow(existing, stamped);
    const { vendorUserId, rejected } = await resolveVendorUserId(
      db,
      timedRow.vendorId,
      await resolveVendorOwnerManagerUserId(db, actor, timedRow),
    );
    if (rejected) return NextResponse.json({ error: "Forbidden: vendor not available to this manager." }, { status: 403 });
    // Single-row upserts also serve both create and edit; `existing` (fetched
    // above) being null means a genuinely new row → notify the resident.
    const persisted = recordForActor(actor, timedRow, vendorUserId, existing);
    preserveServerDispatch(persisted.row_data, existing);
    if (!(await persistRecord(persisted, existing))) return NextResponse.json({ error: "The request changed; please retry." }, { status: 409 });
    if (!existing) {
      await emitCreatedWorkOrder(db, actor, timedRow, persisted.manager_user_id);
    }
    maybePrepareDispatch(existing, timedRow.id);
    maybeOfferToPreferredVendor(existing, persisted);
    await maybeNotifyVendorAssigned(existing, persisted);
    maybeNotifyAutoBookedVisit(autoTimeOutcome, persisted.manager_user_id, persisted.row_data);
    await maybeSyncWorkOrderGoogleCalendar(existing, persisted);
    return NextResponse.json({ ok: true, row: persisted.row_data });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save work order.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
