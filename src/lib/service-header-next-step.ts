/**
 * The one header of a service record, for both models (studio plan mobile-step-tabs-1004, Part 3, D8):
 *
 *   Message · Edit · ⋯ · the next step as the ONE labeled primary button
 *
 * The next step of an add-on follows its status: pending -> Approve, approved (with or without a
 * visit time) -> Mark done, nothing once it is returned or declined. A maintenance service keeps the
 * lifecycle's own next step (`managerServiceNextStep`, so the header and the overview's "Needs you"
 * never disagree). The ⋯ holds the two destructive items, the only red ones.
 *
 * "Mark done" is the plan's word for finishing an add-on; the maintenance flow keeps "Complete"
 * (`MANAGER_SERVICE_ACTION_LABEL`). The vocabulary guard allows this one literal on purpose.
 */
import type { ServiceRequest } from "@/lib/service-requests-storage";

export type AddOnHeaderStepKey = "approve" | "mark-done";
export type AddOnHeaderNextStep = { key: AddOnHeaderStepKey; label: string };

export const ADD_ON_NEXT_STEP_LABEL: Record<AddOnHeaderStepKey, string> = {
  approve: "Approve",
  "mark-done": "Mark done",
};

/** The labeled primary of an add-on's header; null when nothing is left to do. */
export function addOnHeaderNextStep(req: Pick<ServiceRequest, "status">): AddOnHeaderNextStep | null {
  switch ((req.status ?? "").toLowerCase()) {
    case "pending":
      return { key: "approve", label: ADD_ON_NEXT_STEP_LABEL.approve };
    case "approved":
      return { key: "mark-done", label: ADD_ON_NEXT_STEP_LABEL["mark-done"] };
    default:
      return null;
  }
}

export type ServiceHeaderMenuItem = { id: "decline" | "cancel" | "delete"; label: string; danger: true };

/**
 * What the ⋯ holds. An add-on that is still pending can be declined (the existing reason dialog); a
 * maintenance service that is not finished can be cancelled; both can be deleted.
 */
export function serviceHeaderMenuItems(
  kind: "add-on" | "maintenance",
  state: { canDecline?: boolean; canCancel?: boolean; canDelete?: boolean },
): ServiceHeaderMenuItem[] {
  const items: ServiceHeaderMenuItem[] = [];
  if (kind === "add-on" && state.canDecline) items.push({ id: "decline", label: "Decline request", danger: true });
  if (kind === "maintenance" && state.canCancel) items.push({ id: "cancel", label: "Cancel service", danger: true });
  if (state.canDelete !== false) items.push({ id: "delete", label: "Delete", danger: true });
  return items;
}
