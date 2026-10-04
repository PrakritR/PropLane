import type { DemoManagerOutgoingPaymentRow, DemoManagerWorkOrderRow, ManagerPaymentBucket } from "@/data/demo-portal";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { enrichOutgoingRowWithVendorPayments, managerVendorPayMethodLabel } from "@/lib/manager-vendor-payment-flow";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { readManagerWorkOrderRows } from "@/lib/manager-work-orders-storage";
import { parseMoneyAmount } from "@/lib/parse-money";
import { portalSessionViewerId, onPortalSessionViewerChange } from "@/lib/auth/portal-session-gate";
import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";
import { serverSyncOriginatedEvent } from "@/lib/property-pipeline-events";
import { safeFormatDateTime } from "@/lib/pacific-time";
import {
  maskAccountReference,
  PAYEE_TYPE_SHORT_LABEL,
  payeeReferenceNoun,
  type ManagerPayee,
} from "@/lib/manager-payees";
import { serviceIsVendorPayable } from "@/lib/work-order-bid-cycle";

export type ManagerExpenseSnapshot = {
  id: string;
  propertyId?: string | null;
  propertyName?: string | null;
  categoryCode: string;
  categoryLabel: string;
  amountCents: number;
  expenseDate: string;
  memo?: string | null;
  vendorId?: string | null;
  /** The saved payee an expense recorded through "Add payment" was made to. */
  payeeId?: string | null;
  sourceWorkOrderId?: string | null;
};

/** Payee name, type and masked reference for a row ("Chase Home Lending" / "Mortgage" / "Loan ••4821"). */
export function outgoingPayeeDetails(payee: ManagerPayee): { name: string; typeLabel: string; referenceLabel?: string } {
  const typeLabel = payee.kind === "teammate" ? "Teammate" : payee.payeeType ? PAYEE_TYPE_SHORT_LABEL[payee.payeeType] : "Payee";
  const masked = maskAccountReference(payee.accountReference);
  return {
    name: payee.name,
    typeLabel,
    referenceLabel: masked ? `${payeeReferenceNoun(payee.payeeType)} ${masked}` : undefined,
  };
}

export const MANAGER_OUTGOING_PAYMENTS_EVENT = "axis:manager-outgoing-payments";
const SESSION_KEY = "axis:manager-outgoing-expenses:v1";
const DELETED_DEMO_EXPENSES_KEY = "axis:manager-outgoing-expenses-deleted:v1";
const SYNC_TTL_MS = 15_000;

type ExpenseCache = {
  rows: ManagerExpenseSnapshot[];
  hydrated: boolean;
  lastSyncedAt: number;
  refresher?: CoalescedRefresher<ManagerExpenseSnapshot[]>;
};
const caches = new Map<string, ExpenseCache>();
let viewerGeneration = 0;
onPortalSessionViewerChange(() => {
  viewerGeneration += 1;
  caches.clear();
});
function viewerKey(): string | null {
  return isDemoModeActive() ? "demo" : portalSessionViewerId();
}
function storageKey(key: string): string {
  return key === "demo" ? SESSION_KEY : `${SESSION_KEY}:${key}`;
}
function cacheFor(key: string): ExpenseCache {
  let entry = caches.get(key);
  if (!entry) {
    entry = { rows: [], hydrated: false, lastSyncedAt: 0 };
    caches.set(key, entry);
  }
  return entry;
}


