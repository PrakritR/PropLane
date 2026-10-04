/**
 * The vendor-bid cycle as pure functions (docs/agents/vendor-portal.md § Estimate vs bid).
 *
 *   Open -> bids requested (several vendors) -> estimate and/or estimate visit ->
 *   bid submitted -> manager approves ONE bid -> Assigned -> Scheduled -> Completed -> Paid
 *
 * An ESTIMATE is a rough price; it is never approvable and never a payment. A BID is the real
 * price plus a time and is the only thing a manager can approve. Server and UI both read the
 * same predicates here so the two cannot disagree about what "has a bid" means.
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import { resolveWorkOrderAssignee } from "@/lib/manager-service-workflow";

export {
  MAX_ESTIMATE_VISIT_FEE_CENTS,
  VISIT_FEE_INVOICE_PREFIX,
  isVisitFeeInvoiceNumber,
  parseVisitFeeCents,
  visitFeeInvoiceNumber,
} from "@/lib/work-order-visit-fee";

export { bidCanBeApproved, type BidApprovalFacts } from "@/lib/work-order-bid-approval";
import { bidCanBeApproved, type BidApprovalFacts } from "@/lib/work-order-bid-approval";

/** Client bids from before the estimate columns existed carry a price but no stamp; the price is the bid. */
export function clientBidApprovalFacts(bid: WorkOrderBid): BidApprovalFacts {
  return {
    status: bid.status,
    amountCents: bid.amountCents,
    bidSubmittedAt: bid.bidSubmittedAt ?? (bid.amountCents != null ? bid.updatedAt : null),
  };
}

/** Bids a manager can approve right now (a submitted bid, not an estimate and not a lost one). */
export function countSubmittedBids(bids: readonly WorkOrderBid[]): number {
  return bids.filter((bid) => bid.status === "submitted" && bidCanBeApproved(clientBidApprovalFacts(bid))).length;
}

export type VendorRequestState =
  | "requested"
  | "estimate"
  | "visit_booked"
  | "visit_done"
  | "bid"
  | "approved"
  | "declined";

export type VendorRequestRow = {
  key: string;
  vendorDirectoryId: string | null;
  vendorUserId: string | null;
  vendorName: string;
  offerId: string | null;
  bidId: string | null;
  state: VendorRequestState;
  estimateCents: number | null;
  visitAt: string | null;
  visitFeeCents: number;
  visitDone: boolean;
  bidAmountCents: number | null;
  bidMaterialsCents: number;
  bidTotalCents: number | null;
  proposedTime: string | null;
  note: string | null;
  /** When the vendor was asked (offer or bid creation). */
  requestedAt: string | null;
  /** When the vendor gave their estimate. */
  estimateAt: string | null;
  canApprove: boolean;
};

function stateOfBid(bid: WorkOrderBid): VendorRequestState {
  if (bid.status === "accepted") return "approved";
  if (bid.status === "declined") return "declined";
  if (bidCanBeApproved(clientBidApprovalFacts(bid))) return "bid";
  if (bid.consultationVisitAt) return bid.estimateVisitDoneAt ? "visit_done" : "visit_booked";
  if (bid.estimateCents != null) return "estimate";
  return "requested";
}

/**
 * One row per requested vendor: every bid row, plus every still-open offer that has no bid yet.
 * A vendor-declined offer reads as declined; a manager-withdrawn offer is not a row at all.
 */
