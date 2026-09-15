/**
 * Signature freezes the money terms.
 *
 * A signed lease states a rent, a utilities estimate, a deposit and a move-in
 * fee. Until this module existed nothing wrote those figures onto the
 * resident's record at signature, so every Payments load re-priced the
 * resident from the CURRENT listing (`selectedRoomRentAmount` → the room's
 * `monthlyRent`). A manager who then edited the room's rent moved a signed
 * tenant's pending rent and recurring profile with it — a resident owed a
 * number they never agreed to, and the old and new October rows could both
 * survive.
 *
 * The generator already prefers a negotiated figure over the listing at every
 * money line (`savedAmount(override, listingFallback)`, `residentNegotiatedMonthlyRent`).
 * This module writes that figure at the one moment it becomes a fact — the
 * lease is fully executed — and only into fields that are still empty, so a
 * manager's deliberate pre-signature override is never overwritten. After the
 * freeze the listing can change freely; the only path that moves a signed
 * resident's terms is a renewal or amendment, which writes a new signed rent
 * through `lease-renewal-payments.ts`.
 *
 * Source of each figure, in order:
 *   1. the executed document itself — the generated lease's summary table, or
 *      the structured parse of an uploaded PDF — what the resident actually saw;
 *   2. otherwise the billing snapshot resolved right now (`buildLeaseBillingSnapshot`),
 *      the same resolver the document was rendered from.
 *
 * Rows outside the rule:
 *   - a manually added resident already carries listing-independent terms
 *     (`manualResidentDetails`, `signedMonthlyRent` from the Add-resident form);
 *   - an Airbnb stay bills nothing here;
 *   - a daily- or weekly-priced room keeps billing by its rate — a frozen
 *     MONTHLY override would switch it to flat monthly billing
 *     (`dailyBasisRate` is dropped whenever a negotiated monthly rent exists).
 *     Rent is left alone for those; utilities, deposit and move-in still freeze.
 *
 * Coverage: `tests/unit/lease-signed-terms.test.ts`, `tests/unit/charges-follow-the-lease.test.ts`.
 */

