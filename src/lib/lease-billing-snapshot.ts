import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  type HouseholdCharge,
  type HouseholdChargeKind,
  isManagerAddedOneOffCharge,
  readChargesForManager,
} from "@/lib/household-charges";
import { collectLinkedPropertyIdsForModule } from "@/lib/manager-portfolio-access";
import { parseMoneyLabel } from "@/lib/portal-monthly-profit";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { resolvePlacementValuesForRow } from "@/lib/rental-application/placement-values";
import { computeLeasePaymentAtSigning } from "@/lib/rental-application/listing-fees-display";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { getPropertyById } from "@/lib/rental-application/data";
import { computeProratedFirstMonthTotals, leaseFirstPeriodProration } from "@/lib/lease-first-period-proration";
import { resolveLeaseProrationInputForApplicant } from "@/lib/lease-proration-settings";
import type { LeaseGenerationContext } from "@/lib/generated-lease";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { resolveSubmissionRoom } from "@/lib/listing-room-resolution";
import { resolveStayPricing } from "@/lib/room-pricing";
import { shortTermStayNightCount, shortTermStayTotalAmount } from "@/lib/short-term-stay-pricing";

/** Dollar amounts that match household charges / placement (what actually bills). */
export type LeaseBillingSnapshot = {
  monthlyRent: number;
  /** Explicit short-term applications use a nightly rate and checkout-exclusive total. */
  nightlyRent?: number;
  /** Standard daily-basis rent must never be patched into a monthly override. */
  dailyRent?: number;
  firstPeriodRentDue?: number;
  firstPeriodUtilitiesDue?: number;
  stayRent?: number;
  totalBeforeCheckIn?: number;
  monthlyUtilities: number;
  securityDeposit: number;
  /** Full contractual deposit stays separate from the remaining collection. */
  securityDepositDue?: number;
  holdingDeposit?: { amount: number; amountDue: number; received: number };
  moveInFee: number;
  moveInFeeDue?: number;
  otherCostLabel: string;
  otherCostAmount: number;
  otherCostDue?: number;
  otherCostReceived?: number;
  oneTimeCustomFeeBalances?: Record<string, number>;
  oneTimeCustomFeeReceived?: Record<string, number>;
  proratedRent?: number;
  proratedUtilities?: number;
  proratedLastMonthRent?: number;
  proratedLastMonthUtilities?: number;
  applicationFee?: number;
  /** Dollars CLEARED toward the deposit (holding portion included). Never waived or clearing. */
  securityDepositReceived?: number;
  /** Dollars CLEARED toward the move-in fee. Never a waived or clearing charge. */
  moveInFeeReceived?: number;
  /** Dollars CLEARED toward everything owed before move-in / check-in. */
  receivedBeforeMoveIn?: number;
  dueAtSigning: number;
};

const SIGNING_CHARGE_KINDS: HouseholdChargeKind[] = [
  "security_deposit",
  "move_in_fee",
  "application_fee",
  "holding_deposit",
  "stay_total",
  "first_month_rent",
  "payment_at_signing",
  "prorated_rent",
  "prorated_utilities",
  "other_cost",
];

const FIRST_PERIOD_RENT_KINDS: HouseholdChargeKind[] = ["first_month_rent", "prorated_rent"];
const FIRST_PERIOD_UTIL_KINDS: HouseholdChargeKind[] = ["utilities", "prorated_utilities"];

function chargeAmount(c: HouseholdCharge): number {
  return parseMoneyLabel(c.balanceLabel || c.amountLabel || "0");
}

// Settled means nothing is owed, exactly as `householdChargeManagerBucket` reads it: a
// cancelled charge was waived and a refunded one was returned. Both contribute zero to the
// remaining collection, and neither may be dropped from the snapshot — a missing row falls
// back to the FULL contractual amount and re-quotes an obligation the manager voided.
const SETTLED_CHARGE_STATUSES = new Set<HouseholdCharge["status"]>(["paid", "cancelled", "refunded"]);

function chargeIsSettled(c: HouseholdCharge): boolean {
  return SETTLED_CHARGE_STATUSES.has(c.status);
}

// Voided money: waived or returned, so it never becomes a disclosure, a credit, or a receipt.
function chargeIsVoided(c: HouseholdCharge): boolean {
  return c.status === "cancelled" || c.status === "refunded";
}

