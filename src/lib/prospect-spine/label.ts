import type { ProspectSource } from "@/lib/prospect-spine/contracts";

/** Pure: the tag a thread wears. "5259 Brooklyn Ave NE · Room 4" or, for a platform inquiry, "SpareRoom · 4709a Room 9". */
export function contextLabel(input: { propertyLabel: string | null; roomLabel?: string | null; sourceLabel?: string | null }): string {
  const property = (input.propertyLabel ?? "").replace(/\s+/g, " ").trim();
  const room = (input.roomLabel ?? "").replace(/\s+/g, " ").trim();
  const source = (input.sourceLabel ?? "").replace(/\s+/g, " ").trim();
  if (source) {
    const place = [property, room].filter(Boolean).join(" ");
    return [source, place].filter(Boolean).join(" · ");
  }
  return [property, room].filter(Boolean).join(" · ");
}

const SOURCE_LABELS: Record<ProspectSource, string | null> = {
  sms: null,
  listing_message: "Listing message",
  in_app: null,
  application: null,
  tour: null,
  voice: "Call",
  spareroom: "SpareRoom",
  roomies: "Roomies",
  facebook: "Facebook",
  zillow: "Zillow",
  craigslist: "Craigslist",
  roomster: "Roomster",
  airbnb: "Airbnb",
  booking_com: "Booking.com",
  padsplit: "PadSplit",
  other: null,
};

/** The label a source adds in front of the house; null for a text, an in-app message and the like (the house stands alone). */
export function sourceLabelFor(source: ProspectSource): string | null {
  return SOURCE_LABELS[source] ?? null;
}

/** A sender shown by its last four digits when no name is known. Never the full number. */
export function maskedPhoneLabel(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "Unknown number";
}
