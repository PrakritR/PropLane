/**
 * Auto-create default manager tasks from lifecycle events and email assignees.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { loadManagerTasks, saveManagerTasks } from "@/lib/manager-tasks.server";
import type { ManagerTask, ManagerTaskType } from "@/lib/manager-tasks";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  LIFECYCLE_TASK_KEYS,
  LIFECYCLE_TASK_META,
  lifecycleDueDate,
  formatTaskReminderTimingLabel,
  type LifecycleTaskKey,
  type LifecycleTaskConfig,
} from "@/lib/task-lifecycle-automation";
import { loadLifecycleAutomation } from "@/lib/task-lifecycle-automation.server";
import type { WorkAssignee } from "@/lib/work-assignment";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isManagerTaskLate } from "@/lib/manager-task-display";
import { managerTaskListHref } from "@/lib/portal-detail-routes";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { shouldNotifyManagerOfApplicationSubmit } from "@/lib/application-submitted-notification.server";

type ServiceDb = SupabaseClient;

function taskDedupKey(templateKey: LifecycleTaskKey, sourceId: string): string {
  return `${templateKey}:${sourceId}`;
}

function existingAutoTask(tasks: ManagerTask[], templateKey: LifecycleTaskKey, sourceId: string): boolean {
  const key = taskDedupKey(templateKey, sourceId);
  return tasks.some((task) => task.templateKey === templateKey && task.sourceId === sourceId && task.dedupKey === key);
}

function isLifecycleTemplateKey(key: string | undefined): key is LifecycleTaskKey {
  return Boolean(key && (LIFECYCLE_TASK_KEYS as readonly string[]).includes(key));
}

async function resolveAssignee(
  db: ServiceDb,
  managerUserId: string,
  config: LifecycleTaskConfig,
): Promise<WorkAssignee | undefined> {
  const assigneeId = config.defaultAssigneeUserId?.trim() || managerUserId;
  const { data: profile } = await db.from("profiles").select("full_name, email").eq("id", assigneeId).maybeSingle();
  const name =
    (typeof profile?.full_name === "string" && profile.full_name.trim()) ||
    (typeof profile?.email === "string" && profile.email.trim()) ||
    "Team member";
  return { type: "team", id: assigneeId, name };
}

async function createLifecycleAutoTask(input: {
  db: ServiceDb;
  managerUserId: string;
  templateKey: LifecycleTaskKey;
  sourceId: string;
  title: string;
  notes?: string;
  propertyId?: string;
  propertyTitle?: string;
  roomLabel?: string;
  linkedTourId?: string;
  triggeredAt?: Date;
  eventAt?: Date | null;
  config: LifecycleTaskConfig;
  taskType?: ManagerTaskType;
}): Promise<ManagerTask | null> {
  if (!input.config.enabled) return null;
  const due = lifecycleDueDate(input.templateKey, input.config, {
    triggeredAt: input.triggeredAt,
    eventAt: input.eventAt,
  });
  if (!due) return null;

  const tasks = await loadManagerTasks(input.db, input.managerUserId);
  if (existingAutoTask(tasks, input.templateKey, input.sourceId)) return null;

  const assignee = await resolveAssignee(input.db, input.managerUserId, input.config);
  const now = new Date().toISOString();
  const meta = LIFECYCLE_TASK_META[input.templateKey];
  const taskType =
    input.taskType ??
    (meta.section === "tours" ? "tour" : "general");
  const task: ManagerTask = {
    id: crypto.randomUUID(),
    title: input.title,
    notes: input.notes,
    propertyId: input.propertyId,
    propertyTitle: input.propertyTitle,
    roomLabel: input.roomLabel,
    dueDate: due.toISOString(),
    completed: false,
    assignee,
    taskType,
    urgency: "deadline",
    linkedTourId: input.linkedTourId,
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

export async function createApproveTourRequestTask(
  db: ServiceDb,
  managerUserId: string,
  input: {
    inquiryId: string;
    triggeredAt?: string;
    guestName?: string;
    propertyTitle?: string;
    propertyId?: string;
    roomLabel?: string;
  },
): Promise<ManagerTask | null> {
  const automation = await loadLifecycleAutomation(db, managerUserId);
  const guest = input.guestName?.trim() || "Guest";
  const propertyTitle = input.propertyTitle?.trim() || "Property";
  const triggeredAt = input.triggeredAt?.trim()
    ? new Date(input.triggeredAt)
    : new Date();
  return createLifecycleAutoTask({
    db,
    managerUserId,
    templateKey: "approve_tour_request",
    sourceId: input.inquiryId.trim(),
    triggeredAt,
    title: LIFECYCLE_TASK_META.approve_tour_request.taskTitle,
    notes: `Approve or decline the tour request from ${guest} for ${propertyTitle}.`,
    propertyId: input.propertyId,
    propertyTitle,
    roomLabel: input.roomLabel,
    linkedTourId: input.inquiryId.trim(),
    config: automation.approve_tour_request,
    taskType: "tour",
  });
}

export async function createPrepareForTourTask(
  db: ServiceDb,
  managerUserId: string,
  input: {
    inquiryId: string;
    tourStart: string;
    guestName?: string;
    propertyTitle?: string;
    propertyId?: string;
    roomLabel?: string;
    plannedEventId?: string;
  },
): Promise<ManagerTask | null> {
  const automation = await loadLifecycleAutomation(db, managerUserId);
  const guest = input.guestName?.trim() || "Guest";
  const propertyTitle = input.propertyTitle?.trim() || "Property";
  const eventAt = new Date(input.tourStart);
  if (!Number.isFinite(eventAt.getTime())) return null;
  return createLifecycleAutoTask({
    db,
    managerUserId,
    templateKey: "prepare_for_tour",
    sourceId: input.inquiryId.trim(),
    eventAt,
    title: LIFECYCLE_TASK_META.prepare_for_tour.taskTitle,
    notes: `Prepare for the tour with ${guest} at ${propertyTitle}.`,
    propertyId: input.propertyId,
    propertyTitle,
    roomLabel: input.roomLabel,
    linkedTourId: input.plannedEventId?.trim() || input.inquiryId.trim(),
    config: automation.prepare_for_tour,
    taskType: "tour",
  });
}

export async function createReviewApplicationTask(
  db: ServiceDb,
  managerUserId: string,
  row: DemoApplicantRow,
): Promise<ManagerTask | null> {
  const automation = await loadLifecycleAutomation(db, managerUserId);
  const submittedAt =
    (row.application as { submittedAt?: string } | undefined)?.submittedAt?.trim() ||
    (row as { submittedAt?: string }).submittedAt?.trim() ||
    new Date().toISOString();
  const name = row.name?.trim() || "Applicant";
  const propertyTitle = row.property?.trim() || "Property";
  return createLifecycleAutoTask({
    db,
    managerUserId,
    templateKey: "review_application",
    sourceId: row.id.trim(),
    triggeredAt: new Date(submittedAt),
    title: LIFECYCLE_TASK_META.review_application.taskTitle,
    notes: `Review the application from ${name} for ${propertyTitle}.`,
    propertyId: row.assignedPropertyId?.trim() || row.propertyId?.trim(),
    propertyTitle,
    roomLabel: row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim(),
    config: automation.review_application,
  });
}

export async function createDecideApplicationTask(
  db: ServiceDb,
  managerUserId: string,
  row: DemoApplicantRow,
): Promise<ManagerTask | null> {
  const automation = await loadLifecycleAutomation(db, managerUserId);
  const submittedAt =
    (row.application as { submittedAt?: string } | undefined)?.submittedAt?.trim() ||
    (row as { submittedAt?: string }).submittedAt?.trim() ||
    new Date().toISOString();
  const name = row.name?.trim() || "Applicant";
  const propertyTitle = row.property?.trim() || "Property";
  return createLifecycleAutoTask({
    db,
    managerUserId,
    templateKey: "decide_application",
    sourceId: row.id.trim(),
    triggeredAt: new Date(submittedAt),
    title: LIFECYCLE_TASK_META.decide_application.taskTitle,
    notes: `Approve or decline the application from ${name} for ${propertyTitle}.`,
    propertyId: row.assignedPropertyId?.trim() || row.propertyId?.trim(),
    propertyTitle,
    roomLabel: row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim(),
    config: automation.decide_application,
  });
}

export async function createReviewAndSendLeaseTask(
  db: ServiceDb,
  managerUserId: string,
  row: DemoApplicantRow,
): Promise<ManagerTask | null> {
  const automation = await loadLifecycleAutomation(db, managerUserId);
  const name = row.name?.trim() || "Applicant";
  const propertyTitle = row.property?.trim() || "Property";
  return createLifecycleAutoTask({
    db,
    managerUserId,
    templateKey: "review_and_send_lease",
    sourceId: row.id.trim(),
    triggeredAt: new Date(),
    title: LIFECYCLE_TASK_META.review_and_send_lease.taskTitle,
    notes: `Generate and send the lease to ${name} for ${propertyTitle}.`,
    propertyId: row.assignedPropertyId?.trim() || row.propertyId?.trim(),
    propertyTitle,
    roomLabel: row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim(),
    config: automation.review_and_send_lease,
  });
}

export async function createCountersignLeaseTask(
  db: ServiceDb,
  managerUserId: string,
  row: LeasePipelineRow,
): Promise<ManagerTask | null> {
  const automation = await loadLifecycleAutomation(db, managerUserId);
  const residentName =
    row.residentSignature?.name?.trim() ||
    row.residentName?.trim() ||
    row.signatureName?.trim() ||
    "Resident";
  const propertyTitle = row.unit?.trim() || "Property";
  const signedAt =
    row.residentSignature?.signedAtIso?.trim() ||
    row.residentSignedAt?.trim() ||
    row.signedAtIso?.trim() ||
    new Date().toISOString();
  return createLifecycleAutoTask({
    db,
    managerUserId,
    templateKey: "countersign_lease",
    sourceId: row.id.trim(),
    triggeredAt: new Date(signedAt),
    title: LIFECYCLE_TASK_META.countersign_lease.taskTitle,
    notes: `Countersign the lease for ${residentName} at ${propertyTitle}.`,
    propertyId: row.propertyId?.trim(),
    propertyTitle,
    roomLabel: row.roomChoice?.trim(),
    config: automation.countersign_lease,
  });
}

export async function createCollectRentTask(
  db: ServiceDb,
  managerUserId: string,
  input: { sourceId: string; residentName: string; propertyTitle: string; propertyId?: string },
): Promise<ManagerTask | null> {
  const automation = await loadLifecycleAutomation(db, managerUserId);
  return createLifecycleAutoTask({
    db,
    managerUserId,
    templateKey: "collect_rent",
    sourceId: input.sourceId,
    triggeredAt: new Date(),
    title: LIFECYCLE_TASK_META.collect_rent.taskTitle,
    notes: `Confirm rent is collected for ${input.residentName} at ${input.propertyTitle}.`,
    propertyId: input.propertyId,
    propertyTitle: input.propertyTitle,
    config: automation.collect_rent,
  });
}

/**
 * The assignee's address: a co-manager's profile email, or a vendor's stored
 * contact. Exported so the reminder spine resolves recipients the same way the
 * task emails already do, rather than growing a second lookup that could drift.
 */
