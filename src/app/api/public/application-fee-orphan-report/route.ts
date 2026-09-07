import { NextResponse } from "next/server";

import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { reportOrphanedApplicationFeePayment } from "@/lib/report-orphaned-application-fee.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = {
  sessionId?: string;
  expectedEmail?: string;
};

/**
 * Guest apply path: Stripe succeeded but finalize submit failed.
 * Re-verifies the Checkout session, ensures a paid fee charge, notifies the manager.
 */
export async function POST(req: Request) {
  if (!(await rateLimit(`application-fee-orphan-report:${clientIpFrom(req)}`, 10, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const expectedEmail = typeof body.expectedEmail === "string" ? body.expectedEmail.trim() : "";

  try {
    const db = createSupabaseServiceRoleClient();
    const result = await reportOrphanedApplicationFeePayment(db, { sessionId, expectedEmail });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({
      ok: true,
      notified: result.notified,
      chargeId: result.chargeId,
      reason: result.reason ?? null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to report orphaned payment.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
