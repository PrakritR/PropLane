import { NextResponse } from "next/server";

import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { checkApplicationFeeManualPayment } from "@/lib/resident-check-manual-payment.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = {
  propertyId?: string;
  residentEmail?: string;
  channel?: "zelle" | "venmo" | "other";
  /** True when a manager waiver code already covered the application fee — only the holding deposit (if any) is checked. */
  feeWaived?: boolean;
  residentName?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    const residentEmail = typeof body.residentEmail === "string" ? body.residentEmail.trim() : "";
    const channel = body.channel;
    if (channel !== "zelle" && channel !== "venmo" && channel !== "other") {
      return NextResponse.json({ error: "channel must be zelle, venmo, or other." }, { status: 400 });
    }

    // This route is deliberately reachable without a session — the apply wizard
    // calls it before the applicant has an account. It was the only route under
    // `api/public/` with no limiter, which mattered more here than elsewhere:
    // the email below is taken from the body and, when no session exists, is
    // NOT bound to the caller (see the note on the session check that follows),
    // so an unthrottled caller could walk an address list.
    if (!rateLimit(`application-fee-check-payment:${clientIpFrom(req)}`, 10, 60_000).ok) {
      return NextResponse.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    // NOTE (known gap, needs a product decision — do not mistake this for a
    // complete check): the email match below runs only when a session exists.
    // An UNAUTHENTICATED caller therefore supplies `residentEmail` freely, and
    // `checkApplicationFeeManualPayment` does not re-derive ownership — so it
    // can read another applicant's fee charge, or cause one to be created on a
    // manager's account for an address of its choosing.
    //
    // Closing it properly needs an apply-session token bound to the address
    // (the wizard has no identity for a pre-account applicant today, which is
    // why this route is anonymous at all). That is a design change, not a
    // patch, so the limiter above is the interim mitigation.
    let residentUserId: string | null = null;
    try {
      const auth = await createSupabaseServerClient();
      const {
        data: { user },
      } = await auth.auth.getUser();
      residentUserId = user?.id ?? null;
      if (user?.email && residentEmail && user.email.trim().toLowerCase() !== residentEmail.toLowerCase()) {
        return NextResponse.json({ error: "Email does not match your signed-in account." }, { status: 403 });
      }
    } catch {
      residentUserId = null;
    }

    const db = createSupabaseServiceRoleClient();
    const result = await checkApplicationFeeManualPayment(db, {
      propertyId,
      residentEmail,
      residentUserId,
      feeWaived: body.feeWaived === true,
      residentName: typeof body.residentName === "string" ? body.residentName.trim() : undefined,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    if (!result.paid) {
      return NextResponse.json({ paid: false, message: result.message });
    }

    return NextResponse.json({ paid: true, charges: result.charges });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to check payment.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
