import { NextResponse } from "next/server";
import { buildEngageList } from "@/lib/growth/engage/build.server";
import { pacificDate, shiftDate } from "@/lib/growth/engage/dates";
import { isProductionRuntime } from "@/lib/server-env";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Preview deployments are public and hold real service-role credentials.
    // Secretless access is only a localhost/test convenience.
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
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
