/**
 * Stay times -> the guest's two timed texts (bookings-times-1018).
 *
 *   stay_arrival_guide      24 h before the stay's REAL check-in (`bookingTimeline(...).arrivalGuideAt`):
 *                           check-in time, door/gate code, Wi-Fi, parking, house rules, a link to
 *                           the guest's Stays page.
 *   stay_checkout_reminder  08:00 on checkout day (an hour before an earlier checkout):
 *                           "Checkout is at 11:00 am today", the paid late time when bought.
 *
 * Both go to ONE person: the guest of a CONFIRMED short stay who has a login
 * (`row_data.residentUserId`), in their own 1:1 thread with the manager. Never a hold, a cancelled
 * stay, a stay with no login, a teammate, a group or a prospect. The door code is built from the
 * property's `houseInfo` at SEND time and never written into the queued row's payload.
 *
 * Anchors are the check-in / check-out INSTANTS (property wall time through the property's own
 * zone), and the lead is the exact gap `bookingTimeline` gives, so a paid early check-in or late
 * checkout moves the send with it. The subject id carries the stay's times: a stay whose times
 * moved is a different subject (a re-sweep never double-sends the old copy), and the currency check
 * refuses the stale row at send time. Quiet hours are the workspace's shared window (21:00-08:00
 * Pacific): a guide due at 3 am waits until 8 am, still ahead of check-in; one that would slide past
 * check-in is dropped, never sent late.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  buildArrivalGuideSmsText,
  buildArrivalGuideText,
  buildCheckoutReminderText,
} from "@/lib/bookings/arrival-guide";
import { propertyStayClockFromRecord, type PropertyStayClock } from "@/lib/bookings/property-stay-times.server";
import {
  bookingTimeline,
  formatStayMoment,
  formatStayTime,
  normalizeStayTime,
  resolveStayTimes,
  stayTimeMinutes,
  type BookingTimeline,
  type StayAddOns,
} from "@/lib/bookings/stay-times";
import { houseInfoWithoutInternal, normalizeHouseInfo, type HouseInfoV1 } from "@/lib/house-info";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import { reminderAnchorMatches } from "@/lib/reminders/current.server";
import { materializeReminders, type ReminderQueueRow, type ReminderRecipient } from "@/lib/reminders/queue.server";
import type { ReminderSettings } from "@/lib/reminders/rules";
import { loadReminderSettingsResolver } from "@/lib/reminders/settings.server";
import { hasSmsTestProvenance } from "@/lib/sms/sms-test-provenance";

export const STAY_TIME_REMINDER_KINDS = ["stay_arrival_guide", "stay_checkout_reminder"] as const;
export type StayTimeReminderKind = (typeof STAY_TIME_REMINDER_KINDS)[number];

export function isStayTimeReminderKind(kind: string): kind is StayTimeReminderKind {
  return (STAY_TIME_REMINDER_KINDS as readonly string[]).includes(kind);
}

/** Ceiling on rows examined per sweep, so one tick can never run unbounded. */
const MAX_ROWS = 500;
/** A stay is queued this far ahead of its check-in / checkout; the send itself is at the timeline instant. */
const HORIZON_MS = 7 * 24 * 3_600_000;
/** A stay confirmed after its arrival-guide moment still gets one, this long before check-in. */
const CATCH_UP_LEAD_MINUTES = 60;
const CATCH_UP_MIN_AHEAD_MINUTES = 10;

export type GuestStayRow = {
  blockId: string;
  managerUserId: string;
  propertyId: string;
  roomId: string;
  guestUserId: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  checkInTime: string;
  checkOutTime: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A stay row that qualifies for the guest's texts: a live room-date block, CONFIRMED (a hold is a
 * request nobody has accepted), carrying the guest's login. Null otherwise.
 */
