/**
 * One move-in payment.
 *
 * A signed lease bills the move-in schedule as SEPARATE charges — first month's
 * rent, the security deposit, the move-in fee, every one-time custom fee — and
 * every one of them is a real ledger line (`syncLedger*` is write-through, and
 * the deposit is a liability whose refund and move-out deductions need their
 * own basis). Those lines never merge.
 *
 * What merges is what the RESIDENT is asked to do: instead of five rows and
 * five taps, the Payments tab shows one "Move-in total" row with the breakdown
 * behind it, and Pay runs the existing multi-charge checkout on the group — one
 * Stripe session, one receipt, and every underlying charge marked paid exactly
 * as if it had been paid alone. The manager sees the same total over the same
 * lines. Nothing here is stored: a group is derived from the charges every
 * render, so a charge the manager edits, cancels or marks paid falls out of the
 * group on its own.
 */
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import {
  chargeDueLabel,
  householdChargeDueDate,
  isHouseholdChargeOverdue,
  isPendingUpfrontMoveInCharge,
  parseMoneyAmount,
  type HouseholdCharge,
} from "@/lib/household-charges";

export const MOVE_IN_GROUP_ID_PREFIX = "movein:";

export function isMoveInGroupId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(MOVE_IN_GROUP_ID_PREFIX);
}

/**
 * The charges that belong to a resident's move-in: still owed, billed up front by
 * the signature, and not a pass-through, a late fee or a prospect's fee.
 * `payment_at_signing` is the legacy single signing line; it rides along so an
 * older listing's schedule collapses the same way.
 */
export function isMoveInScheduleCharge(charge: HouseholdCharge): boolean {
  if (charge.status !== "pending" && charge.status !== "processing") return false;
  if (charge.workOrderId || charge.sourceChargeId) return false;
  if (charge.kind === "payment_at_signing") return true;
  return isPendingUpfrontMoveInCharge(charge);
}

/**
 * The manager's side of the same total: over one resident's ledger rows, the
 * still-owed move-in lines summed. `null` below two lines, for the same reason
 * the resident sees no group then.
 */
export function moveInSubtotalForLedgerRows(
  rows: ReadonlyArray<Pick<DemoManagerPaymentLedgerRow, "moveInSchedule" | "bucket" | "balanceDue">>,
): { count: number; totalCents: number; totalLabel: string } | null {
  const lines = rows.filter((row) => row.moveInSchedule && row.bucket !== "paid");
  if (lines.length < 2) return null;
  const totalCents = lines.reduce((sum, row) => sum + Math.round(parseMoneyAmount(row.balanceDue) * 100), 0);
  return { count: lines.length, totalCents, totalLabel: formatMoveInTotal(totalCents) };
}

export type MoveInChargeGroup = {
  /** Stable synthetic id, safe in a URL segment: `movein:<email>|<propertyId>`. */
  id: string;
  residentEmail: string;
  propertyId: string;
  propertyLabel: string;
  /** Every still-owed move-in line, soonest due first. */
  items: HouseholdCharge[];
  totalCents: number;
  totalLabel: string;
  /** The soonest due label among the lines — paying the total settles all of them by then. */
  dueLabel: string;
  dueDate: Date | null;
  overdue: boolean;
  /** Every line is a bank transfer still clearing — nothing left to pay. */
  allProcessing: boolean;
  blocksLeaseUntilPaid: boolean;
};

export function moveInGroupKey(charge: Pick<HouseholdCharge, "residentEmail" | "propertyId">): string {
  return `${charge.residentEmail.trim().toLowerCase()}|${charge.propertyId}`;
}

export function formatMoveInTotal(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function balanceCents(charge: HouseholdCharge): number {
  return Math.round(parseMoneyAmount(charge.balanceLabel) * 100);
}

/**
 * Group the still-owed move-in lines per resident and property. A group needs at
 * least two lines — a lone deposit is just a deposit, and collapsing it would
 * only rename it.
 */
export function buildMoveInChargeGroups(charges: HouseholdCharge[], now = new Date()): MoveInChargeGroup[] {
  const byKey = new Map<string, HouseholdCharge[]>();
  for (const charge of charges) {
    if (!isMoveInScheduleCharge(charge)) continue;
    if (!charge.residentEmail.trim() || !charge.propertyId) continue;
    const key = moveInGroupKey(charge);
    const list = byKey.get(key);
    if (list) list.push(charge);
    else byKey.set(key, [charge]);
  }
  const groups: MoveInChargeGroup[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const items = [...list].sort((a, b) => {
      const da = householdChargeDueDate(a)?.getTime() ?? Number.POSITIVE_INFINITY;
      const db = householdChargeDueDate(b)?.getTime() ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a.createdAt.localeCompare(b.createdAt);
    });
    const totalCents = items.reduce((sum, c) => sum + balanceCents(c), 0);
    const dated = items.find((c) => householdChargeDueDate(c) !== null);
    const first = dated ?? items[0];
    groups.push({
      id: `${MOVE_IN_GROUP_ID_PREFIX}${key}`,
      residentEmail: first.residentEmail,
      propertyId: first.propertyId,
      propertyLabel: first.propertyLabel,
      items,
      totalCents,
      totalLabel: formatMoveInTotal(totalCents),
      dueLabel: chargeDueLabel(first),
      dueDate: householdChargeDueDate(first),
      overdue: items.some((c) => c.status !== "processing" && isHouseholdChargeOverdue(c, now)),
      allProcessing: items.every((c) => c.status === "processing"),
      blocksLeaseUntilPaid: items.some((c) => c.blocksLeaseUntilPaid && c.status === "pending"),
    });
  }
  return groups;
}

/**
 * The group as a row the charge list already knows how to draw. It is never
 * written anywhere — its id says so — and it carries the group's total as its
 * balance so the amount column, the due column and the compact meta line all
 * read from the same fields a real charge uses.
 */
export function moveInGroupAsListRow(group: MoveInChargeGroup): HouseholdCharge {
  const first = group.items[0];
  return {
    id: group.id,
    createdAt: first.createdAt,
    applicationId: first.applicationId,
    residentEmail: first.residentEmail,
    residentName: first.residentName,
    residentUserId: first.residentUserId,
    propertyId: group.propertyId,
    propertyLabel: group.propertyLabel,
    managerUserId: first.managerUserId,
    kind: "stay_total",
    title: "Move-in total",
    amountLabel: group.totalLabel,
    balanceLabel: group.totalLabel,
    status: group.allProcessing ? "processing" : "pending",
    dueDateLabel: group.dueLabel,
    blocksLeaseUntilPaid: group.blocksLeaseUntilPaid,
  };
}

export function moveInGroupItemCountLabel(group: MoveInChargeGroup): string {
  return `${group.items.length} items`;
}
