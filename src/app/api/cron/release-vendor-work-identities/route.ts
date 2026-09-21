import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { reconcileVendorWorkIdentityReleases, releaseQueuedVendorWorkIdentities } from "@/lib/vendor-work-identity-release.server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const db = createSupabaseServiceRoleClient();
    const [claimed, reconciled] = await Promise.all([releaseQueuedVendorWorkIdentities(db), reconcileVendorWorkIdentityReleases(db)]);
    return NextResponse.json({ ok: true, ...claimed, reconciled });
  } catch {
    return NextResponse.json({ ok: false, error: "Vendor identity release unavailable." }, { status: 503 });
  }
}
