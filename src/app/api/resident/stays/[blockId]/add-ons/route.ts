import { NextResponse } from "next/server";

import { resolveAppOrigin } from "@/lib/app-url";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { rateLimit } from "@/lib/rate-limit";
import {
  StayAddOnReadError,
  loadGuestStayForAddOns,
  quoteStayAddOns,
  requestStayAddOn,
} from "@/lib/short-stay/stay-add-ons.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

type RouteContext = { params: Promise<{ blockId: string }> };

/** The signed-in resident, from the session only. Nothing in the path or body names who is asking. */
async function requireResident() {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) return null;
  return { db, userId: user.id };
}

/**
 * One of the guest's own stays: its standard and current times and what early check-in / late checkout
 * could be added, at the property's own price. A stay that is not this login's is a 404.
 */
export async function GET(_req: Request, context: RouteContext) {
  try {
    const ctx = await requireResident();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    const { blockId } = await context.params;
    const stay = await loadGuestStayForAddOns(ctx.db, { blockId, userId: ctx.userId });
    if (!stay) return NextResponse.json({ error: "Stay not found." }, { status: 404, headers: NO_STORE });
    return NextResponse.json(
      {
        stay: {
          id: stay.blockId,
          checkIn: stay.stay.checkIn,
          checkOut: stay.stay.checkOut,
          checkInTime: stay.stay.checkInTime,
          checkOutTime: stay.stay.checkOutTime,
          estimatedArrival: typeof (stay.row.stayDetails as { estimatedArrival?: unknown } | undefined)?.estimatedArrival === "string"
            ? (stay.row.stayDetails as { estimatedArrival: string }).estimatedArrival
            : null,
          status: stay.bookingStatus,
        },
        rows: quoteStayAddOns(stay),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof StayAddOnReadError) {
      return NextResponse.json({ error: "We couldn't check the calendar right now. Try again in a minute." }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Could not load this stay." }, { status: 500, headers: NO_STORE });
  }
}

/**
 * Asks for early check-in or late checkout on one of the guest's own stays. The body is `{ kind, time? }` and
 * nothing else: who (the session), which stay's owner and the price (the property's stored settings) are all
 * re-derived. Answers the charge to pay and its checkout link; a hold answers `requested` (no charge yet).
 */
export async function POST(req: Request, context: RouteContext) {
  try {
    const ctx = await requireResident();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    let body: { kind?: unknown; time?: unknown };
    try {
      body = (await req.json()) as { kind?: unknown; time?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
    }
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body." }, { status: 400, headers: NO_STORE });
    const allowed = await rateLimit(`resident-stay-add-on:${ctx.userId}`, 20, 3_600_000);
    if (!allowed.ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: NO_STORE });
    }
    const { blockId } = await context.params;
    const result = await requestStayAddOn(ctx.db, {
      blockId,
      userId: ctx.userId,
      kind: body.kind,
      time: body.time,
      appOrigin: resolveAppOrigin(req),
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
    const { ok: _ok, ...rest } = result;
    void _ok;
    return NextResponse.json(rest, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Could not save that." }, { status: 500, headers: NO_STORE });
  }
}
