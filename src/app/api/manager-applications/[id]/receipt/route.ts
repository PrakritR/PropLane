import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { applicationPaymentReceipt } from "@/lib/application-payment-receipt";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await ctx.params;
    const id = rawId?.trim();
    if (!id) return NextResponse.json({ error: "Application id required." }, { status: 400 });
    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    const { data: application, error: applicationError } = await db.from("manager_application_records")
      .select("id,manager_user_id,property_id,assigned_property_id,resident_email")
      .eq("id", id).maybeSingle();
    if (applicationError) throw new Error(applicationError.message);
    if (!application) return NextResponse.json({ error: "Application not found." }, { status: 404 });
    if (!(await isAdminUser(user.id)) && !(await managerCanAccessApplicationRecord(db, user.id, application))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const managerUserId = String(application.manager_user_id ?? "").trim();
    const propertyId = String(application.property_id ?? "").trim();
    const residentEmail = String(application.resident_email ?? "").trim().toLowerCase();
    if (!managerUserId || !propertyId || !residentEmail) {
      return NextResponse.json({ receipt: { status: "needs_review" } });
    }
    const [claimResult, chargesResult] = await Promise.all([
      db.from("application_fee_payment_claims")
        .select("application_id,manager_user_id,property_id,resident_email,charge_id,status,promotion_status,stripe_session_id,principal_cents,payer_total_cents")
        .eq("application_id", id).maybeSingle(),
      db.from("portal_household_charge_records")
        .select("id,status,row_data")
        .eq("manager_user_id", managerUserId).eq("property_id", propertyId)
        .eq("resident_email", residentEmail).eq("kind", "application_fee").limit(201),
    ]);
    if (claimResult.error) throw new Error(claimResult.error.message);
    if (chargesResult.error) throw new Error(chargesResult.error.message);
    const rows = chargesResult.data ?? [];
    const exactCharges = rows.filter((row) => (row.row_data as { applicationId?: unknown } | null)?.applicationId === id);
    const ambiguousLegacyCharges = rows.filter((row) =>
      ["paid", "processing", "partially_paid", "refunded"].includes(String(row.status ?? "")) &&
      !(row.row_data as { applicationId?: unknown } | null)?.applicationId);
    const sourceId = claimResult.data?.charge_id ?? exactCharges[0]?.id;
    let payments: Array<{ manager_user_id: string | null; amount_cents: number; stripe_checkout_session_id?: string | null }> = [];
    let refunds: typeof payments = [];
    let ledgerOverflow = false;
    if (sourceId) {
      const { data, error } = await db.from("ledger_entries")
        .select("entry_type,manager_user_id,amount_cents,stripe_checkout_session_id")
        .eq("source_charge_id", sourceId).in("entry_type", ["payment", "refund"]).limit(101);
      if (error) throw new Error(error.message);
      ledgerOverflow = (data ?? []).length > 100;
      payments = (data ?? []).filter((row) => row.entry_type === "payment");
      refunds = (data ?? []).filter((row) => row.entry_type === "refund");
    }
    const receipt = applicationPaymentReceipt({
      applicationId: id, managerUserId, propertyId, residentEmail,
      claim: claimResult.data, exactCharges, ambiguousLegacyCharges, payments, refunds,
      overflow: rows.length > 200 || ledgerOverflow,
    });
    return NextResponse.json({ receipt }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[application receipt] read failed", error);
    return NextResponse.json({ error: "Could not load application payment." }, { status: 500 });
  }
}
