import { NextResponse } from "next/server";

import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import {
  createLeaseSigningFeeCheckout,
  leaseSigningFeeReturnUrl,
} from "@/lib/lease-signing-fee-checkout.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { getStripe } from "@/lib/stripe";
import { stripeNotConfiguredError } from "@/lib/stripe-axis-ach-checkout";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Resident: start embedded Stripe Checkout for the lease signing fee.
 * Body: `{ leaseId, managerUserId, propertyId? }`.
 */
export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`lease-signing-fee-checkout:${clientIpFrom(req)}`, 20, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.id || !user.email) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const db = createSupabaseServiceRoleClient();
    const roleOk = await authorizeResidentRole(db, { userId: user.id, legacyRole: null });
    if (!roleOk) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const leaseId = typeof body.leaseId === "string" ? body.leaseId.trim() : "";
    const managerUserId = typeof body.managerUserId === "string" ? body.managerUserId.trim() : "";
    const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : null;
    if (!leaseId || !managerUserId) {
      return NextResponse.json({ error: "leaseId and managerUserId are required." }, { status: 400 });
    }

    const stripe = getStripe();
    const result = await createLeaseSigningFeeCheckout(db, stripe, {
      leaseId,
      managerUserId,
      propertyId,
      residentUserId: user.id,
      residentEmail: user.email,
      returnUrl: leaseSigningFeeReturnUrl(req, leaseId),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({
      clientSecret: result.clientSecret,
      sessionId: result.sessionId,
      feeCents: result.feeCents,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    if (stripeNotConfiguredError(message)) {
      return NextResponse.json({ error: "Payments are not configured." }, { status: 503 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
