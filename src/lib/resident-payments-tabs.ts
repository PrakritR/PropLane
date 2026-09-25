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
