import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveOwnedVendor } from "@/lib/work-order-vendor.server";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

export const runtime = "nodejs";

/**
 * N006: an ordered preferred-vendor list per (property, trade). Read/write
 * scoped strictly to the authenticated manager's own rows — `manager_user_id`
 * is never taken from the request body, and every write re-derives ownership
 * of both the property and the vendor id server-side (never trusts a
 * client-supplied id), mirroring `resolveOwnedVendor`'s use across the rest
 * of the vendor/work-order surface.
 */
export type ManagerVendorPreferenceRow = {
  id: string;
  propertyId: string;
  trade: string;
  vendorId: string;
  priority: number;
};

function mapRow(row: Record<string, unknown>): ManagerVendorPreferenceRow {
  return {
    id: String(row.id),
    propertyId: String(row.property_id ?? ""),
    trade: String(row.trade ?? ""),
    vendorId: String(row.vendor_id ?? ""),
    priority: Number(row.priority ?? 0),
  };
}

async function requireManager() {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return { ok: false as const, status: 401 as const, error: "Unauthorized." };
  if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
    return { ok: false as const, status: 403 as const, error: "Forbidden." };
  }
  return { ok: true as const, managerUserId: ctx.user.id };
}

export async function GET(req: Request) {
  const auth = await requireManager();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const db = createSupabaseServiceRoleClient();
  const url = new URL(req.url);
  const propertyId = url.searchParams.get("propertyId")?.trim();
  const trade = url.searchParams.get("trade")?.trim();
  const vendorId = url.searchParams.get("vendorId")?.trim();

  let query = db
    .from("manager_vendor_preferences")
    .select("id, property_id, trade, vendor_id, priority")
    .eq("manager_user_id", auth.managerUserId)
    .order("priority", { ascending: true });
  if (propertyId) query = query.eq("property_id", propertyId);
  if (trade) query = query.eq("trade", trade);
  if (vendorId) query = query.eq("vendor_id", vendorId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: (data ?? []).map(mapRow) });
}

export async function POST(req: Request) {
  const auth = await requireManager();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as
    | { propertyId?: string; trade?: string; vendorId?: string; priority?: number }
    | null;
  const propertyId = body?.propertyId?.trim();
  const trade = body?.trade?.trim();
  const vendorId = body?.vendorId?.trim();
  const priority = Number.isFinite(body?.priority) ? Math.trunc(body!.priority as number) : 0;
  if (!propertyId || !trade || !vendorId) {
    return NextResponse.json({ error: "propertyId, trade, and vendorId are required." }, { status: 400 });
  }
  if (!VENDOR_TRADE_OPTIONS.includes(trade as (typeof VENDOR_TRADE_OPTIONS)[number])) {
    return NextResponse.json({ error: "Unrecognized trade." }, { status: 400 });
  }

  const db = createSupabaseServiceRoleClient();

  // Re-derive vendor ownership server-side — never trust the client's vendorId
  // beyond using it to look up the row this manager is actually allowed to use.
  const { vendor, rejected } = await resolveOwnedVendor(db, vendorId, auth.managerUserId);
  if (rejected || !vendor) {
    return NextResponse.json({ error: "That vendor is not in this workspace's vendor directory." }, { status: 404 });
  }

  // Re-derive property ownership — a synthetic/local-only property id (no
  // `manager_property_records` row, e.g. a browser-store extra listing) is
  // still accepted here the same way every other property_id column in this
  // schema does (portal_work_order_records, manager_application_records):
  // there is no single authoritative property table to check against.
  const { error: upsertError } = await db.from("manager_vendor_preferences").upsert(
    {
      manager_user_id: auth.managerUserId,
      property_id: propertyId,
      trade,
      vendor_id: vendorId,
      priority,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id,property_id,trade,vendor_id" },
  );
  if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const auth = await requireManager();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  const id = body?.id?.trim();
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const db = createSupabaseServiceRoleClient();
  const { error } = await db
    .from("manager_vendor_preferences")
    .delete()
    .eq("id", id)
    .eq("manager_user_id", auth.managerUserId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
