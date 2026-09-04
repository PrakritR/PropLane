/**
 * Carry a rolled-over lease past its end date, in the DATA and not just the
 * document.
 *
 * A listing with `rolloverToMonthToMonth` prints a clause saying the tenancy
 * "continues as a month-to-month tenancy" when the fixed term ends. Charges,
 * however, are bounded by `leaseEnd` (`resolveLeaseDatesForBilling`), so without
 * this the promised month-to-month tenancy would bill nothing at all: the
 * resident stays, owes rent, and no charge is ever created. The signed document
 * is the authority, so the record has to follow it.
 *
 * The conversion is exactly what the clause says and nothing more — same rent,
 * same room, term becomes Month-to-Month and the end date is cleared, which is
 * how every other month-to-month resident already bills.
 */
import { readManagerApplicationRows, writeManagerApplicationRows, upsertApplicationRowToServer } from "@/lib/manager-applications-storage";
import { hasBothLeaseSignatures, readLeasePipeline } from "@/lib/lease-pipeline-storage";
import { listingRollsOverToMonthToMonth } from "@/lib/rental-application/data";
import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";
import type { DemoApplicantRow } from "@/data/demo-portal";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function todayIso(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** True when this approved resident's fixed term has lapsed into its promised rollover. */
export function rolloverConversionApplies(
  row: DemoApplicantRow,
  opts: { renewalInFlight: boolean; now: Date },
): boolean {
  if (row.bucket !== "approved") return false;
  const app = row.application;
  const rentalType = app?.rentalType;
  // A short stay or an off-platform Airbnb booking has no month-to-month clause
  // to roll into, and neither bills a monthly schedule.
  if (rentalType === "short_term" || rentalType === "airbnb") return false;

  const term = (app?.leaseTerm ?? row.manualResidentDetails?.leaseTerm ?? "").trim();
  if (term === "Month-to-Month") return false;

  const leaseEnd = (row.manualResidentDetails?.moveOutDate ?? app?.leaseEnd ?? "").trim();
  if (!leaseEnd || !parseFlexibleLocalDate(leaseEnd)) return false;
  if (leaseEnd >= todayIso(opts.now)) return false;

  // A renewal already out for signature is the resident choosing a NEW term.
  // Converting underneath it would overwrite that choice with the fallback.
  if (opts.renewalInFlight) return false;

  const propertyId = (row.assignedPropertyId ?? app?.propertyId ?? "").trim();
  if (!propertyId) return false;
  return listingRollsOverToMonthToMonth(propertyId);
}

function convertRow(row: DemoApplicantRow): DemoApplicantRow {
  return {
    ...row,
    manualResidentDetails: row.manualResidentDetails
      ? { ...row.manualResidentDetails, moveOutDate: undefined, leaseTerm: "long_term" }
      : row.manualResidentDetails,
    application: row.application
      ? { ...row.application, leaseTerm: "Month-to-Month", leaseEnd: "" }
      : row.application,
  };
}

/**
 * Convert every lapsed rollover lease this manager can see. Returns how many
 * changed, so the caller can decide whether to reprice.
 *
 * Runs in the manager's browser alongside the payment reconcile, because that is
 * where the listing catalog — and therefore the rollover flag and the charge
 * generator — actually exist.
 */
export function convertLapsedRolloverLeasesToMonthToMonth(
  managerUserId: string | null,
  now: Date = new Date(),
): number {
  if (!isBrowser()) return 0;
  const rows = readManagerApplicationRows();
  if (rows.length === 0) return 0;

  const pipeline = readLeasePipeline(managerUserId);
  const renewalInFlightEmails = new Set(
    pipeline
      .filter((lease) => Boolean(lease.pendingRenewal) && !hasBothLeaseSignatures(lease))
      .map((lease) => lease.residentEmail.trim().toLowerCase()),
  );

  let converted = 0;
  const next = rows.map((row) => {
    const email = (row.email ?? "").trim().toLowerCase();
    if (!rolloverConversionApplies(row, { renewalInFlight: renewalInFlightEmails.has(email), now })) {
      return row;
    }
    converted += 1;
    return convertRow(row);
  });

  if (converted === 0) return 0;
  writeManagerApplicationRows(next);
  for (const row of next) {
    const email = (row.email ?? "").trim().toLowerCase();
    const before = rows.find((r) => r.id === row.id);
    if (before && before !== row && email) upsertApplicationRowToServer(row);
  }
  return converted;
}
