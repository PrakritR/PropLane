/**
 * What the signed-in applicant is offered for their own application: the checks the listing turned on, the exact
 * total they would pay, and the FCRA disclosure they must authorize first. Read-only; the amount is recomputed from
 * the server catalog every time and never trusted from the client.
 */
import { NextResponse } from "next/server";

import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { loadApplicantScreeningContext } from "@/lib/screening/applicant-screening-access.server";
import { resolveApplicantScreeningView } from "@/lib/screening/applicant-offer.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (!(await rateLimit(`applicant-screening-quote:${clientIpFrom(req)}`, 60, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }
    const applicationId = new URL(req.url).searchParams.get("applicationId")?.trim();
    if (!applicationId) return NextResponse.json({ error: "applicationId is required." }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const ctx = await loadApplicantScreeningContext(db, user, applicationId);
    if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    const view = await resolveApplicantScreeningView(db, ctx);
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Screening is unavailable." }, { status: 500 });
  }
}
