import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge, HouseholdChargeKind } from "@/lib/household-charges";
import { parseMoneyAmount } from "@/lib/parse-money";
import { loadListingByPropertyId } from "@/lib/payment-automation-server";
import { lateFeePolicyFromSubmission } from "@/lib/payment-policy";
import type { RentReportingEnrollment } from "@/lib/rent-reporting/consent.server";

export type RentReportingSubmissionStatus = "on_time" | "late_30" | "late_60" | "late_90" | "unpaid";

/** Rent-kind charges only — utilities, fees, and deposits are never reported. */
const RENT_CHARGE_KINDS: ReadonlySet<HouseholdChargeKind> = new Set([
  "first_month_rent",
  "prorated_rent",
  "prorated_last_month_rent",
  "rent",
]);

export type RentReportingChargeSnapshot = {
  /** ISO calendar date (YYYY-MM-DD) rent was due. */
  dueDate: string;
  /** ISO timestamp or date the charge was paid, or null when still unpaid. */
  paidAt: string | null;
  amountCents: number;
  /** The manager's configured late-fee grace period, in days past due. */
  graceDays: number;
  /** True when a late fee assessed against this charge was waived (cancelled). */
  lateFeeWaived: boolean;
};

/**
 * Bucket a single month's rent charge into a bureau-reportable status, straight from
 * the ledger's own dates and amounts — no model arithmetic, ever. A waived late fee
 * counts as on time regardless of how many days late the payment actually landed,
 * because the manager formally excused the lateness.
 *
 * Buckets after the grace period: 1-30 days late, 31-60, 61+ (`late_90` covers 90+ the
 * same way Metro 2's own severity buckets do — there is no fourth tier here).
 */
export function deriveRentReportingSubmissionStatus(
  input: RentReportingChargeSnapshot,
): RentReportingSubmissionStatus {
  if (!input.paidAt) return "unpaid";
  if (input.lateFeeWaived) return "on_time";
  const due = Date.parse(input.dueDate.length === 10 ? `${input.dueDate}T00:00:00Z` : input.dueDate);
  const paid = Date.parse(input.paidAt.length === 10 ? `${input.paidAt}T00:00:00Z` : input.paidAt);
  if (!Number.isFinite(due) || !Number.isFinite(paid)) return "unpaid";
  const daysLate = Math.floor((paid - due) / (1000 * 60 * 60 * 24));
  const grace = Math.max(0, Math.round(input.graceDays));
  if (daysLate <= grace) return "on_time";
  if (daysLate <= 30) return "late_30";
  if (daysLate <= 60) return "late_60";
  return "late_90";
}

export type RentReportingPeriodRow = {
  reportingId: string;
  residentUserId: string;
  managerUserId: string;
  partnerSubjectId: string | null;
  period: string;
  amountCents: number;
  dueDate: string;
  paidDate: string | null;
  status: RentReportingSubmissionStatus;
};

function chargeDueDate(charge: HouseholdCharge, period: string): string | null {
  const parsed = charge.dueDateLabel?.trim();
  if (parsed) {
    const d = new Date(parsed);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  // Fall back to the 1st of the reported month — every rent charge has a due day,
  // but a legacy row without a parseable label should not silently vanish from export.
  return `${period}-01`;
}

/** The one rent-kind charge for this resident/property/period, if any exists yet. */
function rentChargeForPeriod(charges: HouseholdCharge[], propertyId: string, period: string): HouseholdCharge | null {
  const candidates = charges.filter(
    (c) => c.propertyId === propertyId && RENT_CHARGE_KINDS.has(c.kind) && (c.rentMonth ?? "") === period,
  );
  if (candidates.length > 0) return candidates[0]!;
  // First-month / prorated rent charges are not tagged with rentMonth; fall back to due date.
  return (
    charges.find(
      (c) =>
        c.propertyId === propertyId &&
        RENT_CHARGE_KINDS.has(c.kind) &&
        !c.rentMonth &&
        (c.dueDateLabel ?? "").slice(0, 7) === period,
    ) ?? null
  );
}

/** A late fee charge tied to this rent charge whose status is `cancelled` (manager waived it). */
function lateFeeWaivedFor(charges: HouseholdCharge[], rentChargeId: string): boolean {
  return charges.some((c) => c.kind === "late_fee" && c.sourceChargeId === rentChargeId && c.status === "cancelled");
}

/**
 * Build (but do not persist or submit) this period's reportable rows for a set of
 * active enrollments, reading amounts/dates straight off each resident's own charges
 * and a waived late fee straight off the linked late-fee charge's status.
 *
 * A resident with no rent charge yet for this period is skipped entirely — nothing to
 * report — never synthesized as `unpaid`.
 */
export async function buildRentReportingRowsForPeriod(
  db: SupabaseClient,
  period: string,
  enrollments: RentReportingEnrollment[],
): Promise<RentReportingPeriodRow[]> {
  const active = enrollments.filter((e) => e.status === "active" && e.propertyId);
  if (active.length === 0) return [];

  const listingByPropertyId = await loadListingByPropertyId(db);
  const chargesByResident = new Map<string, HouseholdCharge[]>();
  const residentIds = [...new Set(active.map((e) => e.residentUserId))];
  if (residentIds.length > 0) {
    const { data, error } = await db
      .from("portal_household_charge_records")
      .select("row_data")
      .in("resident_user_id", residentIds);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const charge = row.row_data as HouseholdCharge | null;
      if (!charge?.residentUserId) continue;
      const list = chargesByResident.get(charge.residentUserId) ?? [];
      list.push(charge);
      chargesByResident.set(charge.residentUserId, list);
    }
  }

  const rows: RentReportingPeriodRow[] = [];
  for (const enrollment of active) {
    const propertyId = enrollment.propertyId!;
    const charges = chargesByResident.get(enrollment.residentUserId) ?? [];
    const rentCharge = rentChargeForPeriod(charges, propertyId, period);
    if (!rentCharge) continue;

    const listing = listingByPropertyId.get(propertyId) ?? null;
    const graceDays = listing ? lateFeePolicyFromSubmission(listing).graceDays : 5;
    const dueDate = chargeDueDate(rentCharge, period);
    if (!dueDate) continue;
    const paidAt = rentCharge.status === "paid" || rentCharge.status === "partially_paid" ? (rentCharge.paidAt ?? null) : null;
    const lateFeeWaived = lateFeeWaivedFor(charges, rentCharge.id);
    const amountCents = Math.round(parseMoneyAmount(rentCharge.amountLabel) * 100);
    const status = deriveRentReportingSubmissionStatus({
      dueDate,
      paidAt,
      amountCents,
      graceDays,
      lateFeeWaived,
    });

    rows.push({
      reportingId: enrollment.id,
      residentUserId: enrollment.residentUserId,
      managerUserId: enrollment.managerUserId,
      partnerSubjectId: enrollment.partnerSubjectId,
      period,
      amountCents,
      dueDate,
      paidDate: paidAt ? paidAt.slice(0, 10) : null,
      status,
    });
  }
  return rows;
}
