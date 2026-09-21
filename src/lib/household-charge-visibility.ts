import { householdChargeDueDate, isHouseholdChargeOverdue, type HouseholdCharge } from "@/lib/household-charges";
import { isMoveInScheduleCharge, moveInGroupKey } from "@/lib/move-in-charge-group";

/**
 * `residentVisibleAt` is a new optional row_data field: an ISO timestamp set the moment a
 * manager sends a resident a manual reminder about a not-yet-due charge, so the charge
 * becomes visible to that resident immediately regardless of the visibility window below.
 * `household-charges.ts` does not declare this field yet, so it is typed locally here.
 */
export type HouseholdChargeWithVisibility = HouseholdCharge & { residentVisibleAt?: string };

/** How many days out a future charge becomes visible to the resident before it is due. */
export const RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS = 7;

export function monthKeyFromDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Whole calendar days from `now` to `due` (positive when `due` is later). */
function daysBetween(now: Date, due: Date): number {
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueStart = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  return Math.round((dueStart.getTime() - nowStart.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * True for a charge that belongs to a later calendar month than `now` and is still
 * outstanding (not paid, cancelled, or refunded). Month is `rentMonth` when the charge
 * carries one, otherwise the month of the due date resolved from `dueDateLabel` via
 * {@link householdChargeDueDate} (the same due-date resolution `isHouseholdChargeOverdue`
 * uses). A charge with no resolvable due date is never "upcoming".
 */
export function isUpcomingHouseholdCharge(charge: HouseholdCharge, now = new Date()): boolean {
  if (charge.status === "paid" || charge.status === "cancelled" || charge.status === "refunded") return false;
  const chargeMonth = charge.rentMonth ?? (() => {
    const due = householdChargeDueDate(charge);
    return due ? monthKeyFromDate(due) : null;
  })();
  if (!chargeMonth) return false;
  return chargeMonth > monthKeyFromDate(now);
}

/**
 * Same "later calendar month than now" rule as {@link isUpcomingHouseholdCharge}, for a
 * caller that only has an already-resolved due-date timestamp — e.g. a manager ledger row
 * (`DemoManagerPaymentLedgerRow.dueDateSortMs`), converted from its charge via
 * `householdChargeToLedgerRow`, which stamps that field with the very same
 * `householdChargeDueDate(charge)?.getTime()` this module resolves from. `null`/`undefined`
 * (no real due date) is never upcoming.
 */
export function isUpcomingDueDateMs(dueDateSortMs: number | null | undefined, now = new Date()): boolean {
  if (dueDateSortMs == null) return false;
  return monthKeyFromDate(new Date(dueDateSortMs)) > monthKeyFromDate(now);
}

/**
 * Whether a resident should be shown a given charge at all. Overdue, processing,
 * partially-paid, and paid charges are always visible; a charge with no parseable due
 * date is always visible; a charge a manager has explicitly surfaced early
 * (`residentVisibleAt`) is always visible; otherwise a charge is visible only once its
 * due date is within `windowDays` days of `now` (inclusive).
 */
export function residentCanSeeCharge(
  charge: HouseholdChargeWithVisibility,
  now = new Date(),
  windowDays: number = RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS,
): boolean {
  if (isHouseholdChargeOverdue(charge, now)) return true;
  if (charge.status === "processing" || charge.status === "partially_paid" || charge.status === "paid") return true;
  if (charge.residentVisibleAt) return true;
  const due = householdChargeDueDate(charge);
  if (!due) return true;
  return daysBetween(now, due) <= windowDays;
}

/**
 * Same rule as {@link residentCanSeeCharge}, but keeps a move-in group's
 * lines together: a charge that belongs to the same move-in schedule (same
 * resident + property, upfront move-in lines — see
 * {@link isMoveInScheduleCharge} in `move-in-charge-group.ts`) is visible
 * whenever ANY line in that group is individually visible, even one whose own
 * due date sits outside the window. Filtering per-line here — instead of
 * calling {@link residentCanSeeCharge} on each charge before it ever reaches
 * `buildMoveInChargeGroups` — is what keeps a move-in group's total and
 * breakdown from silently losing a line the resident should still see
 * together with the rest of the group. A charge outside every move-in group
 * is filtered by {@link residentCanSeeCharge} alone.
 */
export function residentVisibleCharges<T extends HouseholdChargeWithVisibility>(
  charges: T[],
  now = new Date(),
  windowDays: number = RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS,
): T[] {
  const groupHasVisibleLine = new Set<string>();
  for (const charge of charges) {
    if (!isMoveInScheduleCharge(charge) || !charge.residentEmail.trim() || !charge.propertyId) continue;
    if (residentCanSeeCharge(charge, now, windowDays)) groupHasVisibleLine.add(moveInGroupKey(charge));
  }
  return charges.filter((charge) => {
    if (isMoveInScheduleCharge(charge) && charge.residentEmail.trim() && charge.propertyId) {
      if (groupHasVisibleLine.has(moveInGroupKey(charge))) return true;
    }
    return residentCanSeeCharge(charge, now, windowDays);
  });
}
