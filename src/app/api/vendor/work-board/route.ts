import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { listBoardServices, requestBoardJob, type BoardChoice } from "@/lib/service-work-board.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

const CHOICES: readonly BoardChoice[] = ["estimate", "bid", "message"];

async function vendorOr401() {
  const access = await requireVendorApiAccess();
  if (!access.ok) return { error: NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status }) };
  const db = createSupabaseServiceRoleClient();
  // Signed-in vendors only (Decide #1): the board is never a public page.
  if ((await resolveAuthenticatedBusinessAccess(access.actor.userId, db)).kind !== "normal") {
    return { error: NextResponse.json({ error: "Forbidden." }, { status: 403 }) };
  }
  return { actor: access.actor, db };
}

/** Find work: published services this vendor's trade and service area cover, as the public allowlist view. */
export async function GET(req: Request) {
  const ctx = await vendorOr401();
  if (ctx.error) return ctx.error;
  const url = new URL(req.url);
  const radius = Number(url.searchParams.get("radiusMi") ?? "");
  const result = await listBoardServices(ctx.db, ctx.actor.userId, {
    trade: url.searchParams.get("trade") ?? undefined,
    radiusMi: Number.isFinite(radius) && radius > 0 ? radius : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ services: result.services }, { headers: { "Cache-Control": "private, no-store" } });
}

/** Request a published job: the offer a manager's own Send job would make, then the existing flow. */
export async function POST(req: Request) {
  const ctx = await vendorOr401();
  if (ctx.error) return ctx.error;
  const body = (await req.json().catch(() => ({}))) as { ref?: string; choice?: string };
  try {
    const result = await requestBoardJob(
      ctx.db,
      { userId: ctx.actor.userId, role: "vendor" },
      { ref: typeof body.ref === "string" ? body.ref : "", choice: CHOICES.find((c) => c === body.choice) },
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, workOrderId: result.workOrderId, choice: result.choice });
  } catch {
    return NextResponse.json({ error: "Could not request this job." }, { status: 500 });
  }
}
