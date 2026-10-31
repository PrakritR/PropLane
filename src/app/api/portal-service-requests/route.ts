import { residentSubjectHasHouse } from "@/lib/auth/resident-subject-evidence.server";
import { resolveAdminOversight } from "@/lib/auth/admin-oversight.server";
import { NextResponse } from "next/server";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  fetchRowsForManagerWithLinked,
  linkedPropertyIdsForModule,
  resolveManagerWorkspaceRowScope,
  rowInWorkspaceScope,
} from "@/lib/auth/co-manager-module-scope";
import { resolveResidentScopedActorRole } from "@/lib/auth/resident-role-access";
import { isViewAsSessionOpen } from "@/lib/auth/view-as.server";
import { refuseOwnerOnly } from "@/lib/property-owner/route-auth.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { resolveResidentFilingScope } from "@/lib/resident-manager-scope";
import {
  repairServiceRequestScopesForManager,
  shouldRunScopeRepair,
} from "@/lib/repair-service-request-scopes.server";
import { emitServiceRequestTransition } from "@/lib/domain-action-events.server";
import {
  notifyManagerOfResidentFiledItem,
  notifyManagersOfManagerAuthoredItem,
  notifyResidentOfManagerAuthoredItem,
} from "@/lib/work-order-notification.server";

export const runtime = "nodejs";

async function sessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

type ServiceRequestScopeRecord = { id: string; row_data: ServiceRequest | null; updated_at: string | null };

