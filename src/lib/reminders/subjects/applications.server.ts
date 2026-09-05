/**
 * Incomplete rental applications → the reminder queue.
 *
 * Uses directional "after" timings from the application-started anchor so a
 * manager can nudge applicants who never submitted, without hooking every
 * draft autosave path.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipients,
  teamReminderRecipients,
} from "@/lib/reminders/manager-recipients.server";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";
import { materializeReminders } from "@/lib/reminders/queue.server";
import { loadReminderSettingsForManagers } from "@/lib/reminders/settings.server";
import {
  inProgressApplicationResumeUrl,
  shouldOfferApplicationCompletionReminder,
} from "@/lib/rental-application/in-progress-application";

const MAX_ROWS = 500;
/** Ignore stale drafts that have not moved in months. */
const MAX_AGE_DAYS = 120;

type ApplicationRecord = {
  id: string;
  manager_user_id: string | null;
  resident_email: string | null;
  row_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function hydrateApplicationRow(record: ApplicationRecord): DemoApplicantRow {
  const row = record.row_data as DemoApplicantRow;
  const email = row.email?.trim() || record.resident_email?.trim() || row.email;
  const propertyId =
    row.propertyId?.trim() ||
    (record as { property_id?: string | null }).property_id?.trim() ||
    row.propertyId;
  return {
    ...row,
    id: row.id?.trim() || record.id,
    bucket: row.bucket ?? "pending",
    ...(email ? { email } : {}),
    ...(propertyId ? { propertyId } : {}),
    managerUserId: row.managerUserId ?? record.manager_user_id,
  };
}

function applicationAnchorIso(record: ApplicationRecord): string | null {
  const raw = record.created_at?.trim() || record.updated_at?.trim() || "";
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function withinAge(anchorIso: string, now: Date, maxAgeDays = MAX_AGE_DAYS): boolean {
  const ms = Date.parse(anchorIso);
  if (!Number.isFinite(ms)) return false;
  return now.getTime() - ms <= maxAgeDays * 24 * 60 * 60 * 1000;
}

export async function sweepApplicationReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, resident_email, row_data, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;

  const rows = (data ?? []).filter(
    (row): row is ApplicationRecord =>
      typeof (row as { id?: unknown }).id === "string" &&
      Boolean((row as { row_data?: unknown }).row_data),
  );
  if (rows.length === 0) return 0;

  const candidates = rows
    .map((record) => {
      const row = hydrateApplicationRow(record);
      const managerUserId = String(record.manager_user_id ?? row.managerUserId ?? "").trim();
      const anchorIso = applicationAnchorIso(record);
      if (!managerUserId || !anchorIso || !withinAge(anchorIso, now)) return null;
      if (!shouldOfferApplicationCompletionReminder(row)) return null;
      const applicantEmail = (row.email?.trim() || record.resident_email?.trim() || "").toLowerCase();
      if (!applicantEmail.includes("@")) return null;
      return { record, row, managerUserId, anchorIso, applicantEmail };
    })
    .filter(Boolean) as Array<{
    record: ApplicationRecord;
    row: DemoApplicantRow;
    managerUserId: string;
    anchorIso: string;
    applicantEmail: string;
  }>;
  if (candidates.length === 0) return 0;

  const managerIds = candidates.map((entry) => entry.managerUserId);
  const [settingsByManager, managerRecipients] = await Promise.all([
    loadReminderSettingsForManagers(db, managerIds),
    loadManagerReminderRecipients(db, managerIds),
  ]);
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");

  let queued = 0;
  for (const entry of candidates) {
    const settings = settingsByManager.get(entry.managerUserId);
    if (!settings?.rules.application.enabled) continue;
    const managerRecipient = managerRecipients.get(entry.managerUserId);
    const teamRecipients = teamReminderRecipients(
      await loadTeamReminderRecipients(db, entry.managerUserId, settings.rules.application.teamUserIds ?? [], {
        module: REMINDER_SUBJECT_CO_MANAGER_MODULE.application,
        propertyId: entry.row.propertyId ?? null,
      }),
    );
    const resumeUrl = inProgressApplicationResumeUrl(origin, entry.row);

    queued += await materializeReminders(
      db,
      {
        managerUserId: entry.managerUserId,
        kind: "application",
        subjectId: entry.record.id,
        anchorIso: entry.anchorIso,
        recipients: [
          ...(managerRecipient
            ? [
                {
                  email: managerRecipient.email,
                  role: "manager" as const,
                  name: managerRecipient.name,
                  userId: entry.managerUserId,
                },
              ]
            : []),
          ...teamRecipients,
          {
            email: entry.applicantEmail,
            role: "counterparty",
            name: entry.row.name ?? null,
          },
        ],
        payload: {
          title: entry.row.property?.trim() || "Rental application",
          propertyLabel: entry.row.property ?? null,
          counterpartyName: entry.row.name ?? null,
          applicantName: entry.row.name ?? null,
          resumeUrl,
          url: resumeUrl,
          notificationCategory: "leases",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}
