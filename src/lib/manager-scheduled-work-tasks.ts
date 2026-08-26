import { createManagerTask, type ManagerTaskInput } from "@/lib/manager-tasks";

/** Create a task list row for a scheduled tour or service without blocking the parent flow. */
export async function createScheduledWorkTask(
  managerUserId: string,
  input: ManagerTaskInput,
): Promise<void> {
  try {
    await createManagerTask(managerUserId, input);
  } catch {
    // Supplementary — a failed task must not undo a confirmed tour or approved service.
  }
}

export function scheduledTaskTitleForTour(guestName: string): string {
  const guest = guestName.trim() || "Guest";
  return `Tour · ${guest}`;
}

export function scheduledTaskTitleForService(offerName: string, residentName?: string): string {
  const offer = offerName.trim() || "Service";
  const resident = residentName?.trim();
  return resident ? `${offer} · ${resident}` : offer;
}
