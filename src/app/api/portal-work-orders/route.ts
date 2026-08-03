import { NextResponse, after } from "next/server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { fetchRowsForManagerWithLinked, linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { resolveResidentScopedActorRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveResidentFilingScope } from "@/lib/resident-manager-scope";
import {
  repairWorkOrderScopesForManager,
  shouldRunScopeRepair,
} from "@/lib/repair-service-request-scopes.server";
import {
  notifyManagerOfResidentFiledItem,
  notifyWorkOrderEvent,
} from "@/lib/work-order-notification.server";
import type { WorkOrderRowWithDispatch } from "@/lib/work-order-dispatch";
import { prepareDispatch } from "@/lib/work-order-dispatch.server";
import {
  syncWorkOrderToGoogleCalendar,
  workOrderGoogleCalendarSyncChanged,
} from "@/lib/google-calendar/sync.server";

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

/** A vendor sees work orders they're currently assigned to (vendor_user_id) plus any
 * they were sent a consultation/quote offer for (work_order_vendor_offers) — several
 * vendors can be offered the same not-yet-assigned work order at once, so this can't
 * rely on the single vendor_user_id column alone. */
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
    if (row) byId.set(record.id as string, row);
  }

  const missingIds = [...offeredIds].filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    const { data: offeredRows } = await db.from("portal_work_order_records").select("id, row_data").in("id", missingIds);
    for (const record of offeredRows ?? []) {
      const row = record.row_data as DemoManagerWorkOrderRow | null;
      if (row) byId.set(record.id as string, row);
    }
  }

  return [...byId.values()];
}

function normalizeRow(row: DemoManagerWorkOrderRow): DemoManagerWorkOrderRow {
  return {
    ...row,
    residentEmail: row.residentEmail?.trim().toLowerCase() || row.residentEmail,
  };
}

