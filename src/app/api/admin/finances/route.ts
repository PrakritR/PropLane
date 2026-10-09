import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { loadPlatformPnl } from "@/lib/admin/platform-pnl.server";

export const runtime = "nodejs";

/**
 * GET /api/admin/finances — the twelve-month profit and loss: Stripe revenue and fees (cached five
 * minutes) and the expense table. Admin-only. When Stripe cannot be read the response says so
 * (`revenueAvailable: false`) rather than reporting zero revenue.
 */
export async function GET() {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json(await loadPlatformPnl(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("GET /api/admin/finances failed", error);
    return NextResponse.json({ error: "Could not load finances." }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
