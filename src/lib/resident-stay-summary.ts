import type { HouseholdCharge, HouseholdChargeKind } from "@/lib/household-charges";
import { householdChargeDueDate } from "@/lib/household-charges";
import { isPayableHouseholdCharge } from "@/lib/platform/resident-payments";
import { chargeBalanceCents } from "@/lib/resident-payment-selection";

/**
 * The resident's "Your stay" price summary.
 *
 * Nothing here prices anything. Every figure is the sum of the balance of a charge the SERVER
 * already billed (rent and proration from `resolveStayPricing`, the custom-date surcharge folded
 * into the stay total, the deposit, a manager's extra lines); this only groups those charges
 * into the three things a resident cares about and adds them for display. The set it covers is
 * exactly the set `Pay` sends to the existing multi-charge checkout (`isPayableHouseholdCharge`),
 * so the total shown is the total of the charges that will be paid.
 */

/**
 * One checkout bills at most this many charges (the Stripe `charge_ids` metadata value is capped at
 * 500 chars). `MAX_BULK_CHARGES` in the checkout core is this same number; a unit test pins them.
 */
export const RESIDENT_PAY_MAX_CHARGES = 10;

export type ResidentStayRowId = "stay" | "deposit" | "additional";

export type ResidentStaySummaryRow = {
  id: ResidentStayRowId;
  label: string;
  cents: number;
  chargeIds: string[];
};

export type ResidentStaySummary = {
  rows: ResidentStaySummaryRow[];
  /** Everything currently payable. */
  totalDueCents: number;
  /** The charges one Pay covers: soonest due first, capped at one checkout's limit. */
  payChargeIds: string[];
  /** What that one Pay totals (equals `totalDueCents` unless the cap applies). */
  payCents: number;
  /** Payable charges left for a second Pay once the cap applies. */
  remainingCount: number;
};

const STAY_KINDS = new Set<HouseholdChargeKind>([
  "stay_total",
  "first_month_rent",
  "prorated_rent",
  "prorated_last_month_rent",
  "rent",
  "utilities",
  "prorated_utilities",
  "prorated_last_month_utilities",
]);

const DEPOSIT_KINDS = new Set<HouseholdChargeKind>(["security_deposit", "holding_deposit"]);

export function residentStayRowIdForKind(kind: HouseholdChargeKind): ResidentStayRowId {
  if (STAY_KINDS.has(kind)) return "stay";
  if (DEPOSIT_KINDS.has(kind)) return "deposit";
  return "additional";
}

const ROW_LABELS: Record<ResidentStayRowId, string> = {
  stay: "Stay",
  deposit: "Deposit",
  additional: "Additional charges",
};
const ROW_ORDER: ResidentStayRowId[] = ["stay", "deposit", "additional"];

export function buildResidentStaySummary(charges: readonly HouseholdCharge[]): ResidentStaySummary {
  const payable = charges.filter((c) => isPayableHouseholdCharge(c));
  const byRow = new Map<ResidentStayRowId, HouseholdCharge[]>();
  for (const charge of payable) {
    const id = residentStayRowIdForKind(charge.kind);
    const list = byRow.get(id);
    if (list) list.push(charge);
    else byRow.set(id, [charge]);
  }
  const rows: ResidentStaySummaryRow[] = [];
  for (const id of ROW_ORDER) {
    const list = byRow.get(id);
    if (!list?.length) continue;
    rows.push({
      id,
      label: ROW_LABELS[id],
      cents: list.reduce((sum, c) => sum + chargeBalanceCents(c.balanceLabel), 0),
      chargeIds: list.map((c) => c.id),
    });
  }
  const ordered = [...payable].sort((a, b) => {
    const da = householdChargeDueDate(a)?.getTime() ?? Number.POSITIVE_INFINITY;
    const db = householdChargeDueDate(b)?.getTime() ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return a.createdAt.localeCompare(b.createdAt);
  });
  const paying = ordered.slice(0, RESIDENT_PAY_MAX_CHARGES);
  return {
    rows,
    totalDueCents: payable.reduce((sum, c) => sum + chargeBalanceCents(c.balanceLabel), 0),
    payChargeIds: paying.map((c) => c.id),
    payCents: paying.reduce((sum, c) => sum + chargeBalanceCents(c.balanceLabel), 0),
    remainingCount: Math.max(0, ordered.length - paying.length),
  };
}
