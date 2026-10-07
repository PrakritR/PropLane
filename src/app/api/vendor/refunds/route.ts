import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { vendorBankingEnabled, vendorRefundsEnabled } from "@/lib/vendor-banking/flag";
import { listVendorRefundsForDisplay } from "@/lib/vendor-banking/central-refund.server";

export const runtime = "nodejs";

/** The signed-in vendor's refund requests (Finances -> Refunds). Scoped by `vendor_user_id = auth.uid()`. */
export async function GET() {
  if (!vendorBankingEnabled()) return NextResponse.json({ error: "Vendor banking is not enabled." }, { status: 404 });
  const access = await requireVendorApiAccess();
  if (!access.ok) {
    return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
  }
  try {
    const refunds = await listVendorRefundsForDisplay(createSupabaseServiceRoleClient(), access.actor.userId);
    return NextResponse.json({ enabled: vendorRefundsEnabled(), refunds });
  } catch (e) {
    console.error("[vendor/refunds GET]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not load refunds." }, { status: 500 });
  }
}
