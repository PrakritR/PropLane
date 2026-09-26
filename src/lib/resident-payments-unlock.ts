/**
 * Whether a resident's Payments section is unlocked (C140).
 *
 * Pure composition of three independent kinds of tenancy evidence, so it can
 * be tested without rendering `resident-payments-panel.tsx`. An application
 * or holding-fee charge is deliberately NOT evidence on its own — a prospect
 * owes those before they are ever a resident.
 */
import { chargesImplyTenancy, type HouseholdCharge } from "@/lib/household-charges";
import { residentHasSignedLease, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";

export function residentPaymentsUnlocked(input: {
  hasApprovedApplication: boolean;
  charges: HouseholdCharge[];
  /** The resident's own lease row, if any — from `findLeaseForResidentEmail`. */
  lease: LeasePipelineRow | null;
}): boolean {
  if (input.hasApprovedApplication) return true;
  if (chargesImplyTenancy(input.charges)) return true;
  // C140: a resident the manager placed directly onto a lease — never through
  // an application — has no approved application row and, before the first
  // charge exists, no tenancy charge either. A signed lease is exactly the
  // tenancy evidence this gate is meant to require.
  return Boolean(input.lease && residentHasSignedLease(input.lease));
}
