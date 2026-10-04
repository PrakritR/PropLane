/**
 * A vendor record's Services tab, by the same four stages every service list uses
 * (`service-lifecycle.ts`): Open · Assigned · Scheduled · Completed.
 *
 *   Open       this vendor was asked and is still answering (Requested, an estimate, a visit, a bid);
 *              the row's fact is that vendor's own answer
 *   Assigned   this vendor is the one doing it, with no visit time yet
 *   Scheduled  this vendor's job has a visit time
 *   Completed  this vendor's job is finished (the row says To pay or Paid)
 *
 * The figure on a row is this vendor's own number: the approved (or invoiced) price once hired, else
 * their bid, else their estimate. Pure: callers pass rows already loaded.
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { workOrderCostCents } from "@/lib/manager-service-workflow";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import { deriveVendorRequestRows } from "@/lib/work-order-bid-cycle";
import { vendorRequestFact, workOrderServiceStage, workOrderStageFact, type ServiceStage } from "@/lib/service-lifecycle";

export type VendorServiceBucket = ServiceStage;

export type VendorServiceItem = {
  workOrderId: string;
  bucket: VendorServiceBucket;
  title: string;
  propertyName: string;
  unit: string;
  /** Plain text: this vendor's own answer on an Open row, else the stage fact ("Wed, Oct 8 · 9am · Pacific"). */
  fact: string;
  figureCents: number | null;
  figureLabel?: "Estimate" | "Bid" | "Approved" | "Invoice";
  /** True for a request the manager still has to answer (so the row opens on Vendors). */
  needsDecision: boolean;
};

export { SERVICE_STAGE_TABS as VENDOR_SERVICE_BUCKETS } from "@/lib/service-stage-ids";
export { vendorRequestFact };

export function buildVendorServiceItems(input: {
  /** The vendor's directory row id (`manager_vendor_records.id`). */
  vendorId: string;
  vendorUserId?: string | null;
  workOrders: readonly DemoManagerWorkOrderRow[];
  bids: readonly WorkOrderBid[];
  offers: readonly WorkOrderVendorOffer[];
}): VendorServiceItem[] {
  const mineBid = (bid: WorkOrderBid) =>
    bid.vendorDirectoryId === input.vendorId || (Boolean(input.vendorUserId) && bid.vendorUserId === input.vendorUserId);
  const mineOffer = (offer: WorkOrderVendorOffer) =>
    offer.vendorDirectoryId === input.vendorId || (Boolean(input.vendorUserId) && offer.vendorUserId === input.vendorUserId);

  const items: VendorServiceItem[] = [];
  for (const wo of input.workOrders) {
    const allBids = input.bids.filter((bid) => bid.workOrderId === wo.id);
    const allOffers = input.offers.filter((offer) => offer.workOrderId === wo.id);
    const bids = allBids.filter(mineBid);
    const offers = allOffers.filter(mineOffer);
    const base = { workOrderId: wo.id, title: wo.title, propertyName: wo.propertyName, unit: wo.unit };

    const assignedToMe = !wo.selfAssigned && wo.vendorId === input.vendorId;
    const approvedMine = bids.find((bid) => bid.status === "accepted");
    if (assignedToMe || approvedMine) {
      const stage = workOrderServiceStage(wo, { bids: allBids, offers: allOffers });
      const cents = workOrderCostCents(wo, approvedMine);
      items.push({
        ...base,
        bucket: stage,
        fact: workOrderStageFact(wo, { bids: allBids, offers: allOffers }),
        figureCents: cents,
        figureLabel: stage === "completed" ? "Invoice" : "Approved",
        needsDecision: false,
      });
      continue;
    }

    // Someone else was hired (or it is finished): this vendor's request is closed, not open.
    if (wo.vendorId || wo.selfAssigned || wo.bucket === "completed") continue;

    const request = deriveVendorRequestRows(bids, offers).find((r) => r.state !== "declined" && r.state !== "approved");
    if (!request) continue;
    const cents = request.bidTotalCents ?? request.estimateCents;
    items.push({
      ...base,
      bucket: "open",
      fact: vendorRequestFact(request),
      figureCents: cents,
      figureLabel: request.bidTotalCents != null ? "Bid" : request.estimateCents != null ? "Estimate" : undefined,
      needsDecision: true,
    });
  }
  return items;
}

export function countVendorServiceBuckets(items: readonly VendorServiceItem[]): Record<VendorServiceBucket, number> {
  const counts: Record<VendorServiceBucket, number> = { open: 0, assigned: 0, scheduled: 0, completed: 0 };
  for (const item of items) counts[item.bucket] += 1;
  return counts;
}
