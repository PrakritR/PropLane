import { NextResponse } from "next/server";
import { plaidFailure } from "@/lib/plaid/client.server";
import { authorizeIncomeActor, createIncomeLinkToken, incomeCheckOffered } from "@/lib/plaid/income.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/** Link token for the applicant income check. The user is the session user; the listing must offer the check. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { propertyId?: unknown };
    const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    const actor = await authorizeIncomeActor();
    if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status, headers: NO_STORE });
    const limit = await rateLimit(`plaid-income-link:${actor.userId}:${clientIpFrom(req)}`, 10, 10 * 60_000);
    if (!limit.ok) return NextResponse.json({ error: "Try again in a few minutes." }, { status: 429, headers: NO_STORE });
    if (!(await incomeCheckOffered(actor.db, propertyId))) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ linkToken: await createIncomeLinkToken(actor.userId) }, { headers: NO_STORE });
  } catch (error) {
    console.warn("[plaid] income link token failed", plaidFailure(error).code);
    return NextResponse.json({ error: "Couldn't reach your bank." }, { status: 502, headers: NO_STORE });
  }
}
