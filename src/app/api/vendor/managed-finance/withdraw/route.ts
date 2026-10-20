import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { financeErrorResponse } from "@/lib/managed-finance/routes.server";
import { withdrawFromManagedFunds } from "@/lib/managed-finance/withdrawals.server";

export const runtime = "nodejs";

/** POST { amountCents, clientKey }: the vendor withdraws available PropLane-held funds to their own Express account. */
export async function POST(req: Request) {
  const who = await resolveVendorPortalUserId();
  if (!who.ok) return NextResponse.json({ error: who.status === 401 ? "Unauthorized." : "Forbidden." }, { status: who.status });
  let body: { amountCents?: unknown; clientKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const result = await withdrawFromManagedFunds(getStripe(), createSupabaseServiceRoleClient(), {
      kind: "vendor",
      userId: who.userId,
      amountCents: typeof body.amountCents === "number" ? body.amountCents : NaN,
      clientKey: typeof body.clientKey === "string" ? body.clientKey.slice(0, 80) : undefined,
    });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    return NextResponse.json({
      ok: true,
      withdrawalId: result.withdrawalId,
      payoutPending: result.payoutPending,
      payoutAutomatic: result.payoutAutomatic === true,
      payoutScheduleUnknown: result.payoutScheduleUnknown === true,
    });
  } catch (e) {
    return financeErrorResponse(e, "Could not start the withdrawal.");
  }
}
