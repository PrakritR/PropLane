/**
 * What the signed-in applicant must complete BEFORE the application form opens for a listing: the manager's
 * requirements (Verify ID, Background check), the applicant's progress through them, the exact total they would pay and
 * the FCRA disclosure to authorize first. Read-only; every amount is recomputed from the server catalog and every
 * fact is re-derived from the session and the stored listing, never trusted from the client.
 */
import { NextResponse } from "next/server";

import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import {
  FCRA_AUTHORIZATION_LABEL,
  FCRA_DISCLOSURE_TEXT,
  FCRA_DISCLOSURE_VERSION,
} from "@/lib/screening/applicant-screening";
import { loadPreApplyContext, resolvePreApplyView } from "@/lib/screening/preapply.server";
import type { PreApplyApiView } from "@/lib/screening/preapply-view";
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
    if (!(await rateLimit(`preapply-status:${user.id}:${clientIpFrom(req)}`, 60, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }
    const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim();
    if (!propertyId) return NextResponse.json({ error: "propertyId is required." }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const ctx = await loadPreApplyContext(db, user, propertyId);
    if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    const resolved = await resolvePreApplyView(db, ctx);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    const { state, plan, orderAllowed } = resolved.view;

    const body: PreApplyApiView = {
      required: state.required,
      satisfied: state.satisfied,
      steps: state.steps,
      next: state.next,
      provider: plan.verifyId.provider,
      quote: plan.order && orderAllowed ? plan.order.quote : null,
      orderAllowed,
      disclosure: {
        version: FCRA_DISCLOSURE_VERSION,
        text: FCRA_DISCLOSURE_TEXT,
        authorizationLabel: FCRA_AUTHORIZATION_LABEL,
      },
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Application requirements are unavailable." }, { status: 500 });
  }
}
