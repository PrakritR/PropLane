import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { VendorPayoutStatus } from "@/lib/vendor-payouts";

export const runtime = "nodejs";

/** Returns the signed-in vendor's own payout history, most recent first. */
export async function GET() {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }

    const db = createSupabaseServiceRoleClient();
    const { data, error } = await db
      .from("vendor_payouts")
      .select("id, work_order_id, amount_cents, stripe_transfer_id, status, failure_reason, created_at, updated_at")
      .eq("vendor_user_id", access.actor.userId)
      .order("created_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const payouts = (data ?? []).map((row) => ({
      id: row.id as string,
      workOrderId: row.work_order_id as string,
      amountCents: row.amount_cents as number,
      stripeTransferId: (row.stripe_transfer_id as string | null) ?? null,
      status: row.status as VendorPayoutStatus,
      failureReason: (row.failure_reason as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: (row.updated_at as string | null) ?? null,
    }));

    return NextResponse.json({ payouts });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load payouts.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
