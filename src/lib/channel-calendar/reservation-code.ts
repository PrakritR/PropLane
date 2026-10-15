/**
 * The Airbnb reservation code behind a channel stay, and the link that opens it.
 *
 * Airbnb's feed names a reservation "Reserved" and puts the code in the event DESCRIPTION as
 * "Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMXXXXXXXX". The sync
 * keeps only that code (`reservation-details.ts`); this reads it back off an entry, falling back
 * to a code or reservation URL written into the summary, and rebuilds the link from the code -
 * never from the feed's own URL.
 */
import { airbnbReservationUrl, isReservationCode, parseReservationDescription, reservationCodeFromUrl } from "@/lib/channel-calendar/reservation-details";

type ReservationCodeEntry = {
  source: string;
  summary?: string | null;
  reservationCode?: string | null;
  reservationUrl?: string | null;
};

const BARE_CODE = /\bHM[A-Z0-9]{6,12}\b/;

/** The reservation code for a stay, or null when the feed never carried one. */
export function reservationCodeForEntry(entry: ReservationCodeEntry): string | null {
  if (isReservationCode(entry.reservationCode)) return entry.reservationCode;
  const fromUrl = entry.reservationUrl ? reservationCodeFromUrl(entry.reservationUrl) : null;
  if (fromUrl) return fromUrl;
  const summary = entry.summary ?? "";
  const fromText = parseReservationDescription(summary).reservationCode ?? BARE_CODE.exec(summary)?.[0];
  return isReservationCode(fromText) ? fromText : null;
}

/** "Open in Airbnb" target: only an Airbnb stay with a parsed code has one. */
export function airbnbOpenUrlForEntry(entry: ReservationCodeEntry): string | null {
  if (entry.source !== "airbnb") return null;
  return airbnbReservationUrl(reservationCodeForEntry(entry));
}
