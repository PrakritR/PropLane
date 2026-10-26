/** Client-side shape returned by GET /api/portal/work-order-vendor-offers — the vendors a
 * manager has confirmed sending a work order to for consultation/quote. */

import { adminOversightUrl } from "@/lib/auth/admin-oversight.client";
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
    const res = await fetch(adminOversightUrl(`/api/portal/work-order-vendor-offers${query}`), { credentials: "include" });
    if (!res.ok) return [];
    const data = (await res.json()) as { offers?: WorkOrderVendorOffer[] };
    return Array.isArray(data.offers) ? data.offers : [];
  } catch {
    return [];
  }
}

/** Confirm sending this work order to one or more vendors for a free consultation/quote.
 * Nothing is ever sent automatically — this is the manager's explicit confirm action. */
export type PublishMarketplaceOptions = {
  enabled?: boolean;
  trade?: string;
  radiusMi?: number;
  budget?: string;
  sharePhotos?: boolean;
  notes?: string;
};

export async function previewMarketplaceVendorReach(
  workOrderId: string,
  trade: string,
  radiusMi: number,
): Promise<number> {
  try {
    const params = new URLSearchParams({
      workOrderId,
      preview: "1",
      trade,
      radiusMi: String(radiusMi),
    });
    const res = await fetch(adminOversightUrl(`/api/portal/work-order-vendor-offers?${params}`), { credentials: "include" });
    if (!res.ok) return 0;
    const data = (await res.json()) as { count?: number };
    return typeof data.count === "number" ? data.count : 0;
  } catch {
    return 0;
  }
}

export async function sendWorkOrderToVendors(
  workOrderId: string,
  vendorIds: string[],
  marketplace?: PublishMarketplaceOptions,
): Promise<SendToVendorsResult> {
  try {
    const res = await fetch("/api/portal/work-order-vendor-offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ workOrderId, vendorIds, marketplace }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? "Could not send to vendors." };
    return {
      ok: true,
      sent: data.sent,
      invited: Array.isArray(data.invited) ? data.invited : [],
      skippedDetails: Array.isArray(data.skippedDetails) ? data.skippedDetails : [],
    };
  } catch {
    return { ok: false, error: "Could not send to vendors." };
  }
}

export type SendToVendorsResult = {
  ok: boolean;
  sent?: string[];
  /** Sent vendors with no account yet: they were emailed a sign-up invite carrying the job. */
  invited?: { id: string; name: string }[];
  /** Vendors nothing reached, with the reason. */
  skippedDetails?: { id: string; name: string; reason: string }[];
  error?: string;
};

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The toast for a send: names who was reached, who was only invited, and who was skipped and why. */
export function describeVendorSendOutcome(result: SendToVendorsResult, vendorNameById: (id: string) => string = () => ""): string {
  const sent = result.sent ?? [];
  const invitedIds = new Set((result.invited ?? []).map((v) => v.id));
  const invitedNames = (result.invited ?? []).map((v) => v.name || "a vendor");
  const reached = sent.filter((id) => !invitedIds.has(id));
  const parts: string[] = [];
  if (reached.length > 0) {
    const names = reached.map((id) => vendorNameById(id)).filter(Boolean);
    parts.push(
      reached.length === 1 && names.length === 1
        ? `Requested ${names[0]}`
        : `Requested ${reached.length} vendor${reached.length === 1 ? "" : "s"}`,
    );
  }
  if (invitedNames.length > 0) parts.push(`Invited ${joinNames(invitedNames)} and sent the job`);
  for (const skip of result.skippedDetails ?? []) parts.push(`Skipped ${skip.name || "a vendor"}: ${skip.reason}`);
  if (parts.length === 0) return "No vendors could be requested.";
  return `${parts.join(". ")}.`;
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
