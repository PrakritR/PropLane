/**
 * The one service vocabulary (docs/agents/services-system.md § One vocabulary).
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
import { formatServiceMoney, resolveWorkOrderAssignee } from "@/lib/manager-service-workflow";
import {
  serviceShortDay as shortDay,
  serviceShortWhen,
  serviceWeekdayDay as weekdayDay,
} from "@/lib/service-time-labels";
import {
  deriveAddOnStages,
  deriveServiceStages,
  deriveVendorRequestRows,
  serviceIsVendorPayable,
  type AddOnStageInput,
  type StageBarItem,
  type VendorRequestRow,
  type VendorRequestState,
} from "@/lib/work-order-bid-cycle";

export {
  SERVICE_STAGE_IDS,
  SERVICE_STAGE_LABEL,
  SERVICE_STAGE_TABS,
  isServiceStage,
  parseServiceStage,
  type ServiceStage,
} from "@/lib/service-stage-ids";
import { SERVICE_STAGE_IDS, SERVICE_STAGE_LABEL, type ServiceStage } from "@/lib/service-stage-ids";

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

/* ------------------------------------ row facts ------------------------------------ */

/** `Wed, Oct 8 · 9am` - a visit or start time as one short fact; empty when the time is unusable. */
export const formatServiceWhen = serviceShortWhen;

/**
 * What one requested vendor's row says, as plain text (never a pill):
 * "Requested Oct 3 · waiting" · "Estimate $180 · Oct 3" · "Visit Mon, Oct 6 · 4pm · $25 visit fee" ·
 * "Bid $152 + $12 materials · can start Wed, Oct 8" · "Declined · <reason>".
 */
export function vendorRequestFact(request: VendorRequestRow): string {
  const bidFact = () => {
    const start = request.proposedTime ? weekdayDay(request.proposedTime) : "";
    return [
      `Bid ${formatServiceMoney(request.bidAmountCents)}${request.bidMaterialsCents > 0 ? ` + ${formatServiceMoney(request.bidMaterialsCents)} materials` : ""}`,
      start ? `can start ${start}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  switch (request.state) {
    case "requested": {
      const day = shortDay(request.requestedAt);
      return `Requested${day ? ` ${day}` : ""} · waiting`;
    }
    case "estimate":
      return [`Estimate ${formatServiceMoney(request.estimateCents)}`, shortDay(request.estimateAt)].filter(Boolean).join(" · ");
    case "visit_booked":
    case "visit_done":
      return [
        `${request.state === "visit_done" ? "Visit done" : "Visit"} ${formatServiceWhen(request.visitAt)}`.trim(),
        request.visitFeeCents > 0 ? `${formatServiceMoney(request.visitFeeCents)} visit fee` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "bid":
      return bidFact();
    case "approved":
      return `Approved · ${bidFact()}`;
    default:
      return request.note?.trim() ? `Declined · ${request.note.trim()}` : "Declined";
  }
}

/**
 * The one fact a maintenance row carries under its title, by stage:
 * Open "3 bids · lowest $152" / "2 estimates" / "Requested 3 vendors" / "New";
 * Assigned "<assignee> · no time yet"; Scheduled "Wed, Oct 8 · 9am · <assignee>";
 * Completed "To pay" / "Paid" / "<assignee>".
 */
export function workOrderStageFact(row: DemoManagerWorkOrderRow, data: BidData): string {
  const stage = workOrderServiceStage(row, data);
  const accepted = data.bids.find((bid) => bid.status === "accepted");
  const assignee = resolveWorkOrderAssignee(row)?.name || accepted?.vendorName?.trim() || "";
  if (stage === "assigned") return [assignee || "Assigned", "no time yet"].join(" · ");
  if (stage === "scheduled") return [formatServiceWhen(row.scheduledAtIso) || "Scheduled", assignee].filter(Boolean).join(" · ");
  if (stage === "completed") {
    if ((row.status ?? "").trim().toLowerCase() === "cancelled") return "Cancelled";
    return (
      completedPaymentFact({ vendorPayable: serviceIsVendorPayable(row), paid: row.automationStatus === "paid" }) ||
      assignee ||
      "Completed"
    );
  }
  const requests = deriveVendorRequestRows(data.bids, data.offers).filter((r) => r.state !== "declined");
  const bids = requests.filter((r) => r.state === "bid" && r.bidTotalCents != null);
  if (bids.length > 0) {
    const lowest = Math.min(...bids.map((r) => r.bidTotalCents as number));
    return `${bids.length} ${bids.length === 1 ? "bid" : "bids"} · lowest ${formatServiceMoney(lowest)}`;
  }
  const estimates = requests.filter((r) => vendorAnswerGroup(r.state) === "estimates");
  if (estimates.length > 0) return `${estimates.length} ${estimates.length === 1 ? "estimate" : "estimates"}`;
  if (requests.length > 0) return `Requested ${requests.length} ${requests.length === 1 ? "vendor" : "vendors"}`;
  return "New";
}

/** The fact an add-on service request carries; it has no vendors, so there are no bids to count. */
export function addOnStageFact(input: AddOnStageInput & { assignee?: { id: string; name?: string } | null }): string {
  const stage = addOnServiceStage(input);
  const status = (input.status ?? "").toLowerCase();
  const who = input.assignee?.name?.trim() || "";
  if (status === "denied") return "Declined";
  if (stage === "assigned") return [who || "Assigned", "no time yet"].join(" · ");
  if (stage === "scheduled") return [formatServiceWhen(input.proposedVisit?.iso) || "Scheduled", who].filter(Boolean).join(" · ");
  if (stage === "completed") return who || "Completed";
  return "New";
}

/* ------------------------------------- the stepper ------------------------------------- */

/**
 * The record's stage stepper: Open -> Assigned -> Scheduled -> Completed, plus Paid only for a job a
 * vendor is paid for (self and team work create no outgoing payment).
 */
export function serviceStageSteps(
  stage: ServiceStage,
  opts: { vendorPayable: boolean; paid: boolean },
): StageBarItem[] {
  const ids: Array<ServiceStage | "paid"> = [...SERVICE_STAGE_IDS];
  if (opts.vendorPayable) ids.push("paid");
  const labels: Record<ServiceStage | "paid", string> = { ...SERVICE_STAGE_LABEL, paid: "Paid" };
  const currentId: ServiceStage | "paid" = stage === "completed" && opts.vendorPayable && opts.paid ? "paid" : stage;
  const currentIdx = ids.indexOf(currentId);
  return ids.map((id, idx) => ({ id, label: labels[id], state: idx < currentIdx ? "done" : idx === currentIdx ? "current" : "todo" }));
}

export function workOrderStageSteps(row: DemoManagerWorkOrderRow, data: BidData): StageBarItem[] {
  return serviceStageSteps(workOrderServiceStage(row, data), {
    vendorPayable: serviceIsVendorPayable(row),
    paid: row.automationStatus === "paid",
  });
}

export function addOnStageSteps(input: AddOnStageInput): StageBarItem[] {
  if ((input.status ?? "").toLowerCase() === "denied") {
    return [
      { id: "open", label: SERVICE_STAGE_LABEL.open, state: "done" },
      { id: "declined", label: "Declined", state: "current" },
    ];
  }
  return serviceStageSteps(addOnServiceStage(input), { vendorPayable: false, paid: false });
}
