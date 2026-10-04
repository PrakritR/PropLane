/**
 * The stage of a manager task, on the one service vocabulary (Open · Assigned · Scheduled ·
 * Completed, `service-lifecycle.ts`). Studio plan claude-2/services-vendors-1004 § Tasks:
 *
 *   completed            -> Completed
 *   has a start time     -> Scheduled
 *   has an assignee      -> Assigned
 *   otherwise            -> Open
 *
 * Overdue is NOT a stage: it is a red fact on a row ("Overdue · was due Oct 2"), derived from the
 * due instant, so the tab a task sits on never changes just because the clock moved.
 */
import type { ManagerTask } from "@/lib/manager-tasks";
import { addOnServiceStage, type ServiceStage } from "@/lib/service-lifecycle";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import { normalizeAssignee } from "@/lib/work-assignment";

export function managerTaskStage(task: Pick<ManagerTask, "completed" | "start" | "assignee">): ServiceStage {
  if (task.completed) return "completed";
  if (task.start?.trim()) return "scheduled";
  if (normalizeAssignee(task.assignee)) return "assigned";
  return "open";
}

/** An add-on service assigned to the viewer rides the Tasks list on the stage the Services page gives it. */
export function serviceRequestTaskStage(request: Pick<ServiceRequest, "status" | "assignee" | "proposedVisit">): ServiceStage {
  return addOnServiceStage({
    status: request.status,
    assignee: request.assignee ?? null,
    proposedVisit: request.proposedVisit ?? null,
  });
}