// Money that has not CLEARED is still owed. A clearing ACH ("processing"), a part payment
// and a failed attempt all leave a real balance on the row, so anything not settled keeps
// its balance — including a status this file has never heard of.
function chargeOutstandingAmount(c: HouseholdCharge): number {
  return chargeIsSettled(c) ? 0 : chargeAmount(c);
}

// Dollars that actually CLEARED. A clearing ACH has not arrived, and a cancelled or
// refunded charge is money the manager never kept — none of the three may be reported to a
// resident as a payment received.
function chargeReceivedAmount(c: HouseholdCharge): number {
  if (c.status === "paid") return Math.max(0, parseMoneyLabel(c.amountLabel || "0"));
  if (c.status !== "partially_paid") return 0;
  const amount = parseMoneyLabel(c.amountLabel || "0");
  const balance = parseMoneyLabel(c.balanceLabel || "0");
  return Math.max(0, amount - balance);
}

const SECURITY_DEPOSIT_KINDS = new Set<HouseholdChargeKind>(["security_deposit", "holding_deposit"]);
const MOVE_IN_FEE_KINDS = new Set<HouseholdChargeKind>(["move_in_fee"]);

const BEFORE_MOVE_IN_KINDS = new Set<HouseholdChargeKind>([
  ...SECURITY_DEPOSIT_KINDS,
  ...MOVE_IN_FEE_KINDS,
  "stay_total",
  "first_month_rent",
  "prorated_rent",
  "utilities",
  "prorated_utilities",
  "other_cost",
]);

function sumReceived(charges: HouseholdCharge[], kinds: Set<HouseholdChargeKind>): number {
  const total = charges.reduce(
    (sum, c) => (kinds.has(c.kind) && !c.rentMonth ? sum + chargeReceivedAmount(c) : sum),
    0,
  );
  return Math.round(total * 100) / 100;
}

function chargesForPlacement(
  residentEmail: string,
  propertyId: string,
  managerUserId: string | null | undefined,
  applicationId?: string,
): HouseholdCharge[] {
  const email = residentEmail.trim().toLowerCase();
  const prop = propertyId.trim();
  if (!email || !prop || !managerUserId) return [];
  const linked = collectLinkedPropertyIdsForModule(managerUserId, "payments");
  return readChargesForManager(managerUserId, { linkedPropertyIds: linked }).filter(
    (c) =>
      // A fine, a replacement key or any other ad-hoc manager charge is not a lease term,
      // so it never enters the signing itemization or its total.
      !isManagerAddedOneOffCharge(c) &&
      (!applicationId || c.applicationId === applicationId) &&
      c.residentEmail.trim().toLowerCase() === email &&
      c.propertyId?.trim() === prop,
  );
}

function sumByKind(charges: HouseholdCharge[], kind: HouseholdChargeKind): number | undefined {
  const hits = charges.filter((c) => c.kind === kind);
  if (!hits.length) return undefined;
  const total = hits.reduce((s, c) => s + chargeAmount(c), 0);
  return total > 0 ? total : undefined;
}

function dueAtSigningFromCharges(
  charges: HouseholdCharge[],
  computedProration: ReturnType<typeof computeProratedFirstMonthTotals> | null,
  resolvedProratedRent: number | undefined,
  resolvedProratedUtilities: number | undefined,
): number {
  let sum = 0;
  let firstRentApplied = false;
  let firstUtilApplied = false;
  for (const c of charges) {
    if (!SIGNING_CHARGE_KINDS.includes(c.kind)) continue;
    if (FIRST_PERIOD_RENT_KINDS.includes(c.kind)) {
      if (firstRentApplied) continue;
      firstRentApplied = true;
      if (computedProration?.applies && resolvedProratedRent != null && resolvedProratedRent > 0) {
        sum += resolvedProratedRent;
      } else {
        sum += chargeAmount(c);
      }
      continue;
    }
    if (FIRST_PERIOD_UTIL_KINDS.includes(c.kind)) {
      if (firstUtilApplied) continue;
      firstUtilApplied = true;
      if (computedProration?.applies && resolvedProratedUtilities != null && resolvedProratedUtilities >= 0) {
        sum += resolvedProratedUtilities;
      } else {
        sum += chargeAmount(c);
      }
      continue;
    }
    sum += chargeAmount(c);
  }
  return sum;
}

