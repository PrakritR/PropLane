import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { buildEngageList } from "@/lib/growth/engage/build.server";
import { pacificDate, shiftDate } from "@/lib/growth/engage/dates";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Runs 04:00 PT; builds the list for tomorrow (Pacific date) so it is ready a day ahead.
    const forDate = shiftDate(pacificDate(), 1);
    return NextResponse.json({ ok: true, ...(await buildEngageList({ forDate })) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "growth-engage failed" }, { status: 500 });
  }
}
