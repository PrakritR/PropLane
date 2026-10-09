import { NextResponse, type NextRequest } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import {
  currentRevenueMonth,
  loadAdminRevenueMonth,
  loadAdminRevenueRow,
  pageRevenue,
} from "@/lib/admin/admin-revenue.server";
import {
  filterRevenueRows,
  isRevenueMonth,
  revenueRowsToCsv,
  revenueTabFromParam,
  shiftMonth,
  type RevenueFilters,
} from "@/lib/admin/admin-revenue-model";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** `txn_...` (Stripe), `apple:<uuid>` (App Store), `fee:<uuid>` (vendor service-fee ledger). */
const ROW_ID_RE = /^(txn_[A-Za-z0-9_]{4,80}|(apple|fee):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SOURCES = new Set(["all", "stripe", "app_store", "ledger"]);

function failure(reason: "stripe_unavailable" | "stripe_error" | "not_found") {
  if (reason === "not_found") return NextResponse.json({ error: "Payment not found.", code: reason }, { status: 404 });
  if (reason === "stripe_unavailable") {
    return NextResponse.json({ error: "Stripe is not connected.", code: reason }, { status: 503 });
  }
  return NextResponse.json({ error: "Couldn't reach Stripe.", code: reason }, { status: 502 });
}

/**
 * GET /api/admin/revenue - the Money > Payments feed: a month of PropLane's platform Stripe account
 * (balance transactions classified into Subscriptions / Credits / Numbers / Service fees / Payouts /
 * Refunds), the App Store subscriptions and the vendor service-fee ledger, cached five minutes.
 *
 * Query: `month=YYYY-MM` (default this month), `tab`, `q`, `source`, `page`, `pageSize`,
 * `format=csv` (every filtered row, no paging) or `id=<row id>` (one payment record).
 * Admin-only; Stripe errors are logged and never returned.
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireAdminRoute();
    if (!gate.ok) return gate.response;
    const params = request.nextUrl.searchParams;

    const monthParam = params.get("month");
    if (monthParam !== null && !isRevenueMonth(monthParam)) {
      return NextResponse.json({ error: "Invalid month." }, { status: 400 });
    }
    const month = monthParam ?? currentRevenueMonth();
    const db = createSupabaseServiceRoleClient();

    const id = params.get("id");
    if (id !== null) {
      if (!ROW_ID_RE.test(id)) return NextResponse.json({ error: "Invalid payment id." }, { status: 400 });
      const months = monthParam ? [month] : [month, shiftMonth(month, -1), shiftMonth(month, -2)];
      const found = await loadAdminRevenueRow(db, id, months);
      if (!found.ok) return failure(found.reason);
      return NextResponse.json(
        { row: found.row, testMode: found.testMode },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const sourceParam = params.get("source") ?? "all";
    if (!SOURCES.has(sourceParam)) return NextResponse.json({ error: "Invalid source." }, { status: 400 });
    const filters: RevenueFilters = {
      tab: revenueTabFromParam(params.get("tab")),
      q: (params.get("q") ?? "").slice(0, 100),
      source: sourceParam as RevenueFilters["source"],
    };

    const result = await loadAdminRevenueMonth(db, month);
    if (!result.ok) return failure(result.reason);

    if (params.get("format") === "csv") {
      return new NextResponse(revenueRowsToCsv(filterRevenueRows(result.data.rows, filters)), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="proplane-payments-${month}.csv"`,
          "Cache-Control": "private, no-store",
        },
      });
    }

    return NextResponse.json(
      pageRevenue(result.data, filters, Number(params.get("page") ?? "1"), Number(params.get("pageSize") ?? "50")),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    console.error("GET /api/admin/revenue failed", e);
    return NextResponse.json({ error: "Could not load payments." }, { status: 500 });
  }
}
