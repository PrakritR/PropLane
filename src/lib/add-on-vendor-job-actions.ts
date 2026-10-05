/**
 * Client writes behind an add-on's Vendors pipeline: create the linked vendor job on the first send,
 * then the same server routes a maintenance service uses (offers, approve / remove a request, complete,
 * approve + pay). The add-on host in `pro-all-services-panel.tsx` calls these; the maintenance host
 * keeps its own handlers. Every amount is read from the stored job or bid - the server re-derives it.
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { parseMoneyAmount } from "@/lib/household-charges";
import {
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
  upsertManagerWorkOrderToServer,
  writeManagerWorkOrderRows,
} from "@/lib/manager-work-orders-storage";
import { buildAddOnVendorJobRow, linkedVendorJobFor } from "@/lib/add-on-vendor-job";
import { updateServiceRequest, type ServiceRequest } from "@/lib/service-requests-storage";
import { sendWorkOrderToVendors, type PublishMarketplaceOptions } from "@/lib/work-order-vendor-offers";
import type { WorkOrderBid } from "@/lib/work-order-bids";

type Result = { ok: true } | { ok: false; error: string };

const DEMO_REFUSAL = { ok: false as const, error: "Vendors are not available in the demo." };

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { error: "Could not reach the server." } };
  }
}

function errorOf(data: Record<string, unknown>, fallback: string): string {
  return typeof data.error === "string" && data.error.trim() ? data.error : fallback;
}

/** The add-on must be approved before a vendor is hired for it: everything after this writes money. */
export const ADD_ON_NOT_APPROVED_REFUSAL = {
  ok: false as const,
  error: "Approve this request first, then send the job to vendors.",
};

/** The vendor job for this add-on, created on first use. Returns the job's id. */
export async function ensureAddOnVendorJob(
  req: ServiceRequest,
  ctx: { propertyName: string; propertyAddress?: string; managerUserId: string | null },
): Promise<{ ok: true; workOrderId: string; created: boolean } | { ok: false; error: string }> {
  if (isDemoModeActive()) return DEMO_REFUSAL;
  const found = () => linkedVendorJobFor(req, readManagerWorkOrderRows());
  let existing = found();
  if (!existing) {
    // The local mirror is not evidence the job does not exist: a job created (and a bid approved) on
    // another device is only in the mirror after a sync, and creating a second blank row here would
    // replace `row_data` wholesale and wipe the hire. Ask the server before deciding it is absent.
    await syncManagerWorkOrdersFromServer({ force: true });
    existing = found();
  }
  if (existing) {
    if (req.linkedWorkOrderId !== existing.id) updateServiceRequest(req.id, { linkedWorkOrderId: existing.id });
    return { ok: true, workOrderId: existing.id, created: false };
  }
  const row = buildAddOnVendorJobRow(req, ctx);
  const saved = await upsertManagerWorkOrderToServer(row);
  if (!saved.ok) return { ok: false, error: saved.error };
  // The server already has the row; keep the local copy without mirroring the whole list again.
  const others = readManagerWorkOrderRows().filter((r) => r.id !== row.id);
  writeManagerWorkOrderRows([...others, saved.row], { mirror: false });
  updateServiceRequest(req.id, { linkedWorkOrderId: row.id });
  return { ok: true, workOrderId: row.id, created: true };
}

/** First "Send job": make sure the vendor job exists, then offer it through the one server offer path. */
export async function sendAddOnToVendors(
  req: ServiceRequest,
  ctx: { propertyName: string; propertyAddress?: string; managerUserId: string | null },
  vendorIds: string[],
  marketplace?: PublishMarketplaceOptions,
): Promise<{ ok: true; workOrderId: string; sent: number } | { ok: false; error: string }> {
  if (req.status !== "approved") return ADD_ON_NOT_APPROVED_REFUSAL;
  const job = await ensureAddOnVendorJob(req, ctx);
  if (!job.ok) return job;
  const sent = await sendWorkOrderToVendors(job.workOrderId, vendorIds, marketplace);
  if (!sent.ok) return { ok: false, error: sent.error ?? "Could not send the job." };
  await syncManagerWorkOrdersFromServer({ force: true });
  return { ok: true, workOrderId: job.workOrderId, sent: sent.sent?.length ?? 0 };
}

