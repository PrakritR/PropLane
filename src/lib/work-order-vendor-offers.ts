/** Client-side shape returned by GET /api/portal/work-order-vendor-offers — the vendors a
 * manager has confirmed sending a work order to for consultation/quote. */
export type WorkOrderVendorOffer = {
  id: string;
  workOrderId: string;
  vendorDirectoryId: string;
  vendorUserId: string | null;
  vendorName?: string;
  vendorEmail?: string;
  status: "sent" | "withdrawn" | "declined";
  declinedReason?: string | null;
  createdAt: string;
};

export async function fetchWorkOrderVendorOffers(workOrderId?: string): Promise<WorkOrderVendorOffer[]> {
  try {
    const query = workOrderId ? `?workOrderId=${encodeURIComponent(workOrderId)}` : "";
    const res = await fetch(`/api/portal/work-order-vendor-offers${query}`, { credentials: "include" });
    if (!res.ok) return [];
    const data = (await res.json()) as { offers?: WorkOrderVendorOffer[] };
    return Array.isArray(data.offers) ? data.offers : [];
  } catch {
    return [];
  }
}

/** Confirm sending this work order to one or more vendors for a free consultation/quote.
 * Nothing is ever sent automatically — this is the manager's explicit confirm action. */
export async function sendWorkOrderToVendors(
  workOrderId: string,
  vendorIds: string[],
): Promise<{ ok: boolean; sent?: string[]; error?: string }> {
  try {
    const res = await fetch("/api/portal/work-order-vendor-offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ workOrderId, vendorIds }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? "Could not send to vendors." };
    return { ok: true, sent: data.sent };
  } catch {
    return { ok: false, error: "Could not send to vendors." };
  }
}

/** Vendor declines a work-order offer they cannot or do not want to take. */
export async function declineWorkOrderVendorOffer(
  offerId: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/portal/work-order-vendor-offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "decline", offerId, reason: reason?.trim() || undefined }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? "Could not decline this offer." };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not decline this offer." };
  }
}
