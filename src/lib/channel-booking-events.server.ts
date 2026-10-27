import "server-only";

/**
 * "New Airbnb booking" / "Airbnb booking cancelled" on the action-event bus.
 *
 * Emitted by the channel calendar sync (`syncChannelCalendarConnection`) when
 * the diff of the connection's stored ranges finds a reservation that is new
 * or gone. Delivery is the bus's own manager path - the same one a confirmed
 * tour takes: `emitActionEvent` -> `deliverProjection` ->
 * `notifyPropertyScopedManagersFromAgent` (the owner's own PropLane Assistant
 * notice, which follows their alert destination and so reaches the work
 * number's SMS, plus one PropLane line in the workspace Team chat for the team;
 * a booking is routine, so no teammate is noticed directly). Nothing here
 * changes delivery.
 *
 * Idempotent: the event id is the connection + the stay, so a re-run sync (or a
 * retry after a failed save) never notifies twice.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent } from "@/lib/action-events.server";
import { track } from "@/lib/analytics/posthog";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { bookingEntryGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { channelRangeKey } from "@/lib/channel-calendar/channel-booking-diff";
import { channelClashText, type ChannelClash } from "@/lib/channel-calendar/channel-overlap";
import { channelCalendarProviderLabel } from "@/lib/channel-calendar/airbnb-url";
import { bookingRecordUrl, channelStayBookingKey } from "@/lib/channel-calendar/booking-record-link";
import { lastNightBeforeCheckout } from "@/lib/channel-calendar/property-bookings";
import type { ChannelCalendarImportedRange, ChannelCalendarProvider } from "@/lib/channel-calendar/types";
import { resolveManagerAssistantWorkspace } from "@/lib/communication/manager-assistant-workspace.server";
import { sendManagerNoticeEmail } from "@/lib/manager-notice-email.server";
import { bookingRecordHref } from "@/lib/portal-detail-routes";

export type ChannelBookingEvent = "channel_booking_created" | "channel_booking_cancelled";
/** Two things hold one room on the same nights (found after a sync). */
export type ChannelClashEvent = "channel_booking_clash";
/** A booking made in PropLane itself (Add booking / Mark reserved / the assistant), not read from a channel feed. */
export type NativeBookingEvent = "booking_created" | "booking_cancelled";

const DAY_MS = 86_400_000;

