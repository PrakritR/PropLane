import { NextResponse } from "next/server";

import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { normalizeE164 } from "@/lib/phone-e164";
import { rateLimit } from "@/lib/rate-limit";
import {
  bookGuestStays,
  listGuestStays,
  loadGuestBookableListing,
  type GuestBookBody,
} from "@/lib/short-stay/guest-stays.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** The signed-in resident, from the session only. Nothing in a request body names who is asking. */
async function requireResident() {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("email, phone, role").eq("id", user.id).maybeSingle();
  if (!(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) return null;
  return {
    db,
    userId: user.id,
    email: String(profile?.email ?? user.email ?? "").trim().toLowerCase(),
    phone: normalizeE164(String(profile?.phone ?? "")) ?? "",
  };
}

/**
 * The guest's own stays (`stays`), or - with `?propertyId=` - what the Book again sheet needs for that
 * house: its bookable rooms and whether this guest would be confirmed at once.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireResident();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim();
    if (propertyId) {
      const listing = await loadGuestBookableListing(ctx.db, { propertyId, userId: ctx.userId, email: ctx.email, phone: ctx.phone });
      if (!listing) return NextResponse.json({ error: "This home doesn't take short stays." }, { status: 404, headers: NO_STORE });
      return NextResponse.json({ listing }, { headers: NO_STORE });
    }
    return NextResponse.json({ stays: await listGuestStays(ctx.db, { userId: ctx.userId }) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Could not load your stays." }, { status: 500, headers: NO_STORE });
  }
}

/** Books one or several date ranges; `dryRun: true` checks them and writes nothing. */
export async function POST(req: Request) {
  try {
    const ctx = await requireResident();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    let body: GuestBookBody;
    try {
      body = (await req.json()) as GuestBookBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
    }
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body." }, { status: 400, headers: NO_STORE });
    const dryRun = body.dryRun === true;
    const allowed = await rateLimit(`resident-stays:${dryRun ? "check" : "book"}:${ctx.userId}`, dryRun ? 120 : 20, 3_600_000);
    if (!allowed.ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: NO_STORE });
    }
    const result = await bookGuestStays(ctx.db, { userId: ctx.userId, body });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
    // Every range refused: say why with the status of the first (a race is a 409), keep the per-range detail.
    const refused = result.results.length > 0 && result.results.every((r) => r.outcome === "unavailable" || r.outcome === "invalid");
    if (refused) {
      const first = result.results[0]!;
      return NextResponse.json(
        { error: first.error ?? "Those dates aren't available.", ...result },
        { status: first.outcome === "unavailable" ? 409 : 400, headers: NO_STORE },
      );
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Could not save your booking." }, { status: 500, headers: NO_STORE });
  }
}
