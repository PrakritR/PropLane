import { NextResponse } from "next/server";
import { resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { redeemApplicationFeeWaiverCode } from "@/lib/application-fee-waiver";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = {
  propertyId?: string;
  managerUserId?: string;
  residentEmail?: string;
  applicationId?: string;
  code?: string;
};

/**
 * Validates AND atomically redeems a manager's application-fee waiver code
 * for one applicant, server-side only. This is the ONLY path that consumes a
 * code — there is no client-side check to bypass. `managerUserId` is
 * verified against the property's real stored owner (never trusted blindly),
 * so a code can never be redeemed against a property it doesn't belong to.
 * Rate-limited per IP to slow down code-guessing.
 */
export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`application-fee-waiver:${clientIpFrom(req)}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const body = (await req.json()) as Body;
    const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    const managerUserId = typeof body.managerUserId === "string" ? body.managerUserId.trim() : "";
    const residentEmail = typeof body.residentEmail === "string" ? body.residentEmail.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";

    if (!propertyId || !managerUserId || !residentEmail.includes("@") || !code) {
      return NextResponse.json(
        { error: "propertyId, managerUserId, residentEmail, and code are required." },
        { status: 400 },
      );
    }

    const db = createSupabaseServiceRoleClient();

    // Re-verify the property is really owned by this manager (the same guard
    // the checkout route applies) before touching that manager's codes.
    const resolved = await resolveApplicationFeeProperty(db, { propertyId, managerUserId });
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
    }

    const result = await redeemApplicationFeeWaiverCode(db, {
      managerUserId,
      propertyId,
      residentEmail,
      applicationId: applicationId || null,
      code,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.reason }, { status: 400 });
    }

    return NextResponse.json({ ok: true, waived: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not apply that code.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