function canUseStorage() {
  return typeof window !== "undefined";
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function parseCents(label: string): number {
  const parsed = parseMoneyAmount(label);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function dueDateLabelFromIso(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Sortable epoch ms for an ISO date (null when absent/unparseable) — keeps ordering chronological, not alphabetical by label. */
function dueDateMsFromIso(iso: string | undefined): number | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function workOrderAmountCents(row: DemoManagerWorkOrderRow): number {
  const labor = row.vendorCostCents ?? 0;
  const materials = row.materialsCostCents ?? 0;
  if (labor + materials > 0) return labor + materials;
  return parseCents(row.cost ?? "");
}

function workOrderBucket(row: DemoManagerWorkOrderRow): ManagerPaymentBucket | null {
  if (row.automationStatus === "paid") return "paid";
  if (row.automationStatus !== "vendor_marked_done") return null;
  const markedAt = row.vendorMarkedDoneAt ? new Date(row.vendorMarkedDoneAt).getTime() : NaN;
  if (Number.isFinite(markedAt) && Date.now() - markedAt > 3 * 86_400_000) return "overdue";
  return "pending";
}

function workOrderStatusLabel(bucket: ManagerPaymentBucket): string {
  if (bucket === "paid") return "Paid";
  if (bucket === "overdue") return "Overdue";
  return "Awaiting approval";
}

function hydrateFromSession(key: string): ExpenseCache {
  const entry = cacheFor(key);
  if (!canUseStorage() || entry.hydrated) return entry;
  entry.hydrated = true;
  try {
    const raw = window.sessionStorage.getItem(storageKey(key));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    entry.rows = Array.isArray(parsed) ? parsed as ManagerExpenseSnapshot[] : [];
  } catch {
    entry.rows = [];
  }
  return entry;
}

function writeSession(expenses: ManagerExpenseSnapshot[], key: string, fromServer = false) {
  const entry = cacheFor(key);
  entry.rows = expenses;
  entry.hydrated = true;
  if (canUseStorage()) {
    try { window.sessionStorage.setItem(storageKey(key), JSON.stringify(expenses)); } catch { /* memory remains usable */ }
    window.dispatchEvent(fromServer ? serverSyncOriginatedEvent(MANAGER_OUTGOING_PAYMENTS_EVENT) : new Event(MANAGER_OUTGOING_PAYMENTS_EVENT));
  }
}

function readDeletedDemoExpenseIds(): Set<string> {
  if (!canUseStorage()) return new Set();
  try {
    const raw = window.sessionStorage.getItem(DELETED_DEMO_EXPENSES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeDeletedDemoExpenseIds(ids: Set<string>) {
  if (!canUseStorage()) return;
  window.sessionStorage.setItem(DELETED_DEMO_EXPENSES_KEY, JSON.stringify([...ids]));
}

/** Demo seed: overwrite local expense rows (no server mirror). */
export function seedDemoManagerOutgoingExpenses(expenses: ManagerExpenseSnapshot[]): void {
  writeSession(expenses, "demo");
}

export function deleteManagerOutgoingExpense(expenseId: string): boolean {
  const id = expenseId.trim();
  const key = viewerKey();
  if (!id || !key) return false;
  const entry = hydrateFromSession(key);
  const hadLocal = entry.rows.some((expense) => expense.id === id);
  if (!hadLocal) return false;
  writeSession(entry.rows.filter((expense) => expense.id !== id), key);
  if (isDemoModeActive()) {
    const deleted = readDeletedDemoExpenseIds();
    deleted.add(id);
    writeDeletedDemoExpenseIds(deleted);
  }
  return true;
}

export function readManagerOutgoingExpenses(): ManagerExpenseSnapshot[] {
  const key = viewerKey();
  return key ? [...hydrateFromSession(key).rows] : [];
}

export async function syncManagerOutgoingExpensesFromServer(force = false): Promise<ManagerExpenseSnapshot[]> {
  const key = viewerKey();
  if (!key) return [];
  const entry = hydrateFromSession(key);
  if (isDemoModeActive()) return [...entry.rows];
  if (!force && entry.lastSyncedAt > 0 && Date.now() - entry.lastSyncedAt < SYNC_TTL_MS) {
    return [...entry.rows];
  }
  if (!entry.refresher) {
    const generation = viewerGeneration;
    const stillCurrent = () => generation === viewerGeneration && key === viewerKey();
    entry.refresher = createCoalescedRefresher(async () => {
      // A queued forced refresh must not start under a different session.
      if (!stillCurrent()) return [];
      try {
        const res = await fetch("/api/expenses", { credentials: "include", cache: "no-store" });
        const data = (await res.json()) as { expenses?: ManagerExpenseSnapshot[] };
        if (!stillCurrent()) return [];
        if (!res.ok) return [...entry.rows];
        const expenses = data.expenses ?? [];
        writeSession(expenses, key, true);
        entry.lastSyncedAt = Date.now();
        return expenses;
      } catch {
        return stillCurrent() ? [...entry.rows] : [];
      }
    });
  }
  return entry.refresher.run(force);
}

/**
 * One estimate-visit fee owed (or paid) to a vendor. Derived from a bid row whose visit the vendor
 * marked done; the amount is the fee stored on that bid, never typed by the manager.
 */
export type VisitFeeSnapshot = {
  bidId: string;
  workOrderId: string;
  vendorId?: string;
  vendorName?: string;
  feeCents: number;
  /** `estimate_visit_done_at` - the fee is not payable before this is set. */
  visitDoneAt: string | null | undefined;
  /** Set once the fee invoice is paid. */
  paidAt?: string | null;
};

/**
 * The fee rows: one per bid, only after the visit happened, only for a positive fee. Idempotent -
 * the same bid listed twice still yields one row. Fee rows carry no `workOrderId` so they can never
 * be routed into the job's Approve & pay.
 */
export function buildVisitFeeOutgoingRows(
  fees: readonly VisitFeeSnapshot[],
  workOrders: readonly DemoManagerWorkOrderRow[],
  propertyLabelById: Map<string, string> = new Map(),
): DemoManagerOutgoingPaymentRow[] {
  const workOrderById = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder]));
  const seen = new Set<string>();
  const rows: DemoManagerOutgoingPaymentRow[] = [];
  for (const fee of fees) {
    if (seen.has(fee.bidId)) continue;
    if (!fee.visitDoneAt || !Number.isSafeInteger(fee.feeCents) || fee.feeCents <= 0) continue;
    seen.add(fee.bidId);
    const workOrder = workOrderById.get(fee.workOrderId);
    const propertyId = workOrder?.assignedPropertyId?.trim() || workOrder?.propertyId?.trim() || undefined;
    const paid = Boolean(fee.paidAt);
    const dateIso = (paid ? fee.paidAt : fee.visitDoneAt) ?? undefined;
    rows.push({
      id: `visit-fee-${fee.bidId}`,
      kind: "visit-fee",
      visitFeeBidId: fee.bidId,
      serviceId: fee.workOrderId,
      propertyId,
      propertyName: (propertyId && propertyLabelById.get(propertyId)) || workOrder?.propertyName || "Portfolio",
      categoryLabel: "Estimate visit",
      payeeLabel: fee.vendorName?.trim() || "Vendor",
      chargeTitle: workOrder?.title ? `${workOrder.title} · estimate visit` : "Estimate visit",
      amountLabel: formatMoney(fee.feeCents),
      amountCents: fee.feeCents,
      dueDate: dueDateLabelFromIso(dateIso),
      dueDateSortMs: dueDateMsFromIso(dateIso),
      bucket: paid ? "paid" : "pending",
      statusLabel: paid ? "Paid" : "Awaiting approval",
      vendorId: fee.vendorId,
    });
  }
  return rows;
}

export function buildManagerOutgoingPaymentRows(input: {
  managerUserId: string | null;
  expenses: ManagerExpenseSnapshot[];
  workOrders?: DemoManagerWorkOrderRow[];
  /** Estimate-visit fees owed to vendors, built separately from the job payout. */
  visitFees?: readonly VisitFeeSnapshot[];
  propertyLabelById?: Map<string, string>;
  vendorNameById?: Map<string, string>;
  vendorById?: Map<string, ManagerVendorRow>;
  /** Saved payees by id; an expense naming one is titled by the payee, not by its memo. */
  payeeById?: Map<string, ManagerPayee>;
}): DemoManagerOutgoingPaymentRow[] {
  const rows: DemoManagerOutgoingPaymentRow[] = [];
  const propertyLabelById = input.propertyLabelById ?? new Map<string, string>();
  const vendorNameById = input.vendorNameById ?? new Map<string, string>();
  const vendorById = input.vendorById ?? new Map<string, ManagerVendorRow>();
  const workOrders = input.workOrders ?? readManagerWorkOrderRows();
  const workOrderById = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder]));
  const workOrderExpenseIds = new Set(
    input.expenses.map((expense) => expense.sourceWorkOrderId).filter((id): id is string => Boolean(id)),
  );

  for (const expense of input.expenses) {
    const propertyName =
      (expense.propertyId && propertyLabelById.get(expense.propertyId)) ||
      expense.propertyName?.trim() ||
      "Portfolio";
    const savedPayee = expense.payeeId ? input.payeeById?.get(expense.payeeId) : undefined;
    const payeeDetails = savedPayee ? outgoingPayeeDetails(savedPayee) : undefined;
    const payee =
      payeeDetails?.name ||
      (expense.vendorId && vendorNameById.get(expense.vendorId)) ||
      (expense.categoryCode === "service_fees" ? "PropLane" : "—");
    const sourceWorkOrder = expense.sourceWorkOrderId
      ? workOrderById.get(expense.sourceWorkOrderId)
      : undefined;
    const paidChannel = sourceWorkOrder?.vendorPaymentChannel;
    const vendor = sourceWorkOrder?.vendorId ? vendorById.get(sourceWorkOrder.vendorId) : undefined;
    const baseRow: DemoManagerOutgoingPaymentRow = {
      id: `expense-${expense.id}`,
      propertyId: expense.propertyId ?? undefined,
      propertyName,
      categoryLabel: expense.categoryLabel,
      payeeLabel: payee,
      ...(expense.payeeId ? { payeeId: expense.payeeId } : {}),
      ...(payeeDetails ? { payeeTypeLabel: payeeDetails.typeLabel, payeeReferenceLabel: payeeDetails.referenceLabel } : {}),
      chargeTitle: expense.memo?.trim() || expense.categoryLabel,
      amountLabel: formatMoney(expense.amountCents),
      dueDate: dueDateLabelFromIso(expense.expenseDate),
      dueDateSortMs: dueDateMsFromIso(expense.expenseDate),
      bucket: "paid",
      statusLabel: paidChannel ? `Paid · ${managerVendorPayMethodLabel(paidChannel)}` : "Paid",
      expenseEntryId: expense.id,
      workOrderId: expense.sourceWorkOrderId ?? undefined,
      fromExpense: true,
      fromAxisFee: expense.categoryCode === "service_fees",
      paidViaChannel: paidChannel,
      paidAtLabel: sourceWorkOrder?.paidAt ? safeFormatDateTime(sourceWorkOrder.paidAt) : undefined,
      vendorId: sourceWorkOrder?.vendorId,
    };
    rows.push(enrichOutgoingRowWithVendorPayments(baseRow, vendor));
  }

  for (const workOrder of workOrders) {
    if (input.managerUserId && workOrder.managerUserId && workOrder.managerUserId !== input.managerUserId) continue;
    // Only an assigned vendor's job is payable: yourself and teammates never create an outgoing row.
    if (!serviceIsVendorPayable(workOrder)) continue;
    const bucket = workOrderBucket(workOrder);
    if (!bucket || bucket === "paid") continue;
    if (workOrderExpenseIds.has(workOrder.id)) continue;
    const amountCents = workOrderAmountCents(workOrder);
    const vendor = workOrder.vendorId ? vendorById.get(workOrder.vendorId) : undefined;
    const workOrderPropertyId =
      workOrder.assignedPropertyId?.trim() || workOrder.propertyId?.trim() || undefined;
    const baseRow: DemoManagerOutgoingPaymentRow = {
      id: `work-order-${workOrder.id}`,
      propertyId: workOrderPropertyId,
      propertyName: workOrder.propertyName,
      categoryLabel: "Vendor payment",
      payeeLabel: workOrder.vendorName?.trim() || "Vendor",
      chargeTitle: workOrder.title,
      amountLabel: amountCents > 0 ? formatMoney(amountCents) : workOrder.cost || "—",
      amountCents: amountCents > 0 ? amountCents : undefined,
      dueDate: dueDateLabelFromIso(workOrder.vendorMarkedDoneAt ?? workOrder.completedAt),
      dueDateSortMs: dueDateMsFromIso(workOrder.vendorMarkedDoneAt ?? workOrder.completedAt),
      bucket,
      statusLabel: workOrderStatusLabel(bucket),
      workOrderId: workOrder.id,
      vendorId: workOrder.vendorId,
    };
    rows.push(enrichOutgoingRowWithVendorPayments(baseRow, vendor));
  }

  for (const workOrder of workOrders) {
    if (input.managerUserId && workOrder.managerUserId && workOrder.managerUserId !== input.managerUserId) continue;
    if (workOrder.automationStatus !== "paid") continue;
    if (!serviceIsVendorPayable(workOrder)) continue;
    if (workOrderExpenseIds.has(workOrder.id)) continue;
    const amountCents = workOrderAmountCents(workOrder);
    const vendor = workOrder.vendorId ? vendorById.get(workOrder.vendorId) : undefined;
    const workOrderPropertyId =
      workOrder.assignedPropertyId?.trim() || workOrder.propertyId?.trim() || undefined;
    const baseRow: DemoManagerOutgoingPaymentRow = {
      id: `work-order-paid-${workOrder.id}`,
      propertyId: workOrderPropertyId,
      propertyName: workOrder.propertyName,
      categoryLabel: "Vendor payment",
      payeeLabel: workOrder.vendorName?.trim() || "Vendor",
      chargeTitle: workOrder.title,
      amountLabel: amountCents > 0 ? formatMoney(amountCents) : workOrder.cost || "—",
      amountCents: amountCents > 0 ? amountCents : undefined,
      dueDate: dueDateLabelFromIso(workOrder.paidAt ?? workOrder.completedAt),
      dueDateSortMs: dueDateMsFromIso(workOrder.paidAt ?? workOrder.completedAt),
      bucket: "paid",
      statusLabel: workOrder.vendorPaymentChannel
        ? `Paid · ${managerVendorPayMethodLabel(workOrder.vendorPaymentChannel)}`
        : "Paid",
      workOrderId: workOrder.id,
      vendorId: workOrder.vendorId,
      paidViaChannel: workOrder.vendorPaymentChannel,
      paidAtLabel: workOrder.paidAt ? safeFormatDateTime(workOrder.paidAt) : undefined,
    };
    rows.push(enrichOutgoingRowWithVendorPayments(baseRow, vendor));
  }

  rows.push(...buildVisitFeeOutgoingRows(input.visitFees ?? [], workOrders, propertyLabelById));

  // No manager-side processing-cost rows here. On Free/Business (and Pro when the
  // resident pays) the manager receives the full charge amount. When a Pro manager
  // opts to absorb the service fee it comes out of that charge's Connect payout
  // (managerAbsorbedPaymentFeeCents) and is already reflected in the ledger payment
  // net — it is not a separate outgoing-payment row.

  return rows.sort((a, b) => {
    const bucketOrder: Record<ManagerPaymentBucket, number> = { overdue: 0, pending: 1, paid: 2 };
    const bucketDiff = bucketOrder[a.bucket] - bucketOrder[b.bucket];
    if (bucketDiff !== 0) return bucketDiff;
    // Same bucket: pending/overdue soonest-first, paid most-recent-first. Undated rows last.
    const at = a.dueDateSortMs ?? null;
    const bt = b.dueDateSortMs ?? null;
    if (at === bt) return 0;
    if (at === null) return 1;
    if (bt === null) return -1;
    return a.bucket === "paid" ? bt - at : at - bt;
  });
}

export const OUTGOING_PAYMENT_CATEGORY_CODES = [
  "service_fees",
  "property_tax",
  "taxes",
  "mortgage",
  "maintenance",
  "cleaning",
  "plumbing",
  "materials",
  "utilities",
  "insurance",
  "management",
  "other_expense",
] as const;
