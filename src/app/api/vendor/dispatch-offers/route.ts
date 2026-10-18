import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { listVendorDispatchOffers } from "@/lib/vendor-dispatch/vendor-offers.server";

export const runtime = "nodejs";

/** The signed-in vendor's own open dispatch offers (general area only until they accept). */
export async function GET() {
  try {
    const access = await resolveVendorPortalUserId();
    if (!access.ok) return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    const result = await listVendorDispatchOffers(createSupabaseServiceRoleClient(), access.userId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
    return NextResponse.json({ offers: result.offers });
  } catch {
    return NextResponse.json({ error: "Could not load offers." }, { status: 500 });
  }
}
