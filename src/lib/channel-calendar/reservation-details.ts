/**
 * The two facts an Airbnb calendar feed carries about a reservation besides its dates: the
 * reservation code (inside the "Reservation URL" in the event DESCRIPTION) and the last four
 * digits of the guest's phone. Nothing else in the description is kept, and the raw text is
 * never stored. The URL is only trusted when its host is exactly airbnb.com / www.airbnb.com
 * and its path is the reservation-details path, so a hostile feed cannot plant a link.
 */

const AIRBNB_HOSTS = new Set(["www.airbnb.com", "airbnb.com"]);
const RESERVATION_PATH = /^\/hosting\/reservations\/details\/(HM[A-Z0-9]{6,12})\/?$/;
const RESERVATION_CODE = /^HM[A-Z0-9]{6,12}$/;

export type ReservationDetails = { reservationCode?: string; phoneLast4?: string };

export function isReservationCode(value: unknown): value is string {
  return typeof value === "string" && RESERVATION_CODE.test(value);
}

export function isPhoneLast4(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}$/.test(value);
}

/** The reservation code in an Airbnb reservation URL, or null for any other URL. */
export function reservationCodeFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !AIRBNB_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password || url.port) return null;
  return RESERVATION_PATH.exec(url.pathname)?.[1] ?? null;
}

/** The link the host opens in Airbnb, rebuilt from the code - never the raw feed URL. */
export function airbnbReservationUrl(code: string | null | undefined): string | null {
  return isReservationCode(code) ? `https://www.airbnb.com/hosting/reservations/details/${code}` : null;
}

/** Pull the reservation code and phone suffix out of an event DESCRIPTION; absent when the format does not match. */
export function parseReservationDescription(description: string | null | undefined): ReservationDetails {
  const text = description ?? "";
  if (!text) return {};
  const out: ReservationDetails = {};
  for (const candidate of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
    const code = reservationCodeFromUrl(candidate.replace(/[.,;)]+$/, ""));
    if (code) {
      out.reservationCode = code;
      break;
    }
  }
  const phone = /Last\s*4\s*Digits\)?\s*:\s*(\d{4})(?!\d)/i.exec(text);
  if (phone) out.phoneLast4 = phone[1];
  return out;
}
