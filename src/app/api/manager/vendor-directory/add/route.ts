import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

export const runtime = "nodejs";

/**
 * "Add to my vendors" for a directory-listed self-serve vendor. Unlike
 * `ensureCatalogVendorOnRoster` (which only copies curated catalog fields
 * onto a fresh roster row, never touching `vendor_user_id`), this sets the
 * real DB link so the vendor sees the new manager immediately — mirroring
 * what invite redemption does in `provision-vendor-account.ts`. Idempotent:
 * a second call for the same manager+vendor returns the existing row.
 */
export async function POST(req: Request) {
  try {
    const ctx = await getPortalAccessContext();
    if (!ctx.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    // Same canonical multi-role-safe check as the GET route above — never
    // `profiles.role` (legacy/singular) or `user_metadata.role` (client-writable).
    if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const db = createSupabaseServiceRoleClient();
    const body = (await req.json().catch(() => null)) as { vendorUserId?: string } | null;
    const vendorUserId = body?.vendorUserId?.trim();
    if (!vendorUserId) return NextResponse.json({ error: "vendorUserId required." }, { status: 400 });

    // The vendor directory is owner-keyed with no property column, so there is
    // no per-property `linkedOwnerForProperty` to attribute this to — mirrors
    // `POST /api/portal-vendors`'s "replace"/insert path, where a genuinely
    // NEW roster row is always owned by the authenticated caller's own id, not
    // a co-manager's linked owner (co-manager access to an owner's EXISTING
    // vendor rows is a read-scope concern only, resolved client-side via
    // `linkedOwnerScopeForModule` when listing `/api/portal-vendors`).
    const managerUserId = ctx.user.id;

    const { data: existing } = await db
      .from("manager_vendor_records")
      .select("id, row_data")
      .eq("manager_user_id", managerUserId)
      .eq("vendor_user_id", vendorUserId)
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ row: existing.row_data as ManagerVendorRow, existing: true });
    }

    const { data: directoryRow, error: directoryError } = await db
      .from("vendor_business_profiles")
      .select("business_name, work_email, work_phone, trades, directory_listed, onboarding_completed_at")
      .eq("user_id", vendorUserId)
      .maybeSingle();
    if (directoryError) return NextResponse.json({ error: directoryError.message }, { status: 500 });
    if (!directoryRow || directoryRow.directory_listed !== true || !directoryRow.onboarding_completed_at) {
      return NextResponse.json({ error: "That vendor is not listed in the directory." }, { status: 404 });
    }

    const trades = Array.isArray(directoryRow.trades) ? (directoryRow.trades as string[]) : [];
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const row: ManagerVendorRow = {
      id,
      managerUserId,
      name: (directoryRow.business_name as string | null)?.trim() || "PropLane vendor",
      trade: trades[0] ?? "",
      trades: trades.length ? trades : undefined,
      phone: (directoryRow.work_phone as string | null)?.trim() || "",
      email: (directoryRow.work_email as string | null)?.trim() || "",
      notes: "",
      active: true,
      catalogId: `self-serve-${vendorUserId}`,
      vendorUserId,
      createdAt: now,
      updatedAt: now,
    };

    const { error: insertError } = await db
      .from("manager_vendor_records")
      .insert({ id, manager_user_id: managerUserId, vendor_user_id: vendorUserId, row_data: row, updated_at: now });
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

    return NextResponse.json({ row, existing: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not add vendor.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
