/**
 * Work orders and service orders → the reminder queue.
 *
 * Unlike tasks (one JSON blob per manager), these are per-row tables with
 * `manager_user_id` and `resident_email` as real columns, so each sweep is a
 * single bounded read rather than a walk over blobs.
 *
 * Both anchors are stored inside `row_data`, which Postgres cannot index here,
 * so the window is applied in JS after a bounded fetch. That is affordable
 * because the row counts are small and the query is capped; if either table
 * grows, promote the anchor to a column and filter in SQL.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { materializeReminders } from "@/lib/reminders/queue.server";
import type { ReminderSettings, ReminderSubjectKind } from "@/lib/reminders/rules";
import { loadReminderSettingsForManagers } from "@/lib/reminders/settings.server";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipients,
  teamReminderRecipients,
} from "@/lib/reminders/manager-recipients.server";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";

const HORIZON_DAYS = 31;
/** Ceiling on rows examined per sweep, so one tick can never run unbounded. */
const MAX_ROWS = 500;

type RecordRow = { manager_user_id: string; resident_email: string | null; row_data: Record<string, unknown> };

/** ISO if the value parses to a real instant, else null. Empty string is "unset". */
export function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // "—" is the display placeholder these records use for "not scheduled".
  if (!trimmed || trimmed === "—") return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Inside the reminder window: strictly ahead of now, not past the horizon. */
export function withinHorizon(anchorIso: string | null, now: Date, horizonDays = HORIZON_DAYS): boolean {
  if (!anchorIso) return false;
  const ms = Date.parse(anchorIso);
  if (!Number.isFinite(ms)) return false;
  return ms > now.getTime() && ms <= now.getTime() + horizonDays * 24 * 60 * 60 * 1000;
}

function whenLabel(anchorIso: string): string {
  return new Date(anchorIso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function str(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function sweepRecordTable(
  db: SupabaseClient,
  table: string,
  kind: ReminderSubjectKind,
  now: Date,
  read: (row: RecordRow) => {
    subjectId: string | null;
    anchorIso: string | null;
    title: string | null;
    propertyLabel: string | null;
    propertyId: string | null;
    residentName: string | null;
    notes: string | null;
    url: string;
    active: boolean;
  },
): Promise<number> {
  const { data, error } = await db
    .from(table)
    .select("manager_user_id, resident_email, row_data")
    .limit(MAX_ROWS);
  if (error) throw error;

  const rows = (data ?? []).filter(
    (row): row is RecordRow =>
      typeof (row as { manager_user_id?: unknown }).manager_user_id === "string" &&
      Boolean((row as { row_data?: unknown }).row_data),
  );
  if (rows.length === 0) return 0;

  const managerIds = rows.map((row) => row.manager_user_id);
  const [settingsByManager, managerRecipients] = await Promise.all([
    loadReminderSettingsForManagers(db, managerIds),
    loadManagerReminderRecipients(db, managerIds),
  ]);

  let queued = 0;
  for (const row of rows) {
    const settings: ReminderSettings | undefined = settingsByManager.get(row.manager_user_id);
    if (!settings?.rules[kind]?.enabled) continue;
    const managerRecipient = managerRecipients.get(row.manager_user_id);

    const parsed = read(row);
    if (!parsed.subjectId || !parsed.active) continue;
    if (!withinHorizon(parsed.anchorIso, now)) continue;

    const teamRecipients = teamReminderRecipients(
      await loadTeamReminderRecipients(
        db,
        row.manager_user_id,
        settings.rules[kind].teamUserIds ?? [],
        {
          module: REMINDER_SUBJECT_CO_MANAGER_MODULE[kind],
          propertyId: parsed.propertyId,
        },
      ),
    );

    const residentEmail = (row.resident_email ?? "").trim().toLowerCase();
    const hasResidentRecipient = residentEmail.includes("@");

    queued += await materializeReminders(
      db,
      {
        managerUserId: row.manager_user_id,
        kind,
        subjectId: parsed.subjectId,
        anchorIso: parsed.anchorIso!,
        recipients: [
          ...(managerRecipient
            ? [{ email: managerRecipient.email, role: "manager" as const, name: managerRecipient.name, userId: row.manager_user_id }]
            : []),
          ...teamRecipients,
          ...(hasResidentRecipient
            ? [{ email: residentEmail, role: "counterparty" as const, name: parsed.residentName }]
            : []),
        ],
        payload: {
          title: parsed.title,
          whenLabel: whenLabel(parsed.anchorIso!),
          propertyLabel: parsed.propertyLabel,
          counterpartyName: parsed.residentName,
          notes: parsed.notes,
          url: parsed.url,
          notificationCategory: "maintenance",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

/** Maintenance visits: the anchor is the scheduled visit, not when it was raised. */
export async function sweepWorkOrderReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  return sweepRecordTable(db, "portal_work_order_records", "work_order", now, (row) => ({
    subjectId: str(row.row_data, "id"),
    // `scheduledAtIso` is the machine anchor; `scheduled` is only a display label.
    anchorIso: isoOrNull(row.row_data.scheduledAtIso),
    title: str(row.row_data, "title"),
    propertyLabel: str(row.row_data, "propertyName"),
    propertyId: str(row.row_data, "propertyId"),
    residentName: str(row.row_data, "residentName"),
    notes: str(row.row_data, "description"),
    url: `${origin}/portal/services`,
    active: str(row.row_data, "bucket") !== "completed" && str(row.row_data, "status") !== "Completed",
  }));
}

/**
 * Add-on services: the anchor is the return-by date.
 *
 * A request with no deposit stores an empty `returnByDate`, which reads as
 * "no date" rather than a bad one — those simply produce no reminder.
 */
export async function sweepServiceOrderReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  return sweepRecordTable(db, "portal_service_request_records", "service_order", now, (row) => ({
    subjectId: str(row.row_data, "id"),
    anchorIso: isoOrNull(row.row_data.returnByDate),
    title: str(row.row_data, "offerName"),
    propertyLabel: null,
    propertyId: str(row.row_data, "propertyId"),
    residentName: str(row.row_data, "residentName"),
    notes: str(row.row_data, "notes"),
    url: `${origin}/portal/services`,
    active: str(row.row_data, "status") === "approved",
  }));
}
