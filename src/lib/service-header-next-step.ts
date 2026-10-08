/**
 * The one header of a service record, for both models (studio plan mobile-step-tabs-1004, Part 3, D8):
 *
 *   Edit · [Send to phone · Publish to vendors] · red trash · the next step as the ONE labeled primary button
 *
 * The next step of an add-on follows its status: pending -> Approve, approved (with or without a
 * visit time) -> Mark done, nothing once it is returned or declined. A maintenance service keeps the
 * lifecycle's own next step (`managerServiceNextStep`, so the header and the overview's "Needs you"
 * never disagree). The red trash opens the one Cancel service / Delete permanently popup
 * (`ServiceRemoveDialog`, plan admin-money-1008 D8); the only thing a ⋯ can still hold is an add-on's
 * Decline request. No Message icon: Communication is a section in the rail.
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

export type ServiceHeaderMenuItem = { id: "decline"; label: string; danger: true };

/**
 * What the red part of the ⋯ holds: an add-on that is still pending can be declined (the existing reason
 * dialog). Cancel service and Delete are the trash icon's popup now, never menu items.
 */
export function serviceHeaderMenuItems(
  kind: "add-on" | "maintenance",
  state: { canDecline?: boolean },
): ServiceHeaderMenuItem[] {
  return kind === "add-on" && state.canDecline ? [{ id: "decline", label: "Decline request", danger: true }] : [];
}

export type ServiceHeaderIconId = "edit" | "send-to-phone" | "publish" | "trash";

/**
 * The icons of a service record's header, left to right, before the labeled next-step primary:
 * Edit · [Send to phone · Publish to vendors] · red trash. Send to phone and Publish to vendors keep their
 * place after Edit and show only while a maintenance service is Open with nobody on it (`canShare`).
 */
export function serviceHeaderIconIds(state: { canEdit?: boolean; canShare?: boolean; canRemove?: boolean }): ServiceHeaderIconId[] {
  const ids: ServiceHeaderIconId[] = [];
  if (state.canEdit !== false) ids.push("edit");
  if (state.canShare) ids.push("send-to-phone", "publish");
  if (state.canRemove !== false) ids.push("trash");
  return ids;
}
