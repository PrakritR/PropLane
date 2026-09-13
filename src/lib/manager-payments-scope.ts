import type { DemoApplicantRow } from "@/data/demo-portal";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import {
  householdChargeManagerBucket,
  isManagerAddedOneOffCharge,
  readChargesForManager,
  type HouseholdCharge,
} from "@/lib/household-charges";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { collectLinkedPropertyIdsForModule } from "@/lib/manager-portfolio-access";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";

/**
 * WHY THIS MODULE EXISTS
 *
 * `/portal/payments` and the dashboard "Payments" group are the same money,
 * read from the same store — and they used to compute it two different ways.
 * Payments narrowed `readChargesForManager` by two extra rules (below) that the
 * dashboard never applied, so the dashboard advertised "View all 85 →" against
 * a page that listed 64, and "80 pending" against a Pending tab reading 58.
 *
 * A manager acts on those numbers. The scoping now lives here once, and BOTH
 * surfaces call it, so the two can no longer drift apart.
 * Coverage: `tests/unit/manager-payments-dashboard-agreement.test.ts`.
 */

/**
 * Internal accounts that must never appear as a payer on the manager ledger.
 *
 * Matched EXACTLY, never as a substring. This started as a substring match on
 * name-or-email (commit 4dc87e57, "Exclude Sharad Ramachandran account from
 * payments tab"), so any real resident whose name or email merely CONTAINED the
 * token — "Sharada", "sharad.k@…" — silently lost every charge from every
 * manager's money surfaces, with nothing on screen to say so. Exact matching
 * keeps the intended exclusion and drops the collateral damage.
 *
 * An exact EMAIL is the right identifier and is checked first. The name list
 * survives only because no address was ever recorded for this account; supply
 * one and delete the name. Either way this is a data hack living in product
 * code, and it belongs in configuration.
 */
export const PAYMENT_ACCOUNT_EXCLUDED_EMAILS: readonly string[] = [];
export const PAYMENT_ACCOUNT_EXCLUDED_NAMES: readonly string[] = ["sharad ramachandran", "sharad"];

export function shouldExcludePaymentAccount(residentName: string, residentEmail?: string): boolean {
  const email = (residentEmail ?? "").trim().toLowerCase();
  if (email && PAYMENT_ACCOUNT_EXCLUDED_EMAILS.includes(email)) return true;
  const name = (residentName ?? "").trim().toLowerCase();
  return Boolean(name) && PAYMENT_ACCOUNT_EXCLUDED_NAMES.includes(name);
}

/**
 * The Payments ledger view of a manager's charges: everything
 * `readChargesForManager` returns, minus
 *  1. internal/system payer accounts, and
 *  2. charges belonging to a resident who has MOVED OUT — except a manager
 *     "Add payment" one-off, which stays visible afterwards because the manager
 *     entered it deliberately.
 *
 * "Moved out" is deliberately narrow. The rule used to drop the email of every
 * application row that was not a current resident — which is also true of
 * pending, in-progress, rejected and withdrawn rows — so a resident who merely
 * held a SECOND application had every one of their charges disappear. On the
 * audited portfolio that hid 38 charges across 4 people, not one of whom had
 * moved out: three were pending applicants carrying real application fees, and
 * one was a housed resident whose own portal was showing them the very charges
 * their manager could not see. Money a manager cannot see is money they never
 * chase, so an email is excluded only when it has an approved-but-no-longer-
 * current row AND no current-resident row anywhere.
 */
export function scopeChargesToManagerPaymentsLedger(
  charges: HouseholdCharge[],
  applications: DemoApplicantRow[],
): HouseholdCharge[] {
  const emailOf = (row: DemoApplicantRow) => row.email?.trim().toLowerCase() ?? "";
  const currentResidentEmails = new Set(
    applications.filter((row) => isCurrentResidentApplicationRow(row)).map(emailOf).filter(Boolean),
  );
  const movedOutEmails = new Set(
    applications
      .filter((row) => row.bucket === "approved" && !isCurrentResidentApplicationRow(row))
      .map(emailOf)
      .filter((e) => e && !currentResidentEmails.has(e)),
  );
  return charges
    .filter((charge) => !shouldExcludePaymentAccount(charge.residentName, charge.residentEmail))
    .filter((charge) => {
      if (isManagerAddedOneOffCharge(charge)) return true;
      const email = charge.residentEmail?.trim().toLowerCase();
      return !email || !movedOutEmails.has(email);
    });
}

/** Browser-only convenience: read + scope in one call (what both surfaces use). */
export function readManagerPaymentsLedgerCharges(managerUserId: string | null): HouseholdCharge[] {
  const charges = readChargesForManager(managerUserId, {
    linkedPropertyIds: collectLinkedPropertyIdsForModule(managerUserId ?? "", "payments"),
  });
  return scopeChargesToManagerPaymentsLedger(charges, readManagerApplicationRows()).filter((charge) =>
    workspaceContainsProperty(charge.propertyId),
  );
}

export type ManagerPaymentBucketCounts = { pending: number; overdue: number; paid: number };

/** Pending / Overdue / Paid counts — the same split the Payments tabs render. */
export function managerPaymentBucketCounts(charges: HouseholdCharge[]): ManagerPaymentBucketCounts {
  const counts: ManagerPaymentBucketCounts = { pending: 0, overdue: 0, paid: 0 };
  for (const charge of charges) counts[householdChargeManagerBucket(charge)] += 1;
  return counts;
}

/** Charges the manager still has to collect (Pending + Overdue), never Paid. */
export function unpaidManagerPaymentCharges(charges: HouseholdCharge[]): HouseholdCharge[] {
  return charges.filter((charge) => householdChargeManagerBucket(charge) !== "paid");
}
