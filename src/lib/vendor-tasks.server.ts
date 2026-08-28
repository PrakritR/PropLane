import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerTasks, patchManagerTaskRow } from "@/lib/manager-tasks.server";
import type { ManagerTask } from "@/lib/manager-tasks";
import { resolveOwnVendorRecords } from "@/lib/vendor-own-record";

export type VendorAssignedTask = ManagerTask & {
  managerUserId: string;
  managerName: string;
  vendorDirectoryId: string;
};

async function managerDisplayName(db: SupabaseClient, managerUserId: string): Promise<string> {
  const { data } = await db.from("profiles").select("full_name").eq("id", managerUserId).maybeSingle();
  const name = typeof data?.full_name === "string" ? data.full_name.trim() : "";
  return name || "Property manager";
}

function taskAssignedToVendorLink(
  task: ManagerTask,
  vendorDirectoryId: string,
): boolean {
  return task.assignee?.type === "vendor" && task.assignee.id === vendorDirectoryId;
}

export async function loadVendorAssignedTasks(
  db: SupabaseClient,
  vendorUserId: string,
): Promise<VendorAssignedTask[]> {
  const links = await resolveOwnVendorRecords(db, vendorUserId);
  const out: VendorAssignedTask[] = [];
  const managerNames = new Map<string, string>();

  for (const link of links) {
    let managerName = managerNames.get(link.managerUserId);
    if (!managerName) {
      managerName = await managerDisplayName(db, link.managerUserId);
      managerNames.set(link.managerUserId, managerName);
    }
    const tasks = await loadManagerTasks(db, link.managerUserId);
    for (const task of tasks) {
      if (!taskAssignedToVendorLink(task, link.id)) continue;
      out.push({
        ...task,
        managerUserId: link.managerUserId,
        managerName,
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
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export async function patchVendorAssignedTask(
  db: SupabaseClient,
  vendorUserId: string,
  input: { managerUserId: string; taskId: string; completed: boolean },
): Promise<VendorAssignedTask> {
  const managerUserId = input.managerUserId.trim();
  const taskId = input.taskId.trim();
  if (!managerUserId || !taskId) throw new Error("Task not found.");

  const links = await resolveOwnVendorRecords(db, vendorUserId);
  const link = links.find((row) => row.managerUserId === managerUserId);
  if (!link) throw new Error("You do not have access to this task.");

  const tasks = await loadManagerTasks(db, managerUserId);
  const current = tasks.find((row) => row.id === taskId);
  if (!current || !taskAssignedToVendorLink(current, link.id)) {
    throw new Error("You do not have access to this task.");
  }

  const saved = await patchManagerTaskRow(db, managerUserId, taskId, { completed: input.completed });
  const managerName = await managerDisplayName(db, managerUserId);
  return {
    ...saved,
    managerUserId,
    managerName,
    vendorDirectoryId: link.id,
  };
}
