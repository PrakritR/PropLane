import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { resolveRatingDispute } from "@/lib/resident-ratings/ratings.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** PropLane staff close a rating dispute: `{ action: "keep" }` clears the "Disputed" mark, `{ action: "remove" }` deletes the rating. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminRoute();
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action === "remove" ? "remove" : body?.action === "keep" ? "keep" : null;
  if (!action) return NextResponse.json({ error: "action must be keep or remove." }, { status: 400 });
  const result = await resolveRatingDispute(createSupabaseServiceRoleClient(), id ?? "", action);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
