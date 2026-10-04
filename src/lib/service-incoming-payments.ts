/**
 * Incoming payments for ONE service: the resident's real charges for it, as ledger rows - the same
 * rows the Payments page draws. An add-on request bills through `serviceChargeId` / `depositChargeId`;
 * a maintenance service through the charge stamped with its `workOrderId`. Nothing is invented: a
 * service with no charge has no rows (the tab shows the standard empty card).
 */
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { householdChargeToLedgerRow, type HouseholdCharge } from "@/lib/household-charges";

export type ServiceIncomingRow = {
  row: DemoManagerPaymentLedgerRow;
  /** "$40 / month" on the fee row of a recurring add-on; absent on one-off and deposit rows. */
  recurringLabel?: string;
};

const RECURRING_PRICE_RE = /(\/|per\s+)\s*(month|mo|week|wk|year|yr)\b|\bmonthly\b|\bweekly\b|\bannual(ly)?\b/i;

/** The recurring cadence of an add-on's price text, verbatim ("$40 / month"), or undefined for a one-off. */
export function recurringPriceLabel(price: string | null | undefined): string | undefined {
  const text = (price ?? "").trim();
  return text && RECURRING_PRICE_RE.test(text) ? text : undefined;
}

export function buildServiceIncomingRows(input: {
  charges: readonly HouseholdCharge[];
  /** Add-on request: which charges are this service's, and the price text the fee row's cadence comes from. */
  request?: { serviceChargeId?: string; depositChargeId?: string; price?: string } | null;
  /** Maintenance service: charges stamped with this work order id. */
  workOrderId?: string | null;
}): ServiceIncomingRow[] {
  const mine = input.charges.filter((charge) => {
    if (input.workOrderId && charge.workOrderId === input.workOrderId) return true;
    if (input.request?.serviceChargeId && charge.id === input.request.serviceChargeId) return true;
    if (input.request?.depositChargeId && charge.id === input.request.depositChargeId) return true;
    return false;
  });
  const seen = new Set<string>();
  const out: ServiceIncomingRow[] = [];
  for (const charge of mine) {
    if (seen.has(charge.id)) continue;
    seen.add(charge.id);
    out.push({
      row: householdChargeToLedgerRow(charge),
      recurringLabel: charge.id === input.request?.serviceChargeId ? recurringPriceLabel(input.request?.price) : undefined,
    });
  }
  return out;
}
