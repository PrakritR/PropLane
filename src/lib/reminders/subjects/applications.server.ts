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
    const resumeUrl = inProgressApplicationResumeUrl(origin, entry.row);
    const managerRecipient = managerRecipients.get(entry.managerUserId);
    const teamRecipients = teamReminderRecipients(
      await loadTeamReminderRecipients(db, entry.managerUserId, settings?.rules.application_manager.teamUserIds ?? [], {
        module: REMINDER_SUBJECT_CO_MANAGER_MODULE.application,
        propertyId: entry.row.propertyId ?? null,
      }),
    );
    const payload = {
      title: entry.row.property?.trim() || "Rental application",
      propertyLabel: entry.row.property ?? null,
      counterpartyName: entry.row.name ?? null,
      applicantName: entry.row.name ?? null,
      resumeUrl,
      url: resumeUrl,
      notificationCategory: "leases",
    };

    if (settings?.rules.application.enabled) {
      queued += await materializeReminders(
        db,
        {
          managerUserId: entry.managerUserId,
          kind: "application",
          subjectId: entry.record.id,
          anchorIso: entry.anchorIso,
          recipients: [
            {
              email: entry.applicantEmail,
              role: "counterparty",
              name: entry.row.name ?? null,
            },
          ],
          payload,
        },
        settings,
        now,
      );
    }

    if (settings?.rules.application_manager.enabled) {
      queued += await materializeReminders(
        db,
        {
          managerUserId: entry.managerUserId,
          kind: "application_manager",
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
          ],
          payload: {
            ...payload,
            url: `${origin}/portal/applications`,
          },
        },
        settings,
        now,
      );
    }
  }
  return queued;
}

function whenLabelFromIso(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function hasApplicationForProspect(
  applications: readonly ApplicationRecord[],
  email: string,
  propertyId?: string | null,
): boolean {
  const normalized = email.toLowerCase();
  return applications.some((record) => {
    const row = hydrateApplicationRow(record);
    const rowEmail = (row.email?.trim() || record.resident_email?.trim() || "").toLowerCase();
    if (rowEmail !== normalized) return false;
    if (propertyId?.trim() && row.propertyId?.trim() && row.propertyId.trim() !== propertyId.trim()) {
      return false;
    }
    if (String(row.bucket ?? "") === "withdrawn") return false;
    return true;
  });
}

const PLANNED_EVENTS_RECORD = "axis_admin_planned_events_v1";
const POST_TOUR_MAX_AGE_DAYS = 60;

function tourEndedAnchorIso(
  event: { end?: string; start?: string },
  now: Date,
): string | null {
  const endIso = event.end?.trim() || event.start?.trim() || "";
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(endMs) || endMs > now.getTime()) return null;
  if (now.getTime() - endMs > POST_TOUR_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) return null;
  return new Date(endMs).toISOString();
}

/** Completed tours with no application yet → post-tour apply-link reminders. */
export async function sweepApplicationPostTourReminders(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<number> {
  const { data: scheduleData, error: scheduleError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_EVENTS_RECORD)
    .maybeSingle();
  if (scheduleError) throw scheduleError;

  const payload = (scheduleData?.row_data as { payload?: unknown } | null)?.payload;
  const events = Array.isArray(payload) ? payload : [];
  const endedTours = events.filter((event) => {
    if (!event || typeof event !== "object") return false;
    const row = event as Record<string, unknown>;
    if (row.kind !== "tour") return false;
    if (String(row.canceledAt ?? "").trim()) return false;
    if (!String(row.managerUserId ?? "").trim()) return false;
    const email = String(row.attendeeEmail ?? "").trim().toLowerCase();
    if (!email.includes("@")) return false;
    return tourEndedAnchorIso({ end: String(row.end ?? ""), start: String(row.start ?? "") }, now) !== null;
  });
  if (endedTours.length === 0) return 0;

  const { data: appData, error: appError } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, resident_email, row_data, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(MAX_ROWS);
  if (appError) throw appError;
  const applications = (appData ?? []).filter(
    (row): row is ApplicationRecord =>
      typeof (row as { id?: unknown }).id === "string" &&
      Boolean((row as { row_data?: unknown }).row_data),
  );

  const managerIds = endedTours.map((event) => String((event as Record<string, unknown>).managerUserId));
  const settingsByManager = await loadReminderSettingsForManagers(db, managerIds);
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  const { buildTourApplyUrl } = await import("@/lib/tour-notifications");

  let queued = 0;
  for (const event of endedTours) {
    const row = event as Record<string, unknown>;
    const managerUserId = String(row.managerUserId ?? "").trim();
    const settings = settingsByManager.get(managerUserId);
    if (!settings?.rules.application_post_tour.enabled) continue;
    const anchorIso = tourEndedAnchorIso(
      { end: String(row.end ?? ""), start: String(row.start ?? "") },
      now,
    );
    if (!anchorIso) continue;
    const email = String(row.attendeeEmail ?? "").trim().toLowerCase();
    const propertyId = String(row.propertyId ?? "").trim() || null;
    if (hasApplicationForProspect(applications, email, propertyId)) continue;

    const applyUrl = buildTourApplyUrl(origin, propertyId, String(row.roomLabel ?? "") || null);
    const tourStart = String(row.start ?? "");
    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "application_post_tour",
        subjectId: String(row.id ?? ""),
        anchorIso,
        recipients: [
          {
            email,
            role: "counterparty",
            name: String(row.attendeeName ?? "").trim() || null,
          },
        ],
        payload: {
          title: String(row.propertyTitle ?? "").trim() || "Property tour",
          propertyLabel: String(row.propertyTitle ?? "").trim() || null,
          counterpartyName: String(row.attendeeName ?? "").trim() || null,
          applicantName: String(row.attendeeName ?? "").trim() || null,
          applyUrl,
          url: applyUrl,
          whenLabel: tourStart ? whenLabelFromIso(tourStart) : null,
          tourTime: tourStart ? whenLabelFromIso(tourStart) : null,
          notificationCategory: "leases",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}
