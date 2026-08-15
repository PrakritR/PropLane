import type { DemoApplicantRow } from "@/data/demo-portal";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  mirrorHouseholdChargesToServerAwait,
  recordApprovedApplicationCharges,
  syncHouseholdChargesFromServer,
} from "@/lib/household-charges";
import { regenerateEditableLeasesForResident, syncLeasePipelineFromServer } from "@/lib/lease-pipeline-storage";
import {
  readManagerApplicationRows,
  replaceManagerApplicationRowInCache,
  syncManagerApplicationsFromServer,
  upsertApplicationRowToServer,
  upsertApplicationRowToServerAwait,
  writeManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { shortTermCheckoutDate } from "@/lib/short-term-stay-pricing";

/** Keep resident manual move-in/out dates aligned with application lease dates. */
export function mergeApplicationLeaseDatesIntoResidentRow(
  row: DemoApplicantRow,
  application: RentalWizardFormState | DemoApplicantRow["application"],
): DemoApplicantRow {
  if (!application) return row;
  const leaseStart = application.leaseStart?.trim() || undefined;
  const leaseEnd = application.leaseEnd?.trim() || undefined;
  const shouldMirrorManual =
    row.manuallyAdded || row.manualResidentDetails?.moveInDate || row.manualResidentDetails?.moveOutDate;
  if (!shouldMirrorManual) {
    return { ...row, application: structuredClone(application) };
  }
  return {
    ...row,
    application: structuredClone(application),
    manualResidentDetails: {
      ...(row.manualResidentDetails ?? {}),
      ...(leaseStart ? { moveInDate: leaseStart } : {}),
      moveOutDate: leaseEnd || undefined,
    },
  };
}

async function mirrorResidentBillingToServer(managerUserId: string | null): Promise<void> {
  if (isDemoModeActive()) return;
  await mirrorHouseholdChargesToServerAwait();
  await Promise.all([
    syncManagerApplicationsFromServer({ force: true, managerUserId }),
    syncHouseholdChargesFromServer(true),
    syncLeasePipelineFromServer(managerUserId, { force: true }),
  ]);
}

function resolveResidentRow(input: { residentEmail: string; row?: DemoApplicantRow }): DemoApplicantRow | null {
  if (input.row) return input.row;
  const email = input.residentEmail.trim().toLowerCase();
  if (!email) return null;
  return readManagerApplicationRows().find((r) => r.email?.trim().toLowerCase() === email) ?? null;
}

export type ResidentBillingSyncOutcome = {
  /** Charges were rebuilt from the edited row. */
  chargesRegenerated: boolean;
  /** How many editable leases were regenerated. */
  leasesRegenerated: number;
  /** Why nothing (or not everything) propagated — manager-facing, empty when all ran. */
  skipped: string[];
};

/**
 * Rebuild charges and editable leases from an edited resident row.
 *
 * Returns WHAT happened rather than a bare count, because every one of these steps can decline
 * silently and the caller was reporting a flat "Resident updated." either way:
 *
 *  - `recordApprovedApplicationCharges` bails when `getPropertyById` cannot resolve the
 *    resident's property. That lookup covers live, extra and PENDING listings but not UNLISTED
 *    or DRAFT ones, so a resident living at an unlisted property silently never has charges
 *    rebuilt.
 *  - `regenerateEditableLeasesForResident` only touches leases in Draft or Manager Review, and
 *    only ones a lease can actually be generated for. A signed lease is deliberately excluded —
 *    it is the evidence of what was signed — and an uploaded PDF is not regenerated either.
 *
 * Those are all legitimate refusals. Reporting them as success is not: the manager edits rent,
 * is told the resident was updated, and finds the application, lease and charges unchanged with
 * nothing saying why.
 */
function regenerateBillingForRow(
  row: DemoApplicantRow,
  managerUserId: string | null,
): ResidentBillingSyncOutcome {
  const skipped: string[] = [];
  const chargesRegenerated = recordApprovedApplicationCharges(row, managerUserId, true);
  if (!chargesRegenerated) {
    skipped.push(
      "charges were not rebuilt — this resident's property could not be resolved (an unlisted or draft listing does not resolve here)",
    );
  }

  const residentEmail = row.email?.trim();
  if (!residentEmail || !row.application) {
    skipped.push("the lease was not regenerated — this resident has no application on file");
    return { chargesRegenerated, leasesRegenerated: 0, skipped };
  }

  const leasesRegenerated = regenerateEditableLeasesForResident(
    residentEmail,
    managerUserId,
    row.application,
  );
  if (leasesRegenerated === 0) {
    skipped.push(
      "no lease was regenerated — only leases in Draft or Manager Review update, and a signed or uploaded lease is never rewritten",
    );
  }

  return { chargesRegenerated, leasesRegenerated, skipped };
}

/** After a short-term stay-total payment edit, align application dates, charges, and editable leases. */
export function syncResidentAfterStayPaymentEdit(input: {
  residentEmail: string;
  managerUserId: string | null;
  nights: number;
  nightlyRate?: number;
}): number {
  const email = input.residentEmail.trim().toLowerCase();
  if (!email || !(input.nights > 0)) return 0;

  const rows = readManagerApplicationRows();
  const idx = rows.findIndex((r) => r.email?.trim().toLowerCase() === email);
  if (idx === -1) return 0;

  const existing = rows[idx]!;
  if (existing.application?.rentalType !== "short_term") return 0;

  const leaseStart =
    existing.application.leaseStart?.trim() || existing.manualResidentDetails?.moveInDate?.trim() || "";
  if (!leaseStart) return 0;

  const leaseEnd = shortTermCheckoutDate(leaseStart, input.nights);
  if (!leaseEnd) return 0;

  const nightly =
    input.nightlyRate && input.nightlyRate > 0
      ? input.nightlyRate
      : Number(existing.signedMonthlyRent ?? 0) > 0
        ? Number(existing.signedMonthlyRent)
        : undefined;

  const nextRow: DemoApplicantRow = {
    ...existing,
    signedMonthlyRent: nightly ?? existing.signedMonthlyRent,
    manualResidentDetails: {
      ...(existing.manualResidentDetails ?? {}),
      moveInDate: leaseStart,
      moveOutDate: leaseEnd,
    },
    application: existing.application
      ? {
          ...existing.application,
          leaseStart,
          leaseEnd,
          managerRentOverride: nightly != null ? String(nightly) : existing.application.managerRentOverride,
        }
      : existing.application,
  };

  const next = [...rows];
  next[idx] = nextRow;
  writeManagerApplicationRows(next);
  upsertApplicationRowToServer(nextRow);
  return regenerateBillingForRow(nextRow, input.managerUserId).leasesRegenerated;
}

/**
 * Refresh pending charges and regenerate editable leases after application or payment edits.
 * Persists regenerated charges to the server so Payments and Application stay in sync.
 */
export async function syncResidentBillingAndLeases(input: {
  residentEmail: string;
  managerUserId: string | null;
  row?: DemoApplicantRow;
}): Promise<number> {
  const row = resolveResidentRow(input);
  if (!row) return 0;

  const leases = regenerateBillingForRow(row, input.managerUserId).leasesRegenerated;
  await mirrorResidentBillingToServer(input.managerUserId);
  return leases;
}

/**
 * Save an edited resident profile, regenerate pending charges/leases, and persist
 * to the server before any forced sync can resurrect stale payment rows.
 */
export async function persistResidentProfileEdit(input: {
  rows: DemoApplicantRow[];
  nextRow: DemoApplicantRow;
  managerUserId: string | null;
}): Promise<{ ok: boolean; error?: string; sync?: ResidentBillingSyncOutcome }> {
  const { rows, nextRow, managerUserId } = input;
  writeManagerApplicationRows(rows);

  if (!isDemoModeActive()) {
    await syncPropertyPipelineFromServer({ force: true });
    const persisted = await upsertApplicationRowToServerAwait(nextRow);
    if (!persisted.ok) {
      return { ok: false, error: persisted.error ?? "Could not save resident." };
    }
    if (persisted.row?.id) {
      replaceManagerApplicationRowInCache(persisted.row);
    }
  }

  const sync = regenerateBillingForRow(nextRow, managerUserId);
  await mirrorResidentBillingToServer(managerUserId);

  return { ok: true, sync };
}
