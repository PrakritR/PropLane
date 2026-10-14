/**
 * Bookings → the reminder queue.
 *
 * A "booking" on the Bookings page is a dated STAY from one of three sources,
 * and all three are swept here so the one Settings switch governs each:
 *
 *  - an imported channel range on `external_calendar_connections` (Airbnb),
 *  - a PropLane lease's move-in on `portal_lease_pipeline_records`, and
 *  - a room-date block on `portal_schedule_records` (BUILD-WAVE2 C211) — a
 *    manager's own hand-added booking, a linked-sheet import, or a channel
 *    stay filed from a manager calendar rather than an iCal connection. This
 *    third source was the one the check-in reminder never read: "Bookings
 *    → Update from sheet" and "Add booking" both write here, but this file
 *    swept only the two sources above until now.
 *
 * The anchor is CHECK-IN, not when the booking arrived — a manager preparing a
 * room needs the lead time counted back from the day someone walks in.
 *
 * Manager-side only. A channel iCal feed carries no guest contact, so there is
 * no counterparty address to send to; see the note at the top of `rules.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import { channelStayBookingKey, bookingRecordUrl } from "@/lib/channel-calendar/booking-record-link";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { roomBlockSummary } from "@/lib/channel-calendar/property-bookings";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipients,
  teamReminderRecipients,
} from "@/lib/reminders/manager-recipients.server";
import { materializeReminders } from "@/lib/reminders/queue.server";
import { loadReminderSettingsResolver } from "@/lib/reminders/settings.server";
import { withinHorizon } from "@/lib/reminders/subjects/records.server";
import { zonedWallTimeMs } from "@/lib/tour-slot-math";
import { hasSmsTestProvenance } from "@/lib/sms/sms-test-provenance";

const KIND = "booking" as const;
/** Ceiling on rows examined per sweep, so one tick can never run unbounded. */
const MAX_ROWS = 500;
/**
 * The hour (Pacific) both stay reminders are anchored on. Stays carry a DATE, not a time, and the
 * owner wants "check-in tomorrow" and "check-out today" at 9:00 AM, so the check-in anchor is
 * 9:00 on the check-in date ("before:1440" = 9:00 the day before).
 */
const CHECK_IN_HOUR = 9;
/** The check-out reminder rides the same 5-minute floor as every timing: anchor 9:05, "before:5" = 9:00. */
const CHECK_OUT_ANCHOR_MINUTES = 9 * 60 + 5;

/**
 * The instant a `YYYY-MM-DD` check-in happens.
 *
 * Built through {@link zonedWallTimeMs} rather than `new Date(dateKey)`: a bare
 * date parses as UTC, which on Vercel lands the anchor mid-afternoon the day
 * BEFORE in Pacific — the same wall-time trap the tour grid documents.
 */
