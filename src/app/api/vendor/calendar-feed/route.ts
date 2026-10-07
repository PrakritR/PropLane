import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  loadVendorCalendarFeedState,
  resetVendorCalendarFeed,
  vendorCalendarFeedUrl,
} from "@/lib/vendor-calendar-feed.server";

export const runtime = "nodejs";

async function actor() {
  const resolved = await resolveVendorPortalUserId();
  if (!resolved.ok) {
    return { response: NextResponse.json({ ok: false, error: "Unauthorized." }, { status: resolved.status }) };
  }
  return { userId: resolved.userId };
}

function unavailable() {
  return NextResponse.json({ ok: false, error: "Calendar link is temporarily unavailable." }, { status: 503 });
}

export async function GET(req: Request) {
  const current = await actor();
  if ("response" in current) return current.response;
  try {
    const state = await loadVendorCalendarFeedState(createSupabaseServiceRoleClient(), current.userId);
    if (state.revoked) return NextResponse.json({ ok: true, url: null, revoked: true });
    return NextResponse.json({
      ok: true,
      url: vendorCalendarFeedUrl(resolveAppOrigin(req), current.userId, state.version),
      revoked: false,
    });
  } catch {
    return unavailable();
  }
}

export async function POST(req: Request) {
  const current = await actor();
  if ("response" in current) return current.response;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== "reset") {
    return NextResponse.json({ ok: false, error: "action must be reset." }, { status: 400 });
  }
  try {
    const reset = await resetVendorCalendarFeed(createSupabaseServiceRoleClient(), current.userId);
    if (!reset.ok) {
      return NextResponse.json({ ok: false, error: "Could not reset the link." }, { status: 503 });
    }
    return NextResponse.json({
      ok: true,
      url: vendorCalendarFeedUrl(resolveAppOrigin(req), current.userId, reset.version),
      revoked: false,
    });
  } catch {
    return unavailable();
  }
}