export function deriveVendorRequestRows(
  bids: readonly WorkOrderBid[],
  offers: readonly WorkOrderVendorOffer[],
): VendorRequestRow[] {
  const rows: VendorRequestRow[] = [];
  const seenVendors = new Set<string>();
  for (const bid of bids) {
    const state = stateOfBid(bid);
    if (bid.vendorDirectoryId) seenVendors.add(bid.vendorDirectoryId);
    const offer = offers.find(
      (o) => (bid.vendorDirectoryId && o.vendorDirectoryId === bid.vendorDirectoryId) || (o.vendorUserId && o.vendorUserId === bid.vendorUserId),
    );
    const total = bid.amountCents != null ? bid.amountCents + bid.materialsCents : null;
    rows.push({
      key: `bid-${bid.id}`,
      vendorDirectoryId: bid.vendorDirectoryId,
      vendorUserId: bid.vendorUserId,
      vendorName: bid.vendorName?.trim() || offer?.vendorName?.trim() || "Vendor",
      offerId: offer?.id ?? null,
      bidId: bid.id,
      state,
      estimateCents: bid.estimateCents ?? null,
      visitAt: bid.consultationVisitAt,
      visitFeeCents: bid.estimateVisitFeeCents ?? 0,
      visitDone: Boolean(bid.estimateVisitDoneAt),
      bidAmountCents: bid.amountCents,
      bidMaterialsCents: bid.materialsCents,
      bidTotalCents: total,
      proposedTime: bid.proposedTime,
      note: bid.note,
      requestedAt: offer?.createdAt ?? bid.createdAt ?? null,
      estimateAt: bid.estimateGivenAt ?? null,
      canApprove: state === "bid",
    });
  }
  for (const offer of offers) {
    if (offer.status === "withdrawn") continue;
    if (seenVendors.has(offer.vendorDirectoryId)) continue;
    if (offer.vendorUserId && bids.some((b) => b.vendorUserId === offer.vendorUserId)) continue;
    rows.push({
      key: `offer-${offer.id}`,
      vendorDirectoryId: offer.vendorDirectoryId,
      vendorUserId: offer.vendorUserId,
      vendorName: offer.vendorName?.trim() || "Vendor",
      offerId: offer.id,
      bidId: null,
      state: offer.status === "declined" ? "declined" : "requested",
      estimateCents: null,
      visitAt: null,
      visitFeeCents: 0,
      visitDone: false,
      bidAmountCents: null,
      bidMaterialsCents: 0,
      bidTotalCents: null,
      proposedTime: null,
      note: offer.declinedReason ?? null,
      requestedAt: offer.createdAt ?? null,
      estimateAt: null,
      canApprove: false,
    });
  }
  return rows;
}

export type ServiceStageId =
  | "pending"
  | "requested"
  | "estimates"
  | "visits"
  | "bids"
  | "approved"
  | "scheduled"
  | "completed"
  | "paid";
export type ServiceStage = { id: ServiceStageId; label: string; state: "done" | "current" | "todo" };

const STAGE_LABEL: Record<ServiceStageId, string> = {
  pending: "Open",
  requested: "Requested",
  estimates: "Estimates",
  visits: "Visits",
  bids: "Bids",
  approved: "Assigned",
  scheduled: "Scheduled",
  completed: "Completed",
  paid: "Paid",
};

/**
 * The stage of the whole service, from server data only (never a stored stage):
 *
 *   Open -> Requested -> Estimates -> Visits -> Bids -> Approved -> Scheduled -> Completed -> Paid
 *
 * Before a bid is approved the stage is how far the furthest vendor has got (a submitted bid beats
 * a booked visit beats an estimate beats a bare request). A service that goes straight to a
 * vendor, a teammate or yourself skips the vendor stages; one that never involves a vendor drops
 * Paid, since self and team work creates no outgoing payment.
 */
