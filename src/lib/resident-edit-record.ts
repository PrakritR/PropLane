/**
 * What the Edit resident wizard shows about the resident's REAL record: their
 * charges grouped Overdue / Pending / Paid, who has signed the lease, the files
 * on them, and the application facts the form does not ask (status, household,
 * housing charges, placement). Pure over rows the caller already read, so the
 * steps, the tests and the Save-will list agree on the same numbers.
 *
 * Nothing here invents a figure: every amount comes from a stored charge, the
 * listing the resident is placed in, or the form being edited.
 */
import type { DemoApplicantRow, ManagerPaymentBucket } from "@/data/demo-portal";
import {
  chargeDueLabel,
  compareDueDateMs,
  householdChargeDueDate,
  householdChargeManagerBucket,
  type HouseholdCharge,
} from "@/lib/household-charges";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { leaseSignerRows } from "@/lib/lease-signers";
import { parseMoneyAmount } from "@/lib/parse-money";
import { getPropertyById, getRoomChoiceLabel } from "@/lib/rental-application/data";
import { paymentAtSigningPriceLabel, utilitiesListingEstimateLabel } from "@/lib/rental-application/listing-fees-display";
import { applicationStartedLabel, isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import type { ResidentEditDiff, ResidentEditStage } from "@/lib/resident-edit-stage";

export type ResidentEditCharge = {
  id: string;
  title: string;
  kind: string;
  bucket: ManagerPaymentBucket;
  /** Raw charge status; only `paid` counts as money received. */
  status: string;
  /** "Oct 1" style label the Payments tab already shows. */
  dueLabel: string;
  /** Resolved due date (epoch ms) for ordering; null when the label is not a real date. */
  dueMs: number | null;
  paidAtIso: string | null;
  amountCents: number;
};

export type ResidentEditSigner = {
  id: string;
  name: string;
  role: string;
  signedAtIso: string | null;
  /** What to say while the signature is outstanding. */
  waitText: string;
};

export type ResidentEditDocument = {
  id: string;
  name: string;
  /** yyyy-mm-dd */
  date: string | null;
  kindLabel: string;
};

export type ResidentEditFact = { label: string; value: string };

export type ResidentEditRecord = {
  charges: ResidentEditCharge[];
  signers: ResidentEditSigner[];
  /** "Signed Sep 4" · "Sent Sep 2" · "Draft · not sent" — null when there is no lease. */
  leaseStatusText: string | null;
  leaseDocument: { name: string; date: string | null } | null;
  documents: ResidentEditDocument[];
  application: {
    statusText: string;
    household: ResidentEditFact[];
    housingCharges: ResidentEditFact[];
    placement: ResidentEditFact[];
  } | null;
};

export function emptyResidentEditRecord(): ResidentEditRecord {
  return {
    charges: [],
    signers: [],
    leaseStatusText: null,
    leaseDocument: null,
    documents: [],
    application: null,
  };
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/** $975, $1,050.50 — whole dollars without ".00", like every other money label in the editor. */
export function residentEditMoney(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? usd.format(dollars).replace(/\.00$/, "")
    : usd.format(dollars);
}

export function residentEditChargesFromHousehold(charges: readonly HouseholdCharge[]): ResidentEditCharge[] {
  return charges
    .map((charge) => ({
      id: charge.id,
      title: charge.title,
      kind: charge.kind,
      bucket: householdChargeManagerBucket(charge),
      status: charge.status,
      dueLabel: chargeDueLabel(charge),
      dueMs: householdChargeDueDate(charge)?.getTime() ?? null,
      paidAtIso: charge.paidAt?.trim() || null,
      amountCents: Math.round(parseMoneyAmount(charge.amountLabel) * 100),
    }))
    .sort((a, b) => compareDueDateMs(a.dueMs, b.dueMs));
}

export type ResidentEditChargeGroups = Record<ManagerPaymentBucket, ResidentEditCharge[]>;

export function groupResidentEditCharges(charges: readonly ResidentEditCharge[]): ResidentEditChargeGroups {
  const groups: ResidentEditChargeGroups = { overdue: [], pending: [], paid: [] };
  for (const charge of charges) groups[charge.bucket].push(charge);
  // Paid rows lead with the newest receipt, unpaid rows with the soonest due date.
  groups.paid.sort((a, b) => (b.paidAtIso ?? "").localeCompare(a.paidAtIso ?? ""));
  return groups;
}

/** "$1,950 paid of $4,875" — cancelled and refunded charges are neither owed nor received. */
export function residentEditPaidOfLine(charges: readonly ResidentEditCharge[]): string | null {
  const counted = charges.filter((c) => c.status !== "cancelled" && c.status !== "refunded");
  if (counted.length === 0) return null;
  const total = counted.reduce((sum, c) => sum + c.amountCents, 0);
  const paid = counted.filter((c) => c.status === "paid").reduce((sum, c) => sum + c.amountCents, 0);
  return `${residentEditMoney(paid)} paid of ${residentEditMoney(total)}`;
}

/**
 * The amount an UNPAID rent charge will have after Save, or null when it keeps
 * today's. Only a resident added by hand has their unpaid charges rebuilt from the
 * lease form (paid ones are kept as received); every other stage keeps its
 * charges, so no "old → new" is ever drawn for them.
 */
export function residentEditNewUnpaidRentCents(input: {
  stage: ResidentEditStage;
  diff: ResidentEditDiff;
  rent: string;
  charge: Pick<ResidentEditCharge, "kind" | "bucket" | "status" | "amountCents">;
}): number | null {
  const { stage, diff, rent, charge } = input;
  if (stage !== "by_hand" || !diff.lease.includes("rent")) return null;
  if (charge.kind !== "rent" || charge.status === "paid" || charge.bucket === "paid") return null;
  const cents = Math.round(parseMoneyAmount(rent) * 100);
  return cents > 0 && cents !== charge.amountCents ? cents : null;
}

export function residentEditAmountLabel(charge: Pick<ResidentEditCharge, "amountCents">, newCents: number | null): string {
  return newCents == null
    ? residentEditMoney(charge.amountCents)
    : `${residentEditMoney(charge.amountCents)} → ${residentEditMoney(newCents)}`;
}

/** The security deposit line under Billing: paid, due, or not charged at all. */
export function residentEditDepositLine(charges: readonly ResidentEditCharge[], formatDate: (iso: string) => string): {
  text: string;
  paid: boolean;
} {
  const deposit = charges.find((c) => c.kind === "security_deposit" && c.status !== "cancelled");
  if (!deposit) return { text: "No security deposit charged", paid: false };
  const amount = residentEditMoney(deposit.amountCents);
  if (deposit.status === "paid") {
    return { text: `Security deposit ${amount} paid${deposit.paidAtIso ? ` ${formatDate(deposit.paidAtIso)}` : ""}`, paid: true };
  }
  return { text: `Security deposit ${amount} due ${deposit.dueLabel}`, paid: false };
}

export function residentEditSignersFromLease(
  lease: LeasePipelineRow | null,
  stage: ResidentEditStage,
): ResidentEditSigner[] {
  // A resident added by hand never went through signing; nothing to list.
  if (!lease || stage === "by_hand" || stage === "applicant") return [];
  return leaseSignerRows(lease).map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role === "You" ? "Manager" : row.role === "Roommate" ? "Roommate" : "Tenant",
    signedAtIso: row.state === "signed" ? row.at : null,
    waitText: row.role === "You" ? (stage === "lease_sent" ? "Signs after the tenant" : "Not sent") : stage === "lease_sent" ? "Waiting" : "Not sent",
  }));
}

