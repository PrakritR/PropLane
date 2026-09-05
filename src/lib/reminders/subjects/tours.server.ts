/**
 * Tours → the reminder queue.
 *
 * This is the subject the spine exists for. `tourReminderSendAtIso()` has always
 * computed the right send time, but the only job draining the table it wrote to
 * runs once a day, so a "30 minutes before" tour reminder was delivered on the
 * next daily tick — after the tour. Queueing here puts tours on the 5-minute
 * dispatcher instead.
 *
 * Planned events live as one array under a single admin record, and each event
 * carries its OWN `managerUserId` — the record is not owned by one manager — so
 * rules are resolved per event rather than per record.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isActivePlannedEvent, type PlannedEvent } from "@/lib/demo-admin-scheduling";
import { materializeReminders } from "@/lib/reminders/queue.server";
import { loadReminderSettingsForManagers } from "@/lib/reminders/settings.server";
import { loadManagerReminderRecipients, loadTeamReminderRecipientsByManager, teamReminderRecipients } from "@/lib/reminders/manager-recipients.server";

const PLANNED_EVENTS_RECORD = "axis_admin_planned_events_v1";
const HORIZON_DAYS = 31;

/**
 * Tours worth reminding about: an active tour, in the future, inside the
 * horizon, with a guest to reach and a manager to send as.
 *
 * A cancelled tour is excluded by `isActivePlannedEvent` rather than by a
 * hand-rolled check, so this agrees with every other reader of the same data.
 */
export function remindableTours(
  events: readonly PlannedEvent[],
  now: Date,
  horizonDays = HORIZON_DAYS,
): PlannedEvent[] {
  const from = now.getTime();
  const to = from + horizonDays * 24 * 60 * 60 * 1000;
  return events.filter((event) => {
    if (event.kind !== "tour") return false;
    if (!isActivePlannedEvent(event)) return false;
    if (!event.managerUserId?.trim()) return false;
    if (!event.attendeeEmail?.trim().includes("@")) return false;
    const ms = Date.parse(event.start ?? "");
    if (!Number.isFinite(ms)) return false;
    return ms > from && ms <= to;
  });
}

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function sweepTourReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_EVENTS_RECORD)
    .maybeSingle();
  if (error) throw error;

  const payload = (data?.row_data as { payload?: unknown } | null)?.payload;
  const events = Array.isArray(payload) ? (payload as PlannedEvent[]) : [];
  const tours = remindableTours(events, now);
  if (tours.length === 0) return 0;

  const managerIds = tours.map((tour) => tour.managerUserId!);
  const [settingsByManager, managerRecipients] = await Promise.all([
    loadReminderSettingsForManagers(db, managerIds),
    loadManagerReminderRecipients(db, managerIds),
  ]);
  const teamRecipientsByManager = await loadTeamReminderRecipientsByManager(
    db,
    managerIds.map((managerUserId) => ({
      managerUserId,
      teamUserIds: settingsByManager.get(managerUserId)?.rules.tour.teamUserIds ?? [],
    })),
  );
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");

  let queued = 0;
  for (const tour of tours) {
    const managerUserId = tour.managerUserId!;
    const settings = settingsByManager.get(managerUserId);
    if (!settings?.rules.tour.enabled) continue;
    const managerRecipient = managerRecipients.get(managerUserId);
    const teamRecipients = settings.rules.tour.audience.team
      ? teamReminderRecipients(teamRecipientsByManager.get(managerUserId) ?? [])
      : [];
    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "tour",
        subjectId: tour.id,
        anchorIso: new Date(Date.parse(tour.start)).toISOString(),
        recipients: [
          ...(managerRecipient
            ? [{ email: managerRecipient.email, role: "manager" as const, name: managerRecipient.name, userId: managerUserId }]
            : []),
          ...teamRecipients,
          {
            email: tour.attendeeEmail!.trim().toLowerCase(),
            role: "counterparty",
            name: tour.attendeeName ?? null,
          },
        ],
        payload: {
          title: tour.title ?? "Tour",
          whenLabel: whenLabel(tour.start),
          propertyLabel: tour.propertyTitle ?? null,
          locationLabel: tour.roomLabel ?? null,
          counterpartyName: tour.attendeeName ?? null,
          notes: tour.instructions ?? tour.notes ?? null,
          url: `${origin}/portal/tours`,
          notificationCategory: "leasing",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}
