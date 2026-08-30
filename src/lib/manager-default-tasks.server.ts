/**
 * Auto-create default manager tasks from lifecycle events and email assignees.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { loadManagerTasks, saveManagerTasks } from "@/lib/manager-tasks.server";
import type { ManagerTask } from "@/lib/manager-tasks";
import {
  DEFAULT_TASK_TEMPLATE_LABELS,
  dueDateFromDaysAfter,
  loadTaskAutomation,
  type DefaultTaskTemplateKey,
  type TaskTemplateConfig,
} from "@/lib/task-automation-preferences";
import type { WorkAssignee } from "@/lib/work-assignment";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isManagerTaskLate } from "@/lib/manager-task-display";
import { managerTaskListHref } from "@/lib/portal-detail-routes";
import { shouldNotifyManagerOfApplicationSubmit } from "@/lib/application-submitted-notification.server";

type ServiceDb = SupabaseClient;

function taskDedupKey(templateKey: DefaultTaskTemplateKey, sourceId: string): string {
  return `${templateKey}:${sourceId}`;
}

function existingAutoTask(tasks: ManagerTask[], templateKey: DefaultTaskTemplateKey, sourceId: string): boolean {
  const key = taskDedupKey(templateKey, sourceId);
  return tasks.some((task) => task.templateKey === templateKey && task.sourceId === sourceId && task.dedupKey === key);
}

async function resolveAssignee(
  db: ServiceDb,
  managerUserId: string,
  config: TaskTemplateConfig,
): Promise<WorkAssignee | undefined> {
  const assigneeId = config.defaultAssigneeUserId?.trim() || managerUserId;
  const { data: profile } = await db.from("profiles").select("full_name, email").eq("id", assigneeId).maybeSingle();
  const name =
    (typeof profile?.full_name === "string" && profile.full_name.trim()) ||
    (typeof profile?.email === "string" && profile.email.trim()) ||
    "Team member";
  return { type: "team", id: assigneeId, name };
}

async function createAutoTask(input: {
  db: ServiceDb;
  managerUserId: string;
  templateKey: DefaultTaskTemplateKey;
  sourceId: string;
  triggerAt: string;
  title: string;
  notes?: string;
  propertyId?: string;
  propertyTitle?: string;
  roomLabel?: string;
  config: TaskTemplateConfig;
}): Promise<ManagerTask | null> {
  if (!input.config.enabled) return null;
  const tasks = await loadManagerTasks(input.db, input.managerUserId);
  if (existingAutoTask(tasks, input.templateKey, input.sourceId)) return null;

  const assignee = await resolveAssignee(input.db, input.managerUserId, input.config);
  const dueDate = dueDateFromDaysAfter(input.triggerAt, input.config.daysAfterTrigger);
  const now = new Date().toISOString();
  const task: ManagerTask = {
    id: crypto.randomUUID(),
    title: input.title,
    notes: input.notes,
    propertyId: input.propertyId,
    propertyTitle: input.propertyTitle,
    roomLabel: input.roomLabel,
    dueDate,
    completed: false,
    assignee,
    templateKey: input.templateKey,
    sourceId: input.sourceId,
    dedupKey: taskDedupKey(input.templateKey, input.sourceId),
    createdAt: now,
    updatedAt: now,
  };
  await saveManagerTasks(input.db, input.managerUserId, [...tasks, task]);
  if (input.config.sendEmailReminder && assignee) {
    void sendTaskAssigneeEmail({
      db: input.db,
      managerUserId: input.managerUserId,
      task,
      assignee,
      kind: "created",
    }).catch(() => undefined);
  }
  return task;
}

export async function createReviewApplicationTask(
  db: ServiceDb,
  managerUserId: string,
  row: DemoApplicantRow,
): Promise<ManagerTask | null> {
  const automation = await loadTaskAutomation(db, managerUserId);
  const submittedAt =
    (row.application as { submittedAt?: string } | undefined)?.submittedAt?.trim() ||
    (row as { submittedAt?: string }).submittedAt?.trim() ||
    new Date().toISOString();
  const name = row.name?.trim() || "Applicant";
  const propertyTitle = row.property?.trim() || "Property";
  return createAutoTask({
    db,
    managerUserId,
    templateKey: "review_application",
    sourceId: row.id.trim(),
    triggerAt: submittedAt,
    title: DEFAULT_TASK_TEMPLATE_LABELS.review_application,
    notes: `Review the application from ${name} for ${propertyTitle}.`,
    propertyId: row.assignedPropertyId?.trim() || row.propertyId?.trim(),
    propertyTitle,
    roomLabel: row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim(),
    config: automation.review_application,
  });
}

export async function createReviewAndSendLeaseTask(
  db: ServiceDb,
  managerUserId: string,
  row: DemoApplicantRow,
): Promise<ManagerTask | null> {
  const automation = await loadTaskAutomation(db, managerUserId);
  const name = row.name?.trim() || "Applicant";
  const propertyTitle = row.property?.trim() || "Property";
  return createAutoTask({
    db,
    managerUserId,
    templateKey: "review_and_send_lease",
    sourceId: row.id.trim(),
    triggerAt: new Date().toISOString(),
    title: DEFAULT_TASK_TEMPLATE_LABELS.review_and_send_lease,
    notes: `Generate and send the lease to ${name} for ${propertyTitle}.`,
    propertyId: row.assignedPropertyId?.trim() || row.propertyId?.trim(),
    propertyTitle,
    roomLabel: row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim(),
    config: automation.review_and_send_lease,
  });
}

export async function createCollectRentTask(
  db: ServiceDb,
  managerUserId: string,
  input: { sourceId: string; residentName: string; propertyTitle: string; propertyId?: string },
): Promise<ManagerTask | null> {
  const automation = await loadTaskAutomation(db, managerUserId);
  return createAutoTask({
    db,
    managerUserId,
    templateKey: "collect_rent",
    sourceId: input.sourceId,
    triggerAt: new Date().toISOString(),
    title: DEFAULT_TASK_TEMPLATE_LABELS.collect_rent,
    notes: `Confirm rent is collected for ${input.residentName} at ${input.propertyTitle}.`,
    propertyId: input.propertyId,
    propertyTitle: input.propertyTitle,
    config: automation.collect_rent,
  });
}

async function assigneeEmail(db: ServiceDb, assignee: WorkAssignee): Promise<string | null> {
  if (assignee.type === "team") {
    const { data } = await db.from("profiles").select("email").eq("id", assignee.id).maybeSingle();
    const email = typeof data?.email === "string" ? data.email.trim().toLowerCase() : "";
    return email.includes("@") ? email : null;
  }
  const { data } = await db
    .from("manager_vendor_records")
    .select("row_data")
    .eq("id", assignee.id)
    .maybeSingle();
  const rowData = data?.row_data as Record<string, unknown> | null;
  const email = typeof rowData?.email === "string" ? rowData.email.trim().toLowerCase() : "";
  return email.includes("@") ? email : null;
}

export async function sendTaskAssigneeEmail(input: {
  db: ServiceDb;
  managerUserId: string;
  task: ManagerTask;
  assignee: WorkAssignee;
  kind: "created" | "due";
  subject?: string;
  text?: string;
}): Promise<{ sent: boolean; error?: string }> {
  const to = await assigneeEmail(input.db, input.assignee);
  if (!to) return { sent: false, error: "assignee_email_missing" };
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { sent: false, error: "mailer_unconfigured" };
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
  const late = isManagerTaskLate(input.task);
  const tasksUrl = `${origin}${managerTaskListHref("/portal", late ? "overdue" : "in-progress")}`;
  const dueLabel = input.task.dueDate
    ? new Date(input.task.dueDate).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
    : "No due date";
  const subject =
    input.subject?.trim() ||
    (input.kind === "due"
      ? `Task due: ${input.task.title}`
      : `New task assigned: ${input.task.title}`);
  const lines =
    input.text?.trim() ||
    [
      `Hi ${input.assignee.name},`,
      "",
      input.kind === "due"
        ? `This task is due now: ${input.task.title}`
        : `You have been assigned a task: ${input.task.title}`,
      input.task.notes ? "" : null,
      input.task.notes ?? null,
      `Due: ${dueLabel}`,
      input.task.propertyTitle ? `Property: ${input.task.propertyTitle}` : null,
      "",
      `Open your task list: ${tasksUrl}`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text: lines }),
  });
  return { sent: res.ok };
}

/** Fire lifecycle default tasks after application submit or approval. */
export async function syncApplicationLifecycleTasks(
  db: ServiceDb,
  previousRow: DemoApplicantRow | null | undefined,
  row: DemoApplicantRow,
): Promise<void> {
  const managerUserId = row.managerUserId?.trim();
  if (!managerUserId) return;

  if (shouldNotifyManagerOfApplicationSubmit(previousRow, row)) {
    void createReviewApplicationTask(db, managerUserId, row).catch(() => undefined);
  }

  const wasApproved = previousRow?.bucket === "approved";
  const isApproved = row.bucket === "approved";
  if (isApproved && !wasApproved) {
    void createReviewAndSendLeaseTask(db, managerUserId, row).catch(() => undefined);
    void createCollectRentTask(db, managerUserId, {
      sourceId: `${row.id.trim()}-initial-rent`,
      residentName: row.name?.trim() || "Resident",
      propertyTitle: row.property?.trim() || "Property",
      propertyId: row.assignedPropertyId?.trim() || row.propertyId?.trim(),
    }).catch(() => undefined);
  }
}

