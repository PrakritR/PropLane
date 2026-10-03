import { NextRequest, NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createShortStayBooking } from "@/lib/short-stay-booking.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { shortTermStayNightCount } from "@/lib/short-term-stay-pricing";

export const runtime = "nodejs";

type Body = {
  propertyId?: string;
  roomId?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  agreementSha256?: string;
  screeningConsent?: boolean;
};

/** Public short-stay booking — holds dates, creates charges, returns Stripe Checkout when instant book applies. */
export async function POST(req: NextRequest) {
  try {
    if (!(await rateLimit(`short-stay-booking:${clientIpFrom(req)}`, 15, 60_000)).ok) {
      return NextResponse.json({ error: "Too many booking attempts. Try again shortly." }, { status: 429 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const propertyId = body.propertyId?.trim() ?? "";
    const roomId = body.roomId?.trim() ?? "";
    const checkIn = body.checkIn?.trim() ?? "";
    const checkOut = body.checkOut?.trim() ?? "";
    const guestName = body.guestName?.trim() ?? "";
    const guestEmail = body.guestEmail?.trim().toLowerCase() ?? "";
    const agreementSha256 = body.agreementSha256?.trim() ?? "";

    if (!propertyId || !roomId || !checkIn || !checkOut || !guestName || !guestEmail || !agreementSha256) {
      return NextResponse.json({ error: "Missing required booking fields." }, { status: 400 });
    }

    const nights = shortTermStayNightCount(checkIn, checkOut);
    if (!nights || nights < 1) {
      return NextResponse.json({ error: "Check-out must be after check-in." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const result = await createShortStayBooking(db, {
      propertyId,
      roomId,
      checkIn,
      checkOut,
      guests: Math.max(1, Number(body.guests) || 1),
      guestName,
      guestEmail,
      guestPhone: body.guestPhone?.trim(),
      agreementSha256,
      screeningConsent: body.screeningConsent === true,
      appOrigin: resolveAppOrigin(req),
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    if (result.mode === "checkout") {
      return NextResponse.json({
        ok: true,
        bookingId: result.bookingId,
        chargeIds: result.chargeIds,
        checkoutUrl: result.checkoutUrl,
      });
    }

    return NextResponse.json({
      ok: true,
      bookingId: result.bookingId,
      request: true,
      confirmationPath: result.confirmationPath,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create booking." },
      { status: 500 },
    );
  }
}
