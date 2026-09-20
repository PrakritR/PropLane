/**
 * Tours and applications → the reminder queue (PLAN-0915 phase 3).
 *
 *   tour_request_unanswered        manager, after the request came in, still pending
 *   tour_request_reoffer           guest, after the request came in, still pending
 *   tour_no_show_manager           manager, after a tour ended, asking whether it happened
 *   application_decision_manager   manager, after submit, still pending
 *   application_no_lease_manager   manager, after approval, no lease row yet
 *
 * Tour requests live as one array under an admin record (`INQUIRIES_RECORD_ID`),
 * planned tours under another (`axis_admin_planned_events_v1`); each row carries
 * its own `managerUserId`, so rules resolve per row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isActivePlannedEvent, type PlannedEvent } from "@/lib/demo-admin-scheduling";
import { INQUIRIES_RECORD_ID, rowsFromRecord } from "@/lib/tour-inquiry.server";
import { materializeReminders, type ReminderRecipient } from "@/lib/reminders/queue.server";
import type { ReminderSettings, ReminderSubjectKind } from "@/lib/reminders/rules";
import {
  createSettingsScopeCache,
  resolveReminderSettingsForRow,
} from "@/lib/reminders/settings.server";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipients,
  teamReminderRecipients,
} from "@/lib/reminders/manager-recipients.server";
import { REMINDER_SUBJECT_CO_MANAGER_MODULE } from "@/lib/co-manager-notification-recipients.server";

const PLANNED_EVENTS_RECORD = "axis_admin_planned_events_v1";
const MAX_ROWS = 1000;

function origin(): string {
  return resolveEmailLinkBaseUrl().replace(/\/$/, "");
}

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function iso(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function withinDays(anchorIso: string, now: Date, days: number): boolean {
  return now.getTime() - Date.parse(anchorIso) <= days * 24 * 60 * 60_000;
}

async function managerSide(
  db: SupabaseClient,
  managerUserId: string,
  kind: ReminderSubjectKind,
  settings: ReminderSettings,
  managerRecipients: Map<string, { email: string; name: string | null }>,
  propertyId: string | null,
): Promise<ReminderRecipient[]> {
  const out: ReminderRecipient[] = [];
  const manager = managerRecipients.get(managerUserId);
  if (manager) out.push({ email: manager.email, role: "manager", name: manager.name, userId: managerUserId });
  const rule = settings.rules[kind];
  if (rule.audience.team) {
    out.push(
      ...teamReminderRecipients(
        await loadTeamReminderRecipients(db, managerUserId, rule.teamUserIds ?? [], { module: REMINDER_SUBJECT_CO_MANAGER_MODULE[kind], propertyId }),
      ),
    );
  }
  return out;
}

/** Pending tour requests: the manager chased, then the guest offered other times. */
export async function sweepTourRequestReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db.from("portal_schedule_records").select("row_data").eq("id", INQUIRIES_RECORD_ID).maybeSingle();
  if (error) throw error;
  const rows = rowsFromRecord(data?.row_data).filter(
    (row) => String(row.kind ?? "") === "tour" && String(row.status ?? "") === "pending" && String(row.managerUserId ?? "").trim(),
  );
  if (rows.length === 0) return 0;
  const managerIds = rows.map((row) => String(row.managerUserId));
  const cache = createSettingsScopeCache();
  const managerRecipients = await loadManagerReminderRecipients(db, managerIds);
  let queued = 0;
  for (const row of rows) {
    const managerUserId = String(row.managerUserId);
    const propertyId = String(row.propertyId ?? "").trim() || null;
    // A house with its own reminder rules gets them; a request with no
    // property, or an un-customized house, falls through workspace then account.
    const settings = await resolveReminderSettingsForRow(db, cache, managerUserId, propertyId);
    const anchorIso = iso(row.createdAt);
    if (!anchorIso || !withinDays(anchorIso, now, 14)) continue;
    const guestEmail = String(row.email ?? "").trim().toLowerCase();
    const guestName = String(row.name ?? "").trim() || "A guest";
    const requested = iso(row.proposedStart);
    const payload = {
      title: "tour request",
      propertyLabel: String(row.propertyTitle ?? "").trim() || null,
      counterpartyName: guestName,
      whenLabel: requested ? whenLabel(requested) : "the requested time",
      notificationCategory: "tours",
    };
    if (settings.rules.tour_request_unanswered.enabled) {
      const recipients = await managerSide(db, managerUserId, "tour_request_unanswered", settings, managerRecipients, propertyId);
      if (recipients.length) {
        queued += await materializeReminders(
          db,
          { managerUserId, kind: "tour_request_unanswered", subjectId: String(row.id), anchorIso, recipients, payload: { ...payload, url: `${origin()}/portal/tours` } },
          settings,
          now,
        );
      }
    }
    if (settings.rules.tour_request_reoffer.enabled && guestEmail.includes("@")) {
      queued += await materializeReminders(
        db,
        {
          managerUserId,
          kind: "tour_request_reoffer",
          subjectId: String(row.id),
          anchorIso,
          recipients: [{ email: guestEmail, role: "counterparty", name: guestName }],
          payload: { ...payload, url: `${origin()}/tour${propertyId ? `?property=${encodeURIComponent(propertyId)}` : ""}` },
        },
        settings,
        now,
      );
    }
  }
  return queued;
}

