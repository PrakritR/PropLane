/**
 * The paid-state merge for a service whose vendor has no login yet. The vendor-account path does this inside
 * `mark_work_order_payment_paid`; this applies the same allowed keys to the freshly read row, so a stale client copy can never
 * overwrite a concurrent edit. Pure.
 */
const ALLOWED_KEYS = [
  "bucket", "status", "category", "vendorCostCents", "materialsCostCents", "materialsMemo", "workDoneSummary", "completedAt",
  "vendorPaymentChannel",
] as const;

export function mergeDirectoryVendorPaidRow(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const allowed: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) if (patch[key] !== undefined) allowed[key] = patch[key];
  const merged: Record<string, unknown> = {
    ...current,
    ...allowed,
    automationStatus: "paid",
    paidAt: current.paidAt ?? patch.paidAt ?? new Date().toISOString(),
  };
  // A completion the row already carries is never moved.
  if (current.completedAt !== undefined) merged.completedAt = current.completedAt;
  const ids = new Set<string>([
    ...(Array.isArray(current.expenseEntryIds) ? (current.expenseEntryIds as unknown[]).map(String) : []),
    ...(Array.isArray(patch.expenseEntryIds) ? (patch.expenseEntryIds as unknown[]).map(String) : []),
  ]);
  if (ids.size > 0) merged.expenseEntryIds = [...ids];
  return merged;
}