/** Approve one submitted bid (the server re-checks it is a real bid on this manager's job). */
export async function approveVendorJobBid(bid: Pick<WorkOrderBid, "id" | "workOrderId">): Promise<Result> {
  if (isDemoModeActive()) return DEMO_REFUSAL;
  const res = await postJson("/api/portal/work-order-bids", { action: "approve_bid", bidId: bid.id, workOrderId: bid.workOrderId });
  if (!res.ok) return { ok: false, error: errorOf(res.data, "Could not approve bid.") };
  await syncManagerWorkOrdersFromServer({ force: true });
  return { ok: true };
}

/** Withdraw one vendor's request (their offer or their open bid row). */
export async function removeVendorJobRequest(input: { workOrderId: string; bidId?: string | null; offerId?: string | null }): Promise<Result> {
  if (isDemoModeActive()) return DEMO_REFUSAL;
  const res = await postJson("/api/portal/work-order-bids", {
    action: "remove_request",
    workOrderId: input.workOrderId,
    ...(input.bidId ? { bidId: input.bidId } : {}),
    ...(input.offerId ? { offerId: input.offerId } : {}),
  });
  if (!res.ok) return { ok: false, error: errorOf(res.data, "Could not withdraw the request.") };
  return { ok: true };
}

function jobCostCents(row: DemoManagerWorkOrderRow): number {
  if (row.vendorCostCents != null) return row.vendorCostCents;
  const parsed = parseMoneyAmount(row.cost ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
}

/** Mark the vendor job done: the same completion route (and expense logging) a maintenance service uses. */
export async function completeVendorJob(row: DemoManagerWorkOrderRow, bid: Pick<WorkOrderBid, "amountCents" | "materialsCents"> | null): Promise<Result> {
  if (isDemoModeActive()) return DEMO_REFUSAL;
  const vendorCostCents = bid?.amountCents ?? jobCostCents(row);
  const materialsCostCents = bid?.materialsCents ?? row.materialsCostCents ?? 0;
  const res = await postJson("/api/portal/work-orders/complete", {
    workOrder: row,
    category: row.category ?? "general",
    ...(vendorCostCents > 0 ? { vendorCostCents } : {}),
    ...(materialsCostCents > 0 ? { materialsCostCents } : {}),
    workDoneSummary: row.workDoneSummary || row.vendorMarkedDoneNote || row.title,
    skipResidentNotify: true,
  });
  if (!res.ok) return { ok: false, error: errorOf(res.data, "Could not mark the job done.") };
  await syncManagerWorkOrdersFromServer({ force: true });
  return { ok: true };
}

/** Approve and pay the vendor's bill through the existing approve-pay route; a card checkout redirects. */
export async function payVendorJob(row: DemoManagerWorkOrderRow): Promise<Result & { checkoutUrl?: string }> {
  if (isDemoModeActive()) return DEMO_REFUSAL;
  const res = await postJson("/api/portal/work-orders/approve-pay", {
    workOrder: row,
    category: row.category ?? "general",
    vendorCostCents: jobCostCents(row),
    materialsCostCents: row.materialsCostCents ?? 0,
    materialsMemo: row.materialsMemo ?? "",
    workDoneSummary: row.workDoneSummary || row.vendorMarkedDoneNote || row.title,
    paymentChannel: "ach",
  });
  if (!res.ok) return { ok: false, error: errorOf(res.data, "Could not approve payment.") };
  if (typeof res.data.checkoutUrl === "string" && res.data.checkoutUrl) return { ok: true, checkoutUrl: res.data.checkoutUrl };
  await syncManagerWorkOrdersFromServer({ force: true });
  return { ok: true };
}