export function deriveServiceStages(
  row: DemoManagerWorkOrderRow,
  data: { bids: readonly WorkOrderBid[]; offers: readonly WorkOrderVendorOffer[] },
): { stages: ServiceStage[]; currentId: ServiceStageId } {
  const assignee = resolveWorkOrderAssignee(row);
  const requests = deriveVendorRequestRows(data.bids, data.offers);
  const live = requests.filter((r) => r.state !== "declined");
  const anyBid = data.bids.length > 0;
  const anyOpenOffer = data.offers.some((o) => o.status === "sent");
  const biddingTouched = Boolean(row.biddingOpen || row.biddingResolvedAt) || anyBid || anyOpenOffer || data.offers.length > 0;
  const approvedBid = data.bids.some((b) => b.status === "accepted");
  const bidFlow = biddingTouched;
  const paid = row.automationStatus === "paid";
  const completed = row.bucket === "completed" || row.automationStatus === "vendor_marked_done" || paid;
  const scheduled = row.bucket === "scheduled" || Boolean(row.scheduledAtIso) || completed;
  const vendorJob = assignee?.kind === "vendor" || (!assignee && bidFlow);

  const ids: ServiceStageId[] = ["pending"];
  if (bidFlow) ids.push("requested", "estimates", "visits", "bids", "approved");
  ids.push("scheduled", "completed");
  if (vendorJob) ids.push("paid");

  let currentId: ServiceStageId = "pending";
  if (paid) currentId = "paid";
  else if (completed) currentId = "completed";
  else if (scheduled) currentId = "scheduled";
  else if (bidFlow && (approvedBid || (assignee?.kind === "vendor" && row.biddingResolvedAt))) currentId = "approved";
  else if (bidFlow && live.some((r) => r.state === "bid")) currentId = "bids";
  else if (bidFlow && live.some((r) => r.state === "visit_booked" || r.state === "visit_done")) currentId = "visits";
  else if (bidFlow && live.some((r) => r.state === "estimate")) currentId = "estimates";
  else if (bidFlow && (row.biddingOpen || anyBid || anyOpenOffer)) currentId = "requested";
  if (!ids.includes(currentId)) currentId = ids[ids.length - 1]!;

  const currentIdx = ids.indexOf(currentId);
  const stages = ids.map((id, idx): ServiceStage => ({
    id,
    label: STAGE_LABEL[id],
    state: idx < currentIdx ? "done" : idx === currentIdx ? "current" : "todo",
  }));
  return { stages, currentId };
}

/** Self or team work is never paid through PropLane; only an assigned vendor's job can be. */
export function serviceIsVendorPayable(row: DemoManagerWorkOrderRow): boolean {
  if (row.selfAssigned) return false;
  const assignee = resolveWorkOrderAssignee(row);
  return assignee?.kind === "vendor";
}

export type BidComparisonRow = {
  key: string;
  bidId: string | null;
  vendorName: string;
  vendorDirectoryId: string | null;
  totalCents: number;
  laborCents: number;
  materialsCents: number;
  /** When the vendor says they can start (the bid's proposed time). */
  earliestAt: string | null;
  /** The estimate visit's date, when the vendor came out before bidding. */
  estimateVisitAt: string | null;
  /** True for every row tied at the lowest total. */
  lowest: boolean;
  canApprove: boolean;
};

/**
 * Side-by-side bids: every vendor with a SUBMITTED bid (an estimate is never comparable), cheapest
 * first, the lowest total flagged. Ties keep the order the vendors answered in.
 */
export function compareBids(rows: readonly VendorRequestRow[]): BidComparisonRow[] {
  const bids = rows.filter((row) => row.state === "bid" && row.bidTotalCents != null);
  if (bids.length === 0) return [];
  const lowestTotal = Math.min(...bids.map((row) => row.bidTotalCents as number));
  return bids
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (a.row.bidTotalCents as number) - (b.row.bidTotalCents as number) || a.index - b.index)
    .map(({ row }) => ({
      key: row.key,
      bidId: row.bidId,
      vendorName: row.vendorName,
      vendorDirectoryId: row.vendorDirectoryId,
      totalCents: row.bidTotalCents as number,
      laborCents: row.bidAmountCents ?? 0,
      materialsCents: row.bidMaterialsCents,
      earliestAt: row.proposedTime,
      estimateVisitAt: row.visitAt,
      lowest: row.bidTotalCents === lowestTotal,
      canApprove: row.canApprove,
    }));
}

export type VendorReplyChoice =
  | "give_estimate"
  | "book_estimate_visit"
  | "submit_bid"
  | "complete_estimate_visit"
  | "decline"
  | "cant_do_it";

