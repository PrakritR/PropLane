import { NextResponse, type NextRequest } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import {
  filterSubscribers,
  subscriberTabFromParam,
  subscribersToCsv,
  type SubscriberFilters,
} from "@/lib/admin/admin-subscribers-model";
import { enrichRenewals, loadSubscriberPopulation, pageSubscribers } from "@/lib/admin/admin-subscribers.server";
import { isStripeTestMode } from "@/lib/admin/admin-revenue.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const PLANS = new Set(["all", "pro", "business"]);
const SOURCES = new Set(["all", "stripe", "app_store", "proplane"]);
const SIGNUP_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * GET /api/admin/subscribers - Accounts > Subscribers: every real manager in one of Paid / Trial /
 * Promo / Free / Complimentary, decided by the resolvers enforcement uses (see
 * `admin-subscribers-model.ts`). Counts and MRR describe the whole population; `rows` is one page of
 * the requested tab. Sandbox accounts are excluded. Admin-only.
 *
 * Query: `tab`, `q`, `plan` (all|pro|business), `source` (all|stripe|app_store|proplane),
 * `signup` (YYYY-MM), `page`, `pageSize`.
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireAdminRoute();
    if (!gate.ok) return gate.response;
    const params = request.nextUrl.searchParams;

    const plan = params.get("plan") ?? "all";
    const source = params.get("source") ?? "all";
    const signup = params.get("signup") ?? "";
    if (!PLANS.has(plan) || !SOURCES.has(source) || (signup && !SIGNUP_RE.test(signup))) {
      return NextResponse.json({ error: "Invalid filter." }, { status: 400 });
    }
    const filters: SubscriberFilters = {
      tab: subscriberTabFromParam(params.get("tab")),
      q: (params.get("q") ?? "").slice(0, 100),
      plan: plan as SubscriberFilters["plan"],
      source: source as SubscriberFilters["source"],
      signup,
    };

    const population = await loadSubscriberPopulation(createSupabaseServiceRoleClient());
    if (params.get("format") === "csv") {
      return new NextResponse(subscribersToCsv(filterSubscribers(population.rows, filters)), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="proplane-subscribers-${filters.tab}.csv"`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    const page = pageSubscribers(
      population,
      filters,
      Number(params.get("page") ?? "1"),
      Number(params.get("pageSize") ?? "50"),
    );
    const rows = await enrichRenewals(page.rows);
    return NextResponse.json({ ...page, rows, testMode: isStripeTestMode() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("GET /api/admin/subscribers failed", e);
    return NextResponse.json({ error: "Could not load subscribers." }, { status: 500 });
  }
}