export function guestStayFromRow(
  record: { id?: unknown; manager_user_id?: unknown; property_id?: unknown; record_type?: unknown; row_data?: unknown },
  clock: PropertyStayClock,
): GuestStayRow | null {
  if (record.record_type !== undefined && record.record_type !== ROOM_DATE_BLOCK_RECORD_TYPE) return null;
  const rowData = asRecord(record.row_data);
  if (hasSmsTestProvenance(rowData)) return null;
  if (text(rowData.bookingStatus) !== "confirmed") return null;
  const guestUserId = text(rowData.residentUserId);
  const blockId = text(record.id);
  const managerUserId = text(record.manager_user_id);
  const checkIn = text(rowData.checkIn);
  const checkOut = text(rowData.checkOut);
  if (!guestUserId || !blockId || !managerUserId || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    return null;
  }
  const details = asRecord(rowData.stayDetails);
  const times = resolveStayTimes(
    {
      checkInTime: text(rowData.checkInTime),
      checkOutTime: text(rowData.checkOutTime),
      legacyEarlyCheckIn: text(details.earlyCheckIn),
      legacyLateCheckOut: text(details.lateCheckOut),
    },
    clock.times,
  );
  // A PAID add-on's time is the stay's time even if a writer has not folded it into the stay's own
  // fields yet: earlier than the check-in, later than the checkout, and only once paid.
  const addOns = asRecord(details.addOns) as StayAddOns;
  const paidEarly = addOns.early_check_in?.status === "paid" ? normalizeStayTime(addOns.early_check_in.time) : null;
  const paidLate = addOns.late_check_out?.status === "paid" ? normalizeStayTime(addOns.late_check_out.time) : null;
  const checkInTime =
    paidEarly && stayTimeMinutes(paidEarly) < stayTimeMinutes(times.checkInTime) ? paidEarly : times.checkInTime;
  const checkOutTime =
    paidLate && stayTimeMinutes(paidLate) > stayTimeMinutes(times.checkOutTime) ? paidLate : times.checkOutTime;
  return {
    blockId,
    managerUserId,
    propertyId: text(record.property_id) || text(rowData.propertyId),
    roomId: text(rowData.roomId),
    guestUserId,
    guestName: text(rowData.residentName),
    checkIn,
    checkOut,
    checkInTime,
    checkOutTime,
  };
}

export function stayTimelineFor(stay: GuestStayRow, clock: PropertyStayClock): BookingTimeline {
  return bookingTimeline(stay, { times: clock.times, timeZone: clock.timeZone });
}

/** The reminder subject id: one stay, one moment, the exact time. */
export function stayReminderSubjectId(kind: StayTimeReminderKind, stay: GuestStayRow): string {
  return kind === "stay_arrival_guide"
    ? `block:${stay.blockId}:guide:${stay.checkIn}T${stay.checkInTime}`
    : `block:${stay.blockId}:checkout:${stay.checkOut}T${stay.checkOutTime}`;
}

type PropertyRecord = { id?: unknown; row_data?: unknown; property_data?: unknown };

async function loadProperties(db: SupabaseClient, propertyIds: string[]): Promise<Map<string, PropertyRecord>> {
  const out = new Map<string, PropertyRecord>();
  if (propertyIds.length === 0) return out;
  const { data, error } = await db.from("manager_property_records").select("id, row_data, property_data").in("id", propertyIds);
  if (error) throw error;
  for (const record of (data ?? []) as PropertyRecord[]) out.set(text(record.id), record);
  return out;
}

function propertyLabel(record: PropertyRecord | undefined): string {
  const data = asRecord(record?.property_data);
  return text(data.buildingName) || text(data.title) || "";
}

function houseInfoOf(record: PropertyRecord | undefined): HouseInfoV1 {
  const submission = asRecord(asRecord(record?.property_data).listingSubmission);
  // The staff-only Internal section (pantry / lockbox / mailbox codes) never reaches a guest message.
  return houseInfoWithoutInternal(normalizeHouseInfo(submission.houseInfo));
}

/** The guest's room as the manager named it, with its structured door code (a secret: send time only). */
function roomOf(record: PropertyRecord | undefined, roomId: string): { label: string; doorCode: string } {
  const submission = asRecord(asRecord(record?.property_data).listingSubmission);
  const rooms = Array.isArray(submission.rooms) ? submission.rooms : [];
  const room = rooms.map(asRecord).find((candidate) => text(candidate.id) === roomId);
  return { label: text(room?.name), doorCode: text(room?.doorCode) };
}

/** The house's own checkout steps (trash, keys, lights, anything else), from its Checkout section. */
function checkoutLinesOf(info: HouseInfoV1): string[] {
  return ["trash", "keys", "lights", "other"]
    .map((key) => (info.checkout?.[key] ?? "").trim())
    .filter(Boolean);
}

function staysUrl(): string {
  return `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/resident/applications/approved`;
}

async function loadGuestProfiles(
  db: SupabaseClient,
  userIds: string[],
): Promise<Map<string, { email: string; name: string }>> {
  const out = new Map<string, { email: string; name: string }>();
  if (userIds.length === 0) return out;
  const { data, error } = await db.from("profiles").select("id, email, full_name").in("id", userIds);
  if (error) throw error;
  for (const raw of (data ?? []) as Array<{ id?: unknown; email?: unknown; full_name?: unknown }>) {
    const email = text(raw.email).toLowerCase();
    if (!email.includes("@")) continue;
    out.set(text(raw.id), { email, name: text(raw.full_name) });
  }
  return out;
}