function dayMs(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

function monthDay(key: string): string {
  return new Date(dayMs(key)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The booking RECORD page for a channel stay (falls back to nothing else: the record route resolves this key). */
export function channelBookingRecordUrl(input: {
  provider: ChannelCalendarProvider;
  propertyId: string;
  roomId: string;
  range: Pick<ChannelCalendarImportedRange, "start" | "end" | "summary">;
}): string {
  return bookingRecordUrl(
    resolveEmailLinkBaseUrl(),
    channelStayBookingKey({ provider: input.provider, propertyId: input.propertyId, roomId: input.roomId, ...input.range }),
  );
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
  facts: { provider: ChannelCalendarProvider; channelLabel?: string | null; propertyLabel?: string; roomLabel?: string; start: string; end: string; reservationCode?: string },
): { subject: string; text: string; smsText: string } {
  const channel = channelCalendarProviderLabel(facts.provider, facts.channelLabel);
  const lead = event === "channel_booking_created" ? `New ${channel} booking` : `${channel} booking cancelled`;
  const place = [facts.propertyLabel?.trim(), facts.roomLabel?.trim()].filter(Boolean);
  const code = facts.reservationCode?.trim();
  const text = [lead, ...place, channelBookingStay(facts.start, facts.end).label, ...(code ? [code] : [])].join(" · ");
  return { subject: lead, text, smsText: text };
}

/** The owner's email copy: house, room, guest, dates, source. The link is appended by `sendManagerNoticeEmail`. */
export function renderOwnerBookingEmail(input: {
  created: boolean;
  propertyLabel?: string;
  roomLabel?: string;
  guest: string;
  stayLabel: string;
  sourceLabel: string;
}): { subject: string; text: string } {
  const house = input.propertyLabel?.trim() || "your property";
  const room = input.roomLabel?.trim() || "Whole home";
  const subject = `${input.created ? "New booking" : "Booking cancelled"} · ${house} · ${room}`;
  const text = [
    input.created ? "A booking was added." : "A booking was cancelled.",
    `House: ${house}`,
    `Room: ${room}`,
    `Guest: ${input.guest.trim() || "Not named"}`,
    `Dates: ${input.stayLabel}`,
    `Source: ${input.sourceLabel}`,
  ].join("\n");
  return { subject, text };
}

/**
 * Every booking emails the workspace owner at their login address, from the work
 * email, whatever their notification destination says (the bus notice above is
 * the one that obeys it). Idempotent on the SAME key the bus notice uses for its
 * own email (`action-event:<eventId>:manager`): a destination of email sends once
 * through whichever path gets there first, and a second sync of the same booking
 * sends nothing. Never throws; a mail that cannot go out must not fail the write
 * or the sync that raised the event.
 */
export async function sendOwnerBookingEmail(
  db: SupabaseClient,
  input: { ownerUserId: string; propertyId: string; eventId: string; subject: string; text: string; bookingKey: string },
): Promise<void> {
  try {
    const workspace = await resolveManagerAssistantWorkspace(db, input.ownerUserId, { propertyId: input.propertyId }).catch(() => null);
    await sendManagerNoticeEmail(db, {
      recipientUserId: input.ownerUserId,
      ownerUserId: input.ownerUserId,
      workspaceId: workspace?.workspaceId || null,
      subject: input.subject,
      text: input.text,
      url: bookingRecordHref("/portal", input.bookingKey),
      idempotencyKey: `action-event:${input.eventId}:manager`,
    });
  } catch (error) {
    console.warn("[booking-email] owner email failed", { message: error instanceof Error ? error.message : String(error) });
  }
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
    /** The site name of an "Other calendar" link. */
    channelLabel?: string | null;
    propertyLabel?: string;
    roomLabel?: string;
    range: ChannelCalendarImportedRange;
  },
): Promise<void> {
  const { data: manager } = await db.from("profiles").select("email, full_name").eq("id", input.managerUserId).maybeSingle();
  const senderEmail = String(manager?.email ?? "").trim().toLowerCase();
  if (!senderEmail) return;
  const rendered = renderChannelBookingEvent(input.event, { ...input, start: input.range.start, end: input.range.end, reservationCode: input.range.reservationCode });
  const url = channelBookingRecordUrl(input);
  const stay = channelBookingStay(input.range.start, input.range.end);
  const eventId = `${input.connectionId}:${channelRangeKey(input.range)}:${input.range.start}:${input.range.end}:${input.event}`;
  // The same name the sync files the reservation's resident under: a real name when the feed or the
  // stay carries one, else "Airbnb guest · HM..." from the confirmation code, so the notice and the
  // owner's mail never call a guest something the Bookings list does not.
  const guestLabel = bookingEntryGuestLabel({
    summary: input.range.summary,
    source: input.provider,
    channelLabel: input.channelLabel,
    reservationCode: input.range.reservationCode,
  });
  let busError: unknown = null;
  try {
    await emitActionEvent(db, {
    eventId,
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
      // What the stay is called everywhere else; no contact data is in the feed.
      guestLabel,
    },
    templateContext: { propertyTitle: input.propertyLabel ?? "", roomLabel: input.roomLabel ?? "", stayLabel: stay.label, url },
    recipients: [{ audience: "manager", userId: input.managerUserId, rendered: { ...rendered, text: `${rendered.text}\n\n${url}` } }],
    });
  } catch (error) {
    busError = error;
  }
  // The owner's email does not depend on the bus notice or their alert destination.
  const email = renderOwnerBookingEmail({
    created: input.event === "channel_booking_created",
    propertyLabel: input.propertyLabel,
    roomLabel: input.roomLabel,
    guest: guestLabel,
    stayLabel: stay.label,
    sourceLabel: channelCalendarProviderLabel(input.provider, input.channelLabel),
  });
  await sendOwnerBookingEmail(db, {
    ownerUserId: input.managerUserId,
    propertyId: input.propertyId,
    eventId,
    ...email,
    bookingKey: channelStayBookingKey({ provider: input.provider, propertyId: input.propertyId, roomId: input.roomId, ...input.range }),
  });
  if (busError) throw busError;
  track("channel_booking_alert", input.managerUserId, {
    provider: input.provider,
    kind: input.event === "channel_booking_created" ? "created" : "cancelled",
  });
}

export function renderChannelClashEvent(clash: Pick<ChannelClash, "roomLabel" | "start" | "end" | "sides">, propertyLabel?: string): { subject: string; text: string; smsText: string } {
  const lead = channelClashText(clash);
  const text = [propertyLabel?.trim(), lead].filter(Boolean).join(" · ");
  return { subject: "Double booking", text, smsText: text };
}

/**
 * ONE alert per double booking: "Room 8 is double-booked Oct 29 – Nov 1 (Airbnb and Booking.com)". The event id
 * is the clash's own key (its two sides and the nights they share), so whichever room's sync finds it first
 * announces it and every later sync, retry or manual Sync all, finds the same id and sends nothing.
 */
export async function emitChannelClashEvent(
  db: SupabaseClient,
  input: { clash: ChannelClash; managerUserId: string; propertyLabel?: string },
): Promise<void> {
  const { clash } = input;
  const { data: manager } = await db.from("profiles").select("email, full_name").eq("id", input.managerUserId).maybeSingle();
  const senderEmail = String(manager?.email ?? "").trim().toLowerCase();
  if (!senderEmail) return;
  const rendered = renderChannelClashEvent(clash, input.propertyLabel);
  const channelSide = clash.sides.find((side) => side.kind === "channel");
  const range = channelSide?.kind === "channel" ? channelSide.range : null;
  const url = range
    ? channelBookingRecordUrl({ provider: range.provider as ChannelCalendarProvider, propertyId: clash.propertyId, roomId: range.roomId, range: { start: range.start, end: range.end, summary: range.summary ?? "" } })
    : resolveEmailLinkBaseUrl();
  await emitActionEvent(db, {
    eventId: clash.key,
    domain: "channel_booking",
    event: "channel_booking_clash",
    managerUserId: input.managerUserId,
    entityId: clash.key,
    category: "tours",
    senderUserId: input.managerUserId,
    senderEmail,
    senderName: String(manager?.full_name ?? "").trim() || undefined,
    payload: {
      propertyId: clash.propertyId,
      roomId: clash.roomId,
      start: clash.start,
      end: clash.end,
      sides: clash.sides.map((side) => side.label),
    },
    templateContext: { propertyTitle: input.propertyLabel ?? "", roomLabel: clash.roomLabel, stayLabel: channelBookingStay(clash.start, clash.end).label, url },
    recipients: [{ audience: "manager", userId: input.managerUserId, rendered: { ...rendered, text: `${rendered.text}\n\n${url}` } }],
  });
  track("channel_booking_alert", input.managerUserId, { provider: "clash", kind: "clash" });
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** House and room names for the notice; ids stand in when the property record cannot be read. */
async function nativeBookingLabels(db: SupabaseClient, propertyId: string, roomId: string): Promise<{ propertyLabel: string; roomLabel: string }> {
  try {
    const { data } = await db.from("manager_property_records").select("property_data").eq("id", propertyId).maybeSingle();
    const property = (data?.property_data ?? null) as { title?: unknown; buildingName?: unknown; listingSubmission?: { rooms?: Array<{ id?: unknown; name?: unknown }> } } | null;
    const propertyLabel = cleanText(property?.buildingName) || cleanText(property?.title) || propertyId;
    if (!roomId) return { propertyLabel, roomLabel: "Whole home" };
    const room = property?.listingSubmission?.rooms?.find((item) => cleanText(item.id) === roomId);
    return { propertyLabel, roomLabel: cleanText(room?.name) || roomId };
  } catch {
    return { propertyLabel: propertyId, roomLabel: roomId || "Whole home" };
  }
}

export function renderNativeBookingEvent(
  event: NativeBookingEvent,
  facts: { propertyLabel?: string; roomLabel?: string; guestName?: string; checkIn: string; checkOut: string; openEnded?: boolean },
): { subject: string; text: string; smsText: string; stayLabel: string } {
  const stayLabel = facts.openEnded
    ? `${monthDay(facts.checkIn)} – open-ended`
    : channelBookingStay(facts.checkIn, lastNightBeforeCheckout(facts.checkOut)).label;
  const lead = event === "booking_created" ? "New PropLane booking" : "PropLane booking cancelled";
  const place = [facts.propertyLabel?.trim(), facts.roomLabel?.trim()].filter(Boolean);
  const text = [lead, ...place, facts.guestName?.trim() || "", stayLabel].filter(Boolean).join(" · ");
  return { subject: lead, text, smsText: text, stayLabel };
}

/**
 * A booking made in PropLane (a named reservation; a closed room is not a booking) is created or
 * cancelled/deleted. Same two legs as a channel stay: the bus notice (obeys the manager's alert
 * destination) and the owner's email (always). Idempotent on the block id + event, so a delete
 * after a cancel, or a retried request, announces nothing twice. Best-effort for the caller.
 */
export async function emitNativeBookingEvent(
  db: SupabaseClient,
  input: {
    event: NativeBookingEvent;
    blockId: string;
    /** The house owner: the workspace whose notice and mailbox this is. */
    managerUserId: string;
    propertyId: string;
    roomId: string;
    guestName: string;
    checkIn: string;
    checkOut: string;
    openEnded?: boolean;
    propertyLabel?: string;
    roomLabel?: string;
  },
): Promise<void> {
  const [{ data: manager }, labels] = await Promise.all([
    db.from("profiles").select("email, full_name").eq("id", input.managerUserId).maybeSingle(),
    input.propertyLabel && input.roomLabel ? Promise.resolve({ propertyLabel: input.propertyLabel, roomLabel: input.roomLabel }) : nativeBookingLabels(db, input.propertyId, input.roomId),
  ]);
  const senderEmail = String(manager?.email ?? "").trim().toLowerCase();
  if (!senderEmail) return;
  const rendered = renderNativeBookingEvent(input.event, { ...labels, guestName: input.guestName, checkIn: input.checkIn, checkOut: input.checkOut, openEnded: input.openEnded });
  const bookingKey = `block:${input.blockId}`;
  const url = bookingRecordUrl(resolveEmailLinkBaseUrl(), bookingKey);
  const eventId = `native:${input.blockId}:${input.event}`;
  let busError: unknown = null;
  try {
    await emitActionEvent(db, {
      eventId,
      domain: "channel_booking",
      event: input.event,
      managerUserId: input.managerUserId,
      entityId: input.blockId,
      category: "tours",
      senderUserId: input.managerUserId,
      senderEmail,
      senderName: String(manager?.full_name ?? "").trim() || undefined,
      payload: {
        propertyId: input.propertyId,
        roomId: input.roomId,
        blockId: input.blockId,
        provider: "proplane",
        start: input.checkIn,
        end: input.checkOut,
        guestLabel: input.guestName,
      },
      templateContext: { propertyTitle: labels.propertyLabel, roomLabel: labels.roomLabel, stayLabel: rendered.stayLabel, url },
      recipients: [{ audience: "manager", userId: input.managerUserId, rendered: { subject: rendered.subject, text: `${rendered.text}\n\n${url}`, smsText: rendered.smsText } }],
    });
  } catch (error) {
    busError = error;
  }
  const email = renderOwnerBookingEmail({
    created: input.event === "booking_created",
    propertyLabel: labels.propertyLabel,
    roomLabel: labels.roomLabel,
    guest: input.guestName,
    stayLabel: rendered.stayLabel,
    sourceLabel: "PropLane",
  });
  await sendOwnerBookingEmail(db, { ownerUserId: input.managerUserId, propertyId: input.propertyId, eventId, ...email, bookingKey });
  if (busError) throw busError;
  track("channel_booking_alert", input.managerUserId, { provider: "proplane", kind: input.event === "booking_created" ? "created" : "cancelled" });
}
