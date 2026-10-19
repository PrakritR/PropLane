import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { LedgerError } from "@/lib/managed-finance/ledger.server";
import { gateAndPostManagedVendorBill, VENDOR_CHARGE_DAILY_AUTO_CAP_THRESHOLDS } from "@/lib/managed-finance/vendor-bills.server";

export const runtime = "nodejs";

/**
 * POST { workspaceId, vendorUserId, amountCents, title, propertyId?, chargeKey }: charge a PropLane-managed workspace's owner for
 * work done outside a service record (a tour host fee, a cleaning). Idempotent on `chargeKey`. Only the workspace's own manager
 * (or an admin) may post it; the workspace must have an accepted fee policy; the vendor must be a person on PropLane.
 */
export async function POST(req: Request) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth || (auth.role !== "manager" && auth.role !== "admin")) return NextResponse.json({ error: "Unauthorized." }, { status: auth ? 403 : 401 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const workspaceId = String(body.workspaceId ?? "").trim();
  const vendorUserId = String(body.vendorUserId ?? "").trim();
  const chargeKey = String(body.chargeKey ?? "").trim();
  const amountCents = typeof body.amountCents === "number" ? body.amountCents : NaN;
  const title = String(body.title ?? "").trim().slice(0, 120);
  if (!workspaceId || !vendorUserId || !/^[A-Za-z0-9_-]{8,80}$/.test(chargeKey) || !title) {
    return NextResponse.json({ error: "Choose a vendor, an amount and a title." }, { status: 400 });
  }
  const { data: ws } = await auth.db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
  if (!ws || (auth.role !== "admin" && String((ws as { owner_user_id?: string }).owner_user_id) !== auth.userId)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // A manager never bills their own workspace's owner for themselves, and the target must be a real vendor on THIS workspace's roster.
  if (vendorUserId === auth.userId || vendorUserId === String((ws as { owner_user_id?: string }).owner_user_id)) {
    return NextResponse.json({ error: "Choose a vendor other than yourself." }, { status: 403 });
  }
  const { data: roleRow } = await auth.db.from("profile_roles").select("role").eq("user_id", vendorUserId).eq("role", "vendor").maybeSingle();
  if (!roleRow) return NextResponse.json({ error: "That person is not a vendor." }, { status: 403 });
  const { data: linked } = await auth.db
    .from("manager_vendor_records")
    .select("id")
    .eq("manager_user_id", String((ws as { owner_user_id?: string }).owner_user_id))
    .eq("vendor_user_id", vendorUserId)
    .limit(1);
  if (!Array.isArray(linked) || linked.length === 0) return NextResponse.json({ error: "That vendor is not on this workspace." }, { status: 403 });
  const { data: vendor } = await auth.db.from("profiles").select("full_name, email").eq("id", vendorUserId).maybeSingle();
  if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
  const propertyId = typeof body.propertyId === "string" && body.propertyId.trim() ? body.propertyId.trim() : null;
  try {
    const result = await gateAndPostManagedVendorBill(auth.db, {
      workspaceId, vendorUserId, amountCents, title, propertyId, sourceType: "manual", sourceId: `${workspaceId}:${chargeKey}`,
      vendorLabel: String((vendor as { full_name?: string; email?: string }).full_name || (vendor as { email?: string }).email || "Vendor"),
      jobDate: new Date().toISOString().slice(0, 10),
    }, new Date(), { dailyAutoApproveCapThresholds: VENDOR_CHARGE_DAILY_AUTO_CAP_THRESHOLDS });
    if (result.status === "pending_owner") return NextResponse.json({ status: "pending_owner" }, { status: 202 });
    if (result.status === "declined") return NextResponse.json({ error: "The owner declined this charge.", code: "OWNER_DECLINED" }, { status: 409 });
    return NextResponse.json({ status: "posted" });
  } catch (e) {
    if (e instanceof LedgerError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Could not post the charge." }, { status: 500 });
  }
}
