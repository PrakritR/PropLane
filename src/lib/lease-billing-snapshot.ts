import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  type HouseholdCharge,
  type HouseholdChargeKind,
  readChargesForManager,
} from "@/lib/household-charges";
import { collectLinkedPropertyIdsForModule } from "@/lib/manager-portfolio-access";
import { parseMoneyLabel } from "@/lib/portal-monthly-profit";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { resolvePlacementValuesForRow } from "@/lib/rental-application/placement-values";
import { computeLeasePaymentAtSigning } from "@/lib/rental-application/listing-fees-display";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { getPropertyById } from "@/lib/rental-application/data";
import { computeProratedFirstMonthTotals } from "@/lib/lease-first-period-proration";
import { resolveLeaseProrationInputForApplicant } from "@/lib/lease-proration-settings";
import type { LeaseGenerationContext } from "@/lib/generated-lease";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

/** Dollar amounts that match household charges / placement (what actually bills). */
export type LeaseBillingSnapshot = {
  monthlyRent: number;
  monthlyUtilities: number;
  securityDeposit: number;
  moveInFee: number;
  otherCostLabel: string;
  otherCostAmount: number;
  proratedRent?: number;
  proratedUtilities?: number;
  applicationFee?: number;
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
  "prorated_last_month_rent",
  "prorated_last_month_utilities",
  "other_cost",
];

const FIRST_PERIOD_RENT_KINDS: HouseholdChargeKind[] = ["first_month_rent", "prorated_rent"];
const FIRST_PERIOD_UTIL_KINDS: HouseholdChargeKind[] = ["utilities", "prorated_utilities"];

function chargeAmount(c: HouseholdCharge): number {
  return parseMoneyLabel(c.balanceLabel || c.amountLabel || "0");
}

function pendingChargesForPlacement(
  residentEmail: string,
  propertyId: string,
  managerUserId: string | null | undefined,
): HouseholdCharge[] {
  const email = residentEmail.trim().toLowerCase();
  const prop = propertyId.trim();
  if (!email || !prop || !managerUserId) return [];
  const linked = collectLinkedPropertyIdsForModule(managerUserId, "payments");
  return readChargesForManager(managerUserId, { linkedPropertyIds: linked }).filter(
    (c) =>
      c.status === "pending" &&
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
  >,
  managerUserId: string | null | undefined,
): LeaseBillingSnapshot {
  const placement = resolvePlacementValuesForRow(applicant);
  const charges = pendingChargesForPlacement(applicant.email ?? "", placement.propertyId, managerUserId);

  const monthlyRent = placement.signedMonthlyRent;
  const monthlyUtilities = placement.utilities;
  const securityDeposit =
    sumByKind(charges, "security_deposit") ?? (placement.securityDeposit > 0 ? placement.securityDeposit : 0);
  const moveInFee = sumByKind(charges, "move_in_fee") ?? (placement.moveInFee > 0 ? placement.moveInFee : 0);
  const applicationFee = sumByKind(charges, "application_fee");

  const leaseStart = applicant.application?.leaseStart?.trim() ?? "";
  const leaseEnd = applicant.application?.leaseEnd?.trim() ?? "";
  const prorationSettings = resolveLeaseProrationInputForApplicant(applicant);
  const computedProration =
    leaseStart && (monthlyRent > 0 || monthlyUtilities > 0)
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

  const resolvedProratedRent =
    computedProration?.applies && computedProration.proratedRent > 0
      ? computedProration.proratedRent
      : chargeProratedRent;
  const resolvedProratedUtilities =
    computedProration?.applies
      ? computedProration.proratedUtilities > 0
        ? computedProration.proratedUtilities
        : chargeProratedUtilities
      : chargeProratedUtilities;

  let dueAtSigning = dueAtSigningFromCharges(
    charges,
    computedProration,
    resolvedProratedRent,
    resolvedProratedUtilities,
  );
  if (dueAtSigning <= 0) {
    const listing = placement.propertyId ? getPropertyById(placement.propertyId) : undefined;
    const sub =
      listing?.listingSubmission?.v === 1
        ? normalizeManagerListingSubmissionV1(listing.listingSubmission)
        : undefined;
    dueAtSigning = computeLeasePaymentAtSigning(sub, {
      securityDeposit,
      moveInFee,
      monthlyRent,
      monthlyUtilities,
      proratedRent: resolvedProratedRent,
      proratedUtilities: resolvedProratedUtilities,
      otherSigningCost: placement.otherCostAmount,
    });
  }

  return {
    monthlyRent,
    monthlyUtilities,
    securityDeposit,
    moveInFee,
    otherCostLabel: placement.otherCostLabel,
    otherCostAmount: placement.otherCostAmount,
    proratedRent: resolvedProratedRent,
    proratedUtilities: resolvedProratedUtilities,
    applicationFee,
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
    managerRentOverride: billing.monthlyRent > 0 ? fmtUsd(billing.monthlyRent) : app.managerRentOverride,
    managerUtilitiesOverride:
      billing.monthlyUtilities > 0 ? fmtUsd(billing.monthlyUtilities) : app.managerUtilitiesOverride,
    managerSecurityDepositOverride:
      billing.securityDeposit > 0 ? fmtUsd(billing.securityDeposit) : app.managerSecurityDepositOverride,
    managerMoveInFeeOverride: billing.moveInFee > 0 ? fmtUsd(billing.moveInFee) : app.managerMoveInFeeOverride,
    managerOtherCostLabel: billing.otherCostLabel || app.managerOtherCostLabel,
    managerOtherCostAmount:
      billing.otherCostAmount > 0 ? fmtUsd(billing.otherCostAmount) : app.managerOtherCostAmount,
  };
  return {
    ...ctx,
    application: patched,
    leaseBilling: billing,
  };
}
