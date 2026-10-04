/**
 * A vendor record's Services tab, from the bid cycle.
 *
 *   Requested - this vendor was asked, or has given an estimate / booked a visit / submitted a bid,
 *               and has not been approved (nor lost the service to someone else)
 *   Active    - this vendor is the one doing the service and it is not finished
 *   Done      - this vendor's service is completed or paid
 *
 * The figure on a row is this vendor's own number: the approved (or invoiced) price once hired, else
 * their bid, else their estimate. Pure: callers pass rows already loaded.
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { workOrderCostCents, formatServiceMoney } from "@/lib/manager-service-workflow";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import { deriveVendorRequestRows, serviceListStageFact, type VendorRequestRow } from "@/lib/work-order-bid-cycle";

export type VendorServiceBucket = "requested" | "active" | "done";

export type VendorServiceItem = {
  workOrderId: string;
  bucket: VendorServiceBucket;
  title: string;
  propertyName: string;
  unit: string;
  /** Plain glyph fact: "Requested · waiting", "Estimate $180", "Visit Mon 4:00 PM", "Bid $200", "Scheduled Oct 8". */
  fact: string;
  figureCents: number | null;
  figureLabel?: "Estimate" | "Bid" | "Approved" | "Invoice";
  /** True for a request the manager still has to answer (so the row opens on Vendor & schedule). */
  needsDecision: boolean;
};

export const VENDOR_SERVICE_BUCKETS: ReadonlyArray<{ id: VendorServiceBucket; label: string }> = [
  { id: "requested", label: "Requested" },
  { id: "active", label: "Active" },
  { id: "done", label: "Done" },
];

function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function vendorRequestFact(request: VendorRequestRow): string {
  switch (request.state) {
    case "requested":
      return "Requested · waiting";
    case "estimate":
      return `Estimate ${formatServiceMoney(request.estimateCents)}`;
    case "visit_booked":
      return `Visit ${shortWhen(request.visitAt)}`.trim();
    case "visit_done":
      return "Visit done";
    case "bid":
      return `Bid ${formatServiceMoney(request.bidTotalCents)}`;
    case "approved":
      return "Approved";
    default:
      return "Declined";
  }
}

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
    const bids = input.bids.filter((bid) => bid.workOrderId === wo.id && mineBid(bid));
    const offers = input.offers.filter((offer) => offer.workOrderId === wo.id && mineOffer(offer));
    const base = { workOrderId: wo.id, title: wo.title, propertyName: wo.propertyName, unit: wo.unit };

    const assignedToMe = !wo.selfAssigned && wo.vendorId === input.vendorId;
    if (assignedToMe) {
      const done = wo.bucket === "completed" || wo.automationStatus === "vendor_marked_done" || wo.automationStatus === "paid";
      const accepted = bids.find((bid) => bid.status === "accepted");
      const cents = workOrderCostCents(wo, accepted);
      items.push({
        ...base,
        bucket: done ? "done" : "active",
        fact: serviceListStageFact(wo, { bids: input.bids.filter((b) => b.workOrderId === wo.id), offers: input.offers.filter((o) => o.workOrderId === wo.id) }),
        figureCents: cents,
        figureLabel: done ? "Invoice" : "Approved",
        needsDecision: false,
      });
      continue;
    }

    // Someone else was hired (or it is finished): this vendor's request is closed, not requested.
    if (wo.vendorId || wo.selfAssigned || wo.bucket === "completed") continue;

    const request = deriveVendorRequestRows(bids, offers).find((r) => r.state !== "declined" && r.state !== "approved");
    if (!request) continue;
    const cents = request.bidTotalCents ?? request.estimateCents;
    items.push({
      ...base,
      bucket: "requested",
      fact: vendorRequestFact(request),
      figureCents: cents,
      figureLabel: request.bidTotalCents != null ? "Bid" : request.estimateCents != null ? "Estimate" : undefined,
      needsDecision: true,
    });
  }
  return items;
}

export function countVendorServiceBuckets(items: readonly VendorServiceItem[]): Record<VendorServiceBucket, number> {
  const counts: Record<VendorServiceBucket, number> = { requested: 0, active: 0, done: 0 };
  for (const item of items) counts[item.bucket] += 1;
  return counts;
}
