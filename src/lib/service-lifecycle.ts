/**
 * The one service vocabulary (studio plan claude-2/services-vendors-1004 § One vocabulary).
 *
 * Every service list in every portal (manager Services page, property Services, vendor record
 * Services, vendor portal, resident) and the task list use the same four tabs, in this order:
 *
 *   Open -> Assigned -> Scheduled -> Completed
 *
 * Open      nobody is doing it yet (new, or out for bids)
 * Assigned  someone is doing it - an approved bid's vendor, a picked vendor, a teammate, or you -
 *           with no visit time yet
 * Scheduled has a visit time
 * Completed the work is finished; a vendor job then carries "To pay" or "Paid" as its fact
 *
 * A vendor's answer on one service is a separate, smaller vocabulary:
 *
 *   Requested -> Estimate -> Bid -> Approved | Declined
 *
 * Retired words (guarded by tests/unit/service-vocabulary.test.ts): Pending / Active / Current /
 * Potential / Past / Done as a service state, "quote", "Vendor & schedule", "Mark done",
 * "Publish to vendors", "Compare quotes".
 *
 * This module owns ids and labels only. The stage of a maintenance row is derived from
 * `deriveServiceStages` and of an add-on from `deriveAddOnStages` (work-order-bid-cycle.ts), so the
 * tab, its count, the row fact and the record's stepper can never disagree.
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import { resolveWorkOrderAssignee } from "@/lib/manager-service-workflow";
import {
  deriveAddOnStages,
  deriveServiceStages,
  type AddOnStageInput,
  type VendorRequestState,
} from "@/lib/work-order-bid-cycle";

export const SERVICE_STAGE_IDS = ["open", "assigned", "scheduled", "completed"] as const;
export type ServiceStage = (typeof SERVICE_STAGE_IDS)[number];

export const SERVICE_STAGE_LABEL: Record<ServiceStage, string> = {
  open: "Open",
  assigned: "Assigned",
  scheduled: "Scheduled",
  completed: "Completed",
};

/** The tabs every service list renders, in order. */
export const SERVICE_STAGE_TABS: ReadonlyArray<{ id: ServiceStage; label: string }> = SERVICE_STAGE_IDS.map((id) => ({
  id,
  label: SERVICE_STAGE_LABEL[id],
}));

/**
 * Old tab / bucket ids that may still arrive in a URL, a saved link or an email, mapped onto the
 * four stages. `active` / `current` / `upcoming` resolve to `scheduled`; the caller may refine
 * with data (an assigned row with no time belongs on `assigned`), but a link never falls home.
 */
const LEGACY_STAGE_ALIASES: Record<string, ServiceStage> = {
  open: "open",
  pending: "open",
  potential: "open",
  requested: "open",
  requests: "open",
  new: "open",
  "in-progress": "open",
  overdue: "open",
  assigned: "assigned",
  approved: "assigned",
  hired: "assigned",
  scheduled: "scheduled",
  active: "scheduled",
  current: "scheduled",
  upcoming: "scheduled",
  completed: "completed",
  complete: "completed",
  done: "completed",
  past: "completed",
  closed: "completed",
  paid: "completed",
  declined: "completed",
  denied: "completed",
};

export function parseServiceStage(raw: string | null | undefined): ServiceStage {
  const key = (raw ?? "").trim().toLowerCase();
  return LEGACY_STAGE_ALIASES[key] ?? "open";
}

export function isServiceStage(raw: string | null | undefined): raw is ServiceStage {
  return (SERVICE_STAGE_IDS as readonly string[]).includes(raw ?? "");
}

type BidData = { bids: readonly WorkOrderBid[]; offers: readonly WorkOrderVendorOffer[] };

/**
 * The stage of a maintenance service (work order). Bidding sub-steps (requested, estimates,
 * visits, bids) are all Open; an approved bid is Assigned. A service assigned straight to a
 * vendor, a teammate or yourself with no time yet is Assigned too.
 */
export function workOrderServiceStage(row: DemoManagerWorkOrderRow, data: BidData): ServiceStage {
  const { currentId } = deriveServiceStages(row, data);
  if (currentId === "completed" || currentId === "paid") return "completed";
  if (currentId === "scheduled") return "scheduled";
  if (currentId === "approved") return "assigned";
  if (currentId === "pending" && (resolveWorkOrderAssignee(row) || row.selfAssigned)) return "assigned";
  return "open";
}

/** The stage of an add-on service request (no vendors; declined lands on Completed). */
export function addOnServiceStage(input: AddOnStageInput | string | null | undefined): ServiceStage {
  const { currentId } = deriveAddOnStages(input);
  if (currentId === "completed" || currentId === "paid" || currentId === "declined") return "completed";
  if (currentId === "scheduled") return "scheduled";
  if (currentId === "assigned") return "assigned";
  return "open";
}

export function countByServiceStage<T>(items: readonly T[], stageOf: (item: T) => ServiceStage): Record<ServiceStage, number> {
  const counts: Record<ServiceStage, number> = { open: 0, assigned: 0, scheduled: 0, completed: 0 };
  for (const item of items) counts[stageOf(item)] += 1;
  return counts;
}

/* ------------------------- a vendor's answer on one service ------------------------- */

export const VENDOR_ANSWER_IDS = ["requested", "estimates", "bids", "approved", "declined"] as const;
export type VendorAnswerGroup = (typeof VENDOR_ANSWER_IDS)[number];

export const VENDOR_ANSWER_LABEL: Record<VendorAnswerGroup, string> = {
  requested: "Requested",
  estimates: "Estimates",
  bids: "Bids",
  approved: "Approved",
  declined: "Declined",
};

/** The service record's Vendors tabs, in order. An estimate visit counts as an estimate. */
export const VENDOR_ANSWER_TABS: ReadonlyArray<{ id: VendorAnswerGroup; label: string }> = VENDOR_ANSWER_IDS.map((id) => ({
  id,
  label: VENDOR_ANSWER_LABEL[id],
}));

export function vendorAnswerGroup(state: VendorRequestState): VendorAnswerGroup {
  switch (state) {
    case "estimate":
    case "visit_booked":
    case "visit_done":
      return "estimates";
    case "bid":
      return "bids";
    case "approved":
      return "approved";
    case "declined":
      return "declined";
    default:
      return "requested";
  }
}

/* ------------------------------------ actions ------------------------------------ */

/** Manager action labels: the same word on a header icon, a menu item, a button and the assistant. */
export const MANAGER_SERVICE_ACTION_LABEL = {
  requestBids: "Request bids",
  assign: "Assign",
  approveBid: "Approve bid",
  compareBids: "Compare bids",
  schedule: "Schedule",
  complete: "Complete",
  pay: "Pay",
  message: "Message",
  edit: "Edit",
  cancel: "Cancel service",
  delete: "Delete",
} as const;

/** Vendor action labels: a reply choice and its submit button say the same thing. */
export const VENDOR_SERVICE_ACTION_LABEL = {
  giveEstimate: "Give estimate",
  bookVisit: "Book visit",
  completeVisit: "Visit done",
  submitBid: "Submit bid",
  decline: "Decline",
  complete: "Complete",
  sendInvoice: "Send invoice",
} as const;

/** The fact a completed vendor job carries instead of a fifth tab. */
export function completedPaymentFact(input: { vendorPayable: boolean; paid: boolean }): "Paid" | "To pay" | null {
  if (!input.vendorPayable) return null;
  return input.paid ? "Paid" : "To pay";
}