import type { DemoApplicantRow } from "@/data/demo-portal";
import { buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import { resolveSubmissionRoom } from "@/lib/listing-room-resolution";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  normalizeApplicationAxisId,
  readManagerApplicationRows,
  upsertApplicationRowToServer,
  writeManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import { parseMoneyAmount } from "@/lib/parse-money";
import { getPropertyById } from "@/lib/rental-application/data";
import { roomIsDailyPriced, roomIsWeeklyPriced } from "@/lib/room-pricing";
import type { UploadedLeaseParse } from "@/lib/uploaded-lease-extraction";
import { resolvedFieldValue } from "@/lib/uploaded-lease-extraction";

/** The slice of an executed lease row this module reads. Kept structural so tests need no pipeline. */
export type ExecutedLeaseTermsSource = {
  axisId?: string | null;
  residentEmail: string;
  generatedHtml?: string | null;
  uploadedLeaseParse?: UploadedLeaseParse | null;
  signedLeaseSnapshots?: { generatedHtml?: string | null }[];
  jointLeaseMembers?: { residentEmail: string; applicationId?: string | null }[];
  leaseKind?: string;
};

export type SignedLeaseTerms = {
  monthlyRent?: number;
  monthlyUtilities?: number;
  securityDeposit?: number;
  moveInFee?: number;
};

const SUMMARY_ROW = (label: string) =>
  new RegExp(
    String.raw`<t[hd][^>]*>\s*${label}\s*</t[hd]>\s*<td[^>]*>\s*(?:<strong>)?\s*(\$\s?\d[\d,]*(?:\.\d{2})?)`,
    "i",
  );

function moneyFromHtml(html: string, label: string): number | undefined {
  const match = SUMMARY_ROW(label).exec(html);
  if (!match) return undefined;
  const amount = parseMoneyAmount(match[1]!);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

/**
 * The money terms as the generated lease document states them. The summary
 * table `build-lease-html.ts` renders is the contract: `<th>Monthly rent</th>`
 * followed by the amount cell. A document that says "Daily rent" states no
 * monthly figure and returns none for rent.
 */
export function signedTermsFromLeaseHtml(html: string | null | undefined): SignedLeaseTerms {
  if (!html) return {};
  const out: SignedLeaseTerms = {};
  const rent = moneyFromHtml(html, "Monthly rent");
  if (rent !== undefined && rent > 0) out.monthlyRent = rent;
  const utilities = moneyFromHtml(html, "Monthly utilities");
  if (utilities !== undefined) out.monthlyUtilities = utilities;
  const deposit = moneyFromHtml(html, "Security deposit");
  if (deposit !== undefined) out.securityDeposit = deposit;
  const moveIn = moneyFromHtml(html, "Move-in fee");
  if (moveIn !== undefined) out.moveInFee = moveIn;
  return out;
}

/** The money terms an uploaded PDF's structured parse extracted (manager overrides win). */
export function signedTermsFromUploadedParse(parse: UploadedLeaseParse | null | undefined): SignedLeaseTerms {
  if (!parse || parse.status !== "parsed") return {};
  const out: SignedLeaseTerms = {};
  for (const field of parse.fields) {
    if (field.key !== "monthlyRent" && field.key !== "securityDeposit") continue;
    const { value } = resolvedFieldValue(field, parse.review);
    if (!value.trim()) continue;
    const amount = parseMoneyAmount(value);
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (field.key === "monthlyRent" && amount > 0) out.monthlyRent = amount;
    if (field.key === "securityDeposit") out.securityDeposit = amount;
  }
  return out;
}

/** The terms the executed document states, generated HTML first, then the upload parse. */
export function signedTermsFromExecutedLease(lease: ExecutedLeaseTermsSource | null | undefined): SignedLeaseTerms {
  if (!lease) return {};
  const html =
    lease.generatedHtml ||
    lease.signedLeaseSnapshots?.find((s) => s.generatedHtml)?.generatedHtml ||
    null;
  const fromHtml = signedTermsFromLeaseHtml(html);
  const fromParse = signedTermsFromUploadedParse(lease.uploadedLeaseParse);
  return { ...fromParse, ...fromHtml };
}

/** The executed lease that covers this application row, by axis id or email (joint members included). */
export function executedLeaseForRow(
  row: Pick<DemoApplicantRow, "id" | "email">,
  leases: readonly ExecutedLeaseTermsSource[],
): ExecutedLeaseTermsSource | null {
  const axisId = normalizeApplicationAxisId(row.id);
  const email = row.email?.trim().toLowerCase() ?? "";
  for (const lease of leases) {
    if (axisId && lease.axisId && normalizeApplicationAxisId(lease.axisId) === axisId) return lease;
    if (email && lease.residentEmail.trim().toLowerCase() === email) return lease;
    for (const member of lease.jointLeaseMembers ?? []) {
      if (axisId && member.applicationId && normalizeApplicationAxisId(member.applicationId) === axisId) return lease;
      if (email && member.residentEmail.trim().toLowerCase() === email) return lease;
    }
  }
  return null;
}

function hasAmount(raw: string | undefined | null): boolean {
  return raw != null && raw.trim() !== "";
}

/** True once the row carries a rent of its own — override or signed — and no longer tracks the listing. */
export function rowHasFrozenRent(row: Pick<DemoApplicantRow, "signedMonthlyRent" | "application">): boolean {
  if (parseMoneyAmount(row.application?.managerRentOverride ?? "") > 0) return true;
  const signed = Number(row.signedMonthlyRent ?? 0);
  return Number.isFinite(signed) && signed > 0;
}

/** True when every money term this module freezes is already on the row. Cheap pre-check for the reconciler. */
export function rowHasFrozenTerms(row: Pick<DemoApplicantRow, "signedMonthlyRent" | "application" | "manuallyAdded">): boolean {
  if (row.manuallyAdded) return true;
  const app = row.application;
  if (app?.rentalType === "airbnb") return true;
  if (!rowHasFrozenRent(row)) return false;
  if (app?.rentalType === "short_term") {
    return hasAmount(app.managerSecurityDepositOverride) && hasAmount(app.managerMoveInFeeOverride);
  }
  return (
    hasAmount(app?.managerUtilitiesOverride) &&
    hasAmount(app?.managerSecurityDepositOverride) &&
    hasAmount(app?.managerMoveInFeeOverride)
  );
}

function money(n: number): string {
  return String(Number(n.toFixed(2)));
}

/**
 * Write the executed lease's money terms onto the row, filling only what is
 * still empty. Pure: returns the next row and whether anything changed; the
 * caller persists (see {@link persistFrozenSignedLeaseTerms}).
 */
export function freezeSignedLeaseTerms(
  row: DemoApplicantRow,
  opts: { managerUserId: string | null; lease?: ExecutedLeaseTermsSource | null },
): { row: DemoApplicantRow; changed: boolean } {
  if (rowHasFrozenTerms(row)) return { row, changed: false };
  const app = row.application;
  const isShortTerm = app?.rentalType === "short_term";

  const documentTerms = signedTermsFromExecutedLease(opts.lease);
  let snapshot: ReturnType<typeof buildLeaseBillingSnapshot> | null = null;
  const resolved = (): ReturnType<typeof buildLeaseBillingSnapshot> => {
    if (!snapshot) snapshot = buildLeaseBillingSnapshot(row, opts.managerUserId);
    return snapshot;
  };

  // A daily- or weekly-priced room bills by its rate; a frozen monthly figure
  // would silently switch it to flat monthly billing.
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || app?.propertyId?.trim() || "";
  const prop = propertyId ? getPropertyById(propertyId) : undefined;
  const sub = prop?.listingSubmission?.v === 1 ? normalizeManagerListingSubmissionV1(prop.listingSubmission) : undefined;
  const room = resolveSubmissionRoom(sub, {
    roomChoices: [row.assignedRoomChoice, app?.roomChoice1],
    unitLabel: prop?.unitLabel ?? row.manualResidentDetails?.roomNumber,
    signedMonthlyRent: row.signedMonthlyRent,
  });
  const rateBasedRoom = !isShortTerm && (roomIsDailyPriced(room) || roomIsWeeklyPriced(room));

  let signedMonthlyRent = row.signedMonthlyRent;
  let rentOverride = app?.managerRentOverride;
  if (!rowHasFrozenRent(row) && !rateBasedRoom) {
    const rent = isShortTerm
      ? resolved().nightlyRent ?? 0
      : documentTerms.monthlyRent ?? (resolved().dailyRent == null ? resolved().monthlyRent : 0);
    if (rent > 0) {
      signedMonthlyRent = Number(rent.toFixed(2));
      rentOverride = money(rent);
    }
  }

  let utilitiesOverride = app?.managerUtilitiesOverride;
  if (!isShortTerm && !hasAmount(utilitiesOverride)) {
    const utilities = documentTerms.monthlyUtilities ?? resolved().monthlyUtilities;
    if (Number.isFinite(utilities) && utilities >= 0) utilitiesOverride = money(utilities);
  }

  let depositOverride = app?.managerSecurityDepositOverride;
  if (!hasAmount(depositOverride)) {
    const deposit = documentTerms.securityDeposit ?? resolved().securityDeposit;
    if (Number.isFinite(deposit) && deposit >= 0) depositOverride = money(deposit);
  }

  let moveInOverride = app?.managerMoveInFeeOverride;
  if (!hasAmount(moveInOverride)) {
    const moveIn = documentTerms.moveInFee ?? resolved().moveInFee;
    if (Number.isFinite(moveIn) && moveIn >= 0) moveInOverride = money(moveIn);
  }

  const changed =
    signedMonthlyRent !== row.signedMonthlyRent ||
    rentOverride !== app?.managerRentOverride ||
    utilitiesOverride !== app?.managerUtilitiesOverride ||
    depositOverride !== app?.managerSecurityDepositOverride ||
    moveInOverride !== app?.managerMoveInFeeOverride;
  if (!changed) return { row, changed: false };

  // A row with no application object (a legacy or migrated tenant) can only
  // carry the rent, on `signedMonthlyRent`, which the generator reads too.
  // The override fields are required strings on RentalWizardFormState, so
  // inventing a partial application here would break every other reader.
  if (!app) {
    if (signedMonthlyRent === row.signedMonthlyRent) return { row, changed: false };
    return { row: { ...row, signedMonthlyRent }, changed: true };
  }

  return {
    row: {
      ...row,
      ...(signedMonthlyRent !== undefined ? { signedMonthlyRent } : {}),
      application: {
        ...app,
        managerRentOverride: rentOverride ?? app.managerRentOverride,
        managerUtilitiesOverride: utilitiesOverride ?? app.managerUtilitiesOverride,
        managerSecurityDepositOverride: depositOverride ?? app.managerSecurityDepositOverride,
        managerMoveInFeeOverride: moveInOverride ?? app.managerMoveInFeeOverride,
      },
    },
    changed: true,
  };
}

/** Persist frozen rows into the local cache and mirror each to the server. */
export function persistFrozenSignedLeaseTerms(frozen: readonly DemoApplicantRow[]): void {
  if (!frozen.length) return;
  const byId = new Map(frozen.map((r) => [r.id, r] as const));
  const rows = readManagerApplicationRows().map((r) => byId.get(r.id) ?? r);
  writeManagerApplicationRows(rows);
  for (const row of frozen) upsertApplicationRowToServer(row);
}
