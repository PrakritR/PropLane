import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { readPhoneVendorTextStatus, readRosterVendorTextStatus } from "@/lib/manager-sms-send.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Does texting this roster vendor still need the manager's "I work with this
 * vendor" attestation? Read-only; the send route re-derives all of it. The modal
 * shows the box (and the exact identification line) only when this says so.
 */
export async function GET(req: Request) {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
    return NextResponse.json({ error: "Manager access required." }, { status: 403 });
  }
  const params = new URL(req.url).searchParams;
  const vendorRecordId = params.get("vendorRecordId")?.trim() ?? "";
  const phone = params.get("phone")?.trim() ?? "";
  if (!vendorRecordId && phone) {
    // A number typed into Send to phone: no roster row is needed to know whether the first text needs the box.
    const byPhone = await readPhoneVendorTextStatus(createSupabaseServiceRoleClient(), { actorUserId: ctx.user.id, phone });
    return NextResponse.json(byPhone.body, { status: byPhone.status, headers: { "Cache-Control": "private, no-store" } });
  }
  if (!vendorRecordId) return NextResponse.json({ error: "Choose a vendor." }, { status: 400 });
  const result = await readRosterVendorTextStatus(createSupabaseServiceRoleClient(), {
    actorUserId: ctx.user.id,
    vendorRecordId,
  });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
}
