import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  MANAGER_TASKS_EVENT,
  normalizeManagerTasks,
  readManagerTasksLocal,
} from "@/lib/manager-tasks";
import {
  isVendorCategorySettingsRow,
  readManagerVendorRows,
} from "@/lib/manager-vendors-storage";
import type { VendorAssignedTask } from "@/lib/vendor-tasks.server";

export const VENDOR_TASKS_EVENT = "vendor-tasks-changed";

function normalizeVendorAssignedTasks(raw: unknown): VendorAssignedTask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const task = normalizeManagerTasks([row])[0];
      if (!task || !row || typeof row !== "object" || Array.isArray(row)) return null;
      const record = row as Record<string, unknown>;
      const managerUserId = String(record.managerUserId ?? "").trim();
      const vendorDirectoryId = String(record.vendorDirectoryId ?? "").trim();
      if (!managerUserId || !vendorDirectoryId) return null;
      return {
        ...task,
        managerUserId,
        managerName: String(record.managerName ?? "Property manager").trim() || "Property manager",
        vendorDirectoryId,
      } satisfies VendorAssignedTask;
    })
    .filter((task): task is VendorAssignedTask => Boolean(task));
}

function notifyVendorTasksChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(VENDOR_TASKS_EVENT));
  window.dispatchEvent(new Event(MANAGER_TASKS_EVENT));
}

function readDemoVendorTasks(vendorUserId: string): VendorAssignedTask[] {
  const links = readManagerVendorRows().filter(
    (row) => !isVendorCategorySettingsRow(row) && row.vendorUserId === vendorUserId && row.managerUserId,
  );
  const out: VendorAssignedTask[] = [];
  for (const link of links) {
    const managerUserId = link.managerUserId!;
    const tasks = readManagerTasksLocal(managerUserId);
    for (const task of tasks) {
      if (task.assignee?.type !== "vendor" || task.assignee.id !== link.id) continue;
      out.push({
        ...task,
        managerUserId,
        managerName: "Property manager",
        vendorDirectoryId: link.id,
      });
    }
  }
  return out.sort((a, b) => {
    const aStart = a.start ?? "";
    const bStart = b.start ?? "";
    if (aStart && bStart) return aStart.localeCompare(bStart);
    if (aStart) return -1;
    if (bStart) return 1;
    return a.createdAt.localeCompare(a.createdAt);
  });
}

export async function fetchVendorAssignedTasks(vendorUserId: string): Promise<VendorAssignedTask[]> {
  if (!vendorUserId.trim()) return [];
  if (isDemoModeActive()) return readDemoVendorTasks(vendorUserId);

  const res = await fetch("/api/vendor/tasks", { credentials: "include", cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as { tasks?: unknown; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load tasks.");
  return normalizeVendorAssignedTasks(data.tasks);
}

export async function updateVendorAssignedTask(
  vendorUserId: string,
  input: { managerUserId: string; taskId: string; completed: boolean },
): Promise<VendorAssignedTask> {
  if (isDemoModeActive()) {
    const tasks = readDemoVendorTasks(vendorUserId);
    const current = tasks.find((row) => row.id === input.taskId && row.managerUserId === input.managerUserId);
    if (!current) throw new Error("Task not found.");
    const { updateManagerTask } = await import("@/lib/manager-tasks");
    const saved = await updateManagerTask(input.managerUserId, input.taskId, { completed: input.completed });
    notifyVendorTasksChanged();
    return {
      ...saved,
      managerUserId: current.managerUserId,
      managerName: current.managerName,
      vendorDirectoryId: current.vendorDirectoryId,
    };
  }

  const res = await fetch("/api/vendor/tasks", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { task?: VendorAssignedTask; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not update task.");
  if (!data.task) throw new Error("Could not update task.");
  notifyVendorTasksChanged();
  return data.task;
}

export function vendorTaskToMeeting(
  task: Pick<VendorAssignedTask, "id" | "title" | "start" | "end" | "completed" | "propertyTitle">,
): {
  id: string;
  startIso: string;
  endIso: string;
  title: string;
  propertyTitle?: string;
} | null {
  if (task.completed || !task.start || !task.end) return null;
  return {
    id: `vendor-task-${task.id}`,
    startIso: task.start,
    endIso: task.end,
    title: task.title,
    propertyTitle: task.propertyTitle,
  };
}