function recordFromRow(row: ServiceRequest) {
  const residentEmail = row.residentEmail?.trim().toLowerCase() || row.residentEmail;
  const managerUserId = row.managerUserId?.trim() || "";
  const propertyId = row.propertyId?.trim() || "";
  const normalized: ServiceRequest = {
    ...row,
    residentEmail: residentEmail || row.residentEmail,
    managerUserId,
    propertyId,
  };
  return {
    id: normalized.id,
    manager_user_id: managerUserId || null,
    resident_user_id: normalized.residentUserId || null,
    resident_email: residentEmail || null,
    property_id: propertyId || null,
    status: normalized.status || null,
    row_data: normalized,
    updated_at: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Test workspace access is unavailable." }, { status: 403 });
    }
    const admin = await isAdminUser(user.id);
    // The all-owners read is admin oversight: asked for with `?oversight=admin` AND confirmed by the
    // role. An admin in their own manager portal reads exactly what a manager does.
    const oversight = await resolveAdminOversight(req, user.id, admin);
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const role = await resolveResidentScopedActorRole(db, {
      userId: user.id,
      legacyRole: profile?.role,
    });
    if (role === "denied" && !oversight) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

    // Managers/pro see the requests they own plus rows on properties they own
    // or share via co-manager services access — catches mis-stamped manager_user_id
    // as long as property_id is correct.
    if (!oversight && role !== "resident") {
      // A manager surface: the shared owner-only seam is asked before any manager read or write.
      const ownerRefusal = await refuseOwnerOnly(db, user.id);
      if (ownerRefusal) return ownerRefusal;
      // Heal orphans for this manager's residents before listing (wrong/empty
      // manager_user_id on older client-mirrored rows). TTL-gated so nav-count
      // polls and repeat page loads don't re-run the per-resident sweep.
      // (Skipped while an operator is viewing as this account: a read-only session writes nothing.)
      if (shouldRunScopeRepair(`service-requests:${user.id}`) && !(await isViewAsSessionOpen())) {
        await repairServiceRequestScopesForManager(db, user.id).catch(() => undefined);
      }

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
      // Owned rows AND the co-manager fan-out both live inside this one call,
      // so narrowing it to the active workspace is the whole GET scope fix.
      const workspaceScope = await resolveManagerWorkspaceRowScope(db, user.id);
      const records = await fetchRowsForManagerWithLinked<ServiceRequestScopeRecord>(
        db,
        "portal_service_request_records",
        user.id,
        linkedPropertyIds,
        { propertyColumns: ["property_id"], workspaceScope },
      );
      const rows = records
        .sort((a, b) => {
          const aTs = Date.parse(String(a.updated_at ?? ""));
          const bTs = Date.parse(String(b.updated_at ?? ""));
          return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
        })
        .map((record) => record.row_data)
        .filter(Boolean) as ServiceRequest[];
      return NextResponse.json({ rows });
    }

    let query = db
      .from("portal_service_request_records")
      .select("row_data, updated_at")
      .order("updated_at", { ascending: false })
      .limit(500);

    // Residents see only their own requests; admin oversight sees all.
    if (!oversight && role === "resident") {
      query = query.eq("resident_user_id", user.id);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? []).map((record) => record.row_data).filter(Boolean) as ServiceRequest[];

    return NextResponse.json({ rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load add-on service requests.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type Actor = { userId: string; email: string; admin: boolean; role: string };

/** A caller may write/delete a row only if they own it: the manager it belongs
 * to, or the resident it is for. Admins may act on any row. */
function actorOwnsRecord(
  actor: Actor,
  rec: { resident_user_id?: string | null; manager_user_id?: string | null; resident_email?: string | null; row_data?: { residentUserId?: string | null } | null } | null,
): boolean {
  if (actor.admin) return true;
  if (!rec) return false;
  if (actor.role === "manager" && rec.manager_user_id && rec.manager_user_id === actor.userId) return true;
  if (rec.resident_user_id === actor.userId) return true;
  return false;
}

/**
 * Bind the scope columns to the authenticated caller so a client cannot spoof
 * ownership: a manager's writes are pinned to their own id; a resident's writes
 * are pinned to their own email. Manager/property for residents are server-
 * resolved from residency records, not trusted from the client alone.
 */
function recordForActor(actor: Actor, role: string, row: ServiceRequest, storedSubject: string | null) {
  row = { ...row, residentUserId: role === "resident" && !actor.admin ? actor.userId : storedSubject };
  if (actor.admin) return recordFromRow(row);
  if (role === "resident") {
    const pinned: ServiceRequest = {
      ...row,
      residentEmail: actor.email || row.residentEmail,
    };
    return recordFromRow(pinned);
  }
  // Any other non-admin caller is treated as the owning manager — never trust a
  // client-supplied manager_user_id for a non-resident. Keep row_data in sync
  // with the column so client filters that key on managerUserId stay correct.
  const pinned: ServiceRequest = {
    ...row,
    managerUserId: actor.userId,
  };
  return recordFromRow(pinned);
}

export async function POST(req: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Test workspace access is unavailable." }, { status: 403 });
    }
    // Writing with every owner's privileges (trusting the body's `managerUserId`, skipping the
    // ownership and workspace gates) is admin OVERSIGHT, the same explicit surface the read uses:
    // an admin writing from their own manager portal is the manager they are.
    const oversight = await resolveAdminOversight(req, user.id, await isAdminUser(user.id));
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const role = await resolveResidentScopedActorRole(db, {
      userId: user.id,
      legacyRole: profile?.role,
    });
    if (role === "denied" && !oversight) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const actor: Actor = {
      userId: user.id,
      email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
      admin: oversight,
      role,
    };
    const isManagerActor = !oversight && role !== "resident";
    if (isManagerActor) {
      const ownerRefusal = await refuseOwnerOnly(db, user.id);
      if (ownerRefusal) return ownerRefusal;
    }
    // The active workspace refuses a write outside it: a create must land in
    // it, an update/delete must refuse a row outside it. Residents and admins
    // are never narrowed by a manager's workspace.
    const workspaceScope = isManagerActor
      ? await resolveManagerWorkspaceRowScope(db, user.id)
      : { propertyIds: null, untaggedOwnedVisible: true };

    const body = (await req.json()) as {
      action?: "upsert" | "delete" | "replace";
      id?: string;
      row?: ServiceRequest;
      rows?: ServiceRequest[];
    };

    const ownsExisting = async (id: string, candidatePropertyId?: string | null): Promise<boolean> => {
      const { data, error } = await db
        .from("portal_service_request_records")
        .select("manager_user_id, resident_user_id, resident_email, property_id, row_data, row_revision")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error("Could not verify service ownership.");
      // A brand-new id (no existing row) is allowed to be created, subject to
      // the same workspace gate a manager actor's create must land inside.
      if (data == null) {
        return !isManagerActor || rowInWorkspaceScope(candidatePropertyId ?? null, workspaceScope);
      }
      if (!actorOwnsRecord(actor, data)) return false;
      if (isManagerActor && !rowInWorkspaceScope(data.property_id ? String(data.property_id) : null, workspaceScope)) {
        return false;
      }
      return true;
    };

    /** Stamp manager + property from residency; reject if resident has no scope. */
    const stampResidentRow = async (row: ServiceRequest): Promise<ServiceRequest | null> => {
      if (actor.admin || role !== "resident") return row;
      const scope = await resolveResidentFilingScope(db, {
        residentUserId: actor.userId,
        claimedManagerUserId: row.managerUserId,
        claimedPropertyId: row.propertyId,
      });
      if (!scope || !scope.propertyId || !(await residentSubjectHasHouse(db, actor.userId, actor.email, scope.managerUserId, scope.propertyId))) return null;
      return {
        ...row,
        managerUserId: scope.managerUserId,
        propertyId: scope.propertyId || row.propertyId?.trim() || "",
        residentEmail: actor.email || row.residentEmail,
      };
    };

    const saveRow = async (row: ServiceRequest) => {
      const { data: existing, error: readError } = await db.from("portal_service_request_records")
        .select("id,manager_user_id,resident_user_id,resident_email,property_id,row_data,row_revision")
        .eq("id", row.id).maybeSingle();
      if (readError) return null;
      if (existing && (!actorOwnsRecord(actor, existing) || (isManagerActor && !rowInWorkspaceScope(existing.property_id ? String(existing.property_id) : null, workspaceScope)))) return null;
      if (!existing && isManagerActor && !rowInWorkspaceScope(row.propertyId?.trim() || null, workspaceScope)) return null;
      const record = recordForActor(actor, role, row, existing?.resident_user_id ?? null);
      if (!existing) {
        const { error } = await db.from("portal_service_request_records").insert(record);
        return error ? null : { record, existing: null };
      }
      let update = db.from("portal_service_request_records").update(record).eq("id", row.id).eq("row_revision", existing.row_revision);
      if (role === "resident" && !actor.admin) update = update.eq("resident_user_id", actor.userId);
      else if (!actor.admin && existing.manager_user_id) update = update.eq("manager_user_id", existing.manager_user_id);
      const { data, error } = await update.select("id");
      return error || !data?.length ? null : { record, existing };
    };

    if (body.action === "replace") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      for (const row of rows) {
        if (!row?.id) continue;
        if (!(await ownsExisting(row.id, row.propertyId?.trim() || null))) continue;
        const stamped = await stampResidentRow(row);
        if (!stamped) continue;
        if (!(await saveRow(stamped))) return NextResponse.json({ error: "The request changed; please retry." }, { status: 409 });
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === "delete") {
      const id = body.id?.trim();
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { data: existing, error: readError } = await db
        .from("portal_service_request_records")
        .select("manager_user_id, resident_user_id, resident_email, property_id, row_data, row_revision")
        .eq("id", id)
        .maybeSingle();
      if (readError) return NextResponse.json({ error: "Could not verify the request; please retry." }, { status: 500 });
      if (!existing) return NextResponse.json({ ok: true });
      if (!actorOwnsRecord(actor, existing)) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      if (isManagerActor && !rowInWorkspaceScope(existing.property_id ? String(existing.property_id) : null, workspaceScope)) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      let deletion = db.from("portal_service_request_records").delete().eq("id", id).eq("row_revision", existing.row_revision);
      if (role === "resident" && !actor.admin) deletion = deletion.eq("resident_user_id", actor.userId);
      const { data: deleted, error } = await deletion.select("id");
      if (!error && !deleted?.length) return NextResponse.json({ error: "The request changed; please retry." }, { status: 409 });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    if (!body.row?.id) return NextResponse.json({ error: "row required" }, { status: 400 });
    if (!(await ownsExisting(body.row.id, body.row.propertyId?.trim() || null))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const stamped = await stampResidentRow(body.row);
    if (!stamped) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const saved = await saveRow(stamped);
    if (!saved) return NextResponse.json({ error: "The request changed; please retry." }, { status: 409 });
    const { record, existing: preExisting } = saved;
    const previousStatus = (preExisting?.row_data as ServiceRequest | null | undefined)?.status ?? null;
    const managerUserId = record.manager_user_id;
    if (!preExisting && !actor.admin && managerUserId) {
      const rowData = record.row_data as ServiceRequest;
      const title = stamped.offerName?.trim() || "Add-on service";
      const description = stamped.notes?.trim() || stamped.offerDescription?.trim();
      const propertyId = stamped.propertyId?.trim() || undefined;
      if (role === "resident") {
        await notifyManagerOfResidentFiledItem(db, {
          kind: "service-request",
          senderUserId: actor.userId,
          senderEmail: actor.email,
          senderName: stamped.residentName?.trim() || undefined,
          managerUserId,
          propertyId,
          title,
          description: description || undefined,
        }).catch(() => undefined);
      } else {
        await notifyManagersOfManagerAuthoredItem(db, {
          kind: "service-request",
          senderUserId: actor.userId,
          senderEmail: actor.email,
          ownerManagerUserId: managerUserId,
          propertyId,
          title,
          description: description || undefined,
          residentName: stamped.residentName?.trim() || rowData.residentName?.trim() || undefined,
        }).catch(() => undefined);
        const residentEmail = stamped.residentEmail?.trim().toLowerCase();
        if (residentEmail?.includes("@")) {
          await notifyResidentOfManagerAuthoredItem(db, {
            kind: "service-request",
            senderUserId: actor.userId,
            senderEmail: actor.email,
            residentEmail,
            title,
            description: description || undefined,
          }).catch(() => undefined);
        }
      }
    }
    if (managerUserId && !actor.admin) {
      // The resident's own side of a submission, and BOTH sides of every status
      // change after it — none of which reached anybody before.
      void emitServiceRequestTransition(db, {
        managerUserId,
        previousStatus,
        request: record.row_data as ServiceRequest,
        actor: { userId: actor.userId, email: actor.email },
      }).catch(() => undefined);
    }
    return NextResponse.json({ ok: true, row: record.row_data });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save add-on service request.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
