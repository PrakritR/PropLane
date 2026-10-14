import { NextResponse } from "next/server";

import { channelImportUrlErrorMessage, ICAL_VALIDATE_TIMEOUT_MS, isValidIcalImportUrl } from "@/lib/channel-calendar/airbnb-url";
import { requireBookingsManager } from "@/lib/channel-calendar/require-manager.server";
import { fetchChannelIcs } from "@/lib/channel-calendar/sync.server";
import { parseIcsCalendar } from "@/lib/ical/parse";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST { url } -> { ok, eventCount } | { ok: false, error }. Checks an "Other calendar" link before it is
 * saved: https, a public host (every resolved address), and a response that really is a calendar. The
 * server makes the request, so this is a fetch-on-behalf-of route: manager session only, rate limited,
 * and it never echoes the response body.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });

    const limited = await rateLimit(`channel-calendar-validate:${ctx.userId}`, 20, 60_000);
    if (!limited.ok) return NextResponse.json({ ok: false, error: "Too many checks. Wait a minute and try again." }, { status: 429 });

    const body = (await req.json().catch(() => ({}))) as { url?: unknown };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!isValidIcalImportUrl(url)) {
      return NextResponse.json({ ok: false, error: channelImportUrlErrorMessage("ical") }, { status: 400 });
    }

    try {
      const text = await fetchChannelIcs(url, "ical", { timeoutMs: ICAL_VALIDATE_TIMEOUT_MS });
      return NextResponse.json({ ok: true, eventCount: parseIcsCalendar(text).length });
    } catch (e) {
      // The fetcher's messages are written for the manager (private address, not a calendar, a status code).
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Could not read that link." }, { status: 422 });
    }
  } catch {
    return NextResponse.json({ ok: false, error: "Could not check that link." }, { status: 500 });
  }
}
