import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isResidentPaysFeeChargeKind } from "@/lib/payment-policy";
import { resolveManagedForProperties } from "@/lib/managed-finance/resolve.server";

export const MANAGED_OFFLINE_RENT_MESSAGE =
  "Rent for a PropLane-managed home is paid through PropLane, so it cannot be marked paid by hand. Ask the resident to pay in PropLane, or ask PropLane staff to record a payment made outside it.";

/**
 * Is this a rent charge on a PropLane-managed workspace? Its money must reach PropLane's balance and the party ledger,
 * so a manager (or the assistant acting as one) may not record it as paid from cash, a check or a transfer that never
 * touched PropLane - that would leave the owner's books and the platform balance disagreeing with the bank. Platform staff
 * may still record one. A read that fails answers true for rent: the safe side is to refuse, never to book unverified money.
 */
export async function offlineReceiptRefusedForManagedRent(
  db: SupabaseClient,
  charge: { kind?: string | null; propertyId?: string | null },
): Promise<boolean> {
  if (!isResidentPaysFeeChargeKind(charge.kind)) return false;
  const propertyId = charge.propertyId?.trim() ?? "";
  if (!propertyId) return false;
  try {
    return (await resolveManagedForProperties(db, [propertyId], new Date().toISOString())) !== null;
  } catch {
    return true;
  }
}
