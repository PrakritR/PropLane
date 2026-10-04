import type { WorkOrderBid } from "@/lib/work-order-bids";

export const WORK_ORDER_BIDS_EVENT = "axis:work-order-bids";
const WORK_ORDER_BIDS_SESSION_KEY = "axis:work-order-bids:v1";

let memoryBids: WorkOrderBid[] = [];

function canUseStorage() {
  return typeof window !== "undefined";
}

function hydrateBidsFromSession() {
  if (!canUseStorage() || memoryBids.length > 0) return;
  try {
    const raw = window.sessionStorage.getItem(WORK_ORDER_BIDS_SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as WorkOrderBid[];
    if (!Array.isArray(parsed)) return;
    memoryBids = parsed;
  } catch {
    /* ignore */
  }
}

function persistBidsToSession(rows: WorkOrderBid[]) {
  if (!canUseStorage()) return;
  try {
    window.sessionStorage.setItem(WORK_ORDER_BIDS_SESSION_KEY, JSON.stringify(rows));
  } catch {
    /* ignore */
  }
}

function emit() {
  if (!canUseStorage()) return;
  window.dispatchEvent(new Event(WORK_ORDER_BIDS_EVENT));
}

/** Demo seed: overwrite local bid rows (no server mirror). */
export function seedDemoWorkOrderBids(bids: WorkOrderBid[]): void {
  if (!canUseStorage()) return;
  memoryBids = bids;
  persistBidsToSession(bids);
  emit();
}

export function readWorkOrderBids(workOrderId?: string): WorkOrderBid[] {
  hydrateBidsFromSession();
  const rows = memoryBids;
  if (!workOrderId?.trim()) return rows;
  return rows.filter((b) => b.workOrderId === workOrderId);
}

export function upsertWorkOrderBid(input: {
  workOrderId: string;
  vendorUserId?: string;
  vendorDirectoryId?: string | null;
  quoteMode?: WorkOrderBid["quoteMode"];
  consultationVisitAt?: string | null;
  amountCents?: number | null;
  materialsCents?: number;
  proposedTime?: string | null;
  note?: string | null;
  status?: WorkOrderBid["status"];
  vendorName?: string;
  vendorEmail?: string;
  estimateCents?: number | null;
  estimateVisitFeeCents?: number;
  estimateVisitDoneAt?: string | null;
  bidSubmittedAt?: string | null;
}): WorkOrderBid {
  hydrateBidsFromSession();
  const now = new Date().toISOString();
  const vendorUserId = input.vendorUserId?.trim();
  if (!vendorUserId) {
    throw new Error("vendorUserId is required");
  }
  const idx = memoryBids.findIndex((b) => b.workOrderId === input.workOrderId && b.vendorUserId === vendorUserId);
  const existing = idx >= 0 ? memoryBids[idx]! : null;
  const next: WorkOrderBid = {
    id: existing?.id ?? `bid-${input.workOrderId}-${vendorUserId}`,
    workOrderId: input.workOrderId,
    vendorUserId,
    vendorDirectoryId: input.vendorDirectoryId ?? existing?.vendorDirectoryId ?? null,
    vendorName: input.vendorName ?? existing?.vendorName ?? "Vendor",
    vendorEmail: input.vendorEmail ?? existing?.vendorEmail ?? "",
    quoteMode: input.quoteMode ?? existing?.quoteMode ?? "upfront",
    consultationVisitAt:
      input.consultationVisitAt !== undefined ? input.consultationVisitAt : (existing?.consultationVisitAt ?? null),
    amountCents: input.amountCents !== undefined ? input.amountCents : (existing?.amountCents ?? null),
    materialsCents: input.materialsCents ?? existing?.materialsCents ?? 0,
    proposedTime: input.proposedTime !== undefined ? input.proposedTime : (existing?.proposedTime ?? null),
    note: input.note !== undefined ? input.note : (existing?.note ?? null),
    status: input.status ?? existing?.status ?? "submitted",
    estimateCents: input.estimateCents !== undefined ? input.estimateCents : (existing?.estimateCents ?? null),
    estimateGivenAt: input.estimateCents ? now : (existing?.estimateGivenAt ?? null),
    bidSubmittedAt: input.bidSubmittedAt !== undefined ? input.bidSubmittedAt : (existing?.bidSubmittedAt ?? null),
    estimateVisitFeeCents: input.estimateVisitFeeCents ?? existing?.estimateVisitFeeCents ?? 0,
    estimateVisitDoneAt: input.estimateVisitDoneAt !== undefined ? input.estimateVisitDoneAt : (existing?.estimateVisitDoneAt ?? null),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const copy = [...memoryBids];
  if (idx >= 0) copy[idx] = next;
  else copy.push(next);
  memoryBids = copy;
  persistBidsToSession(copy);
  emit();
  return next;
}
