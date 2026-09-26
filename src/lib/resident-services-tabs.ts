import type { ServiceRowState } from "@/lib/unified-service-rows";

/**
 * Resident Services header buttons (captain, 2026-09-25: every resident list
 * gets three right-side header buttons named per page — Services get
 * Requested / Scheduled / Done). The underlying row state
 * (`ServiceRowState`) keeps its own four values — `open` / `scheduled` /
 * `done` / `declined` — since that finer state still drives row facts and
 * manager-side filtering; only the resident's own three-button display folds
 * `declined` into `done`, the same way vendor Jobs' Past folds completed,
 * declined, and withdrawn (`src/lib/vendor-work-order-tabs.ts`).
 */
export type ResidentServiceTab = "open" | "scheduled" | "done";

export const RESIDENT_SERVICE_TAB_ORDER: ResidentServiceTab[] = ["open", "scheduled", "done"];

export const RESIDENT_SERVICE_TAB_LABELS: Record<ResidentServiceTab, string> = {
  open: "Requested",
  scheduled: "Scheduled",
  done: "Done",
};

export function residentServiceTab(state: ServiceRowState): ResidentServiceTab {
  if (state === "declined") return "done";
  return state;
}
