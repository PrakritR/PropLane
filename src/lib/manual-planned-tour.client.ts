import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  appendManualPlannedTourLocal,
  syncScheduleRecordsFromServer,
} from "@/lib/demo-admin-scheduling";
import type { ManualPlannedTourInput } from "@/lib/manual-planned-tour.server";

export async function createManualPlannedTourClient(
  managerUserId: string,
  input: ManualPlannedTourInput,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (isDemoModeActive()) {
    appendManualPlannedTourLocal(managerUserId, {
      ...input,
      assignee: input.assignee ?? undefined,
    });
    return { ok: true, message: "Tour scheduled." };
  }

  const res = await fetch("/api/portal/manual-tour", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    return { ok: false, error: data.error ?? "Could not schedule tour." };
  }

  await syncScheduleRecordsFromServer({ force: true });
  return { ok: true, message: data.message ?? "Tour scheduled." };
}