export async function assigneeEmail(db: ServiceDb, assignee: WorkAssignee): Promise<string | null> {
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

/**
 * Notify a task's assignee on every channel they accept.
 *
 * This used to POST Resend directly, so a task reminder was email-ONLY, it left on the shared
 * `RESEND_FROM` no matter which manager the task belonged to, and it appeared nowhere in the
 * portal. It now goes through `deliverPortalInboxMessage`, the same path every other portal
 * notification uses, which means:
 *
 * - the portal inbox always gets it, so the reminder exists somewhere the person can find it
 *   again rather than only in a mailbox;
 * - email and SMS follow each recipient's own saved preferences for this category, so "all
 *   three channels" never means overriding someone who turned one off, and SMS keeps the
 *   consent and quiet-hours gates it already had;
 * - the email carries the MANAGER's work email as its sender when they have one, so a reply
 *   reaches that manager's assistant inbox instead of a shared address.
 *
 * The name is unchanged because the callers and their tests are; what it does is wider.
 */
export async function sendTaskAssigneeEmail(input: {
  db: ServiceDb;
  managerUserId: string;
  task: ManagerTask;
  assignee: WorkAssignee;
  kind: "created" | "due" | "advance";
  subject?: string;
  text?: string;
  minutesBeforeDue?: number;
}): Promise<{ sent: boolean; error?: string }> {
  const to = await assigneeEmail(input.db, input.assignee);
  if (!to) return { sent: false, error: "assignee_email_missing" };

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
      : input.kind === "advance"
        ? `Reminder: ${input.task.title}`
        : `New task assigned: ${input.task.title}`);
  const advanceLine =
    input.kind === "advance" && input.minutesBeforeDue
      ? formatTaskReminderTimingLabel(input.minutesBeforeDue)
      : null;
  const greetingName = taskAssigneeGreetingName(input.assignee, to);
  const lines =
    input.text?.trim() ||
    [
      `Hi ${greetingName},`,
      "",
      input.kind === "due"
        ? `This task is due now: ${input.task.title}`
        : input.kind === "advance"
          ? `Reminder — ${advanceLine ?? "this task is due soon"}: ${input.task.title}`
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

  const { data: managerProfile } = await input.db
    .from("profiles")
    .select("email, full_name")
    .eq("id", input.managerUserId)
    .maybeSingle();
  const senderEmail = String((managerProfile as { email?: string } | null)?.email ?? "").trim().toLowerCase();
  const managerName = String((managerProfile as { full_name?: string } | null)?.full_name ?? "").trim();

  const result = await deliverPortalInboxMessage(input.db, {
    senderUserId: input.managerUserId,
    senderEmail,
    fromName: managerName || "PropLane",
    subject,
    text: lines,
    toEmails: [to],
    // A text has no room for notes and a link the reader must retype, so SMS gets the one
    // line that matters and the full body stays in the inbox and the email.
    smsText: taskReminderSmsBody(input.kind, input.task, advanceLine, tasksUrl),
    senderRole: "manager",
    // Per-recipient preferences decide email and SMS; the inbox copy is always written.
    eventCategory: "maintenance",
  });

  return result.ok ? { sent: true } : { sent: false, error: result.error };
}

/**
 * Who the message greets.
 *
 * A vendor directory row can carry a blank name, and the greeting then fell through to the
 * raw email address — "Hi ogambik2@gmail.com," is what a person actually received. An address
 * is an identifier, not a name, so a nameless assignee gets a plain greeting instead.
 */
function taskAssigneeGreetingName(assignee: WorkAssignee, fallbackEmail: string): string {
  const name = assignee.name?.trim() ?? "";
  if (name && name.toLowerCase() !== fallbackEmail.toLowerCase() && !name.includes("@")) return name;
  return "there";
}

/** One line, because a text is read at a glance and cannot be scrolled back to. */
function taskReminderSmsBody(
  kind: "created" | "due" | "advance",
  task: ManagerTask,
  advanceLine: string | null,
  tasksUrl: string,
): string {
  const at = task.propertyTitle?.trim() ? ` at ${task.propertyTitle.trim()}` : "";
  const lead =
    kind === "due"
      ? `(Task due now) "${task.title}"${at}`
      : kind === "advance"
        ? `(Task ${advanceLine ?? "due soon"}) "${task.title}"${at}`
        : `(New task) "${task.title}"${at}`;
  return `${lead}\n${tasksUrl}`;
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
    void createDecideApplicationTask(db, managerUserId, row).catch(() => undefined);
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

/** Fire countersign task when the resident signs and the manager has not yet. */
export async function syncLeaseLifecycleTasks(
  db: ServiceDb,
  managerUserId: string,
  previousRow: LeasePipelineRow | null | undefined,
  row: LeasePipelineRow,
): Promise<void> {
  const wasResidentSigned = Boolean(
    previousRow?.residentSignature?.signedAtIso ||
      previousRow?.signedAtIso ||
      previousRow?.residentSignedAt,
  );
  const isResidentSigned = Boolean(
    row.residentSignature?.signedAtIso || row.signedAtIso || row.residentSignedAt,
  );
  const managerSigned = Boolean(row.managerSignature?.signedAtIso || row.managerSignedAt);
  if (isResidentSigned && !wasResidentSigned && !managerSigned) {
    void createCountersignLeaseTask(db, managerUserId, row).catch(() => undefined);
  }
}

export async function processDueTaskReminders(db: ServiceDb, managerUserId: string): Promise<number> {
  const automation = await loadLifecycleAutomation(db, managerUserId);
  const tasks = await loadManagerTasks(db, managerUserId);
  const now = Date.now();
  const todayKey = new Date().toISOString().slice(0, 10);
  let sent = 0;
  let changed = false;
  const updated: ManagerTask[] = [];

  for (const task of tasks) {
    if (task.completed || !task.dueDate || !task.assignee) {
      updated.push(task);
      continue;
    }
    const dueMs = Date.parse(task.dueDate);
    if (!Number.isFinite(dueMs)) {
      updated.push(task);
      continue;
    }

    let nextTask = task;
    const templateKey = task.templateKey;
    const lifecycleConfig = isLifecycleTemplateKey(templateKey) ? automation[templateKey] : null;

    if (
      lifecycleConfig?.sendEmailReminder &&
      lifecycleConfig.reminderMinutesBeforeList.length > 0 &&
      dueMs > now
    ) {
      const sentOffsets = new Set(nextTask.advanceReminderSentOffsets ?? []);
      for (const minutesBefore of lifecycleConfig.reminderMinutesBeforeList) {
        if (sentOffsets.has(minutesBefore)) continue;
        const reminderAt = dueMs - minutesBefore * 60_000;
        if (now < reminderAt) continue;
        const result = await sendTaskAssigneeEmail({
          db,
          managerUserId,
          task: nextTask,
          assignee: nextTask.assignee!,
          kind: "advance",
          minutesBeforeDue: minutesBefore,
        });
        if (result.sent) {
          sent += 1;
          changed = true;
          sentOffsets.add(minutesBefore);
          nextTask = {
            ...nextTask,
            advanceReminderSentOffsets: [...sentOffsets].sort((a, b) => a - b),
            updatedAt: new Date().toISOString(),
          };
        }
      }
    }

    const remindersOn = !templateKey || lifecycleConfig?.sendEmailReminder !== false;
    if (dueMs <= now && remindersOn) {
      const last = nextTask.reminderSentAt?.slice(0, 10);
      if (last !== todayKey) {
        const result = await sendTaskAssigneeEmail({
          db,
          managerUserId,
          task: nextTask,
          assignee: nextTask.assignee!,
          kind: "due",
        });
        if (result.sent) {
          sent += 1;
          changed = true;
          nextTask = {
            ...nextTask,
            reminderSentAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        }
      }
    }

    updated.push(nextTask);
  }

  if (changed) await saveManagerTasks(db, managerUserId, updated);
  return sent;
}
