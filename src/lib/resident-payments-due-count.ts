import type { HouseholdCharge } from "@/lib/household-charges";
import { residentChargeCountsAsDue } from "@/lib/household-charges";
import { residentVisibleCharges } from "@/lib/household-charge-visibility";
import { buildMoveInChargeGroups } from "@/lib/move-in-charge-group";

/**
 * How many rows the resident's Payments "Due" tab lists, computed the way the tab computes them:
 * the deposit, first month and fees of one move-in are ONE row, a charge still clearing is never
 * due, and a failed payment is. The sidebar badge reads this so it can never disagree with the tab.
 */
export function residentDueRowCount(charges: HouseholdCharge[], now = new Date()): number {
  const pendingRows = residentVisibleCharges(charges, now).filter(
    (charge) => charge.status === "pending" || charge.status === "processing" || charge.status === "failed",
  );
  const groups = buildMoveInChargeGroups(pendingRows, now);
  const grouped = new Set(groups.flatMap((group) => group.items.map((charge) => charge.id)));
  return (
    groups.filter((group) => group.overdue).length +
    pendingRows.filter(
      (charge) => !grouped.has(charge.id) && charge.status !== "processing" && residentChargeCountsAsDue(charge, now),
    ).length
  );
}
