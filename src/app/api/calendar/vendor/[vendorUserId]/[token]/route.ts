import { NextResponse } from "next/server";

import { buildIcsTimedCalendar } from "@/lib/ical/serialize";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { vendorJobsToFeedEvents } from "@/lib/vendor-calendar-feed-events";
import { verifyVendorCalendarFeedToken } from "@/lib/vendor-calendar-feed.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One answer for every invalid, stale or revoked link: nothing says which. */
function notFound() {
  return new NextResponse("Not found", {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function loadVendorJobs(db: ReturnType<typeof createSupabaseServiceRoleClient>, vendorUserId: string) {
  const rows: Array<{ id: string; row_data: unknown }> = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("portal_work_order_records")
      .select("id, row_data")
      .eq("vendor_user_id", vendorUserId)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Array<{ id: string; row_data: unknown }>;
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** The token in the URL IS the credential: no cookie, no session. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ vendorUserId: string; token: string }> },
) {
  const { vendorUserId, token } = await ctx.params;
  try {
    const limited = await rateLimit(`vendor-calendar-feed:${clientIpFrom(req)}`, 120, 60_000);
    if (!limited.ok) {
      return new NextResponse("Too many requests", {
        status: limited.unavailable ? 503 : 429,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    const db = createSupabaseServiceRoleClient();
    if (!(await verifyVendorCalendarFeedToken(db, vendorUserId, token))) return notFound();
    const events = vendorJobsToFeedEvents(await loadVendorJobs(db, vendorUserId));
    const body = buildIcsTimedCalendar(events, { calendarName: "PropLane jobs" });
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new NextResponse("Calendar unavailable", {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
