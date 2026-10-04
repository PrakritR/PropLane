/** Client-side shape returned by GET /api/portal/work-order-bids; shared by the manager and vendor work-order panels.
 * One row per requested vendor. A row moves through: requested -> estimate and/or estimate visit
 * (consultationVisitAt) -> bid (amountCents + bidSubmittedAt) -> accepted or declined.
 * An estimate (estimateCents) is NOT a bid: amountCents/proposedTime stay null until the vendor
 * submits a real bid, and only a row with a submitted bid can be approved. */
export type WorkOrderBid = {
  id: string;
  workOrderId: string;
  vendorUserId: string;
  vendorDirectoryId: string | null;
  vendorName?: string;
  vendorEmail?: string;
  quoteMode: "upfront" | "after_consultation";
  consultationVisitAt: string | null;
  amountCents: number | null;
  materialsCents: number;
  proposedTime: string | null;
  note: string | null;
  status: "submitted" | "accepted" | "declined";
  createdAt: string;
  updatedAt: string;
  /** The vendor's rough price before seeing the job. Never approvable, never a payment. */
  estimateCents?: number | null;
  estimateGivenAt?: string | null;
  /** Set when the vendor submitted a real bid; only a bid with this set can be approved. */
  bidSubmittedAt?: string | null;
  /** Optional fee the manager pays once the estimate visit happened (0 = free visit). */
  estimateVisitFeeCents?: number;
  /** The vendor marked the estimate visit as having happened; the fee is payable from here. */
  estimateVisitDoneAt?: string | null;
};

export async function fetchWorkOrderBids(workOrderId?: string): Promise<WorkOrderBid[]> {
  const result = await fetchWorkOrderBidsResult(workOrderId);
  return result.bids;
}

/** Like {@link fetchWorkOrderBids} but reports fetch failure instead of swallowing it to an empty list. */
export async function fetchWorkOrderBidsResult(workOrderId?: string): Promise<{ ok: boolean; bids: WorkOrderBid[] }> {
  if (typeof window !== "undefined") {
    const { isDemoModeActive } = await import("@/lib/demo/demo-session");
    if (isDemoModeActive()) {
      const { readWorkOrderBids } = await import("@/lib/work-order-bids-storage");
      return { ok: true, bids: readWorkOrderBids(workOrderId) };
    }
  }
  try {
    const query = workOrderId ? `?workOrderId=${encodeURIComponent(workOrderId)}` : "";
    const res = await fetch(`/api/portal/work-order-bids${query}`, { credentials: "include" });
    if (!res.ok) return { ok: false, bids: [] };
    const data = (await res.json()) as { bids?: WorkOrderBid[] };
    return { ok: true, bids: Array.isArray(data.bids) ? data.bids : [] };
  } catch {
    return { ok: false, bids: [] };
  }
}
