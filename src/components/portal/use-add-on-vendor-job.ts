"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  ADD_ON_NOT_APPROVED_REFUSAL,
  approveVendorJobBid,
  completeVendorJob,
  payVendorJob,
  removeVendorJobRequest,
  sendAddOnToVendors,
} from "@/lib/add-on-vendor-job-actions";
import { markServiceRequestDone, type ServiceRequest } from "@/lib/service-requests-storage";
import { fetchWorkOrderBids, type WorkOrderBid } from "@/lib/work-order-bids";
import { fetchWorkOrderVendorOffers, type PublishMarketplaceOptions, type WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import type { VendorRequestRow } from "@/lib/work-order-bid-cycle";

/**
 * Everything the add-on's Vendors pipeline needs from its linked vendor job (`add-on-vendor-job.ts`): the
 * job's offers and bids, and the handlers for Send job - Withdraw - Approve - Mark done - Pay. A request with
 * no job yet simply has empty lists; the first "Send job" creates it. Writes go through the same server
 * routes as a maintenance service; `onChanged` re-reads the local stores after each one.
 */
export function useAddOnVendorJob({
  request,
  job,
  managerUserId,
  propertyLabel,
  showToast,
  onChanged,
}: {
  request: ServiceRequest | null;
  job: DemoManagerWorkOrderRow | null;
  managerUserId: string | null;
  propertyLabel: string;
  showToast: (message: string) => void;
  onChanged: () => void;
}) {
  const workOrderId = job?.id ?? request?.linkedWorkOrderId?.trim() ?? null;
  const [bids, setBids] = useState<WorkOrderBid[]>([]);
  const [offers, setOffers] = useState<WorkOrderVendorOffer[]>([]);
  const [sending, setSending] = useState(false);
  const [approvingBidId, setApprovingBidId] = useState<string | null>(null);

  const reload = useCallback(async (id: string) => {
    const [nextBids, nextOffers] = await Promise.all([fetchWorkOrderBids(id), fetchWorkOrderVendorOffers(id)]);
    setBids(nextBids);
    setOffers(nextOffers);
  }, []);

  useEffect(() => {
    if (!workOrderId) {
      setBids([]);
      setOffers([]);
      return;
    }
    void reload(workOrderId);
  }, [workOrderId, reload]);

  const acceptedBid = useMemo(() => bids.find((bid) => bid.status === "accepted") ?? null, [bids]);

  const send = useCallback(
    async (vendorIds: string[], marketplace: PublishMarketplaceOptions | undefined) => {
      if (!request) return;
      setSending(true);
      try {
        const result = await sendAddOnToVendors(request, { propertyName: propertyLabel, managerUserId }, vendorIds, marketplace);
        if (!result.ok) {
          showToast(result.error);
          return;
        }
        onChanged();
        await reload(result.workOrderId);
        showToast(result.sent > 0 ? `Sent the job to ${result.sent} vendor${result.sent === 1 ? "" : "s"}.` : "No vendors could be reached.");
      } finally {
        setSending(false);
      }
    },
    [request, propertyLabel, managerUserId, showToast, onChanged, reload],
  );

  const approve = useCallback(
    async (row: VendorRequestRow) => {
      const bid = bids.find((candidate) => candidate.id === row.bidId);
      if (!bid) return;
      setApprovingBidId(bid.id);
      try {
        const result = await approveVendorJobBid(bid);
        if (!result.ok) {
          showToast(result.error);
          return;
        }
        onChanged();
        await reload(bid.workOrderId);
        showToast("Bid approved. The visit is booked at the bid's time.");
      } finally {
        setApprovingBidId(null);
      }
    },
    [bids, showToast, onChanged, reload],
  );

  const withdraw = useCallback(
    async (row: VendorRequestRow) => {
      if (!workOrderId) return;
      const result = await removeVendorJobRequest({ workOrderId, bidId: row.bidId, offerId: row.offerId });
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      await reload(workOrderId);
      showToast("Request withdrawn.");
    },
    [workOrderId, showToast, reload],
  );

  /**
   * The add-on's Mark done: finish the vendor job (when a vendor is on it) and the add-on itself.
   * An add-on that is not approved has nothing to finish - say so instead of completing the vendor
   * job (and posting its expense) while the request stays in its own bucket.
   */
  const markDone = useCallback(async () => {
    if (!request) return;
    if (request.status !== "approved") {
      showToast(ADD_ON_NOT_APPROVED_REFUSAL.error);
      return;
    }
    if (job && job.bucket !== "completed" && (job.vendorId || acceptedBid)) {
      const result = await completeVendorJob(job, acceptedBid);
      if (!result.ok) {
        showToast(result.error);
        return;
      }
    }
    const done = markServiceRequestDone(request.id);
    onChanged();
    showToast(done ? "Marked done." : ADD_ON_NOT_APPROVED_REFUSAL.error);
  }, [request, job, acceptedBid, showToast, onChanged]);

  const pay = useCallback(async () => {
    if (!job) return;
    const result = await payVendorJob(job);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    if (result.checkoutUrl) {
      window.location.assign(result.checkoutUrl);
      return;
    }
    onChanged();
    showToast("Approved and paid.");
  }, [job, showToast, onChanged]);

  return { bids, offers, sending, approvingBidId, send, approve, withdraw, markDone, pay, acceptedBid };
}