export function residentEditLeaseDocument(lease: LeasePipelineRow | null): { name: string; date: string | null } | null {
  if (!lease) return null;
  const uploaded = lease.managerUploadedPdf;
  if (uploaded?.fileName) return { name: uploaded.fileName, date: uploaded.uploadedAt?.slice(0, 10) ?? null };
  if (lease.bucket === "manager" && lease.status === "Draft" && !lease.sentToResidentAt) return null;
  return { name: "Lease agreement", date: (lease.sentToResidentAt ?? lease.updatedAtIso ?? "").slice(0, 10) || null };
}

/** The headline under the lease card, e.g. "Signed Sep 4". */
export function residentEditLeaseStatusText(
  stage: ResidentEditStage,
  lease: LeasePipelineRow | null,
  signedAtIso: string | null,
  formatDate: (iso: string) => string,
  movedOutIso: string | null = null,
): string | null {
  switch (stage) {
    case "signed":
      return signedAtIso ? `Signed ${formatDate(signedAtIso)}` : "Signed";
    case "by_hand":
      return "Added by hand · no signatures";
    case "moved_out":
      return movedOutIso ? `Moved out ${formatDate(movedOutIso)}` : "Moved out";
    case "lease_sent":
      return lease?.sentToResidentAt ? `Sent ${formatDate(lease.sentToResidentAt)}` : "Sent for signature";
    case "lease_draft":
      return "Draft · not sent";
    default:
      return "No lease yet";
  }
}

