import { NextResponse } from "next/server";
import { logPlaidFailure } from "@/lib/plaid/client.server";
import {
  authorizeIncomeActor,
  computeIncomeFromPublicToken,
  incomeCheckOffered,
  saveIncomeVerification,
} from "@/lib/plaid/income.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Compute the applicant's verified monthly income from the Link public token, entirely on the server. The body carries
 * only the public token and the listing id: no income figure is ever read from it. The figure is stored for the session
 * user and stamped onto the application by the signed-in write; the Plaid Item is removed before this returns.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { publicToken?: unknown; propertyId?: unknown };
    const publicToken = typeof body.publicToken === "string" ? body.publicToken : "";
    const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    if (!publicToken || !propertyId) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
    const actor = await authorizeIncomeActor();
    if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status, headers: NO_STORE });
    const limit = await rateLimit(`plaid-income-verify:${actor.userId}:${clientIpFrom(req)}`, 10, 10 * 60_000);
    if (!limit.ok) return NextResponse.json({ error: "Try again in a few minutes." }, { status: 429, headers: NO_STORE });
    if (!(await incomeCheckOffered(actor.db, propertyId))) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    const result = await computeIncomeFromPublicToken({ publicToken });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
    await saveIncomeVerification(actor.db, { userId: actor.userId, propertyId, verification: result.verification });
    return NextResponse.json(
      { verified: { monthlyIncomeCents: result.verification.monthlyIncomeCents, months: result.verification.months } },
      { headers: NO_STORE },
    );
  } catch (error) {
    logPlaidFailure("[plaid] income verify failed", error);
    return NextResponse.json({ error: "Couldn't reach your bank." }, { status: 502, headers: NO_STORE });
  }
}