export type LeaseRowBillingRef = {
  axisId?: string | null;
  residentEmail: string;
};

export function applicantRowForLeaseRow(row: LeaseRowBillingRef): DemoApplicantRow | undefined {
  const rows = readManagerApplicationRows();
  const axis = row.axisId?.trim().toUpperCase();
  if (axis) {
    const byAxis = rows.find((a) => a.id.trim().toUpperCase() === axis);
    if (byAxis) return byAxis;
  }
  const email = row.residentEmail.trim().toLowerCase();
  if (!email) return undefined;
  return rows.find((a) => a.email?.trim().toLowerCase() === email);
}

export function buildLeaseBillingSnapshot(
  applicant: Pick<
    DemoApplicantRow,
    | "application"
    | "assignedPropertyId"
    | "assignedRoomChoice"
    | "propertyId"
    | "property"
    | "signedMonthlyRent"
    | "email"
    | "manualResidentDetails"
  > & { id?: string },
  managerUserId: string | null | undefined,
): LeaseBillingSnapshot {
  const placement = resolvePlacementValuesForRow(applicant);
  const placementCharges = chargesForPlacement(applicant.email ?? "", placement.propertyId, managerUserId, applicant.id);
  const charges = placementCharges.filter((c) => !chargeIsSettled(c));
  const listing = placement.propertyId ? getPropertyById(placement.propertyId) : undefined;
  const sub = listing?.listingSubmission?.v === 1
    ? normalizeManagerListingSubmissionV1(listing.listingSubmission) : undefined;
  const isShortTerm = applicant.application?.rentalType === "short_term";
  const selectedRoom = resolveSubmissionRoom(sub, {
    roomChoices: [applicant.assignedRoomChoice, applicant.application?.roomChoice1],
    unitLabel: listing?.unitLabel ?? applicant.manualResidentDetails?.roomNumber,
    signedMonthlyRent: applicant.signedMonthlyRent,
  });
  const pricing = resolveStayPricing({
    room: selectedRoom, submission: sub,
    application: { ...applicant.application, signedMonthlyRent: applicant.signedMonthlyRent },
  });
  const shortPricing = isShortTerm ? pricing : undefined;
  const dailyRent = !isShortTerm && pricing.basis === "daily" ? pricing.dailyRate : undefined;
  const stayNights = shortTermStayNightCount(applicant.application?.leaseStart, applicant.application?.leaseEnd);
  const stayRent = shortPricing?.dailyRate != null && stayNights != null
    ? shortTermStayTotalAmount(shortPricing.dailyRate, stayNights)
    : undefined;

  const monthlyRent = placement.signedMonthlyRent;
  const monthlyUtilities = isShortTerm ? 0 : placement.utilities;
  const securityDeposit = Math.max(0,
    applicant.application?.managerSecurityDepositOverride?.trim()
      ? parseMoneyLabel(applicant.application.managerSecurityDepositOverride)
      : applicant.manualResidentDetails?.securityDeposit ?? (isShortTerm ? shortPricing?.deposit ?? 0 : placement.securityDeposit));
  const moveInFee = Math.max(0,
    applicant.application?.managerMoveInFeeOverride?.trim()
      ? parseMoneyLabel(applicant.application.managerMoveInFeeOverride)
      : applicant.manualResidentDetails?.moveInFee ?? (isShortTerm
        ? parseMoneyLabel(selectedRoom?.shortTermMoveInFee?.trim() || sub?.shortTermMoveInFee || "0")
        : placement.moveInFee));
  const holdingCharge = !isShortTerm
    ? placementCharges.find((c) => c.kind === "holding_deposit" && !chargeIsVoided(c))
    : undefined;
  const holdingDeposit = holdingCharge
    ? {
        amount: parseMoneyLabel(holdingCharge.amountLabel),
        amountDue: chargeOutstandingAmount(holdingCharge),
        received: chargeReceivedAmount(holdingCharge),
      }
    : undefined;
  const remainingForKind = (kind: HouseholdChargeKind, fallback: number) => {
    const rows = placementCharges.filter((c) => c.kind === kind);
    return rows.length
      ? rows.reduce((sum, c) => sum + chargeOutstandingAmount(c), 0)
      : fallback;
  };
  const securityDepositDue = remainingForKind(
    "security_deposit",
    Math.max(0, securityDeposit - (holdingDeposit?.amount ?? 0)),
  );
  const moveInFeeDue = remainingForKind("move_in_fee", moveInFee);
  const otherCostCharges = placementCharges.filter((c) => c.kind === "other_cost" && !c.customFeeId);
  const otherCostDue = otherCostCharges.length
    ? otherCostCharges.reduce((sum, c) => sum + chargeOutstandingAmount(c), 0)
    : placement.otherCostAmount;
  const otherCostReceived = otherCostCharges.length
    ? Math.round(otherCostCharges.reduce((sum, c) => sum + chargeReceivedAmount(c), 0) * 100) / 100
    : 0;
  const oneTimeCustomFeeBalances: Record<string, number> = {};
  const oneTimeCustomFeeReceived: Record<string, number> = {};
  for (const c of placementCharges) {
    if (c.kind !== "other_cost" || !c.customFeeId || c.rentMonth) continue;
    oneTimeCustomFeeBalances[c.customFeeId] = (oneTimeCustomFeeBalances[c.customFeeId] ?? 0) +
      chargeOutstandingAmount(c);
    oneTimeCustomFeeReceived[c.customFeeId] = (oneTimeCustomFeeReceived[c.customFeeId] ?? 0) +
      chargeReceivedAmount(c);
  }
  const customOneTimeFeesDue = (sub?.customFees ?? []).reduce((sum, fee) => {
    const presetId = (fee as { presetId?: string }).presetId;
    if (presetId && presetId !== "custom") return sum;
    if (!isShortTerm && fee.frequency !== "one-time") return sum;
    return sum + (oneTimeCustomFeeBalances[fee.id] ?? parseMoneyLabel(isShortTerm ? fee.shortTermAmount ?? "0" : fee.amount ?? "0"));
  }, 0);
  const stayRentDue = stayRent != null ? remainingForKind("stay_total", stayRent) : undefined;
  // An unpaid holding charge and the net security charge are two portions of ONE
  // deposit. Paid holding dollars are never collected a second time at signing.
  const depositCollectionDue = securityDepositDue + (holdingDeposit?.amountDue ?? 0);
  const applicationFee = sumByKind(charges, "application_fee");
  const securityDepositReceived = sumReceived(placementCharges, SECURITY_DEPOSIT_KINDS);
  const moveInFeeReceived = sumReceived(placementCharges, MOVE_IN_FEE_KINDS);
  const receivedBeforeMoveIn = sumReceived(placementCharges, BEFORE_MOVE_IN_KINDS);

  const leaseStart = applicant.application?.leaseStart?.trim() ?? "";
  const leaseEnd = applicant.application?.leaseEnd?.trim() ?? "";
  const prorationSettings = resolveLeaseProrationInputForApplicant(applicant);
  const computedProration =
    !isShortTerm && leaseStart && (monthlyRent > 0 || monthlyUtilities > 0)
      ? computeProratedFirstMonthTotals({
          monthlyRent,
          monthlyUtilities,
          leaseStart,
          leaseEnd,
          ...prorationSettings,
        })
      : null;

  const chargeProratedRent = sumByKind(charges, "prorated_rent");
  const chargeProratedUtilities = sumByKind(charges, "prorated_utilities");
  const chargeProratedLastMonthRent = sumByKind(charges, "prorated_last_month_rent");
  const chargeProratedLastMonthUtilities = sumByKind(charges, "prorated_last_month_utilities");

  const firstPeriod = leaseFirstPeriodProration(leaseStart, leaseEnd, true);
  const dailyFirstPeriodRent = dailyRent != null && firstPeriod.billableDays > 0
    ? Math.round(dailyRent * firstPeriod.billableDays * 100) / 100 : undefined;
  const resolvedProratedRent =
    dailyFirstPeriodRent != null && firstPeriod.prorated ? dailyFirstPeriodRent : computedProration?.applies && computedProration.proratedRent > 0
      ? computedProration.proratedRent
      : chargeProratedRent;
  const resolvedProratedUtilities =
    computedProration?.applies
      ? computedProration.proratedUtilities > 0
        ? computedProration.proratedUtilities
        : chargeProratedUtilities
      : chargeProratedUtilities;

  const remainingFirstPeriod = (kinds: HouseholdChargeKind[], fallback: number) => {
    // Approval-time charges have no rentMonth; recurring future months must not
    // enter the signing balance merely because they share the utilities kind.
    const rows = placementCharges.filter((c) => kinds.includes(c.kind) && !c.rentMonth);
    return rows.length ? rows.reduce((sum, c) => sum + chargeOutstandingAmount(c), 0) : fallback;
  };
  const firstPeriodRentDue = isShortTerm ? stayRentDue ?? 0 : remainingFirstPeriod(
    FIRST_PERIOD_RENT_KINDS, dailyFirstPeriodRent ?? resolvedProratedRent ?? monthlyRent,
  );
  const firstPeriodUtilitiesDue = isShortTerm ? 0 : remainingFirstPeriod(
    FIRST_PERIOD_UTIL_KINDS, resolvedProratedUtilities ?? monthlyUtilities,
  );

  const totalBeforeCheckIn = pricing.stayKind === "short"
    ? firstPeriodRentDue + firstPeriodUtilitiesDue + depositCollectionDue + moveInFeeDue + otherCostDue + customOneTimeFeesDue
    : undefined;

  let dueAtSigning: number;
  if (sub) {
    dueAtSigning = computeLeasePaymentAtSigning(sub, {
      securityDeposit: depositCollectionDue,
      moveInFee: moveInFeeDue,
      monthlyRent: firstPeriodRentDue,
      monthlyUtilities: firstPeriodUtilitiesDue,
      otherSigningCost: otherCostDue,
      customOneTimeFees: customOneTimeFeesDue,
    });
  } else {
    dueAtSigning = dueAtSigningFromCharges(
      charges,
      computedProration,
      resolvedProratedRent,
      resolvedProratedUtilities,
    );
    if (dueAtSigning <= 0) {
      dueAtSigning = computeLeasePaymentAtSigning(sub, {
        securityDeposit: depositCollectionDue,
        moveInFee: moveInFeeDue,
        monthlyRent,
        monthlyUtilities,
        proratedRent: resolvedProratedRent,
        proratedUtilities: resolvedProratedUtilities,
        otherSigningCost: otherCostDue,
        customOneTimeFees: customOneTimeFeesDue,
      });
    }
  }

  return {
    monthlyRent,
    nightlyRent: shortPricing?.dailyRate,
    dailyRent,
    firstPeriodRentDue,
    firstPeriodUtilitiesDue,
    stayRent,
    totalBeforeCheckIn,
    monthlyUtilities,
    securityDeposit,
    securityDepositDue,
    holdingDeposit,
    moveInFee,
    moveInFeeDue,
    otherCostLabel: placement.otherCostLabel,
    otherCostAmount: placement.otherCostAmount,
    otherCostDue,
    otherCostReceived,
    oneTimeCustomFeeBalances,
    oneTimeCustomFeeReceived,
    proratedRent: resolvedProratedRent,
    proratedUtilities: resolvedProratedUtilities,
    proratedLastMonthRent: chargeProratedLastMonthRent,
    proratedLastMonthUtilities: chargeProratedLastMonthUtilities,
    applicationFee,
    securityDepositReceived,
    moveInFeeReceived,
    receivedBeforeMoveIn,
    dueAtSigning,
  };
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Align lease generation with placement + pending household charges (no invented fees). */
export function applyLeaseBillingToContext(
  ctx: LeaseGenerationContext,
  row: LeaseRowBillingRef,
  managerUserId: string | null | undefined,
): LeaseGenerationContext {
  const applicant = applicantRowForLeaseRow(row);
  if (!applicant) return ctx;
  const billing = buildLeaseBillingSnapshot(applicant, managerUserId);
  const app = ctx.application;
  const patched: Partial<RentalWizardFormState> = {
    ...app,
    managerRentOverride: billing.dailyRent != null ? app.managerRentOverride : fmtUsd(billing.nightlyRent ?? billing.monthlyRent),
    managerUtilitiesOverride: fmtUsd(billing.monthlyUtilities),
    managerSecurityDepositOverride: fmtUsd(billing.securityDeposit),
    managerMoveInFeeOverride: fmtUsd(billing.moveInFee),
    managerOtherCostLabel: billing.otherCostLabel || app.managerOtherCostLabel,
    managerOtherCostAmount: fmtUsd(billing.otherCostAmount),
  };
  return {
    ...ctx,
    application: patched,
    leaseBilling: billing,
  };
}
