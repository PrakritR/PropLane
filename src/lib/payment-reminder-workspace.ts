import type { PropertyPayoutOwner } from "@/lib/payments/property-payout-owner.server";
import { isUnpaidHouseholdCharge, type HouseholdCharge } from "@/lib/household-charges";

/** A property-backed reminder always belongs to its current property owner. */
export function resolveReminderWorkspaceOwner(
  propertyOwners: ReadonlyMap<string, PropertyPayoutOwner>,
  propertyId: string,
  legacyManagerUserId: string | null | undefined,
): string | null {
  const id = propertyId.trim();
  if (!id) return legacyManagerUserId?.trim() || null;
  const owner = propertyOwners.get(id);
  return owner?.ok ? owner.ownerUserId : null;
}

/** Refuse a pre-rendered reminder when the financial source changed meanwhile. */
export function paymentReminderSnapshotMatches(expected: HouseholdCharge, current: HouseholdCharge | null | undefined): boolean {
  if (!current || !isUnpaidHouseholdCharge(current)) return false;
  return current.id === expected.id &&
    current.propertyId === expected.propertyId &&
    current.residentEmail.trim().toLowerCase() === expected.residentEmail.trim().toLowerCase() &&
    current.amountLabel === expected.amountLabel &&
    current.balanceLabel === expected.balanceLabel &&
    current.title === expected.title &&
    current.status === expected.status;
}
