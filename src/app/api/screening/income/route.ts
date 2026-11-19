import { NextResponse } from "next/server";
import { authorizeIncomeActor, incomeCheckOffered, loadIncomeVerification } from "@/lib/plaid/income.server";
import { plaidEnabled } from "@/lib/plaid/client.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Does this listing offer the Plaid income check to the signed-in applicant, and do they already have a verified
 * figure? Disabled Plaid, a guest (no session) and a listing whose setting is off all answer `offered: false`, so the
 * screen draws nothing. The figure here is read back for display only; it is stamped onto the application by the write.
 */
export async function GET(req: Request) {
  const none = NextResponse.json({ offered: false, verified: null }, { headers: NO_STORE });
  try {
    if (!plaidEnabled()) return none;
    const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim() ?? "";
    if (!propertyId) return none;
    const actor = await authorizeIncomeActor();
    if (!actor.ok) return none;
    if (!(await incomeCheckOffered(actor.db, propertyId))) return none;
    const verified = await loadIncomeVerification(actor.db, actor.userId, propertyId);
    return NextResponse.json(
      { offered: true, verified: verified ? { monthlyIncomeCents: verified.monthlyIncomeCents, months: verified.months } : null },
      { headers: NO_STORE },
    );
  } catch {
    return none;
  }
}