/** Application status the way the Applications tab says it. */
export function residentEditApplicationStatusText(row: DemoApplicantRow): string {
  const bits: string[] = [];
  if (row.manuallyAdded) bits.push("Added by hand · no application fee");
  const stamp = applicationStartedLabel(row);
  if (isInProgressApplicationRow(row)) {
    bits.push("Draft · not submitted");
  } else {
    if (stamp) bits.push(stamp);
    if (row.bucket === "approved") bits.push("Approved");
    else if (row.bucket === "rejected") bits.push("Declined");
    else if (row.bucket === "pending") bits.push("Waiting on your review");
  }
  return bits.length ? bits.join(" · ") : "No application on file";
}

const NOT_PROVIDED = "Not provided";

function orNotProvided(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  return text || NOT_PROVIDED;
}

/**
 * The application facts the wizard form does not ask: status, household, what the
 * listing charges, and where the manager placed them. Same sources as the resident
 * record's Application tab (`ManagerResidentApplicationFactCards`), so the editor and
 * the record never disagree.
 */
export function residentEditApplicationFacts(
  row: DemoApplicantRow,
  opts: { assignedPropertyId?: string; assignedRoomChoice?: string },
): NonNullable<ResidentEditRecord["application"]> {
  const app = (row.application ?? {}) as Partial<RentalWizardFormState>;
  const propertyId = (app.propertyId ?? "").trim() || (row.propertyId ?? "").trim();
  const property = propertyId ? getPropertyById(propertyId) : null;
  const listing = property?.listingSubmission?.v === 1 ? property.listingSubmission : undefined;
  const yesNo = (value: string | null | undefined) => (value === "yes" ? "Yes" : value === "no" ? "No" : "—");

  const housingCharges: ResidentEditFact[] = listing
    ? [
        { label: "Application fee", value: orNotProvided(listing.applicationFee) },
        { label: "Security deposit", value: orNotProvided(listing.securityDeposit) },
        { label: "Move-in fee", value: orNotProvided(listing.moveInFee) },
        { label: "Payment due at signing", value: orNotProvided(paymentAtSigningPriceLabel(listing)) },
        { label: "Utilities (estimate, by room)", value: orNotProvided(utilitiesListingEstimateLabel(listing)) },
      ]
    : [];

  const assignedProperty = opts.assignedPropertyId ? getPropertyById(opts.assignedPropertyId)?.title : "";
  const assignedRoom = opts.assignedRoomChoice ? getRoomChoiceLabel(opts.assignedRoomChoice) : "";
  const firstChoice = app.roomChoice1 ? getRoomChoiceLabel(app.roomChoice1) : "";
  const placement: ResidentEditFact[] =
    opts.assignedPropertyId || opts.assignedRoomChoice
      ? [
          { label: "Assigned property", value: orNotProvided(assignedProperty) },
          { label: "Assigned room", value: orNotProvided(assignedRoom) },
          ...(firstChoice ? [{ label: "1st choice room", value: firstChoice }] : []),
        ]
      : [];

  return {
    statusText: residentEditApplicationStatusText(row),
    household: [
      { label: "Co-signer", value: yesNo(app.hasCosigner) },
      { label: "Group application", value: yesNo(app.applyingAsGroup) },
    ],
    housingCharges,
    placement,
  };
}
