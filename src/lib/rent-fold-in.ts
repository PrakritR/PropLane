/**
 * Which monthly costs are part of the RENT line, and which still bill as their own charge.
 *
 * This is the one enumeration the charge ledger (`household-charges.ts`), the placement
 * values the lease is generated from (`placement-values.ts`), and the lease document's fee
 * schedule all read, so the rent a resident signs for is the rent they are billed.
 *
 * Two regimes:
 *
 *  - Everywhere but Seattle: a monthly custom fee folds into rent only when the manager
 *    ticked `includeInRent` on it; every other monthly fee (parking, HOA, other monthly, the
 *    custom-lease surcharge) bills as its own recurring charge. Unchanged behaviour.
 *  - Seattle (`listingFoldsAllMonthlyFeesIntoRent`): EVERY monthly fee folds into rent —
 *    including the month-to-month surcharge, which previously never billed at all — and
 *    nothing monthly bills separately. The lease prints the composition.
 *
 * The two surcharge presets stay conditional in both regimes: the month-to-month surcharge
 * applies only to a month-to-month tenancy and the custom-lease surcharge only to a lease on
 * custom calendar dates. Those predicates live in `custom-lease-billing.ts`; they are reused
 * here rather than re-derived so a fee can never fold on a tenancy it would not have billed.
 */

import {
  CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL,
  CUSTOM_LEASE_SURCHARGE_FEE_ID,
  recurringMonthlyFeesForLease,
  shouldBillCustomLeaseSurcharge,
  shouldBillMonthToMonthSurcharge,
  type LeaseRecurringFeeBillingContext,
} from "@/lib/custom-lease-billing";
import { listingPresetFeeAmountIfEnabled } from "@/lib/listing-fee-term-toggles";
import type { ListingFeePresetId } from "@/lib/listing-fees";
import type { ManagerCustomFeeRow, ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { parseMoneyAmount } from "@/lib/parse-money";
import { listingFoldsAllMonthlyFeesIntoRent, type RentRuleAddress } from "@/lib/seattle-rent-rule";

export type MonthlyFeeLine = { id: string; label: string; amount: number };

export const MONTH_TO_MONTH_SURCHARGE_FEE_ID = "preset:mtm_surcharge";
export const MONTH_TO_MONTH_SURCHARGE_LABEL = "Month-to-month surcharge";

/** Genuinely-custom fee rows (the "+ Add custom fee" rows). Preset-backed rows are excluded. */
export function genuinelyCustomFees(sub: ManagerListingSubmissionV1 | null | undefined): ManagerCustomFeeRow[] {
  return (sub?.customFees ?? []).filter((fee) => {
    const presetId = (fee as { presetId?: string }).presetId;
    return !presetId || presetId === "custom";
  });
}

/**
 * Preset fee rows that own no legacy submission field a charge generator reads. Parking, HOA
 * and "other monthly fees" were materialized into `customFees` by the unified-fees migration
 * and then excluded from billing as "preset-backed", but unlike every other preset there was
 * no field billing them either — so a fee the manager entered, and the public listing
 * advertises as a monthly cost, was never charged to anyone.
 */
const SELF_BILLING_PRESET_FEE_IDS = new Set<ListingFeePresetId>([
  "parking_monthly",
  "hoa_monthly",
  "other_monthly",
]);

/**
 * Bill the self-billing presets, gated on the wizard checkbox. The amount comes from
 * `listingPresetFeeAmountIfEnabled` rather than the stored row, so an unchecked or removed
 * row resolves to 0 and emits nothing even when a stale amount survives on the row — that
 * gate is the whole point, not a side effect of the row happening to be blank.
 */
export function selfBillingPresetFees(
  sub: ManagerListingSubmissionV1 | null | undefined,
  cadence: "one-time" | "monthly",
): MonthlyFeeLine[] {
  if (!sub) return [];
  return (sub.customFees ?? []).flatMap((fee) => {
    const presetId = (fee as { presetId?: string }).presetId as ListingFeePresetId | undefined;
    if (!presetId || !SELF_BILLING_PRESET_FEE_IDS.has(presetId)) return [];
    const matchesCadence = cadence === "one-time" ? fee.frequency === "one-time" : fee.frequency !== "one-time";
    if (!matchesCadence) return [];
    const amount = listingPresetFeeAmountIfEnabled(sub, presetId);
    if (!(amount > 0)) return [];
    return [{ id: fee.id, label: fee.label?.trim() || "Fee", amount }];
  });
}

function monthlyGenuinelyCustomFees(
  sub: ManagerListingSubmissionV1 | null | undefined,
  filter: (fee: ManagerCustomFeeRow) => boolean,
): MonthlyFeeLine[] {
  return genuinelyCustomFees(sub)
    .filter((fee) => fee.frequency !== "one-time")
    .filter(filter)
    .map((fee) => ({ id: fee.id, label: fee.label?.trim() || "Custom fee", amount: parseMoneyAmount(fee.amount ?? "") }))
    .filter((fee) => fee.amount > 0);
}

/**
 * A surcharge preset as a fold-in line, or null when it is off. Gated on the wizard checkbox
 * (a stale amount on an unchecked row is nothing), never on the listing's CURRENT term list:
 * once there is a real lease, that lease's term decides — the `ctx` predicates the callers
 * apply — because a listing may stop offering month-to-month after a month-to-month lease was
 * signed and that lease still carries the surcharge.
 */
function surchargePresetLine(
  sub: ManagerListingSubmissionV1,
  presetId: "mtm_surcharge" | "custom_lease_surcharge",
): MonthlyFeeLine | null {
  const amount = listingPresetFeeAmountIfEnabled(sub, presetId);
  if (!(amount > 0)) return null;
  const row = (sub.customFees ?? []).find((fee) => (fee as { presetId?: string }).presetId === presetId);
  return presetId === "mtm_surcharge"
    ? { id: MONTH_TO_MONTH_SURCHARGE_FEE_ID, label: row?.label?.trim() || MONTH_TO_MONTH_SURCHARGE_LABEL, amount }
    : { id: CUSTOM_LEASE_SURCHARGE_FEE_ID, label: row?.label?.trim() || CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL, amount };
}

function dedupeById(lines: MonthlyFeeLine[]): MonthlyFeeLine[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (seen.has(line.id)) return false;
    seen.add(line.id);
    return true;
  });
}

