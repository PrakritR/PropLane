import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import { validateVendorW9Input } from "@/lib/vendor-banking/tax";
import { readVendorTaxYears, readVendorW9, saveVendorW9, vendorHasTinOnFile } from "@/lib/vendor-banking/tax.server";

export const runtime = "nodejs";

/** The signed-in vendor's own W-9 (TIN masked to its last four) and per-year earnings. Scoped to the session user, never a body id. */
export async function GET() {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }
    const db = createSupabaseServiceRoleClient();
    const [profile, years] = await Promise.all([
      readVendorW9(db, access.actor.userId),
      readVendorTaxYears(db, access.actor.userId),
    ]);
    return NextResponse.json({ profile, years, currentYear: new Date().getUTCFullYear() });
  } catch (e) {
    return stripePayoutErrorResponse("vendor/finances/tax GET", e);
  }
}

/** Saves the vendor's one W-9. The TIN is encrypted before it is stored and is never echoed back. */
export async function PUT(req: Request) {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }
    const body = await req.json().catch(() => null);
    const db = createSupabaseServiceRoleClient();
    const hasTinOnFile = await vendorHasTinOnFile(db, access.actor.userId);
    const validated = validateVendorW9Input(body, { hasTinOnFile });
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 422 });

    if (validated.value.tin && !process.env.FINANCIALS_TIN_ENCRYPTION_KEY?.trim()) {
      // Fail closed: never store a tax ID we cannot encrypt.
      return NextResponse.json({ error: "Tax info is temporarily unavailable. Try again later." }, { status: 503 });
    }
    const profile = await saveVendorW9(db, access.actor.userId, validated.value);
    return NextResponse.json({ profile });
  } catch (e) {
    return stripePayoutErrorResponse("vendor/finances/tax PUT", e);
  }
}