/** A tour that ended: ask the manager whether it happened. */
export async function sweepTourNoShowPrompts(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db.from("portal_schedule_records").select("row_data").eq("id", PLANNED_EVENTS_RECORD).maybeSingle();
  if (error) throw error;
  const payload = (data?.row_data as { payload?: unknown } | null)?.payload;
  const events = (Array.isArray(payload) ? (payload as PlannedEvent[]) : []).filter((event) => {
    if (event.kind !== "tour" || !isActivePlannedEvent(event) || !event.managerUserId?.trim()) return false;
    const end = Date.parse(event.end ?? event.start ?? "");
    // Ended in the last two days, or ends within the next day (the reminder is queued ahead).
    return Number.isFinite(end) && end > now.getTime() - 2 * 24 * 60 * 60_000 && end < now.getTime() + 24 * 60 * 60_000;
  });
  if (events.length === 0) return 0;
  const managerIds = events.map((event) => event.managerUserId!);
  const cache = createSettingsScopeCache();
  const managerRecipients = await loadManagerReminderRecipients(db, managerIds);
  let queued = 0;
  for (const event of events) {
    const managerUserId = event.managerUserId!;
    // A house with its own reminder rules gets them; a tour with no property,
    // or an un-customized house, falls through workspace then account (phase C).
    const settings = await resolveReminderSettingsForRow(db, cache, managerUserId, event.propertyId ?? null);
    if (!settings.rules.tour_no_show_manager.enabled) continue;
    const anchorIso = iso(event.end ?? event.start);
    if (!anchorIso) continue;
    const recipients = await managerSide(db, managerUserId, "tour_no_show_manager", settings, managerRecipients, event.propertyId ?? null);
    if (recipients.length === 0) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "tour_no_show_manager",
        subjectId: event.id,
        anchorIso,
        recipients,
        payload: {
          title: event.title ?? "Tour",
          propertyLabel: event.propertyTitle ?? null,
          counterpartyName: event.attendeeName ?? null,
          whenLabel: whenLabel(new Date(Date.parse(event.start)).toISOString()),
          url: `${origin()}/portal/tours`,
          notificationCategory: "tours",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

type ApplicationRecord = { id: string; manager_user_id: string | null; resident_email: string | null; created_at: string; updated_at: string; row_data: Record<string, unknown> };

/** Applications waiting on a decision, and approvals with no lease yet. */
export async function sweepApplicationEscalations(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, resident_email, created_at, updated_at, row_data")
    .limit(MAX_ROWS);
  if (error) throw error;
  const rows = ((data ?? []) as ApplicationRecord[]).filter((row) => row.row_data && !row.row_data.withdrawnAt && String(row.manager_user_id ?? "").trim());
  const pending = rows.filter((row) => String(row.row_data.bucket ?? "") === "pending" && !row.row_data.manuallyAdded);
  const approved = rows.filter((row) => String(row.row_data.bucket ?? "") === "approved" && !row.row_data.manuallyAdded);
  if (pending.length === 0 && approved.length === 0) return 0;
  const managerIds = [...pending, ...approved].map((row) => String(row.manager_user_id));
  const cache = createSettingsScopeCache();
  const managerRecipients = await loadManagerReminderRecipients(db, managerIds);

  // Which approved applications already have a lease row.
  const approvedIds = approved.map((row) => row.id);
  const withLease = new Set<string>();
  if (approvedIds.length) {
    const { data: leases } = await db.from("portal_lease_pipeline_records").select("row_data").in("row_data->>axisId", approvedIds).limit(MAX_ROWS);
    for (const lease of leases ?? []) withLease.add(String((lease.row_data as { axisId?: string })?.axisId ?? ""));
  }

  let queued = 0;
  for (const row of pending) {
    const managerUserId = String(row.manager_user_id);
    const propertyId = String(row.row_data.assignedPropertyId ?? row.row_data.propertyId ?? "").trim() || null;
    // A house with its own reminder rules gets them; an application with no
    // property, or an un-customized house, falls through workspace then account.
    const settings = await resolveReminderSettingsForRow(db, cache, managerUserId, propertyId);
    if (!settings.rules.application_decision_manager.enabled) continue;
    const anchorIso = iso(row.created_at);
    if (!anchorIso || !withinDays(anchorIso, now, 30)) continue;
    const recipients = await managerSide(db, managerUserId, "application_decision_manager", settings, managerRecipients, propertyId);
    if (recipients.length === 0) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "application_decision_manager",
        subjectId: row.id,
        anchorIso,
        recipients,
        payload: { title: "application", propertyLabel: String(row.row_data.property ?? "").trim() || null, counterpartyName: String(row.row_data.name ?? "").trim() || "An applicant", url: `${origin()}/portal/applications`, notificationCategory: "applications" },
      },
      settings,
      now,
    );
  }
  for (const row of approved) {
    if (withLease.has(row.id)) continue;
    const managerUserId = String(row.manager_user_id);
    const propertyId = String(row.row_data.assignedPropertyId ?? row.row_data.propertyId ?? "").trim() || null;
    // A house with its own reminder rules gets them; an application with no
    // property, or an un-customized house, falls through workspace then account.
    const settings = await resolveReminderSettingsForRow(db, cache, managerUserId, propertyId);
    if (!settings.rules.application_no_lease_manager.enabled) continue;
    const anchorIso = iso(row.row_data.approvedAt) ?? iso(row.updated_at);
    if (!anchorIso || !withinDays(anchorIso, now, 30)) continue;
    const recipients = await managerSide(db, managerUserId, "application_no_lease_manager", settings, managerRecipients, propertyId);
    if (recipients.length === 0) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "application_no_lease_manager",
        subjectId: row.id,
        anchorIso,
        recipients,
        payload: { title: "application", propertyLabel: String(row.row_data.property ?? "").trim() || null, counterpartyName: String(row.row_data.name ?? "").trim() || "An applicant", url: `${origin()}/portal/leases`, notificationCategory: "applications" },
      },
      settings,
      now,
    );
  }
  return queued;
}
