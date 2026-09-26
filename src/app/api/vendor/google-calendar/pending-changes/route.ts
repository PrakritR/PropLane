import { NextResponse } from "next/server";

import { assertGoogleCalendarProviderAllowed } from "@/lib/google-calendar/api.server";
import { listPendingGoogleCalendarChanges, pullProplaneCalendarPendingChanges } from "@/lib/google-calendar/proplane-calendar-reconcile.server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

async function requireVendor() {
  const resolved = await resolveVendorPortalUserId();
  if (!resolved.ok) return null;
  return { db: createSupabaseServiceRoleClient(), userId: resolved.userId };
}

/** Vendor clone of `/api/portal/google-calendar/pending-changes` — same reconciliation, keyed by vendor userId. */
export async function GET(req: Request) {
  try {
    const ctx = await requireVendor();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await assertGoogleCalendarProviderAllowed(ctx.db, ctx.userId, "pending_changes_read");
    const url = new URL(req.url);
    if (url.searchParams.get("skipPull") !== "true") {
      await pullProplaneCalendarPendingChanges(ctx.db, ctx.userId, "vendor").catch(() => undefined);
    }
    const pending = await listPendingGoogleCalendarChanges(ctx.db, ctx.userId);
    return NextResponse.json({ pending });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
