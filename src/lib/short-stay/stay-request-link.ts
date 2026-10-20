/**
 * The resident portal's short-stay booking application address:
 * `/resident/stays/request?listing=<propertyId>&room=<roomId>&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=N`.
 * The public listing card, the Stays page and the notices build it here; the page parses it here.
 * Everything in it is a PREFILL, never an authorization: the server re-checks the house, room and dates.
 */
export const STAY_REQUEST_PATH = "/resident/stays/request";

export type StayRequestPrefill = {
  listing: string;
  room: string;
  checkIn: string;
  checkOut: string;
  guests: number;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function stayRequestHref(input: Partial<StayRequestPrefill>, basePath = "/resident"): string {
  const query = new URLSearchParams();
  if (input.listing) query.set("listing", input.listing);
  if (input.room) query.set("room", input.room);
  if (input.checkIn && DAY.test(input.checkIn)) query.set("checkIn", input.checkIn);
  if (input.checkOut && DAY.test(input.checkOut)) query.set("checkOut", input.checkOut);
  if (input.guests && Number.isInteger(input.guests) && input.guests > 0) query.set("guests", String(input.guests));
  const qs = query.toString();
  return `${basePath}/stays/request${qs ? `?${qs}` : ""}`;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export function parseStayRequestPrefill(params: Record<string, string | string[] | undefined>): StayRequestPrefill {
  const checkIn = first(params.checkIn);
  const checkOut = first(params.checkOut);
  const guests = Number(first(params.guests));
  return {
    listing: first(params.listing),
    room: first(params.room),
    checkIn: DAY.test(checkIn) ? checkIn : "",
    checkOut: DAY.test(checkOut) ? checkOut : "",
    guests: Number.isInteger(guests) && guests > 0 ? guests : 1,
  };
}