export function bookingCheckInIso(dateKey: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? "").trim());
  if (!match) return null;
  const ms = zonedWallTimeMs(Number(match[1]), Number(match[2]), Number(match[3]), CHECK_IN_HOUR * 60);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function bookingCheckOutIso(dateKey: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? "").trim());
  if (!match) return null;
  const ms = zonedWallTimeMs(Number(match[1]), Number(match[2]), Number(match[3]), CHECK_OUT_ANCHOR_MINUTES);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function addDay(key: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key ?? "").trim())) return null;
  const ms = Date.parse(`${key}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

function stayLabel(startKey: string, endKey: string | null): string {
  const fmt = (key: string) =>
    new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  if (!endKey || endKey === startKey) return fmt(startKey);
  return `${fmt(startKey)} – ${fmt(endKey)}`;
}

export type Stay = {
  managerUserId: string;
  subjectId: string;
  checkInKey: string;
  checkOutKey: string | null;
  guestName: string;
  propertyId: string | null;
  propertyLabel: string;
  roomId?: string;
  roomLabel?: string;
  /** Airbnb reservation code, when the feed carried one. */
  reservationCode?: string;
  /** The record-page key (`bookingEntryKey`) the reminder links to. */
  recordKey?: string;
};

function str(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Imported channel ranges. One row per linked room, ranges inside it. */
export async function channelStays(db: SupabaseClient): Promise<Stay[]> {
  const { data, error } = await db
    .from("external_calendar_connections")
    .select("id, manager_user_id, property_id, room_id, label, provider, imported_ranges")
    .limit(MAX_ROWS);
  if (error) throw error;

  const stays: Stay[] = [];
  for (const raw of data ?? []) {
    const row = raw as Record<string, unknown>;
    const managerUserId = str(row, "manager_user_id");
    const connectionId = str(row, "id");
    if (!managerUserId || !connectionId) continue;
    const ranges = Array.isArray(row.imported_ranges) ? row.imported_ranges : [];
    for (const item of ranges) {
      if (!item || typeof item !== "object") continue;
      const range = item as Record<string, unknown>;
      const start = String(range.start ?? "").trim();
      if (!start) continue;
      // A host's own block closes dates; no guest checks in or out of it.
      if (isHostBlockRange({ hostBlock: range.hostBlock === true ? true : undefined, summary: String(range.summary ?? "") })) continue;
      const end = String(range.end ?? "").trim() || null;
      const rawProvider = str(row, "provider");
      const provider = rawProvider === "booking_com" || rawProvider === "vrbo" || rawProvider === "ical" ? rawProvider : "airbnb";
      const channelLabel = provider === "ical" ? str(row, "label") : null;
      const code = String(range.reservationCode ?? "").trim();
      stays.push({
        managerUserId,
        // Stable across syncs: the same range keeps the same id, so a re-sync
        // dedupes against the reminders already queued rather than doubling them.
        subjectId: `channel:${connectionId}:${String(range.id ?? start).trim()}`,
        checkInKey: start,
        // The stored range ends on its LAST night; the guest leaves the day after.
        checkOutKey: end ? addDay(end) : null,
        guestName: bookingGuestLabel(String(range.summary ?? ""), provider, channelLabel),
        propertyId: str(row, "property_id"),
        propertyLabel: str(row, "label") ?? str(row, "property_id") ?? "your listing",
        roomId: str(row, "room_id") ?? undefined,
        roomLabel: str(row, "label") ?? undefined,
        ...(code ? { reservationCode: code } : {}),
        recordKey: channelStayBookingKey({
          provider,
          propertyId: str(row, "property_id") ?? "",
          roomId: str(row, "room_id") ?? "",
          start,
          end: end ?? start,
          summary: String(range.summary ?? ""),
        }),
      });
    }
  }
  return stays;
}

/** PropLane's own stays — a signed lease's move-in date. */
export async function leaseStays(db: SupabaseClient): Promise<Stay[]> {
  const { data, error } = await db
    .from("portal_lease_pipeline_records")
    .select("manager_user_id, row_data")
    .limit(MAX_ROWS);
  if (error) throw error;

  const stays: Stay[] = [];
  for (const raw of data ?? []) {
    const row = raw as { manager_user_id?: unknown; row_data?: unknown };
    const managerUserId = typeof row.manager_user_id === "string" ? row.manager_user_id : null;
    const data_ = (row.row_data ?? null) as Record<string, unknown> | null;
    if (!managerUserId || !data_ || hasSmsTestProvenance(data_)) continue;
    const id = str(data_, "id");
    if (!id) continue;
    const application = (data_.application ?? null) as Record<string, unknown> | null;
    const start = String(application?.leaseStart ?? "").trim();
    if (!start) continue;
    stays.push({
      managerUserId,
      subjectId: `stay:${id}`,
      checkInKey: start,
      checkOutKey: String(application?.leaseEnd ?? "").trim() || null,
      guestName: str(data_, "residentName") ?? "Your resident",
      propertyId: str(data_, "propertyId"),
      propertyLabel: str(data_, "propertyName") ?? str(data_, "propertyId") ?? "your listing",
      recordKey: `lease:${id}`,
    });
  }
  return stays;
}

/**
 * Hand-added bookings, linked-sheet imports, and manager-filed channel stays
 * — every `portal_schedule_records` row of type `room_date_block` that names
 * a guest, one way or another (BUILD-WAVE2 C211). A plain "these dates are
 * closed" block with no name attached is not a stay anyone is checking into,
 * so it is left out — same distinction `bookingVisualSource` already draws
 * between a block and a hold.
 */
export async function roomDateBlockStays(db: SupabaseClient): Promise<Stay[]> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, manager_user_id, property_id, row_data")
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
    .limit(MAX_ROWS);
  if (error) throw error;

  const stays: Stay[] = [];
  for (const raw of data ?? []) {
    const row = raw as Record<string, unknown>;
    const managerUserId = str(row, "manager_user_id");
    const id = str(row, "id");
    if (!managerUserId || !id) continue;
    const rowData = (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Record<string, unknown>;
    if (hasSmsTestProvenance(rowData)) continue;
    const checkIn = str(rowData, "checkIn");
    const checkOutExclusive = str(rowData, "checkOut");
    if (!checkIn || !checkOutExclusive) continue;
    const residentName = str(rowData, "residentName");
    const reason = str(rowData, "reason") ?? "";
    const isChannelImport = reason.toLowerCase() === "airbnb" || reason.toLowerCase() === "booking";
    // A block with neither a name nor a channel-import reason is just closed
    // dates — nobody to remind anyone about.
    if (!residentName && !isChannelImport) continue;
    stays.push({
      managerUserId,
      subjectId: `block:${id}`,
      checkInKey: checkIn,
      // `checkOutKey` reads as the literal day the guest leaves everywhere
      // else in `Stay` (a lease's `leaseEnd` is the move-out date, not the
      // last night) — the stored block is EXCLUSIVE checkout already
      // (`exclusiveCheckoutAfterLastNight` in sheet-sync, "Add booking"'s own
      // checkout field), so it needs no adjustment here.
      checkOutKey: checkOutExclusive,
      guestName: roomBlockSummary({ reason, residentName: residentName ?? undefined }),
      propertyId: str(row, "property_id"),
      propertyLabel: str(row, "property_id") ?? "your listing",
      roomId: str(rowData, "roomId") ?? undefined,
      recordKey: `block:${id}`,
    });
  }
  return stays;
}

/** House and room names for the reminder line; a failed read just leaves the stay's own labels. */
async function loadPlaceNames(
  db: SupabaseClient,
  propertyIds: string[],
): Promise<Map<string, { property: string; rooms: Map<string, string> }>> {
  const out = new Map<string, { property: string; rooms: Map<string, string> }>();
  if (propertyIds.length === 0) return out;
  try {
    const { data } = await db.from("manager_property_records").select("id, property_data").in("id", propertyIds);
    for (const raw of (data ?? []) as Array<{ id?: unknown; property_data?: unknown }>) {
      const id = typeof raw.id === "string" ? raw.id : "";
      const property = (raw.property_data ?? {}) as { buildingName?: string; title?: string; listingSubmission?: { rooms?: Array<{ id?: string; name?: string }> } };
      if (!id) continue;
      const rooms = new Map<string, string>();
      for (const room of property.listingSubmission?.rooms ?? []) if (room.id && room.name?.trim()) rooms.set(room.id, room.name.trim());
      out.set(id, { property: property.buildingName?.trim() || property.title?.trim() || "", rooms });
    }
  } catch {
    // Names are polish, never a reason to skip a reminder.
  }
  return out;
}

export function bookingReminderHeadline(
  kind: "check_in" | "check_out",
  stay: Pick<Stay, "guestName" | "checkInKey" | "checkOutKey" | "reservationCode">,
  place: { property: string; room?: string },
): string {
  const where = [place.property, place.room].filter(Boolean);
  const dates = stayLabel(stay.checkInKey, stay.checkOutKey).replace(/^\w{3}, /, "").replace(/ – \w{3}, /, " – ");
  const code = stay.reservationCode ? [stay.reservationCode] : [];
  return kind === "check_in"
    ? ["Check-in tomorrow", ...where, stay.guestName, ...code, dates].join(" · ")
    : ["Check-out today", ...where, ...code.length ? code : [stay.guestName], stay.checkOutKey ? `room free from ${stayLabel(stay.checkOutKey, null).replace(/^\w{3}, /, "")}` : ""].filter(Boolean).join(" · ");
}

export async function sweepBookingReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  const stays = [...(await channelStays(db)), ...(await leaseStays(db)), ...(await roomDateBlockStays(db))];
  if (stays.length === 0) return 0;

  const managerIds = [...new Set(stays.map((stay) => stay.managerUserId))];
  const [reminderResolver, managerRecipients, placeNames] = await Promise.all([
    loadReminderSettingsResolver(db, managerIds),
    loadManagerReminderRecipients(db, managerIds),
    loadPlaceNames(db, [...new Set(stays.map((stay) => stay.propertyId).filter((id): id is string => Boolean(id)))]),
  ]);

  let queued = 0;
  for (const stay of stays) {
    // A house's own reminder override wins when it has one (PLAN-0916-1040).
    const settings = reminderResolver.resolve(stay.managerUserId, stay.propertyId);
    if (!settings.rules[KIND]?.enabled) continue;

    const checkInIso = bookingCheckInIso(stay.checkInKey);
    const checkOutIso = stay.checkOutKey ? bookingCheckOutIso(stay.checkOutKey) : null;
    const checkInDue = withinHorizon(checkInIso, now);
    const checkOutDue = withinHorizon(checkOutIso, now);
    if (!checkInDue && !checkOutDue) continue;

    const managerRecipient = managerRecipients.get(stay.managerUserId);
    const team = teamReminderRecipients(
      await loadTeamReminderRecipients(db, stay.managerUserId, settings.rules[KIND].teamUserIds ?? [], {
        module: REMINDER_SUBJECT_CO_MANAGER_MODULE[KIND],
        propertyId: stay.propertyId,
      }),
    );
    const recipients = [
      ...(managerRecipient
        ? [{ email: managerRecipient.email, role: "manager" as const, name: managerRecipient.name, userId: stay.managerUserId }]
        : []),
      ...team,
    ];
    const names = stay.propertyId ? placeNames.get(stay.propertyId) : undefined;
    const place = {
      property: names?.property || stay.propertyLabel,
      room: (stay.roomId ? names?.rooms.get(stay.roomId) : undefined) ?? stay.roomLabel,
    };
    const url = stay.recordKey ? bookingRecordUrl(origin, stay.recordKey) : `${origin}/portal/bookings/upcoming`;
    const payload = {
      title: `${stay.guestName} at ${stay.propertyLabel}`,
      whenLabel: stayLabel(stay.checkInKey, stay.checkOutKey),
      propertyLabel: stay.propertyLabel,
      counterpartyName: stay.guestName,
      url,
      notificationCategory: "leases" as const,
    };

    if (checkInDue) {
      queued += await materializeReminders(
        db,
        {
          managerUserId: stay.managerUserId,
          kind: KIND,
          subjectId: stay.subjectId,
          anchorIso: checkInIso!,
          recipients,
          payload: { ...payload, headline: bookingReminderHeadline("check_in", stay, place) },
        },
        settings,
        now,
      );
    }
    if (checkOutDue) {
      // Morning of check-out: same rule (on/off, audience), its own anchor and subject id so the two
      // reminders dedupe independently and a re-sweep never double-sends either.
      const rule = settings.rules[KIND];
      queued += await materializeReminders(
        db,
        {
          managerUserId: stay.managerUserId,
          kind: KIND,
          subjectId: `${stay.subjectId}:out`,
          anchorIso: checkOutIso!,
          recipients,
          payload: { ...payload, headline: bookingReminderHeadline("check_out", stay, place) },
        },
        { ...settings, rules: { ...settings.rules, [KIND]: { ...rule, leadMinutes: [5], timings: ["before:5"] } } },
        now,
      );
    }
  }
  return queued;
}
