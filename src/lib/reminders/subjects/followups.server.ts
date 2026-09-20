/**
 * Phase-4 follow-ups → the reminder queue (PLAN-0915).
 *
 *   task_overdue         assignee + manager, after a task's due moment passed, still open
 *   document_signature   the signer, after a signature was requested, still pending
 *   resident_welcome     a new resident account, days after it was created (off by default)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { materializeReminders, type ReminderRecipient } from "@/lib/reminders/queue.server";
import {
  createSettingsScopeCache,
  resolveReminderSettingsForRow,
} from "@/lib/reminders/settings.server";
import { loadManagerReminderRecipients } from "@/lib/reminders/manager-recipients.server";
import { assigneeEmail } from "@/lib/manager-default-tasks.server";
import { normalizeAssignee } from "@/lib/work-assignment";

const MAX_ROWS = 500;

function origin(): string {
  return resolveEmailLinkBaseUrl().replace(/\/$/, "");
}

function iso(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Tasks past due and still open: the assignee and the manager, once. */
export async function sweepTaskOverdue(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("manager_user_id, row_data")
    .eq("record_type", "manager_tasks")
    .limit(MAX_ROWS);
  if (error) throw error;
  const entries: { managerUserId: string; task: Record<string, unknown> }[] = [];
  for (const row of data ?? []) {
    const managerUserId = String(row.manager_user_id ?? "").trim();
    const tasks = (row.row_data as { tasks?: unknown } | null)?.tasks;
    if (!managerUserId || !Array.isArray(tasks)) continue;
    for (const task of tasks as Record<string, unknown>[]) {
      if (task.completed === true) continue;
      const due = iso(task.start ?? task.dueDate);
      // Due in the last 14 days, or due within the next day (queued ahead).
      if (!due) continue;
      const ms = Date.parse(due);
      if (ms < now.getTime() - 14 * 24 * 60 * 60_000 || ms > now.getTime() + 24 * 60 * 60_000) continue;
      entries.push({ managerUserId, task });
    }
  }
  if (entries.length === 0) return 0;
  const managerIds = entries.map((entry) => entry.managerUserId);
  const cache = createSettingsScopeCache();
  const managerRecipients = await loadManagerReminderRecipients(db, managerIds);
  let queued = 0;
  for (const { managerUserId, task } of entries) {
    const propertyId = typeof task.propertyId === "string" ? task.propertyId.trim() || null : null;
    // A house with its own reminder rules gets them; a task with no property, or
    // an un-customized house, falls through workspace then account (phase C).
    const settings = await resolveReminderSettingsForRow(db, cache, managerUserId, propertyId);
    const rule = settings.rules.task_overdue;
    if (!rule.enabled) continue;
    const anchorIso = iso(task.start ?? task.dueDate)!;
    const assignee = normalizeAssignee(task.assignee);
    const recipients: ReminderRecipient[] = [];
    const manager = managerRecipients.get(managerUserId);
    if (rule.audience.manager && manager) recipients.push({ email: manager.email, role: "manager", name: manager.name, userId: managerUserId });
    if (rule.audience.counterparty && assignee) {
      const address = await assigneeEmail(db, assignee);
      if (address && address !== manager?.email) {
        recipients.push({ email: address, role: assignee.type === "team" ? "manager" : "counterparty", userId: assignee.type === "team" ? assignee.id : null, name: assignee.name });
      }
    }
    if (recipients.length === 0) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "task_overdue",
        subjectId: String(task.id),
        anchorIso,
        recipients,
        payload: {
          title: String(task.title ?? "Task"),
          counterpartyName: assignee?.name ?? null,
          dueDateLabel: new Date(anchorIso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" }),
          url: `${origin()}/portal/tasks`,
          notificationCategory: "messages",
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

/** A document whose signature was requested and is still pending. */
export async function sweepDocumentSignatureReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const { data, error } = await db
    .from("manager_documents")
    .select("id, manager_user_id, display_name, property_id, resident_user_id, resident_email, signature_requested_at")
    .eq("signature_status", "pending")
    .is("deleted_at", null)
    .gte("signature_requested_at", since)
    .limit(MAX_ROWS);
  if (error) throw error;
  const rows = (data ?? []).filter((row) => row.manager_user_id && (row.resident_email || row.resident_user_id));
  if (rows.length === 0) return 0;
  const cache = createSettingsScopeCache();
  const userIds = [...new Set(rows.map((row) => row.resident_user_id).filter(Boolean).map(String))];
  const { data: profiles } = userIds.length ? await db.from("profiles").select("id, email, full_name").in("id", userIds) : { data: [] };
  const profileById = new Map((profiles ?? []).map((profile) => [String(profile.id), { email: String(profile.email ?? "").trim().toLowerCase(), name: String(profile.full_name ?? "").trim() }]));
  let queued = 0;
  for (const row of rows) {
    const managerUserId = String(row.manager_user_id);
    const propertyId = typeof row.property_id === "string" ? row.property_id.trim() || null : null;
    // A house with its own reminder rules gets them; a document with no property,
    // or an un-customized house, falls through workspace then account (phase C).
    const settings = await resolveReminderSettingsForRow(db, cache, managerUserId, propertyId);
    if (!settings.rules.document_signature.enabled) continue;
    const anchorIso = iso(row.signature_requested_at);
    if (!anchorIso) continue;
    const profile = row.resident_user_id ? profileById.get(String(row.resident_user_id)) : undefined;
    const email = profile?.email || String(row.resident_email ?? "").trim().toLowerCase();
    if (!email.includes("@")) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "document_signature",
        subjectId: String(row.id),
        anchorIso,
        recipients: [{ email, role: "counterparty", name: profile?.name || null, userId: row.resident_user_id ? String(row.resident_user_id) : null }],
        payload: { title: String(row.display_name ?? "a document"), url: `${origin()}/resident/documents`, notificationCategory: "leases" },
      },
      settings,
      now,
    );
  }
  return queued;
}

/** Welcome sequence for a resident account created under a manager (default off). */
export async function sweepResidentWelcome(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 14 * 24 * 60 * 60_000).toISOString();
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, resident_email, row_data")
    .gte("updated_at", since)
    .limit(MAX_ROWS);
  if (error) throw error;
  const rows = (data ?? []).filter((row) => row.manager_user_id && String((row.row_data as { residentUserId?: unknown })?.residentUserId ?? "").trim());
  if (rows.length === 0) return 0;
  const cache = createSettingsScopeCache();
  const rowsWithSettings: { row: (typeof rows)[number]; settings: Awaited<ReturnType<typeof resolveReminderSettingsForRow>> }[] = [];
  for (const row of rows) {
    const managerUserId = String(row.manager_user_id);
    const app = row.row_data as { assignedPropertyId?: unknown; propertyId?: unknown };
    const propertyId = String(app.assignedPropertyId ?? app.propertyId ?? "").trim() || null;
    // A house with its own reminder rules gets them; an application with no
    // property, or an un-customized house, falls through workspace then account.
    const settings = await resolveReminderSettingsForRow(db, cache, managerUserId, propertyId);
    if (settings.rules.resident_welcome.enabled) rowsWithSettings.push({ row, settings });
  }
  if (rowsWithSettings.length === 0) return 0;
  const userIds = [...new Set(rowsWithSettings.map(({ row }) => String((row.row_data as { residentUserId: string }).residentUserId)))];
  const { data: profiles } = await db.from("profiles").select("id, email, full_name, created_at").in("id", userIds).gte("created_at", since);
  const profileById = new Map((profiles ?? []).map((profile) => [String(profile.id), profile]));
  let queued = 0;
  for (const { row, settings } of rowsWithSettings) {
    const managerUserId = String(row.manager_user_id);
    const app = row.row_data as { residentUserId: string; property?: string; name?: string };
    const profile = profileById.get(app.residentUserId);
    if (!profile) continue;
    const anchorIso = iso(profile.created_at);
    const email = String(profile.email ?? row.resident_email ?? "").trim().toLowerCase();
    if (!anchorIso || !email.includes("@")) continue;
    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "resident_welcome",
        subjectId: app.residentUserId,
        anchorIso,
        recipients: [{ email, role: "counterparty", name: String(profile.full_name ?? app.name ?? "").trim() || null, userId: app.residentUserId }],
        payload: { title: "welcome", propertyLabel: String(app.property ?? "").trim() || null, url: `${origin()}/resident/dashboard`, notificationCategory: "account" },
      },
      settings,
      now,
    );
  }
  return queued;
}
