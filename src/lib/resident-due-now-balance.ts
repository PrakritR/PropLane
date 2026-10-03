import type { HouseholdCharge } from "@/lib/household-charges";
import { householdChargeDueDate, isUnpaidHouseholdCharge, parseMoneyAmount } from "@/lib/household-charges";

/** Charges due now (not future rent months) — matches Payments Due tab semantics. */
export function isDueNowHouseholdCharge(charge: HouseholdCharge, now = new Date()): boolean {
  if (!isUnpaidHouseholdCharge(charge)) return false;
  if (charge.status === "failed") return true;
  const dueDay = householdChargeDueDate(charge);
  if (!dueDay) return true;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return dueDay <= today;
}

export function sumDueNowCents(charges: readonly HouseholdCharge[], now = new Date()): number {
  return charges
    .filter((c) => isDueNowHouseholdCharge(c, now))
    .reduce((sum, c) => sum + Math.round(Math.max(0, parseMoneyAmount(c.balanceLabel)) * 100), 0);
}
