import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { acceptGigOffer, declineGigOffer, loadGigByCode, openGigLinesFor } from "@/lib/jobs/gig-offers.server";
import { runListOpenJobsNear } from "@/lib/tools/domains/vendor-line";
import { buildVendorLineContext } from "@/lib/tools/vendor-line-context";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

async function vendorOr401() {
  const access = await requireVendorApiAccess();
  if (!access.ok) return { error: NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status }) };
  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(access.actor.userId, db)).kind !== "normal") {
    return { error: NextResponse.json({ error: "Forbidden." }, { status: 403 }) };
  }
  return { actor: access.actor, db };
}

/** "Open jobs near you": the priced PropLane jobs the vendor's trade and service area cover, general area only. */
export async function GET() {
  const ctx = await vendorOr401();
  if (ctx.error) return ctx.error;
  try {
    const vendorCtx = buildVendorLineContext(ctx.db, { landlordId: "", senderPhone: "", vendorUserId: ctx.actor.userId });
    const listed = await runListOpenJobsNear(vendorCtx, {}, { includeRefs: true, limit: 25 });
    const { lines } = await openGigLinesFor(ctx.db, listed.jobs);
    return NextResponse.json({ gigs: lines.map(({ code, kindLabel, area, when, pays }) => ({ code, kind: kindLabel, area, when, pays })) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load jobs." }, { status: 500 });
  }
}

/** Take (or pass on) a priced job at its offered price: the same submitted bid a YES reply files. */
export async function POST(req: Request) {
  const ctx = await vendorOr401();
  if (ctx.error) return ctx.error;
  const body = (await req.json().catch(() => ({}))) as { code?: unknown; action?: unknown };
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{4}$/.test(code)) return NextResponse.json({ error: "Unknown job." }, { status: 404 });
  try {
    if (body.action === "decline") {
      const gig = await loadGigByCode(ctx.db, code);
      if (gig) await declineGigOffer(ctx.db, { vendorUserId: ctx.actor.userId, gigId: gig.id });
      return NextResponse.json({ ok: true });
    }
    const result = await acceptGigOffer(ctx.db, { vendorUserId: ctx.actor.userId, code, channel: "portal" });
    if (result.ok) return NextResponse.json({ ok: true, already: result.already });
    const status = result.reason === "not_found" || result.reason === "closed" ? 404 : result.reason === "rate_limited" ? 429 : result.reason === "full" ? 409 : result.reason === "not_a_vendor" ? 403 : 500;
    return NextResponse.json({ error: result.reason === "full" ? "Enough vendors have taken this one." : result.reason === "closed" || result.reason === "not_found" ? "This job is taken or closed." : "Could not take this job." }, { status });
  } catch {
    return NextResponse.json({ error: "Could not take this job." }, { status: 500 });
  }
}
