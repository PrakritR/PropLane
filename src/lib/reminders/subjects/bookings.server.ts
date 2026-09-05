/**
 * Bookings → the reminder queue.
 *
 * A "booking" on the Bookings page is a dated STAY from one of two sources, and
 * both are swept here so the one Settings switch governs both:
 *
 *  - an imported channel range on `external_calendar_connections` (Airbnb), and
 *  - a PropLane lease's move-in on `portal_lease_pipeline_records`.
 *
 * The anchor is CHECK-IN, not when the booking arrived — a manager preparing a
 * room needs the lead time counted back from the day someone walks in.
 *
 * Manager-side only. A channel iCal feed carries no guest contact, so there is
 * no counterparty address to send to; see the note at the top of `rules.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipients,
  teamReminderRecipients,
} from "@/lib/reminders/manager-recipients.server";
import { materializeReminders } from "@/lib/reminders/queue.server";
import type { ReminderSettings } from "@/lib/reminders/rules";
import { loadReminderSettingsForManagers } from "@/lib/reminders/settings.server";
import { withinHorizon } from "@/lib/reminders/subjects/records.server";
import { zonedWallTimeMs } from "@/lib/tour-slot-math";

const KIND = "booking" as const;
/** Ceiling on rows examined per sweep, so one tick can never run unbounded. */
const MAX_ROWS = 500;
/** Standard check-in hour, Pacific. Stays carry a DATE, not a time. */
const CHECK_IN_HOUR = 15;

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

type Stay = {
  managerUserId: string;
  subjectId: string;
  checkInKey: string;
  checkOutKey: string | null;
  guestName: string;
  propertyId: string | null;
  propertyLabel: string;
};

function str(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Imported channel ranges. One row per linked room, ranges inside it. */
async function channelStays(db: SupabaseClient): Promise<Stay[]> {
  const { data, error } = await db
    .from("external_calendar_connections")
    .select("id, manager_user_id, property_id, room_id, label, imported_ranges")
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
      const end = String(range.end ?? "").trim() || null;
      stays.push({
        managerUserId,
        // Stable across syncs: the same range keeps the same id, so a re-sync
        // dedupes against the reminders already queued rather than doubling them.
        subjectId: `channel:${connectionId}:${String(range.id ?? start).trim()}`,
        checkInKey: start,
        checkOutKey: end,
        guestName: bookingGuestLabel(String(range.summary ?? "")),
        propertyId: str(row, "property_id"),
        propertyLabel: str(row, "label") ?? str(row, "property_id") ?? "your listing",
      });
    }
  }
  return stays;
}

/** PropLane's own stays — a signed lease's move-in date. */
async function leaseStays(db: SupabaseClient): Promise<Stay[]> {
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
    if (!managerUserId || !data_) continue;
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
    });
  }
  return stays;
}

export async function sweepBookingReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  const stays = [...(await channelStays(db)), ...(await leaseStays(db))];
  if (stays.length === 0) return 0;

  const managerIds = [...new Set(stays.map((stay) => stay.managerUserId))];
  const [settingsByManager, managerRecipients] = await Promise.all([
    loadReminderSettingsForManagers(db, managerIds),
    loadManagerReminderRecipients(db, managerIds),
  ]);

  let queued = 0;
  for (const stay of stays) {
    const settings: ReminderSettings | undefined = settingsByManager.get(stay.managerUserId);
    if (!settings?.rules[KIND]?.enabled) continue;

    const anchorIso = bookingCheckInIso(stay.checkInKey);
    if (!withinHorizon(anchorIso, now)) continue;

    const managerRecipient = managerRecipients.get(stay.managerUserId);
    const team = teamReminderRecipients(
      await loadTeamReminderRecipients(db, stay.managerUserId, settings.rules[KIND].teamUserIds ?? [], {
        module: REMINDER_SUBJECT_CO_MANAGER_MODULE[KIND],
        propertyId: stay.propertyId,
      }),
    );

    queued += await materializeReminders(
      db,
      {
        managerUserId: stay.managerUserId,
        kind: KIND,
        subjectId: stay.subjectId,
        anchorIso: anchorIso!,
        recipients: [
          ...(managerRecipient
            ? [
                {
                  email: managerRecipient.email,
                  role: "manager" as const,
                  name: managerRecipient.name,
                  userId: stay.managerUserId,
                },
              ]
            : []),
          ...team,
        ],
        payload: {
          title: `${stay.guestName} at ${stay.propertyLabel}`,
          whenLabel: stayLabel(stay.checkInKey, stay.checkOutKey),
          propertyLabel: stay.propertyLabel,
          counterpartyName: stay.guestName,
          url: `${origin}/portal/bookings/upcoming`,
          notificationCategory: "leases",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}
