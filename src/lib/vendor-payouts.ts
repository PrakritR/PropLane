/** Client-side shape returned by GET /api/vendor/payouts. */
export type VendorPayoutStatus = "pending" | "paid" | "failed" | "skipped";

export type VendorPayout = {
  id: string;
  workOrderId: string;
  amountCents: number;
  stripeTransferId: string | null;
  /** `pending` is the claim row written before the Stripe call resolves — a transfer in flight. */
  status: VendorPayoutStatus;
  failureReason: string | null;
  createdAt: string;
  /** When the row last changed status — the transfer-sent / failed / skipped instant. Absent on
   * older demo seeds, which render that step's date as "—" rather than guessing. */
  updatedAt?: string | null;
};

export async function fetchVendorPayouts(): Promise<VendorPayout[]> {
  const result = await fetchVendorPayoutsResult();
  return result.payouts;
}

/** Like {@link fetchVendorPayouts} but reports fetch failure instead of swallowing it to an empty list. */
export async function fetchVendorPayoutsResult(): Promise<{ ok: boolean; payouts: VendorPayout[] }> {
  if (typeof window !== "undefined") {
    const { isDemoModeActive } = await import("@/lib/demo/demo-session");
    if (isDemoModeActive()) {
      const { readVendorPayouts } = await import("@/lib/vendor-payouts-storage");
      return { ok: true, payouts: readVendorPayouts() };
    }
  }
  try {
    const res = await fetch("/api/vendor/payouts", { credentials: "include" });
    if (!res.ok) return { ok: false, payouts: [] };
    const data = (await res.json()) as { payouts?: VendorPayout[] };
    return { ok: true, payouts: Array.isArray(data.payouts) ? data.payouts : [] };
  } catch {
    return { ok: false, payouts: [] };
  }
}
