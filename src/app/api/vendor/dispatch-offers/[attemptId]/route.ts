import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { answerVendorDispatchOffer } from "@/lib/vendor-dispatch/vendor-offers.server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ attemptId: string }> };

const MESSAGE: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: "That offer is gone." },
  expired: { status: 409, error: "That offer ran out of time." },
  already_answered: { status: 409, error: "That job was already answered or taken." },
  unavailable: { status: 503, error: "Offers are not available right now." },
};

/** Accept or decline one offer. The vendor is the session; the attempt must be on their own roster record. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const access = await resolveVendorPortalUserId();
    if (!access.ok) return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    const { attemptId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { answer?: unknown } | null;
    if (body?.answer !== "accept" && body?.answer !== "decline") {
      return NextResponse.json({ error: "Accept or decline." }, { status: 400 });
    }
    const result = await answerVendorDispatchOffer(createSupabaseServiceRoleClient(), {
      vendorUserId: access.userId,
      attemptId,
      answer: body.answer,
    });
    if (!result.ok) {
      const failure = MESSAGE[result.reason]!;
      return NextResponse.json({ error: failure.error }, { status: failure.status });
    }
    return NextResponse.json({ ok: true, status: result.status });
  } catch {
    return NextResponse.json({ error: "Could not save your answer." }, { status: 500 });
  }
}
