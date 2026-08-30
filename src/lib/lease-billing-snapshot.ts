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
  const proratedRent =
    sumByKind(charges, "prorated_rent") ?? sumByKind(charges, "prorated_last_month_rent");
  const proratedUtilities =
    sumByKind(charges, "prorated_utilities") ?? sumByKind(charges, "prorated_last_month_utilities");

  const leaseStart = applicant.application?.leaseStart?.trim() ?? "";
  const leaseEnd = applicant.application?.leaseEnd?.trim() ?? "";
  const computedProration =
    leaseStart && (monthlyRent > 0 || monthlyUtilities > 0)
      ? computeProratedFirstMonthTotals({
          monthlyRent,
          monthlyUtilities,
          leaseStart,
          leaseEnd,
        })
      : null;
  const resolvedProratedRent =
    proratedRent ??
    (computedProration?.applies && computedProration.proratedRent > 0
      ? computedProration.proratedRent
      : undefined);
  const resolvedProratedUtilities =
    proratedUtilities ??
    (computedProration?.applies && computedProration.proratedUtilities > 0
      ? computedProration.proratedUtilities
      : undefined);

  let dueAtSigning = 0;
  for (const c of charges) {
    if (SIGNING_CHARGE_KINDS.includes(c.kind)) dueAtSigning += chargeAmount(c);
  }
  if (dueAtSigning <= 0) {
    // `DemoApplicantRow.property` is the property LABEL (a string), not the property object —
    // reading `.listingSubmission` off it did not compile and broke the production build. The
    // listing has to be resolved by id, which `resolvePlacementValuesForRow` already gives us.
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