async function hasQueuedReminder(db: SupabaseClient, kind: StayTimeReminderKind, subjectId: string): Promise<boolean> {
  const { data, error } = await db
    .from("portal_reminder_records")
    .select("id")
    .eq("kind", kind)
    .eq("subject_id", subjectId)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

function leadMinutesBetween(anchorIso: string, sendIso: string): number {
  return Math.max(5, Math.round((Date.parse(anchorIso) - Date.parse(sendIso)) / 60_000));
}

/** A rule with the exact lead for THIS stay: the timeline decides when, the rule decides whether and by which channels. */
function withLead(settings: ReminderSettings, kind: StayTimeReminderKind, leadMinutes: number): ReminderSettings {
  const rule = settings.rules[kind];
  return {
    ...settings,
    rules: { ...settings.rules, [kind]: { ...rule, leadMinutes: [leadMinutes], timings: [`before:${leadMinutes}`] } },
  };
}

export async function sweepStayTimeReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 2 * 24 * 3_600_000).toISOString();
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, manager_user_id, property_id, record_type, row_data")
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
    .filter("row_data->>bookingStatus", "eq", "confirmed")
    .not("row_data->>residentUserId", "is", null)
    .gte("ends_at", cutoff)
    .limit(MAX_ROWS);
  if (error) throw error;
  const records = (data ?? []) as Array<Record<string, unknown>>;
  if (records.length === 0) return 0;

  const propertyIds = [...new Set(records.map((record) => text(record.property_id) || text(asRecord(record.row_data).propertyId)).filter(Boolean))];
  const properties = await loadProperties(db, propertyIds);
  const stays: Array<{ stay: GuestStayRow; clock: PropertyStayClock; timeline: BookingTimeline }> = [];
  for (const record of records) {
    const propertyId = text(record.property_id) || text(asRecord(record.row_data).propertyId);
    const clock = propertyStayClockFromRecord((properties.get(propertyId) as PropertyRecord | undefined) ?? null);
    const stay = guestStayFromRow(record, clock);
    if (stay) stays.push({ stay, clock, timeline: stayTimelineFor(stay, clock) });
  }
  if (stays.length === 0) return 0;

  const [resolver, guests] = await Promise.all([
    loadReminderSettingsResolver(db, [...new Set(stays.map((entry) => entry.stay.managerUserId))]),
    loadGuestProfiles(db, [...new Set(stays.map((entry) => entry.stay.guestUserId))]),
  ]);

  let queued = 0;
  for (const { stay, timeline } of stays) {
    const guest = guests.get(stay.guestUserId);
    if (!guest) continue;
    const settings = resolver.resolve(stay.managerUserId, stay.propertyId || null);
    const record = properties.get(stay.propertyId);
    const place = propertyLabel(record);
    const recipients: ReminderRecipient[] = [
      { email: guest.email, role: "counterparty", name: guest.name || stay.guestName || null, userId: stay.guestUserId },
    ];
    const payload = {
      propertyLabel: place,
      propertyId: stay.propertyId,
      counterpartyName: guest.name || stay.guestName,
      url: staysUrl(),
      notificationCategory: "leases" as const,
      stayBlockId: stay.blockId,
    };
    const checkInMs = Date.parse(timeline.checkInAt);
    const checkOutMs = Date.parse(timeline.checkOutAt);

    // ---- arrival guide ----
    if (settings.rules.stay_arrival_guide?.enabled && checkInMs > now.getTime() && checkInMs <= now.getTime() + HORIZON_MS) {
      const subjectId = stayReminderSubjectId("stay_arrival_guide", stay);
      const input = {
        managerUserId: stay.managerUserId,
        kind: "stay_arrival_guide" as const,
        subjectId,
        anchorIso: timeline.checkInAt,
        recipients,
        payload: { ...payload, title: `arrival guide for ${place || "your stay"}`, whenLabel: formatStayMoment(stay.checkIn, stay.checkInTime) },
      };
      if (Date.parse(timeline.arrivalGuideAt) > now.getTime()) {
        queued += await materializeReminders(
          db,
          input,
          withLead(settings, "stay_arrival_guide", leadMinutesBetween(timeline.checkInAt, timeline.arrivalGuideAt)),
          now,
        );
      } else if (
        (checkInMs - now.getTime()) / 60_000 >= CATCH_UP_MIN_AHEAD_MINUTES &&
        !(await hasQueuedReminder(db, "stay_arrival_guide", subjectId))
      ) {
        // Confirmed (or its time moved) after the 24 h mark: the guest still needs the guide, once,
        // shortly before they arrive. The lead is fixed and nothing queues a second row for this
        // subject, so a re-sweep cannot send it twice.
        queued += await materializeReminders(
          db,
          input,
          withLead(
            settings,
            "stay_arrival_guide",
            Math.min(CATCH_UP_LEAD_MINUTES, Math.max(5, Math.floor((checkInMs - now.getTime()) / 60_000) - 5)),
          ),
          now,
        );
      }
    }

    // ---- checkout reminder ----
    if (settings.rules.stay_checkout_reminder?.enabled && checkOutMs > now.getTime() && checkOutMs <= now.getTime() + HORIZON_MS) {
      if (Date.parse(timeline.checkoutReminderAt) > now.getTime()) {
        queued += await materializeReminders(
          db,
          {
            managerUserId: stay.managerUserId,
            kind: "stay_checkout_reminder",
            subjectId: stayReminderSubjectId("stay_checkout_reminder", stay),
            anchorIso: timeline.checkOutAt,
            recipients,
            payload: { ...payload, title: `checkout from ${place || "your stay"}`, whenLabel: formatStayMoment(stay.checkOut, stay.checkOutTime) },
          },
          withLead(settings, "stay_checkout_reminder", leadMinutesBetween(timeline.checkOutAt, timeline.checkoutReminderAt)),
          now,
        );
      }
    }
  }
  return queued;
}

