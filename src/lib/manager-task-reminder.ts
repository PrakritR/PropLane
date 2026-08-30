import { formatRangeLabel } from "@/lib/demo-admin-scheduling";
import {
  compactTaskLocationLabel,
  isManagerTaskLate,
  openTasksForListTab,
} from "@/lib/manager-task-display";
import {
  inferManagerTaskType,
  MANAGER_TASK_TYPE_LABELS,
  type ManagerTask,
  type ManagerTaskType,
} from "@/lib/manager-tasks";
import { managerTaskListHref } from "@/lib/portal-detail-routes";
import type { WorkAssignee } from "@/lib/work-assignment";

export type TaskAssigneeDirectory = {
  teamMembers: readonly { userId: string; name?: string | null; email?: string | null }[];
  vendors: readonly { id: string; name?: string | null; email?: string | null }[];
};

export function managerTaskScheduleLabel(task: ManagerTask): string {
  if (task.start && task.end) return formatRangeLabel(task.start, task.end);
  if (task.start) return formatPacificDateTime(task.start);
  if (task.dueDate) return `Due ${formatPacificDateTime(task.dueDate)}`;
  return "No schedule or due date";
}

export function resolveTaskAssigneeEmail(
  assignee: WorkAssignee | undefined,
  directory: TaskAssigneeDirectory,
): string | null {
  if (!assignee) return null;
  if (assignee.type === "team") {
    const member = directory.teamMembers.find((row) => row.userId === assignee.id);
    const email = member?.email?.trim().toLowerCase() ?? "";
    return email.includes("@") ? email : null;
  }
  const vendor = directory.vendors.find((row) => row.id === assignee.id);
  const email = vendor?.email?.trim().toLowerCase() ?? "";
  return email.includes("@") ? email : null;
}

export function taskAssigneeRecipientLabel(
  task: ManagerTask,
  directory: TaskAssigneeDirectory,
): string {
  const assignee = task.assignee;
  if (!assignee) return "Unassigned";
  const email = resolveTaskAssigneeEmail(assignee, directory);
  const name = assignee.name?.trim() || "Assignee";
  return email ? `${name} · ${email}` : name;
}

function reminderSubjectPrefix(taskType: ManagerTaskType, late: boolean): string {
  if (late) {
    if (taskType === "tour") return "Overdue tour";
    if (taskType === "work_order") return "Overdue service";
    if (taskType === "house") return "Overdue house task";
    return "Overdue task";
  }
  if (taskType === "tour") return "Tour reminder";
  if (taskType === "work_order") return "Service reminder";
  if (taskType === "house") return "House task reminder";
  return "Task reminder";
}

export function buildManagerTaskReminderPreview(input: {
  task: ManagerTask;
  tasksUrl?: string;
  late?: boolean;
}): { subject: string; body: string } {
  const task = input.task;
  const taskType = inferManagerTaskType(task);
  const late = input.late ?? isManagerTaskLate(task);
  const assigneeName = task.assignee?.name?.trim() || "there";
  const location = compactTaskLocationLabel(task);
  const schedule = managerTaskScheduleLabel(task);
  const typeLabel = MANAGER_TASK_TYPE_LABELS[taskType];
  const subject = `${reminderSubjectPrefix(taskType, late)}: ${task.title.trim()}`;
  const tasksUrl =
    input.tasksUrl?.trim() ||
    `https://prop-lane.space${managerTaskListHref("/portal", late ? "overdue" : "in-progress")}`;

  const intro =
    taskType === "tour"
      ? late
        ? "This tour slot has passed and still needs follow-up:"
        : "Reminder about an upcoming tour:"
      : taskType === "work_order"
        ? late
          ? "This service request is past its scheduled time:"
          : "Reminder about a service request:"
        : taskType === "house"
          ? late
            ? "This house task is overdue:"
            : "Reminder about a house task:"
          : late
            ? "This task is overdue:"
            : "Reminder about a task assigned to you:";

  const lines = [
    `Hi ${assigneeName},`,
    "",
    intro,
    "",
    `Task: ${task.title.trim()}`,
    `Type: ${typeLabel}`,
    `When: ${schedule}`,
    location ? `Location: ${location}` : null,
    task.notes?.trim() ? `Notes: ${task.notes.trim()}` : null,
    "",
    `Open your task list: ${tasksUrl}`,
  ].filter((line): line is string => line !== null);

  return { subject, body: lines.join("\n") };
}
