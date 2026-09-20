import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { centsToUsd } from "@/lib/reports/money";
import type { VendorPayout } from "@/lib/vendor-payouts";

export type VendorIncomePayoutStatus = "paid" | "pending" | "failed" | "skipped";

export type VendorIncomeRow = {
  id: string;
  workOrderId: string;
  workOrderTitle: string;
  propertyId: string;
  propertyLabel: string;
  dateIso: string;
  laborCents: number;
  materialsCents: number;
  totalCents: number;
  payoutStatus: VendorIncomePayoutStatus;
  payoutStatusLabel: string;
  payoutFailureReason: string | null;
};

export type VendorIncomeFilters = {
  from: string;
  to: string;
  propertyId?: string;
  propertyIds?: string[];
  query?: string;
};

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

function parseCostStringCents(cost: string | undefined): number {
  if (!cost?.trim()) return 0;
  const parsed = Number.parseFloat(cost.replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
}

/** Labor portion of vendor earnings on a work order. */
export function vendorWorkOrderLaborCents(row: DemoManagerWorkOrderRow, payout?: VendorPayout): number {
  if (typeof row.vendorCostCents === "number" && row.vendorCostCents > 0) return row.vendorCostCents;
  if (payout && payout.amountCents > 0) return payout.amountCents;
  return parseCostStringCents(row.cost);
}

/** Materials reimbursement portion (manager expense, vendor income). */
export function vendorWorkOrderMaterialsCents(row: DemoManagerWorkOrderRow): number {
  return row.materialsCostCents ?? 0;
}

/** Total vendor income for a work order row. */
export function vendorWorkOrderIncomeCents(row: DemoManagerWorkOrderRow, payout?: VendorPayout): number {
  const labor = vendorWorkOrderLaborCents(row, payout);
  const materials = vendorWorkOrderMaterialsCents(row);
  if (labor + materials > 0) return labor + materials;
  return payout?.amountCents ?? 0;
}

/** Completed work orders where the vendor has marked done or been paid. */
export function vendorIncomeEligible(row: DemoManagerWorkOrderRow): boolean {
  if (row.bucket !== "completed") return false;
  return row.automationStatus === "paid" || row.automationStatus === "vendor_marked_done";
}

function payoutStatusForRow(
  row: DemoManagerWorkOrderRow,
  payout: VendorPayout | undefined,
): { status: VendorIncomePayoutStatus; label: string } {
  if (row.automationStatus !== "paid") {
    return { status: "pending", label: "Pending approval" };
  }
  if (payout?.status === "paid") return { status: "paid", label: "Paid" };
  if (payout?.status === "failed") return { status: "failed", label: "Payout failed" };
  if (payout?.status === "skipped") return { status: "skipped", label: "Payout skipped" };
  if (row.vendorPaymentChannel === "ach") return { status: "paid", label: "Paid via ACH" };
  return { status: "paid", label: "Paid" };
}

function incomeDateIso(row: DemoManagerWorkOrderRow, payout: VendorPayout | undefined): string {
  if (row.automationStatus === "paid") {
    return row.paidAt ?? payout?.createdAt ?? row.completedAt ?? "";
  }
  return row.vendorMarkedDoneAt ?? row.completedAt ?? "";
}

export function buildVendorIncomeRow(
  row: DemoManagerWorkOrderRow,
  payout?: VendorPayout,
): VendorIncomeRow | null {
  if (!vendorIncomeEligible(row)) return null;

  const laborCents = vendorWorkOrderLaborCents(row, payout);
  const materialsCents = vendorWorkOrderMaterialsCents(row);
  const totalCents = laborCents + materialsCents;
  if (totalCents <= 0) return null;

  const { status, label } = payoutStatusForRow(row, payout);
  const dateIso = incomeDateIso(row, payout);

  return {
    id: row.id,
    workOrderId: row.id,
    workOrderTitle: row.title,
    propertyId: row.propertyId ?? row.assignedPropertyId ?? "",
    propertyLabel: propertyLabel(row),
    dateIso,
    laborCents,
    materialsCents,
    totalCents,
    payoutStatus: status,
    payoutStatusLabel: label,
    payoutFailureReason: payout?.failureReason ?? null,
  };
}

export function buildVendorIncomeRows(
  workOrders: DemoManagerWorkOrderRow[],
  payoutsByWorkOrderId: Record<string, VendorPayout>,
): VendorIncomeRow[] {
  return workOrders
    .map((row) => buildVendorIncomeRow(row, payoutsByWorkOrderId[row.id]))
    .filter((row): row is VendorIncomeRow => row !== null);
}

export function buildVendorPropertyFilterOptions(
  rows: VendorIncomeRow[],
): { id: string; label: string }[] {
  const byId = new Map<string, string>();
  for (const row of rows) {
    if (!row.propertyId) continue;
    if (!byId.has(row.propertyId)) byId.set(row.propertyId, row.propertyLabel);
  }
  return [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

function inDateRange(dateIso: string, from: string, to: string): boolean {
  if (!dateIso) return true;
  const day = dateIso.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

export function filterVendorIncomeRows(rows: VendorIncomeRow[], filters: VendorIncomeFilters): VendorIncomeRow[] {
  const propertyIds = (filters.propertyIds ?? []).filter(Boolean);
  const query = filters.query?.trim().toLowerCase() ?? "";
  return rows.filter((row) => {
    if (filters.propertyId && row.propertyId !== filters.propertyId) return false;
    if (propertyIds.length > 0 && !propertyIds.includes(row.propertyId)) return false;
    if (query) {
      const haystack = `${row.workOrderTitle} ${row.propertyLabel}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return inDateRange(row.dateIso, filters.from, filters.to);
  });
}

export function vendorIncomeTotals(rows: VendorIncomeRow[]): {
  laborCents: number;
  materialsCents: number;
  totalCents: number;
} {
  return rows.reduce(
    (acc, row) => ({
      laborCents: acc.laborCents + row.laborCents,
      materialsCents: acc.materialsCents + row.materialsCents,
      totalCents: acc.totalCents + row.totalCents,
    }),
    { laborCents: 0, materialsCents: 0, totalCents: 0 },
  );
}

export function formatVendorIncomeMoney(cents: number): string {
  return cents > 0 ? centsToUsd(cents) : "—";
}