export async function GET() {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const role = await resolveResidentScopedActorRole(db, {
      userId: user.id,
      legacyRole: profile?.role ?? user.user_metadata?.role,
    });
    const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();

    if (!admin && role === "vendor") {
      const rows = await vendorScopedWorkOrderRows(db, user.id);
      return NextResponse.json({ rows });
    }

    if (!admin && role !== "resident") {
      // Heal orphans for this manager's residents before listing. TTL-gated so
      // nav-count polls and repeat page loads don't re-run the sweep.
      if (shouldRunScopeRepair(`work-orders:${user.id}`)) {
        await repairWorkOrderScopesForManager(db, user.id).catch(() => undefined);
      }

      // Managers see their own work orders (plus legacy unassigned rows), never
      // other landlords' — and additionally rows on properties they own or share
      // via an accepted co-manager link with services access (covers mis-stamped
      // manager_user_id when property_id is correct).
      const linkedPropertyIds = await linkedPropertyIdsForModule(db, user.id, "services");
      const { data: ownedProps } = await db
        .from("manager_property_records")
        .select("id")
        .eq("manager_user_id", user.id)
        .limit(500);
      for (const prop of ownedProps ?? []) {
        const id = String((prop as { id?: unknown }).id ?? "").trim();
        if (id) linkedPropertyIds.add(id);
      }
      const records = await fetchRowsForManagerWithLinked<WorkOrderScopeRecord>(
        db,
        "portal_work_order_records",
        user.id,
        linkedPropertyIds,
        { propertyColumns: ["property_id", "assigned_property_id"] },
      );
      const byId = new Map<string, WorkOrderScopeRecord>();
      for (const record of records) {
        if (record.id) byId.set(record.id, record);
      }
      // Legacy unassigned rows stay visible to managers (previously included via
      // `manager_user_id.is.null` in the .or filter).
      const { data: legacyRows, error: legacyError } = await db
        .from("portal_work_order_records")
        .select("id, row_data, updated_at")
        .is("manager_user_id", null)
        .order("updated_at", { ascending: false })
        .limit(500);
      if (legacyError) return NextResponse.json({ error: legacyError.message }, { status: 500 });
      for (const record of (legacyRows ?? []) as unknown as WorkOrderScopeRecord[]) {
        if (record.id && !byId.has(record.id)) byId.set(record.id, record);
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

    if (!admin && role === "resident") {
      query = query.eq("resident_email", email);
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

type OwnerCols = { manager_user_id?: string | null; resident_email?: string | null };

/** Whether the caller may write/delete a row. Managers own their own rows and
 * may also claim legacy rows with no owner; residents own rows addressed to
 * them; admins may act on any row. */
function actorOwnsRecord(actor: Actor, rec: OwnerCols | null): boolean {
  if (actor.admin) return true;
  if (!rec) return false;
  if (rec.manager_user_id && rec.manager_user_id === actor.userId) return true;
  if (rec.resident_email && actor.email && rec.resident_email.trim().toLowerCase() === actor.email) return true;
  // Legacy unassigned rows are claimable by a manager (never a resident).
  if (!rec.manager_user_id && actor.role !== "resident") return true;
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
function recordForActor(actor: Actor, row: DemoManagerWorkOrderRow, vendorUserId: string | null) {
  const normalized = normalizeRow(row);
  const withManager: DemoManagerWorkOrderRow =
    actor.admin || actor.role === "resident"
      ? normalized
      : { ...normalized, managerUserId: actor.userId };
  const base = {
    id: withManager.id,
    manager_user_id: withManager.managerUserId || null,
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

/** Best-effort "work order opened" notice to the linked resident. Callers must
 * only invoke this for ids verified NOT to exist before this request's upsert —
 * the manager client mirrors its full local list through POST ("replace") on
 * every change, so newness cannot be inferred from the payload shape alone.
 * Never throws. */
async function notifyResidentOfCreatedWorkOrder(db: Db, actor: Actor, row: DemoManagerWorkOrderRow): Promise<void> {
  // Only manager-authored creations notify: a resident filing their own request
  // would just notify themselves, and admin bulk/preview writes stay silent.
  if (actor.admin || actor.role === "resident") return;
  const residentEmail = row.residentEmail?.trim().toLowerCase();
  if (!residentEmail || !residentEmail.includes("@")) return;
  const title = row.title?.trim() || "Work order";
  await notifyWorkOrderEvent(db, {
    event: "created",
    senderUserId: actor.userId,
    senderEmail: actor.email,
    subject: `Work order opened: ${title}`,
    text:
      row.description?.trim() ||
      `A work order "${title}"${row.propertyName ? ` at ${row.propertyName}` : ""} has been opened.`,
    title,
    propertyLabel: row.propertyName || undefined,
    toEmails: [residentEmail],
    audience: "resident",
  }).catch(() => undefined);
}

/** Resident-filed work order → manager Axis inbox + email + SMS. Never throws. */
async function notifyManagerOfCreatedWorkOrder(
  db: Db,
  actor: Actor,
  row: DemoManagerWorkOrderRow,
  managerUserId: string | null | undefined,
): Promise<void> {
  if (actor.admin || actor.role !== "resident") return;
  const mid = managerUserId?.trim() || row.managerUserId?.trim();
  if (!mid) return;
  const title = row.title?.trim() || "Work order";
  await notifyManagerOfResidentFiledItem(db, {
    kind: "work-order",
    senderUserId: actor.userId,
    senderEmail: actor.email,
    senderName: row.residentName?.trim() || undefined,
    managerUserId: mid,
    title,
    description: row.description?.trim() || undefined,
    propertyLabel: row.propertyName?.trim() || undefined,
  }).catch(() => undefined);
}

export async function POST(req: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const actor: Actor = {
      userId: user.id,
      email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
      admin,
      role: await resolveResidentScopedActorRole(db, {
        userId: user.id,
        legacyRole: profile?.role ?? user.user_metadata?.role,
      }),
    };

    // Vendors see their offered/assigned work through GET; the record itself is
    // manager-authored (assignment, scheduling, billing), so vendor writes are rejected.
    if (!admin && actor.role === "vendor") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = (await req.json()) as {
      action?: "upsert" | "delete" | "replace";
      id?: string;
      row?: DemoManagerWorkOrderRow;
      rows?: DemoManagerWorkOrderRow[];
    };

    type ExistingRecord = OwnerCols & { dispatch?: unknown; row_data?: DemoManagerWorkOrderRow | null };
    const findExisting = async (id: string): Promise<ExistingRecord | null> => {
      const { data } = await db
        .from("portal_work_order_records")
        .select("manager_user_id, resident_email, dispatch:row_data->dispatch, row_data")
        .eq("id", id)
        .maybeSingle();
      return (data as ExistingRecord | null) ?? null;
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

    // Stamp manager + property from residency for residents; reject if none.
    const stampResidentWorkOrder = async (
      row: DemoManagerWorkOrderRow,
    ): Promise<DemoManagerWorkOrderRow | null> => {
      if (actor.admin || actor.role !== "resident") return row;
      const scope = await resolveResidentFilingScope(db, {
        residentEmail: actor.email,
        claimedManagerUserId: row.managerUserId,
        claimedPropertyId: row.propertyId || row.assignedPropertyId,
      });
      if (!scope) return null;
      return {
        ...row,
        managerUserId: scope.managerUserId,
        propertyId: scope.propertyId || row.propertyId || "",
        assignedPropertyId: row.assignedPropertyId || scope.propertyId || undefined,
        residentEmail: actor.email || row.residentEmail,
      };
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
        // A brand-new id (no existing row) may be created.
        if (existing && !actorOwnsRecord(actor, existing)) continue;
        const stamped = await stampResidentWorkOrder(row);
        if (!stamped) continue;
        const { vendorUserId, rejected } = await resolveVendorUserId(
          db,
          stamped.vendorId,
          await resolveVendorOwnerManagerUserId(db, actor, stamped),
        );
        if (rejected) continue;
        const persisted = recordForActor(actor, stamped, vendorUserId);
        preserveServerDispatch(persisted.row_data, existing);
        const { error: upsertError } = await db
          .from("portal_work_order_records")
          .upsert(persisted, { onConflict: "id" });
        if (!upsertError) {
          if (!existing) {
            await notifyResidentOfCreatedWorkOrder(db, actor, stamped);
            await notifyManagerOfCreatedWorkOrder(db, actor, stamped, persisted.manager_user_id);
          }
          maybePrepareDispatch(existing, stamped.id);
          await maybeSyncWorkOrderGoogleCalendar(existing, persisted);
        }
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === "delete") {
      const id = body.id?.trim();
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { data: existing } = await db
        .from("portal_work_order_records")
        .select("manager_user_id, resident_email, row_data")
        .eq("id", id)
        .maybeSingle();
      if (!existing) return NextResponse.json({ ok: true });
      if (!actorOwnsRecord(actor, existing)) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const row = existing.row_data as DemoManagerWorkOrderRow | null;
      const managerUserId = (existing.manager_user_id as string | null) ?? row?.managerUserId ?? null;
      if (row && managerUserId) {
        await syncWorkOrderToGoogleCalendar(db, managerUserId, { ...row, bucket: "completed", scheduledAtIso: undefined }).catch(
          () => undefined,
        );
      }
      const { error } = await db.from("portal_work_order_records").delete().eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    if (!body.row?.id) return NextResponse.json({ error: "row required" }, { status: 400 });
    const existing = await findExisting(body.row.id);
    // A brand-new id (no existing row) may be created.
    if (existing && !actorOwnsRecord(actor, existing)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const stamped = await stampResidentWorkOrder(body.row);
    if (!stamped) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const { vendorUserId, rejected } = await resolveVendorUserId(
      db,
      stamped.vendorId,
      await resolveVendorOwnerManagerUserId(db, actor, stamped),
    );
    if (rejected) return NextResponse.json({ error: "Forbidden: vendor not available to this manager." }, { status: 403 });
    // Single-row upserts also serve both create and edit; `existing` (fetched
    // above) being null means a genuinely new row → notify the resident.
    const persisted = recordForActor(actor, stamped, vendorUserId);
    preserveServerDispatch(persisted.row_data, existing);
    const { error } = await db
      .from("portal_work_order_records")
      .upsert(persisted, { onConflict: "id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!existing) {
      await notifyResidentOfCreatedWorkOrder(db, actor, stamped);
      await notifyManagerOfCreatedWorkOrder(db, actor, stamped, persisted.manager_user_id);
    }
    maybePrepareDispatch(existing, stamped.id);
    await maybeSyncWorkOrderGoogleCalendar(existing, persisted);
    return NextResponse.json({ ok: true, row: persisted.row_data });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save work order.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
