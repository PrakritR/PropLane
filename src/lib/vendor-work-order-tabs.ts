import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import {
  SERVICE_STAGE_IDS,
  SERVICE_STAGE_LABEL,
  SERVICE_STAGE_TABS,
  VENDOR_SERVICE_ACTION_LABEL,
  parseServiceStage,
  type ServiceStage,
} from "@/lib/service-lifecycle";
import { vendorReplyChoices, type StageBarItem, type VendorReplyChoice } from "@/lib/work-order-bid-cycle";
import { serviceShortDay, serviceShortWhen } from "@/lib/service-time-labels";

/**
 * The vendor portal's Services tabs are the one service vocabulary (service-lifecycle.ts):
 * Open · Assigned · Scheduled · Completed, read from the VENDOR's point of view.
 *
 *  - Open       asked to answer and not approved yet (requested, estimate given, visit booked,
 *               bid submitted and waiting on the manager)
 *  - Assigned   this vendor's bid was approved, or the job was assigned directly, no visit time yet
 *  - Scheduled  has a visit time
 *  - Completed  the work is done (the row's fact says "Invoice sent" / "Paid"), or the vendor declined
 */
export type VendorWorkOrderTab = ServiceStage;

export const VENDOR_WORK_ORDER_TAB_ORDER: readonly VendorWorkOrderTab[] = SERVICE_STAGE_IDS;
export const VENDOR_WORK_ORDER_TABS = SERVICE_STAGE_TABS;
export const VENDOR_WORK_ORDER_TAB_LABELS: Record<VendorWorkOrderTab, string> = SERVICE_STAGE_LABEL;

/**
 * Old URL ids (pending / upcoming / past / quote / tour / scheduled / completed / potential /
 * current) always land on one of the four tabs, never on home.
 */
export function parseVendorWorkOrderTab(raw: string | undefined | null): VendorWorkOrderTab {
  return parseServiceStage(raw);
}

/** An estimate was given or a visit booked; the vendor still owes a real bid (labor price + work date). */
export function isPricingPendingBid(bid: WorkOrderBid | undefined): boolean {
  return Boolean(
    bid &&
      bid.amountCents == null &&
      bid.status === "submitted" &&
      ((bid.quoteMode === "after_consultation" && bid.consultationVisitAt) || bid.estimateCents != null),
  );
}

type VendorServiceFacts = {
  row: DemoManagerWorkOrderRow;
  bid?: WorkOrderBid;
  offer?: WorkOrderVendorOffer;
  /** True once a vendor invoice exists for this service. */
  invoiceSent?: boolean;
};

function isDeclined({ bid, offer }: Pick<VendorServiceFacts, "bid" | "offer">): boolean {
  if (bid?.status === "accepted") return false;
  return bid?.status === "declined" || (!bid && offer?.status === "declined");
}

function isCompleted(row: DemoManagerWorkOrderRow): boolean {
  return (
    row.bucket === "completed" ||
    row.automationStatus === "vendor_marked_done" ||
    row.automationStatus === "paid" ||
    Boolean(row.completedAt)
  );
}

/**
 * Which Services tab a job belongs on for this vendor. A declined offer or bid is finished
 * business and rests under Completed with the fact "Declined".
 */
export function vendorServiceStage(
  row: DemoManagerWorkOrderRow,
  bid?: WorkOrderBid,
  offer?: WorkOrderVendorOffer,
): ServiceStage {
  if (isCompleted(row)) return "completed";
  if (isDeclined({ bid, offer })) return "completed";
  const answering = bid?.status !== "accepted" && (Boolean(row.biddingOpen) || isPricingPendingBid(bid));
  if (answering) return "open";
  return row.scheduledAtIso || row.bucket === "scheduled" ? "scheduled" : "assigned";
}

/** @see vendorServiceStage - kept as the name older callers know. */
export function vendorWorkOrderTab(row: DemoManagerWorkOrderRow, bid?: WorkOrderBid, offer?: WorkOrderVendorOffer): VendorWorkOrderTab {
  return vendorServiceStage(row, bid, offer);
}

/** The stage stepper on the service page: Open → Assigned → Scheduled → Completed. */
export function vendorServiceStageItems(stage: ServiceStage): StageBarItem[] {
  const currentIdx = SERVICE_STAGE_IDS.indexOf(stage);
  return SERVICE_STAGE_IDS.map((id, idx) => ({
    id,
    label: SERVICE_STAGE_LABEL[id],
    state: idx < currentIdx ? "done" : idx === currentIdx ? "current" : "todo",
  }));
}

/* ----------------------------------- row facts ----------------------------------- */

/** "Wed, Oct 8 · 9am" (minutes only when there are some), in Pacific time like every PropLane stamp. */
export const vendorShortWhen = serviceShortWhen;

const vendorShortDay = serviceShortDay;

