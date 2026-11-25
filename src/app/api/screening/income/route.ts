import { NextResponse } from "next/server";
import { authorizeIncomeActor, incomeCheckOffered, loadIncomeVerification } from "@/lib/plaid/income.server";
import { plaidEnabled } from "@/lib/plaid/client.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { incomeVerifiedPayload } from "@/lib/screening/income-verification";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Does this listing offer the Plaid income check to the signed-in applicant, and do they already have a verified
 * figure? Disabled Plaid, a guest (no session) and a listing whose setting is off all answer `offered: false`, so the
 * screen draws nothing. The figure here is read back for display only; it is stamped onto the application by the write.
 * It carries the whole basis the applicant's line renders, the same shape the verify POST answers with: a narrower
 * projection is how that line came to read "(undefined deposits)" on a reload.
 */
export async function GET(req: Request) {
  const none = NextResponse.json({ offered: false, verified: null }, { headers: NO_STORE });
  try {
    if (!plaidEnabled()) return none;
    const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim() ?? "";
    if (!propertyId) return none;
    const actor = await authorizeIncomeActor();
    if (!actor.ok) return none;
    const limit = await rateLimit(`plaid-income-read:${actor.userId}:${clientIpFrom(req)}`, 30, 10 * 60_000);
    if (!limit.ok) return NextResponse.json({ offered: false, verified: null }, { status: 429, headers: NO_STORE });
    if (!(await incomeCheckOffered(actor.db, propertyId))) return none;
    const verified = await loadIncomeVerification(actor.db, actor.userId, propertyId);
    return NextResponse.json(
      { offered: true, verified: verified ? incomeVerifiedPayload(verified) : null },
      { headers: NO_STORE },
    );
  } catch {
    return none;
  }
}
