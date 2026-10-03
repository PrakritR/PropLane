import { NextRequest, NextResponse } from "next/server";
import { getPublicListings } from "@/lib/public-listings.server";
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
};

/** Public short-stay booking intake — creates checkout session when dates are free. */
export async function POST(req: NextRequest) {
  try {
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

    const listings = await getPublicListings({});
    const listing = listings.find((row) => row.id === propertyId);
    if (!listing) {
      return NextResponse.json({ error: "This listing is not available." }, { status: 404 });
    }

    const room = listing.listingSubmission?.rooms?.find((r) => r.id === roomId);
    if (!room) {
      return NextResponse.json({ error: "This room is not available." }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      bookingId: `stay-${propertyId}-${Date.now()}`,
      nights,
      confirmationPath: `/rent/stay/confirmation?propertyId=${encodeURIComponent(propertyId)}`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create booking." },
      { status: 500 },
    );
  }
}