async function loadStayForReminder(
  db: SupabaseClient,
  row: Pick<ReminderQueueRow, "managerUserId" | "payload">,
): Promise<{ stay: GuestStayRow; clock: PropertyStayClock; property: PropertyRecord | undefined } | null> {
  const blockId = text(row.payload.stayBlockId);
  if (!blockId) return null;
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, manager_user_id, property_id, record_type, row_data")
    .eq("id", blockId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const record = data as Record<string, unknown>;
  if (text(record.manager_user_id) !== row.managerUserId) return null;
  const propertyId = text(record.property_id) || text(asRecord(record.row_data).propertyId);
  const properties = await loadProperties(db, propertyId ? [propertyId] : []);
  const property = properties.get(propertyId);
  const clock = propertyStayClockFromRecord(property ?? null);
  const stay = guestStayFromRow(record, clock);
  return stay ? { stay, clock, property } : null;
}

/**
 * Send-time currency: the stay is still a confirmed stay of this guest (not cancelled, not back to
 * a hold, same login), and its check-in / checkout instant is still the one the row was queued for.
 * A stay whose times moved never sends the stale copy.
 */
export async function stayTimeReminderIsCurrent(db: SupabaseClient, row: ReminderQueueRow): Promise<boolean> {
  if (!isStayTimeReminderKind(row.kind) || row.recipientRole !== "counterparty") return false;
  const loaded = await loadStayForReminder(db, row);
  if (!loaded) return false;
  if (text(row.payload.recipientUserId) !== loaded.stay.guestUserId) return false;
  const timeline = stayTimelineFor(loaded.stay, loaded.clock);
  return reminderAnchorMatches(row.payload.anchorIso, row.kind === "stay_arrival_guide" ? timeline.checkInAt : timeline.checkOutAt);
}

export type RenderedStayTimeReminder = {
  subject: string;
  body: string;
  smsText?: string;
  /** The guest's login, re-read from the stay row at send time: the one and only recipient. */
  guestUserId: string;
  propertyId: string;
};

/**
 * The guest's message, built from the house's CURRENT details at send time. The door code is in
 * this text and nowhere in the queue payload; the caller delivers it to this guest alone.
 */
export async function renderStayTimeReminder(db: SupabaseClient, row: ReminderQueueRow): Promise<RenderedStayTimeReminder | null> {
  if (!isStayTimeReminderKind(row.kind)) return null;
  const loaded = await loadStayForReminder(db, row);
  if (!loaded) return null;
  const { stay, property } = loaded;
  const place = propertyLabel(property);
  const url = staysUrl();
  const guestName = text(row.payload.recipientName) || stay.guestName;
  if (row.kind === "stay_arrival_guide") {
    const houseInfo = houseInfoOf(property);
    const room = roomOf(property, stay.roomId);
    const input = {
      checkIn: stay.checkIn,
      checkInTime: stay.checkInTime,
      staysUrl: url,
      guestName,
      propertyLabel: place,
      roomLabel: room.label,
      roomDoorCode: room.doorCode,
      checkOutTime: stay.checkOutTime,
    };
    return {
      subject: place ? `Your arrival guide for ${place}` : "Your arrival guide",
      body: buildArrivalGuideText(houseInfo, input),
      smsText: buildArrivalGuideSmsText(houseInfo, input),
      guestUserId: stay.guestUserId,
      propertyId: stay.propertyId,
    };
  }
  const body = buildCheckoutReminderText({
    checkOutTime: stay.checkOutTime,
    staysUrl: url,
    guestName,
    propertyLabel: place,
    checkoutLines: checkoutLinesOf(houseInfoOf(property)),
  });
  return {
    subject: `Checkout is at ${formatStayTime(stay.checkOutTime)} today`,
    body,
    guestUserId: stay.guestUserId,
    propertyId: stay.propertyId,
  };
}
