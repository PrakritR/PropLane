/**
 * Tasks → the reminder queue.
 *
 * Manager tasks live as one JSON blob per manager in `portal_schedule_records`
 * (`record_type = 'manager_tasks'`), so a sweep is one bounded read per manager
 * rather than a row scan.
 *
 * This runs on the dispatcher's tick instead of hooking every write path. Task
 * writes happen from the list UI, the automation defaults, and the agent tools,
 * and instrumenting each one would leave a reminder missing the moment a new
 * path appeared. `dedupe_key` is unique, so re-sweeping an unchanged task is a
 * no-op and the sweep is safe to run as often as the dispatcher does.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { assigneeEmail } from "@/lib/manager-default-tasks.server";
import { managerTaskListHref } from "@/lib/portal-detail-routes";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { normalizeManagerTasks, type ManagerTask } from "@/lib/manager-tasks";
import { materializeReminders } from "@/lib/reminders/queue.server";
import type { ReminderSettings } from "@/lib/reminders/rules";
import { loadReminderSettingsForManagers } from "@/lib/reminders/settings.server";
import {
  loadManagerReminderRecipients,
  loadTeamReminderRecipients,
  teamReminderRecipients,
  type TeamReminderRecipient,
} from "@/lib/reminders/manager-recipients.server";
import type { ManagerReminderRecipient } from "@/lib/reminders/manager-recipients.server";
import type { ReminderRecipient } from "@/lib/reminders/queue.server";
import { managerNotificationCategoryForTask } from "@/lib/manager-notification-preferences";

/** How far ahead to look. Comfortably past the longest lead time a rule allows. */
const HORIZON_DAYS = 31;

/**
 * The moment a task is reminding about.
 *
 * A scheduled task uses its start; an unscheduled one uses its due date. A task
 * with neither is not on any clock, so there is nothing to count back from.
 */
export function taskAnchorIso(task: ManagerTask): string | null {
  const candidate = task.start?.trim() || task.dueDate?.trim() || "";
  if (!candidate) return null;
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Tasks worth reminding about right now: open, on the clock, inside the horizon. */
export function remindableTasks(tasks: readonly ManagerTask[], now: Date, horizonDays = HORIZON_DAYS): ManagerTask[] {
  const from = now.getTime();
  const to = from + horizonDays * 24 * 60 * 60 * 1000;
  return tasks.filter((task) => {
    if (task.completed) return false;
    if (!task.assignee) return false;
    const anchor = taskAnchorIso(task);
    if (!anchor) return false;
    const ms = Date.parse(anchor);
    // Already past is the overdue path's problem, not a reminder's.
    return ms > from && ms <= to;
  });
}

function taskWhenLabel(anchorIso: string): string {
  return new Date(anchorIso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function sweepManagerTasks(
  db: SupabaseClient,
  managerUserId: string,
  tasks: readonly ManagerTask[],
  settings: ReminderSettings,
  managerRecipient: ManagerReminderRecipient | undefined,
  teamMembers: readonly TeamReminderRecipient[],
  now: Date,
): Promise<number> {
  const rule = settings.rules.task;
  if (!rule.enabled) return 0;

  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  let queued = 0;

  for (const task of remindableTasks(tasks, now)) {
    const anchorIso = taskAnchorIso(task);
    if (!anchorIso || !task.assignee) continue;
    const assigneeAddress = await assigneeEmail(db, task.assignee);
    const isManagerAssignee = task.assignee.type === "team";
    const recipients: ReminderRecipient[] = [];

    if (rule.audience.manager && managerRecipient) {
      recipients.push({
        email: managerRecipient.email,
        role: "manager",
        name: managerRecipient.name,
        userId: managerUserId,
      });
    }
    if (rule.audience.team) {
      recipients.push(...teamReminderRecipients(teamMembers));
    }
    if (rule.audience.counterparty && assigneeAddress) {
      recipients.push({
        email: assigneeAddress,
        role: isManagerAssignee ? "manager" : "counterparty",
        userId: isManagerAssignee ? task.assignee.id : null,
        name: task.assignee.name,
      });
    }
    if (recipients.length === 0) continue;

    queued += await materializeReminders(
      db,
      {
        managerUserId,
        kind: "task",
        subjectId: task.id,
        anchorIso,
        recipients,
        payload: {
          title: task.title,
          whenLabel: taskWhenLabel(anchorIso),
          propertyLabel: task.propertyTitle ?? null,
          counterpartyName: task.assignee.name,
          notes: task.notes ?? null,
          url: `${origin}${managerTaskListHref("/portal", "in-progress")}`,
          notificationCategory: managerNotificationCategoryForTask(task),
        },
      },
      settings,
      now,
    );
  }
  return queued;
}

/**
 * Queue reminders for every manager's upcoming tasks.
 *
 * Returns how many rows were offered to the queue; duplicates are absorbed by
 * the unique `dedupe_key`, so this number is an upper bound on new work, not a
 * count of sends.
 */
export async function sweepTaskReminders(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("manager_user_id, row_data")
    .eq("record_type", "manager_tasks");
  if (error) throw error;

  const rows = (data ?? []).filter(
    (row): row is { manager_user_id: string; row_data: Record<string, unknown> } =>
      typeof (row as { manager_user_id?: unknown }).manager_user_id === "string",
  );
  if (rows.length === 0) return 0;

  const settingsByManager = await loadReminderSettingsForManagers(
    db,
    rows.map((row) => row.manager_user_id),
  );
  const managerRecipients = await loadManagerReminderRecipients(
    db,
    rows.map((row) => row.manager_user_id),
  );

  let queued = 0;
  for (const row of rows) {
    const tasks = normalizeManagerTasks((row.row_data as { tasks?: unknown } | null)?.tasks);
    if (tasks.length === 0) continue;
    const settings = settingsByManager.get(row.manager_user_id);
    if (!settings) continue;
    const teamMembers = settings.rules.task.audience.team
      ? await loadTeamReminderRecipients(db, row.manager_user_id, settings.rules.task.teamUserIds)
      : [];
    queued += await sweepManagerTasks(
      db,
      row.manager_user_id,
      tasks,
      settings,
      managerRecipients.get(row.manager_user_id),
      teamMembers,
      now,
    );
  }
  return queued;
}
