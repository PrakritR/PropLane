/**
 * Resident Payments header buttons. Ids and URL routing (`/resident/payments/{id}`,
 * `RESIDENT_PAYMENTS_LEGACY_TABS`) are unchanged (`pending` / `overdue` / `paid`) —
 * only the DISPLAYED labels read Upcoming / Due / Paid (captain, 2026-09-25:
 * every resident list gets three right-side header buttons named per page).
 * Same pattern as vendor Jobs' Potential / Current / Past
 * (`src/lib/vendor-work-order-tabs.ts`).
 */
export const RESIDENT_PAYMENTS_TAB_LABELS: Record<"pending" | "overdue" | "paid", string> = {
  pending: "Upcoming",
  overdue: "Due",
  paid: "Paid",
};

/**
 * C261: with at most one charge ever (across every status), the Upcoming /
 * Due / Paid tabs and the header's Payment method utility button are sized
 * for a list that does not exist yet — pure visual noise around a single
 * row. `resident-payments-panel.tsx` hides both when this is true; Payment
 * method access is never lost, since `ResidentAutopayCard` (rendered
 * unconditionally below the header) opens the same modal.
 */
export function shouldSimplifyResidentPaymentsHeader(totalChargeCount: number): boolean {
  return totalChargeCount <= 1;
}
