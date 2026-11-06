import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { NextResponse } from "next/server";

import { assertGoogleCalendarProviderAllowed } from "@/lib/google-calendar/api.server";
import { resolvePendingGoogleCalendarChange } from "@/lib/google-calendar/proplane-calendar-reconcile.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  if (!(await userHoldsManagerRole(db, user.id))) return null;
  return { db, userId: user.id };
}

/** Body: `{ action: "accept" | "dismiss" }`. See `proplane-calendar-reconcile.server.ts`. */
export async function POST(req: Request, routeCtx: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await assertGoogleCalendarProviderAllowed(ctx.db, ctx.userId, "pending_changes_resolve");
    const { id } = await routeCtx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== "accept" && body.action !== "dismiss") {
      return NextResponse.json({ error: "action must be \"accept\" or \"dismiss\"." }, { status: 400 });
    }
    const result = await resolvePendingGoogleCalendarChange(ctx.db, ctx.userId, id, body.action);
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
