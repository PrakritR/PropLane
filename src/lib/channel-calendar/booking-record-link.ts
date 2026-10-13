import { bookingRecordHref } from "@/lib/portal-detail-routes";

/**
 * Absolute URL of a booking RECORD page. A channel stay has no stored id: the record route
 * resolves the legacy key `source:property:room:start:end:summary` (`bookingLegacyEntryKey`).
 * A hand-added hold is `block:<id>`, a PropLane stay `lease:<id>`.
 */
export function bookingRecordUrl(origin: string, bookingKey: string): string {
  return `${origin.replace(/\/$/, "")}${bookingRecordHref("/portal", bookingKey)}`;
}

export function channelStayBookingKey(input: {
  provider: string;
  propertyId: string;
  roomId: string;
  start: string;
  end: string;
  summary: string;
}): string {
  return `${input.provider}:${input.propertyId}:${input.roomId}:${input.start}:${input.end}:${input.summary}`;
}
