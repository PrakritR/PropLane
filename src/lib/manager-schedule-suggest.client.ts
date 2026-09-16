import type { ManagerKindAvailabilityKind } from "@/lib/manager-availability-kinds";
import type { ScheduleSuggestion } from "@/lib/manager-schedule-suggest";

// Same set as `ManagerSuggestKind` in `manager-schedule-suggest.server.ts` — kept
// as its own alias here rather than importing from a `.server` module, which a
// client component must never do even for a type-only import.
export type ManagerSuggestKind = ManagerKindAvailabilityKind;

/**
 * Ask the server for a time suggestion (services/tasks scheduling only — never
 * tours). Never throws: a network failure or non-OK response is indistinguishable
 * from "nothing to suggest" here, so callers get `null` and fall back to an
 * empty field rather than a broken modal.
 */
export async function fetchManagerTimeSuggestion(input: {
  kind: ManagerSuggestKind;
  durationMinutes?: number;
  seed: string;
  after?: string | null;
  excludeWorkOrderId?: string;
}): Promise<ScheduleSuggestion | null> {
  const params = new URLSearchParams({ kind: input.kind, seed: input.seed });
  if (input.durationMinutes) params.set("duration", String(input.durationMinutes));
  if (input.after) params.set("after", input.after);
  if (input.excludeWorkOrderId) params.set("excludeWorkOrderId", input.excludeWorkOrderId);

  try {
    const res = await fetch(`/api/portal-schedule-suggest?${params.toString()}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { suggestion?: ScheduleSuggestion | null } | null;
    return data?.suggestion ?? null;
  } catch {
    return null;
  }
}
