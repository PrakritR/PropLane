import { NextResponse } from "next/server";
import { earningsCsv } from "@/lib/managed-finance/earnings";
import { hasAnyEarningsShare, loadMyEarnings, loadMyEarningsRows } from "@/lib/managed-finance/earnings.server";
import { financeErrorResponse, requireEarningsPerson, stripeOrNull } from "@/lib/managed-finance/routes.server";

export const runtime = "nodejs";

/**
 * GET: the signed-in person's own Earnings: balance (available / pending), upcoming, paid, the monthly report and the per-house
 * breakdown. `?format=csv[&month=YYYY-MM]` is the same report as a download. Whose balance is never a parameter.
 */
export async function GET(req: Request) {
  const ctx = await requireEarningsPerson();
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  try {
    // `?probe=1`: only whether this person has an Earnings page at all (the tab's one question), so drawing Finances never
    // pays for the whole view.
    if (url.searchParams.get("probe") === "1") {
      return NextResponse.json({ hasShare: await hasAnyEarningsShare(ctx.db, ctx.userId) }, { headers: { "cache-control": "private, no-store" } });
    }
    if (url.searchParams.get("format") === "csv") {
      const raw = url.searchParams.get("month");
      const month = raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : null;
      const csv = earningsCsv(await loadMyEarningsRows(ctx.db, ctx.userId, month));
      return new NextResponse(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="proplane-earnings-${month ?? "last-12-months"}.csv"`,
          "cache-control": "private, no-store",
        },
      });
    }
    const view = await loadMyEarnings(ctx.db, stripeOrNull(), ctx.userId);
    return NextResponse.json(view, { headers: { "cache-control": "private, no-store" } });
  } catch (e) {
    return financeErrorResponse(e, "Could not load your earnings.");
  }
}
