import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isAdminUser } from "@/lib/auth/admin-preview";
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
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
    if (!admin && role !== "manager" && role !== "pro") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as { vendorUserId?: string } | null;
    const vendorUserId = body?.vendorUserId?.trim();
    if (!vendorUserId) return NextResponse.json({ error: "vendorUserId required." }, { status: 400 });

    const managerUserId = user.id;

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
