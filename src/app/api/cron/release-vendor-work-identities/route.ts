import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { releaseLapsedResidentAgentNumbers } from "@/lib/resident-agent-number/release.server";
import { reconcileVendorWorkIdentityReleases, releaseIdleVendorWorkNumbers, releaseLapsedVendorWorkNumbers, releaseQueuedVendorWorkIdentities } from "@/lib/vendor-work-identity-release.server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const db = createSupabaseServiceRoleClient();
    // A resident's PropLane number follows the same 30-day rule; queued first so this run's worker removes it.
    // It never blocks the vendor passes below.
    const residentLapsed = await releaseLapsedResidentAgentNumbers(db).catch(() => ({ released: 0, failed: 0, kept: 0, error: true }));
    const [claimed, reconciled] = await Promise.all([releaseQueuedVendorWorkIdentities(db), reconcileVendorWorkIdentityReleases(db)]);
    // 60 days with no texts through a vendor's number releases the number (not the account).
    const idle = await releaseIdleVendorWorkNumbers(db);
    // PropLane Number (flag on): a subscription lapsed for 30 days releases the number.
    const lapsed = await releaseLapsedVendorWorkNumbers(db);
    return NextResponse.json({ ok: true, ...claimed, reconciled, idle, lapsed, residentLapsed });
  } catch {
    return NextResponse.json({ ok: false, error: "Vendor identity release unavailable." }, { status: 503 });
  }
}
