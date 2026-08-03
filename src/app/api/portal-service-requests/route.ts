import { NextResponse } from "next/server";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { fetchRowsForManagerWithLinked, linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { resolveResidentScopedActorRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveResidentFilingScope } from "@/lib/resident-manager-scope";
import {
  repairServiceRequestScopesForManager,
  shouldRunScopeRepair,
} from "@/lib/repair-service-request-scopes.server";
import { notifyManagerOfResidentFiledItem } from "@/lib/work-order-notification.server";

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
    resident_email: residentEmail || null,
    property_id: propertyId || null,
    status: normalized.status || null,
    row_data: normalized,
    updated_at: new Date().toISOString(),
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

    // Managers/pro see the requests they own plus rows on properties they own
    // or share via co-manager services access — catches mis-stamped manager_user_id
    // as long as property_id is correct.
    if (!admin && role !== "resident") {
      // Heal orphans for this manager's residents before listing (wrong/empty
      // manager_user_id on older client-mirrored rows). TTL-gated so nav-count
      // polls and repeat page loads don't re-run the per-resident sweep.
      if (shouldRunScopeRepair(`service-requests:${user.id}`)) {
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
      const records = await fetchRowsForManagerWithLinked<ServiceRequestScopeRecord>(
        db,
        "portal_service_request_records",
        user.id,
        linkedPropertyIds,
        { propertyColumns: ["property_id"] },
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

    // Residents see only their own requests; admins see all.
    if (!admin && role === "resident") {
      query = query.eq("resident_email", email);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    let rows = (data ?? []).map((record) => record.row_data).filter(Boolean) as ServiceRequest[];

    // Resident load: re-stamp any of their rows that lost manager/property so
    // the matching manager portal can pick them up on next sync.
    if (!admin && role === "resident" && email) {
      const healed: ServiceRequest[] = [];
      const scopeCache = new Map<
        string,
        Promise<{ managerUserId: string; propertyId: string } | null>
      >();
      const resolveScopeCached = (row: ServiceRequest) => {
        const key = `${row.managerUserId?.trim() ?? ""}|${row.propertyId?.trim() ?? ""}`;
        let pending = scopeCache.get(key);
        if (!pending) {
          pending = resolveResidentFilingScope(db, {
            residentEmail: email,
            claimedManagerUserId: row.managerUserId,
            claimedPropertyId: row.propertyId,
          }).catch(() => null);
          scopeCache.set(key, pending);
        }
        return pending;
      };
      for (const row of rows) {
        const scope = await resolveScopeCached(row);
        if (!scope) {
          healed.push(row);
          continue;
        }
        const needsHeal =
          row.managerUserId?.trim() !== scope.managerUserId ||
          (!row.propertyId?.trim() && Boolean(scope.propertyId));
        if (!needsHeal) {
          healed.push(row);
          continue;
        }
        const next: ServiceRequest = {
          ...row,
          managerUserId: scope.managerUserId,
          propertyId: row.propertyId?.trim() || scope.propertyId,
          residentEmail: email,
        };
        const record = recordFromRow(next);
        await db.from("portal_service_request_records").upsert(record, { onConflict: "id" });
        healed.push(next);
      }
      rows = healed;
    }

    return NextResponse.json({ rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load add-on service requests.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type Actor = { userId: string; email: string; admin: boolean };

/** A caller may write/delete a row only if they own it: the manager it belongs
 * to, or the resident it is for. Admins may act on any row. */
function actorOwnsRecord(
  actor: Actor,
  rec: { manager_user_id?: string | null; resident_email?: string | null } | null,
): boolean {
  if (actor.admin) return true;
  if (!rec) return false;
  if (rec.manager_user_id && rec.manager_user_id === actor.userId) return true;
  if (rec.resident_email && actor.email && rec.resident_email.trim().toLowerCase() === actor.email) return true;
  return false;
}

/**
 * Bind the scope columns to the authenticated caller so a client cannot spoof
 * ownership: a manager's writes are pinned to their own id; a resident's writes
 * are pinned to their own email. Manager/property for residents are server-
 * resolved from residency records, not trusted from the client alone.
 */
function recordForActor(actor: Actor, role: string, row: ServiceRequest) {
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
    const admin = await isAdminUser(user.id);
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const role = await resolveResidentScopedActorRole(db, {
      userId: user.id,
      legacyRole: profile?.role ?? user.user_metadata?.role,
    });
    const actor: Actor = {
      userId: user.id,
      email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
      admin,
    };

    const body = (await req.json()) as {
      action?: "upsert" | "delete" | "replace";
      id?: string;
      row?: ServiceRequest;
      rows?: ServiceRequest[];
    };

    const ownsExisting = async (id: string): Promise<boolean> => {
      const { data } = await db
        .from("portal_service_request_records")
        .select("manager_user_id, resident_email")
        .eq("id", id)
        .maybeSingle();
      // A brand-new id (no existing row) is allowed to be created.
      return data == null || actorOwnsRecord(actor, data);
    };

    /** Stamp manager + property from residency; reject if resident has no scope. */
    const stampResidentRow = async (row: ServiceRequest): Promise<ServiceRequest | null> => {
      if (actor.admin || role !== "resident") return row;
      const scope = await resolveResidentFilingScope(db, {
        residentEmail: actor.email,
        claimedManagerUserId: row.managerUserId,
        claimedPropertyId: row.propertyId,
      });
      if (!scope) return null;
      return {
        ...row,
        managerUserId: scope.managerUserId,
        propertyId: scope.propertyId || row.propertyId?.trim() || "",
        residentEmail: actor.email || row.residentEmail,
      };
    };

    if (body.action === "replace") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      for (const row of rows) {
        if (!row?.id) continue;
        if (!(await ownsExisting(row.id))) continue;
        const stamped = await stampResidentRow(row);
        if (!stamped) continue;
        await db.from("portal_service_request_records").upsert(recordForActor(actor, role, stamped), { onConflict: "id" });
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === "delete") {
      const id = body.id?.trim();
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { data: existing } = await db
        .from("portal_service_request_records")
        .select("manager_user_id, resident_email")
        .eq("id", id)
        .maybeSingle();
      if (!existing) return NextResponse.json({ ok: true });
      if (!actorOwnsRecord(actor, existing)) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const { error } = await db.from("portal_service_request_records").delete().eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    if (!body.row?.id) return NextResponse.json({ error: "row required" }, { status: 400 });
    if (!(await ownsExisting(body.row.id))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const stamped = await stampResidentRow(body.row);
    if (!stamped) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    // The client mirrors both creates and edits through this same single-row
    // upsert, so a genuinely new submission (vs an update) is detected with an
    // existence check BEFORE the write — only brand-new rows notify.
    const { data: preExisting } = await db
      .from("portal_service_request_records")
      .select("id")
      .eq("id", body.row.id)
      .maybeSingle();
    const record = recordForActor(actor, role, stamped);
    const { error } = await db
      .from("portal_service_request_records")
      .upsert(record, { onConflict: "id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const managerUserId = record.manager_user_id;
    if (!preExisting && !actor.admin && role === "resident" && managerUserId) {
      // New resident-submitted request → Axis inbox + email + SMS to manager.
      const title = stamped.offerName?.trim() || "Add-on service";
      const description = stamped.notes?.trim() || stamped.offerDescription?.trim();
      await notifyManagerOfResidentFiledItem(db, {
        kind: "service-request",
        senderUserId: actor.userId,
        senderEmail: actor.email,
        senderName: stamped.residentName?.trim() || undefined,
        managerUserId,
        title,
        description: description || undefined,
      }).catch(() => undefined);
    }
    return NextResponse.json({ ok: true, row: record.row_data });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save add-on service request.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
