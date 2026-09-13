import { vendorCatalogProjection } from "@/lib/vendor-catalog-projection";
import { NextResponse } from "next/server";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { isVendorCategorySettingsRow, managerVendorCategorySettingsRowId } from "@/lib/manager-vendors-storage";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

async function sessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

function normalizeRow(row: ManagerVendorRow, managerUserId: string): ManagerVendorRow {
  // Tolerate partial/legacy rows missing optional string fields — a single
  // vendor row without `trade`/`phone`/`email`/`notes` must never 500 the
  // whole list (shared rows from other managers can be sparse).
  return {
    ...row,
    id: (row.id ?? "").trim(),
    managerUserId,
    name: (row.name ?? "").trim(),
    trade: (row.trade ?? "").trim(),
    phone: (row.phone ?? "").trim(),
    email: (row.email ?? "").trim().toLowerCase(),
    notes: (row.notes ?? "").trim(),
    active: row.active !== false,
    sharedWithManagers: row.sharedWithManagers === true,
    propertyIds: Array.isArray(row.propertyIds) ? row.propertyIds : undefined,
    updatedAt: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const catalogMode = url.searchParams.get("catalog") === "1";
    const catalogQuery = url.searchParams.get("q")?.trim() ?? "";

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();

    if (!admin && role !== "manager" && role !== "pro") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    if (catalogMode) {
      let query = db
        .from("manager_vendor_records")
        .select("row_data, manager_user_id")
        .neq("manager_user_id", user.id)
        .eq("row_data->>sharedWithManagers", "true")
        .order("updated_at", { ascending: false })
        .limit(100);
      if (catalogQuery) {
        query = query.ilike("row_data->>name", `%${catalogQuery}%`);
      }
      const { data, error } = await query;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const rows = (data ?? [])
        .map((record) => {
          const row = record.row_data as ManagerVendorRow | null;
          if (!row?.id || row.name === "__vendor_category_settings__") return null;
          return vendorCatalogProjection(row, record.manager_user_id);
        })
        .filter(Boolean) as ManagerVendorRow[];
      return NextResponse.json({ rows });
    }

    let query = db
      .from("manager_vendor_records")
      .select("row_data, manager_user_id, updated_at")
      .order("updated_at", { ascending: false })
      .limit(500);

    if (!admin) {
      query = query.eq("manager_user_id", user.id);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const ownRows = (data ?? [])
      .map((record) => {
        const row = record.row_data as ManagerVendorRow | null;
        if (!row?.id || isVendorCategorySettingsRow(row)) return null;
        return normalizeRow(row, String(record.manager_user_id ?? user.id));
      })
      .filter((row): row is ManagerVendorRow => row !== null);

    // Co-manager access: the vendor directory is owner-keyed (no property
    // column), so include every linked owner's rows when this user has the
    // "services" module on at least one of that owner's assigned properties.
    let linkedOwnerRows: ManagerVendorRow[] = [];
    if (!admin) {
      const { ownerIds } = await linkedOwnerScopeForModule(db, user.id, "services");
      ownerIds.delete(user.id);
      if (ownerIds.size > 0) {
        const { data: linkedData, error: linkedError } = await db
          .from("manager_vendor_records")
          .select("row_data, manager_user_id")
          .in("manager_user_id", [...ownerIds])
          .order("updated_at", { ascending: false })
          .limit(500);
        if (linkedError) return NextResponse.json({ error: linkedError.message }, { status: 500 });
        linkedOwnerRows = (linkedData ?? [])
          .map((record) => {
            const row = record.row_data as ManagerVendorRow | null;
            if (!row?.id || isVendorCategorySettingsRow(row)) return null;
            const ownerId = record.manager_user_id;
            if (!ownerId) return null;
            return normalizeRow(row, ownerId);
          })
          .filter((row): row is ManagerVendorRow => row !== null);
      }
    }

    let sharedRows: ManagerVendorRow[] = [];
    if (!admin) {
      const { data: sharedData, error: sharedError } = await db
        .from("manager_vendor_records")
        .select("row_data, manager_user_id")
        .neq("manager_user_id", user.id)
        .eq("row_data->>sharedWithManagers", "true")
        .order("updated_at", { ascending: false })
        .limit(200);
      if (sharedError) return NextResponse.json({ error: sharedError.message }, { status: 500 });
      sharedRows = (sharedData ?? [])
        .map((record) => {
          const row = record.row_data as ManagerVendorRow | null;
          if (!row?.id || row.name === "__vendor_category_settings__") return null;
          const ownerId = record.manager_user_id;
          if (!ownerId) return null;
          return vendorCatalogProjection(row, ownerId);
        })
        .filter((row): row is ManagerVendorRow => row !== null);
    }

    const seen = new Set<string>();
    const rows = [...ownRows, ...linkedOwnerRows, ...sharedRows].filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
    return NextResponse.json({ rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load vendors.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
    const admin = await isAdminUser(user.id);

    if (!admin && role !== "manager" && role !== "pro") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = (await req.json()) as {
      action?: "upsert" | "delete" | "replace";
      id?: string;
      row?: ManagerVendorRow;
      rows?: ManagerVendorRow[];
    };

    const managerUserId = user.id;

    // The directory is owner-keyed. A property supplied in a vendor body is
    // never a grant on that vendor: derive services access from accepted links
    // belonging to its stored owner and properties that owner still owns.
    const sourceRows = (body.action === "replace" ? (Array.isArray(body.rows) ? body.rows : []) : body.row ? [body.row] : [])
      .filter((row) => typeof row?.id === "string" && row.id.trim())
      .map((row) => ({ ...row, id: isVendorCategorySettingsRow(row) ? managerVendorCategorySettingsRowId(managerUserId) : row.id.trim() }));
    const vendorOwnerById = new Map<string, string | null>();
    const ids = [...new Set(sourceRows.map((row) => row.id))];
    if (ids.length > 0) {
      const { data: existing, error: existingError } = await db.from("manager_vendor_records").select("id, manager_user_id").in("id", ids);
      if (existingError) return NextResponse.json({ error: "Could not verify vendor ownership." }, { status: 503 });
      for (const r of existing ?? []) {
        vendorOwnerById.set(String(r.id), r.manager_user_id ? String(r.manager_user_id) : null);
      }
    }
    let servicesScope: Awaited<ReturnType<typeof linkedOwnerScopeForModule>> | undefined;
    const editableOwners = new Map<string, boolean>();
    const mayWriteVendor = async (row: ManagerVendorRow): Promise<{ ok: boolean; owner: string }> => {
      if (!vendorOwnerById.has(row.id)) return { ok: true, owner: managerUserId };
      const owner = vendorOwnerById.get(row.id);
      // Existing ownerless rows are not unclaimed ids available for takeover.
      if (!owner) return { ok: false, owner: managerUserId };
      if (admin || owner === managerUserId) return { ok: true, owner };
      if (!editableOwners.has(owner)) {
        servicesScope ??= await linkedOwnerScopeForModule(db, managerUserId, "services", "edit", { throwOnError: true });
        const propertyIds = [...(servicesScope.propertyIdsByOwner.get(owner) ?? [])];
        let allowed = false;
        if (propertyIds.length > 0) {
          const { data: current, error: currentError } = await db.from("manager_property_records").select("id")
            .eq("manager_user_id", owner).in("id", propertyIds).limit(1);
          if (currentError) throw currentError;
          allowed = Boolean(current?.length);
        }
        editableOwners.set(owner, allowed);
      }
      return { ok: editableOwners.get(owner) === true, owner };
    };

    if (body.action === "delete") {
      const id = body.id?.trim();
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      let query = db.from("manager_vendor_records").delete().eq("id", id);
      if (!admin) query = query.eq("manager_user_id", managerUserId);
      const { error } = await query;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    if (body.action !== "replace" && sourceRows.length === 0) return NextResponse.json({ error: "row required" }, { status: 400 });
    const authorizedRows: ManagerVendorRow[] = [];
    for (const raw of sourceRows) {
      const gate = await mayWriteVendor(raw);
      if (!gate.ok) return NextResponse.json({ error: "Cannot edit another manager's vendor." }, { status: 403 });
      authorizedRows.push(normalizeRow(raw, gate.owner));
    }
    for (const row of authorizedRows) {
      const record = { id: row.id, manager_user_id: row.managerUserId, row_data: row, updated_at: new Date().toISOString() };
      // Never upsert after a read: a concurrent insert/transfer must conflict,
      // not overwrite or re-own someone else's record.
      const write = vendorOwnerById.has(row.id)
        ? db.from("manager_vendor_records").update(record).eq("id", row.id).eq("manager_user_id", row.managerUserId)
        : db.from("manager_vendor_records").insert(record);
      const { data: saved, error } = await write.select("id").maybeSingle();
      if (error) return NextResponse.json({ error: error.code === "23505" ? "Vendor changed. Refresh and try again." : "Could not save vendor." }, { status: error.code === "23505" ? 409 : 500 });
      if (!saved) return NextResponse.json({ error: "Vendor ownership changed. Refresh and try again." }, { status: 409 });
      vendorOwnerById.set(row.id, row.managerUserId);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save vendor.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
