import { NextResponse } from "next/server";

import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { parseCheckInKey, recordResidentCheckIn } from "@/lib/check-in-event.server";
import { loadStayCheckIn } from "@/lib/check-in.server";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** The signed-in resident or guest, from the session only. Nothing in a request names who is asking. */
async function requireResident() {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
  if (!(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) return null;
  return { db, userId: user.id, email: String(profile?.email ?? user.email ?? "").trim().toLowerCase() };
}

/**
 * A short-stay guest's Check-in guide for ONE of their own stays (`?stay=<blockId>`). The codes are
 * in the answer only after the reveal moment (`checkInReveal`): before it, every code is `null`.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireResident();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    const blockId = new URL(req.url).searchParams.get("stay")?.trim() ?? "";
    if (!blockId) return NextResponse.json({ error: "Name the stay." }, { status: 400, headers: NO_STORE });
    const stay = await loadStayCheckIn(ctx.db, ctx.userId, blockId);
    // Someone else's stay, a hold and a cancelled stay are all the same answer.
    if (!stay) return NextResponse.json({ error: "Stay not found." }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ guide: stay.guide }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Could not load check-in." }, { status: 500, headers: NO_STORE });
  }
}

/** "I'm in": stamps the check-in once and tells the manager once. Idempotent. */
export async function POST(req: Request) {
  try {
    const ctx = await requireResident();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    let body: { key?: unknown };
    try {
      body = (await req.json()) as { key?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
    }
    const key = parseCheckInKey(body?.key);
    if (!key) return NextResponse.json({ error: "Invalid check-in." }, { status: 400, headers: NO_STORE });
    const allowed = await rateLimit(`resident-check-in:${ctx.userId}`, 30, 3_600_000);
    if (!allowed.ok) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: NO_STORE });
    const result = await recordResidentCheckIn(ctx.db, { userId: ctx.userId, email: ctx.email, key });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
    return NextResponse.json(
      { ok: true, checkedInAt: result.checkedInAt, alreadyCheckedIn: result.alreadyCheckedIn },
      { headers: NO_STORE },
    );
  } catch {
    return NextResponse.json({ error: "Could not save your check-in." }, { status: 500, headers: NO_STORE });
  }
}
