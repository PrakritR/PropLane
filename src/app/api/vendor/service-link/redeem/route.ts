import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { redeemServiceShareLink, type BoardChoice } from "@/lib/service-work-board.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

const CHOICES: readonly BoardChoice[] = ["estimate", "bid", "message"];

/**
 * A signed-in vendor redeems a texted service link: roster row + a `sent` offer, then the existing
 * offer -> bid -> approve flow. A link never creates an account; sign-up / sign-in comes first and
 * the vendor portal calls this once (vendor-work-share-1006).
 */
export async function POST(req: Request) {
  const access = await requireVendorApiAccess();
  if (!access.ok) return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(access.actor.userId, db)).kind !== "normal") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { token?: string; choice?: string };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return NextResponse.json({ error: "This link has expired or is no longer valid." }, { status: 404 });
  const choice = CHOICES.find((c) => c === body.choice);
  try {
    const result = await redeemServiceShareLink(db, { userId: access.actor.userId, role: "vendor" }, { token, choice });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, workOrderId: result.workOrderId, choice: result.choice, alreadyHeld: result.alreadyHeld });
  } catch {
    return NextResponse.json({ error: "Could not open this job." }, { status: 500 });
  }
}