function money(cents: number | null | undefined): string {
  const value = (cents ?? 0) / 100;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(value) ? 0 : 2 })}`;
}

/**
 * The one fact a vendor Services row carries, in the vendor's vocabulary (a glyph fact, never a
 * pill): "Requested by Taylor M. · answer by Oct 5" · "Your estimate $90 · waiting on your bid" ·
 * "Visit Mon, Oct 6 · 4pm" · "Your bid $164 · waiting on the manager" · "Approved · pick a time" ·
 * "Wed, Oct 8 · 9am" · "Invoice sent" · "Paid Oct 2".
 */
export function vendorServiceFact(input: VendorServiceFacts): string {
  const { row, bid, offer } = input;
  const stage = vendorServiceStage(row, bid, offer);
  if (stage === "completed") {
    if (isDeclined({ bid, offer })) return "Declined";
    if (row.automationStatus === "paid") {
      const day = vendorShortDay(row.paidAt);
      return day ? `Paid ${day}` : "Paid";
    }
    return input.invoiceSent ? "Invoice sent" : "No invoice yet";
  }
  if (stage === "scheduled") return vendorShortWhen(row.scheduledAtIso) || row.scheduled?.trim() || "Scheduled";
  if (stage === "assigned") return bid?.status === "accepted" ? "Approved · pick a time" : "Assigned · pick a time";
  if (!bid) {
    const manager = row.managerName?.trim();
    const by = vendorShortDay(row.offerExpiresAt);
    return `${manager ? `Requested by ${manager}` : "Requested"}${by ? ` · answer by ${by}` : ""}`;
  }
  if (bid.consultationVisitAt && !bid.estimateVisitDoneAt) return `Visit ${vendorShortWhen(bid.consultationVisitAt)}`.trim();
  if (bid.consultationVisitAt && bid.estimateVisitDoneAt && bid.amountCents == null) return "Visit done · waiting on your bid";
  if (bid.amountCents == null && bid.estimateCents != null) return `Your estimate ${money(bid.estimateCents)} · waiting on your bid`;
  if (bid.amountCents != null) return `Your bid ${money(bid.amountCents + bid.materialsCents)} · waiting on the manager`;
  return "Requested";
}

/** Retained for callers that want the fact without the invoice lookup. */
export function vendorWorkOrderPhaseLabel(row: DemoManagerWorkOrderRow, bid?: WorkOrderBid, offer?: WorkOrderVendorOffer): string | null {
  return vendorServiceFact({ row, bid, offer });
}

/* ------------------------------- the service page ------------------------------- */

/**
 * The vendor service record's rail: Job (Overview · Estimate & bid · Schedule), Money (Invoice ·
 * Payments), Records (Communication · Documents). "service" is the Overview id.
 */
export type VendorServiceSection = "service" | "bid" | "schedule" | "invoice" | "payments" | "communication" | "documents";

export type VendorNextStepId = "submit_bid" | "visit_done" | "schedule" | "complete" | "send_invoice";
export type VendorNextStep = { id: VendorNextStepId; label: string; section: VendorServiceSection };

/**
 * The ONE primary action in the service page's header, the next thing the vendor owes:
 *  Open, nothing sent -> Submit bid · visit booked -> Visit done · estimate given / visit done ->
 *  Submit bid · bid sent -> nothing (waiting on the manager) · Assigned -> Schedule ·
 *  Scheduled -> Complete · Completed with no invoice -> Send invoice.
 */
export function vendorNextStep(input: VendorServiceFacts): VendorNextStep | null {
  const { row, bid, offer } = input;
  const stage = vendorServiceStage(row, bid, offer);
  if (stage === "open") {
    if (!bid) return { id: "submit_bid", label: VENDOR_SERVICE_ACTION_LABEL.submitBid, section: "bid" };
    if (bid.consultationVisitAt && !bid.estimateVisitDoneAt) {
      return { id: "visit_done", label: VENDOR_SERVICE_ACTION_LABEL.completeVisit, section: "bid" };
    }
    if (isPricingPendingBid(bid)) return { id: "submit_bid", label: VENDOR_SERVICE_ACTION_LABEL.submitBid, section: "bid" };
    return null;
  }
  if (stage === "assigned") return { id: "schedule", label: "Schedule", section: "schedule" };
  if (stage === "scheduled") return { id: "complete", label: VENDOR_SERVICE_ACTION_LABEL.complete, section: "schedule" };
  if (isDeclined({ bid, offer }) || row.automationStatus === "paid" || input.invoiceSent) return null;
  return { id: "send_invoice", label: VENDOR_SERVICE_ACTION_LABEL.sendInvoice, section: "invoice" };
}

/* ------------------------------ the answer on a service ------------------------------ */

/**
 * The choices the Estimate & bid section offers: exactly what `vendorReplyChoices` allows, minus a
 * plain Decline when there is no open request to answer (nothing to decline).
 */
export function vendorAnswerChoices(
  bid: WorkOrderBid | undefined,
  offer?: WorkOrderVendorOffer,
): Array<{ value: VendorReplyChoice; label: string }> {
  const canDeclineOffer = offer?.status === "sent";
  return vendorReplyChoices(bid).filter((choice) => choice.value !== "decline" || canDeclineOffer);
}

/** The choice selected when the section opens: the vendor's next step (Visit done / Submit bid). */
export function vendorDefaultReply(bid: WorkOrderBid | undefined): VendorReplyChoice {
  if (bid?.consultationVisitAt && !bid.estimateVisitDoneAt) return "complete_estimate_visit";
  return "submit_bid";
}

/** The selected choice, or the first allowed one when the selection is no longer on offer. */
export function vendorEffectiveReply(
  selected: VendorReplyChoice | null,
  bid: WorkOrderBid | undefined,
  offer?: WorkOrderVendorOffer,
): { value: VendorReplyChoice; label: string } | null {
  const choices = vendorAnswerChoices(bid, offer);
  const wanted = selected ?? vendorDefaultReply(bid);
  return choices.find((c) => c.value === wanted) ?? choices[0] ?? null;
}

/* ------------------------------- stage actions (⋯) ------------------------------- */

export type VendorServiceActionId =
  | "submit_bid"
  | "book_visit"
  | "visit_done"
  | "decline"
  | "schedule"
  | "reschedule"
  | "mark_done"
  | "send_invoice"
  | "message";

export type VendorServiceAction = { id: VendorServiceActionId; label: string };

/**
 * What a vendor can do to a service from a row's or the record header's ⋯, by stage - the one place
 * the Services tabs and the record agree (no button rows under rows):
 *  Open       Submit bid · Book visit · Decline (a bid already waiting on the manager keeps only Decline)
 *  Assigned   Schedule · Message the manager
 *  Scheduled  Reschedule (asks the manager, who owns the calendar) · Complete
 *  Completed  Send invoice (only while one is owed)
 */
export function vendorServiceActions(input: VendorServiceFacts): VendorServiceAction[] {
  const { row, bid, offer } = input;
  const stage = vendorServiceStage(row, bid, offer);
  const out: VendorServiceAction[] = [];
  if (stage === "open") {
    if (!bid) {
      out.push({ id: "submit_bid", label: VENDOR_SERVICE_ACTION_LABEL.submitBid });
      out.push({ id: "book_visit", label: VENDOR_SERVICE_ACTION_LABEL.bookVisit });
    } else if (bid.consultationVisitAt && !bid.estimateVisitDoneAt) {
      out.push({ id: "visit_done", label: VENDOR_SERVICE_ACTION_LABEL.completeVisit });
    } else if (isPricingPendingBid(bid)) {
      out.push({ id: "submit_bid", label: VENDOR_SERVICE_ACTION_LABEL.submitBid });
    }
    if (offer?.status === "sent" || bid?.status === "submitted") out.push({ id: "decline", label: VENDOR_SERVICE_ACTION_LABEL.decline });
  } else if (stage === "assigned") {
    out.push({ id: "schedule", label: "Schedule" }, { id: "message", label: "Message the manager" });
  } else if (stage === "scheduled") {
    out.push({ id: "reschedule", label: "Reschedule" });
    if (!row.automationStatus) out.push({ id: "mark_done", label: VENDOR_SERVICE_ACTION_LABEL.complete });
  } else if (!isDeclined({ bid, offer }) && row.automationStatus !== "paid" && !input.invoiceSent) {
    out.push({ id: "send_invoice", label: VENDOR_SERVICE_ACTION_LABEL.sendInvoice });
  }
  return out;
}

/**
 * The Estimate & bid section's underline tabs: Bid · Estimate visit · Decline, drawn from exactly the
 * answers `vendorAnswerChoices` allows (Estimate and Visit done appear only when they apply). The
 * submit label stays the choice's own `VENDOR_SERVICE_ACTION_LABEL` text.
 */
const BID_TAB_LABEL: Record<VendorReplyChoice, string> = {
  submit_bid: "Bid",
  give_estimate: "Estimate",
  book_estimate_visit: "Estimate visit",
  complete_estimate_visit: "Visit done",
  decline: "Decline",
  cant_do_it: "Decline",
};
const BID_TAB_ORDER: readonly VendorReplyChoice[] = ["submit_bid", "give_estimate", "book_estimate_visit", "complete_estimate_visit", "decline", "cant_do_it"];

export function vendorBidTabs(
  bid: WorkOrderBid | undefined,
  offer?: WorkOrderVendorOffer,
): Array<{ value: VendorReplyChoice; label: string; submitLabel: string }> {
  return vendorAnswerChoices(bid, offer)
    .map((choice) => ({ value: choice.value, label: BID_TAB_LABEL[choice.value], submitLabel: choice.label }))
    .sort((a, b) => BID_TAB_ORDER.indexOf(a.value) - BID_TAB_ORDER.indexOf(b.value));
}
