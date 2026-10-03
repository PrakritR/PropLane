"use client";

import { MessageCircle, ShieldCheck, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";

function vendorIsVerified(vendor: ManagerVendorRow | undefined | null): boolean {
  if (!vendor) return false;
  const docs = vendor.vendorDocuments ?? [];
  const hasLicense = docs.some((doc) => doc.kind === "license");
  if (!hasLicense) return false;
  const today = new Date().toISOString().slice(0, 10);
  const insuranceDoc = docs.find((doc) => doc.kind === "insurance");
  if (insuranceDoc) return !insuranceDoc.expiresAt || insuranceDoc.expiresAt >= today;
  return Boolean(vendor.insuranceExpiresAt && vendor.insuranceExpiresAt >= today);
}

export function ServiceQuoteCompareSection({
  bids,
  waitingOffers,
  vendors,
  reviewAggregatesByVendorUserId,
  acceptingBidId,
  onHire,
  onMessageVendor,
}: {
  bids: WorkOrderBid[];
  waitingOffers: WorkOrderVendorOffer[];
  vendors: ManagerVendorRow[];
  reviewAggregatesByVendorUserId: Record<string, { average?: number | null; count: number } | undefined>;
  acceptingBidId: string | null;
  onHire: (bid: WorkOrderBid) => void;
  onMessageVendor: (vendorDirectoryId: string) => void;
}) {
  const pricedTotals = bids
    .filter((b) => b.amountCents != null)
    .map((b) => (b.amountCents ?? 0) + b.materialsCents);
  const lowestTotal = pricedTotals.length > 0 ? Math.min(...pricedTotals) : null;

  const quotedVendorIds = new Set(bids.map((b) => b.vendorDirectoryId));
  const waiting = waitingOffers.filter(
    (o) => o.status === "sent" && !quotedVendorIds.has(o.vendorDirectoryId),
  );

  if (bids.length === 0 && waiting.length === 0) {
    return <PortalListEmptyCard title="No bids yet" workspaceAware={false} dataAttr="work-order-bids-empty" />;
  }

  return (
    <div className="space-y-4" data-attr="work-order-compare-quotes">
      {bids.length > 0 ? (
        <div className="overflow-x-auto">
          <div className="grid min-w-[640px] grid-cols-[1.4fr_0.9fr_0.9fr_0.7fr_0.8fr_auto] gap-2 border-b border-border pb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
            <span>Vendor</span>
            <span>Earliest start</span>
            <span>Distance</span>
            <span>Rating</span>
            <span>Price</span>
            <span className="sr-only">Actions</span>
          </div>
          <div className="divide-y divide-border">
            {bids.map((bid) => {
              const pricingPending = bid.amountCents == null;
              const totalCents = (bid.amountCents ?? 0) + bid.materialsCents;
              const isLowest = lowestTotal != null && !pricingPending && totalCents === lowestTotal;
              const bidVendor = vendors.find((v) => v.id === bid.vendorDirectoryId);
              const reviewAggregate = bid.vendorUserId
                ? reviewAggregatesByVendorUserId[bid.vendorUserId]
                : undefined;
              const reviewFact =
                reviewAggregate && reviewAggregate.count > 0
                  ? `${reviewAggregate.average?.toFixed(1) ?? "—"} (${reviewAggregate.count})`
                  : "—";
              const verified = vendorIsVerified(bidVendor);
              return (
                <div
                  key={bid.id}
                  className="grid min-w-[640px] grid-cols-[1.4fr_0.9fr_0.9fr_0.7fr_0.8fr_auto] items-center gap-2 py-2 text-xs"
                >
                  <div>
                    <p className="font-medium text-foreground">{bid.vendorName || "Vendor"}</p>
                    {verified ? (
                      <PortalRowFact icon={ShieldCheck} srLabel="Verified">Verified</PortalRowFact>
                    ) : null}
                    {bid.note ? <p className="mt-0.5 text-muted line-clamp-2">{bid.note}</p> : null}
                  </div>
                  <span className="text-muted">
                    {bid.proposedTime
                      ? new Date(bid.proposedTime).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })
                      : "—"}
                  </span>
                  <span className="text-muted">—</span>
                  <span className="text-muted inline-flex items-center gap-1">
                    <Star className="size-3.5" aria-hidden />
                    {reviewFact}
                  </span>
                  <span className="font-semibold text-foreground tabular-nums">
                    {pricingPending ? "Pending" : `$${(totalCents / 100).toFixed(2)}`}
                    {isLowest ? <span className="ml-1 font-normal text-muted">Lowest</span> : null}
                  </span>
                  <div className="flex items-center gap-1">
                    <PortalIconAction
                      icon={MessageCircle}
                      label="Message"
                      data-attr="work-order-bid-message"
                      onClick={() => {
                        if (bid.vendorDirectoryId) onMessageVendor(bid.vendorDirectoryId);
                      }}
                    />
                    {bid.status === "submitted" && !pricingPending ? (
                      <Button
                        type="button"
                        variant="primary"
                        data-attr="work-order-accept-bid"
                        className="h-7 rounded-full px-3 text-xs"
                        disabled={acceptingBidId === bid.id}
                        onClick={() => onHire(bid)}
                      >
                        Hire
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {waiting.length > 0 ? (
        <div data-attr="work-order-quotes-waiting">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Waiting on</p>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {waiting.map((o) => (
              <li key={o.id}>{o.vendorName ?? "Vendor"}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