/**
 * What a vendor can answer, given where their row stands:
 *  - fresh: Give estimate · Book visit · Submit bid · Decline
 *  - estimate given: Submit bid · Book visit · Decline
 *  - visit booked: Visit done · Submit bid · Decline
 *  - visit done: Submit bid · Decline
 * Both decline values read "Decline" (the same word as the button): `decline` answers an offer
 * with no row yet; `cant_do_it` withdraws a row that exists. Labels match
 * `VENDOR_SERVICE_ACTION_LABEL` (service-lifecycle.ts), guarded by a unit test.
 */
export function vendorReplyChoices(bid: WorkOrderBid | undefined): Array<{ value: VendorReplyChoice; label: string }> {
  const labels: Record<VendorReplyChoice, string> = {
    give_estimate: "Give estimate",
    book_estimate_visit: "Book visit",
    submit_bid: "Submit bid",
    complete_estimate_visit: "Visit done",
    decline: "Decline",
    cant_do_it: "Decline",
  };
  let values: VendorReplyChoice[];
  if (!bid) values = ["give_estimate", "book_estimate_visit", "submit_bid", "decline"];
  else if (bid.consultationVisitAt && bid.estimateVisitDoneAt) values = ["submit_bid", "cant_do_it"];
  else if (bid.consultationVisitAt) values = ["complete_estimate_visit", "submit_bid", "cant_do_it"];
  else if (bid.estimateCents != null && bid.amountCents == null) values = ["submit_bid", "book_estimate_visit", "cant_do_it"];
  else values = ["give_estimate", "book_estimate_visit", "submit_bid", "cant_do_it"];
  return values.map((value) => ({ value, label: labels[value] }));
}

export type StageBarItem = { id: string; label: string; state: "done" | "current" | "todo" };

/** What an add-on stage needs from a service request. */
export type AddOnStageInput = {
  status?: string | null;
  assignee?: { id: string } | null;
  proposedVisit?: { iso: string } | null;
  servicePaid?: boolean;
};

export type AddOnStageId = "pending" | "assigned" | "scheduled" | "completed" | "paid" | "declined";
export const ADD_ON_TAB_IDS = ["pending", "assigned", "scheduled", "completed", "paid"] as const;
export const ADD_ON_STAGE_LABEL: Record<AddOnStageId, string> = {
  pending: "Open",
  assigned: "Assigned",
  scheduled: "Scheduled",
  completed: "Completed",
  paid: "Paid",
  declined: "Declined",
};

/**
 * The cycle of an add-on service request (a resident-bought service such as storage). It has no
 * vendors - vendors cannot take add-on services, `assignableKindsFor` - so it is
 * Open -> Assigned -> Scheduled -> Completed -> Paid (or Open -> Declined).
 */
export function deriveAddOnStages(input: AddOnStageInput | string | null | undefined): { stages: StageBarItem[]; currentId: AddOnStageId } {
  const req: AddOnStageInput = typeof input === "string" || input == null ? { status: input as string | null | undefined } : input;
  const status = (req.status ?? "").toLowerCase();
  const ids: AddOnStageId[] = status === "denied" ? ["pending", "declined"] : [...ADD_ON_TAB_IDS];
  let currentId: AddOnStageId = "pending";
  if (status === "denied") currentId = "declined";
  else if (status === "returned" && req.servicePaid) currentId = "paid";
  else if (status === "returned") currentId = "completed";
  else if (req.assignee && req.proposedVisit) currentId = "scheduled";
  else if (req.assignee) currentId = "assigned";
  const currentIdx = ids.indexOf(currentId);
  const stages = ids.map((id, idx): StageBarItem => ({
    id,
    label: ADD_ON_STAGE_LABEL[id],
    state: idx < currentIdx ? "done" : idx === currentIdx ? "current" : "todo",
  }));
  return { stages, currentId };
}
