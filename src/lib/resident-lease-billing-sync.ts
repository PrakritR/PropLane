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

function regenerateBillingForRow(row: DemoApplicantRow, managerUserId: string | null): number {
  recordApprovedApplicationCharges(row, managerUserId, true);
  const residentEmail = row.email?.trim();
  if (!residentEmail || !row.application) return 0;
  return regenerateEditableLeasesForResident(residentEmail, managerUserId, row.application);
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
  return regenerateBillingForRow(nextRow, input.managerUserId);
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

  const leases = regenerateBillingForRow(row, input.managerUserId);
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
}): Promise<{ ok: boolean; error?: string }> {
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

  regenerateBillingForRow(nextRow, managerUserId);
  await mirrorResidentBillingToServer(managerUserId);

  return { ok: true };
}
