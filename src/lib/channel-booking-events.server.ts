import "server-only";

/**
 * "New Airbnb booking" / "Airbnb booking cancelled" on the action-event bus.
 *
 * Emitted by the channel calendar sync (`syncChannelCalendarConnection`) when
 * the diff of the connection's stored ranges finds a reservation that is new
 * or gone. Delivery is the bus's own manager path - the same one a confirmed
 * tour takes: `emitActionEvent` -> `deliverProjection` -> `notifyManagerFromAgent`
 * (the PropLane Assistant notice, which follows the manager's alert destination
 * and so reaches the work number's SMS). Nothing here changes delivery.
 *
 * Idempotent: the event id is the connection + the stay, so a re-run sync (or a
 * retry after a failed save) never notifies twice.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent } from "@/lib/action-events.server";
import { track } from "@/lib/analytics/posthog";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { channelRangeKey } from "@/lib/channel-calendar/channel-booking-diff";
import { channelCalendarProviderLabel } from "@/lib/channel-calendar/airbnb-url";
import type { ChannelCalendarImportedRange, ChannelCalendarProvider } from "@/lib/channel-calendar/types";

export type ChannelBookingEvent = "channel_booking_created" | "channel_booking_cancelled";

const DAY_MS = 86_400_000;

function dayMs(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

function monthDay(key: string): string {
  return new Date(dayMs(key)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The stored range ends on its LAST night; the guest checks out the day after. */
export function channelBookingStay(start: string, lastNight: string): { label: string; nights: number } {
  const end = lastNight && lastNight >= start ? lastNight : start;
  const nights = Math.round((dayMs(end) - dayMs(start)) / DAY_MS) + 1;
  const checkout = new Date(dayMs(end) + DAY_MS).toISOString().slice(0, 10);
  return { label: `${monthDay(start)} – ${monthDay(checkout)} (${nights} ${nights === 1 ? "night" : "nights"})`, nights };
}

export function renderChannelBookingEvent(
  event: ChannelBookingEvent,
  facts: { provider: ChannelCalendarProvider; propertyLabel?: string; roomLabel?: string; start: string; end: string },
): { subject: string; text: string; smsText: string } {
  const channel = channelCalendarProviderLabel(facts.provider);
  const lead = event === "channel_booking_created" ? `New ${channel} booking` : `${channel} booking cancelled`;
  const place = [facts.propertyLabel?.trim(), facts.roomLabel?.trim()].filter(Boolean);
  const text = [lead, ...place, channelBookingStay(facts.start, facts.end).label].join(" · ");
  return { subject: lead, text, smsText: text };
}

export async function emitChannelBookingEvent(
  db: SupabaseClient,
  input: {
    event: ChannelBookingEvent;
    connectionId: string;
    managerUserId: string;
    propertyId: string;
    roomId: string;
    provider: ChannelCalendarProvider;
    propertyLabel?: string;
    roomLabel?: string;
    range: ChannelCalendarImportedRange;
  },
): Promise<void> {
  const { data: manager } = await db.from("profiles").select("email, full_name").eq("id", input.managerUserId).maybeSingle();
  const senderEmail = String(manager?.email ?? "").trim().toLowerCase();
  if (!senderEmail) return;
  const rendered = renderChannelBookingEvent(input.event, { ...input, start: input.range.start, end: input.range.end });
  const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/bookings/calendar`;
  const stay = channelBookingStay(input.range.start, input.range.end);
  await emitActionEvent(db, {
    eventId: `${input.connectionId}:${channelRangeKey(input.range)}:${input.range.start}:${input.range.end}:${input.event}`,
    domain: "channel_booking",
    event: input.event,
    managerUserId: input.managerUserId,
    entityId: input.connectionId,
    category: "tours",
    senderUserId: input.managerUserId,
    senderEmail,
    senderName: String(manager?.full_name ?? "").trim() || undefined,
    payload: {
      propertyId: input.propertyId,
      roomId: input.roomId,
      connectionId: input.connectionId,
      provider: input.provider,
      start: input.range.start,
      end: input.range.end,
      nights: stay.nights,
      // Whatever the channel exposes ("Reserved" when it hides the guest); no contact data is in the feed.
      guestLabel: bookingGuestLabel(input.range.summary, input.provider),
    },
    templateContext: { propertyTitle: input.propertyLabel ?? "", roomLabel: input.roomLabel ?? "", stayLabel: stay.label, url },
    recipients: [{ audience: "manager", userId: input.managerUserId, rendered: { ...rendered, text: `${rendered.text}\n\n${url}` } }],
  });
  track("channel_booking_alert", input.managerUserId, {
    provider: input.provider,
    kind: input.event === "channel_booking_created" ? "created" : "cancelled",
  });
}
