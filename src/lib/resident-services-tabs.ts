import { SERVICE_STAGE_IDS, SERVICE_STAGE_LABEL, type ServiceStage } from "@/lib/service-stage-ids";
import type { ServiceRowState } from "@/lib/unified-service-rows";

/**
 * Resident Services header buttons: the same four words every service list uses
 * (`service-lifecycle.ts`) - Open · Assigned · Scheduled · Completed. A declined add-on folds into
 * Completed, the same way the manager list does.
 */
export type ResidentServiceTab = ServiceStage;

export const RESIDENT_SERVICE_TAB_ORDER: ResidentServiceTab[] = [...SERVICE_STAGE_IDS];

export const RESIDENT_SERVICE_TAB_LABELS: Record<ResidentServiceTab, string> = SERVICE_STAGE_LABEL;

export function residentServiceTab(state: ServiceRowState): ResidentServiceTab {
  if (state === "declined") return "completed";
  return state;
}