/**
 * Monthly costs folded INTO the rent line for this listing and tenancy.
 *
 * They are still real, disclosed amounts — they arrive as part of rent rather than as their
 * own charge, which is what "rent includes parking" means. Whatever appears here never
 * appears in {@link monthlyFeesBilledSeparately}, so a fee cannot be counted twice.
 */
export function monthlyRentFoldInLines(
  sub: ManagerListingSubmissionV1 | null | undefined,
  listingProperty: RentRuleAddress | null | undefined,
  ctx: LeaseRecurringFeeBillingContext,
): MonthlyFeeLine[] {
  if (!sub) return [];
  if (!listingFoldsAllMonthlyFeesIntoRent(sub, listingProperty)) {
    return monthlyGenuinelyCustomFees(sub, (fee) => fee.includeInRent === true);
  }
  const lines: MonthlyFeeLine[] = [
    ...monthlyGenuinelyCustomFees(sub, () => true),
    ...selfBillingPresetFees(sub, "monthly"),
  ];
  if (shouldBillMonthToMonthSurcharge(ctx)) {
    const mtm = surchargePresetLine(sub, "mtm_surcharge");
    if (mtm) lines.push(mtm);
  }
  if (shouldBillCustomLeaseSurcharge(ctx)) {
    const custom = surchargePresetLine(sub, "custom_lease_surcharge");
    if (custom) lines.push(custom);
  }
  return dedupeById(lines);
}

/** Total of {@link monthlyRentFoldInLines}, in dollars. */
export function monthlyRentFoldInTotal(
  sub: ManagerListingSubmissionV1 | null | undefined,
  listingProperty: RentRuleAddress | null | undefined,
  ctx: LeaseRecurringFeeBillingContext,
): number {
  return Number(
    monthlyRentFoldInLines(sub, listingProperty, ctx)
      .reduce((sum, fee) => sum + fee.amount, 0)
      .toFixed(2),
  );
}

/**
 * Monthly costs that bill as their OWN recurring charge. Empty on a Seattle listing —
 * everything monthly there is inside the rent — and otherwise the fees a manager did not fold.
 */
export function monthlyFeesBilledSeparately(
  sub: ManagerListingSubmissionV1 | null | undefined,
  listingProperty: RentRuleAddress | null | undefined,
  ctx: LeaseRecurringFeeBillingContext,
): MonthlyFeeLine[] {
  if (!sub) return [];
  if (listingFoldsAllMonthlyFeesIntoRent(sub, listingProperty)) return [];
  const own = [
    // A fee folded into rent must NOT also bill separately — that is the one way this
    // feature could overcharge, so the exclusion lives next to the inclusion.
    ...monthlyGenuinelyCustomFees(sub, (fee) => fee.includeInRent !== true),
    ...selfBillingPresetFees(sub, "monthly"),
  ];
  return recurringMonthlyFeesForLease(sub, own, ctx);
}