export async function processDueTaskReminders(db: ServiceDb, managerUserId: string): Promise<number> {
  const automation = await loadTaskAutomation(db, managerUserId);
  const tasks = await loadManagerTasks(db, managerUserId);
  const now = Date.now();
  const todayKey = new Date().toISOString().slice(0, 10);
  let sent = 0;
  const updated: ManagerTask[] = [];

  for (const task of tasks) {
    if (task.completed || !task.dueDate || !task.assignee) {
      updated.push(task);
      continue;
    }
    const dueMs = Date.parse(task.dueDate);
    if (!Number.isFinite(dueMs) || dueMs > now) {
      updated.push(task);
      continue;
    }
    const templateKey = task.templateKey;
    const remindersOn =
      !templateKey || automation[templateKey as DefaultTaskTemplateKey]?.sendEmailReminder !== false;
    const last = task.reminderSentAt?.slice(0, 10);
    if (!remindersOn || last === todayKey) {
      updated.push(task);
      continue;
    }
    const result = await sendTaskAssigneeEmail({
      db,
      managerUserId,
      task,
      assignee: task.assignee,
      kind: "due",
    });
    if (result.sent) {
      sent += 1;
      updated.push({ ...task, reminderSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    } else {
      updated.push(task);
    }
  }

  if (sent > 0) await saveManagerTasks(db, managerUserId, updated);
  return sent;
}
