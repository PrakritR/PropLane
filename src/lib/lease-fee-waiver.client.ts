/**
 * Manager-side lease fee waiver (browser). The SERVER does the authoritative, audited work
 * (`/api/manager/lease-fee-waivers`); this only mirrors the result into the manager's own stores so the
 * charge generator, which runs in the manager's browser, never bills a waived fee and the lease document
 * and signing total drop it at once.
 */
import {
  HOUSEHOLD_CHARGES_EVENT,
  syncHouseholdChargesFromServer,
  type HouseholdCharge,
} from "@/lib/household-charges";
import { readLeasePipeline } from "@/lib/lease-pipeline-storage";
import type { LeaseFeeWaiver } from "@/lib/lease-at-signing";
import {
  normalizeApplicationAxisId,
  readManagerApplicationRows,
  upsertApplicationRowToServer,
  writeManagerApplicationRows,
} from "@/lib/manager-applications-storage";

/** The lease a lease-fee charge belongs to: by application (a joint lease's members included), else by resident + property. */
export function leaseIdForLeaseFeeCharge(
  charge: Pick<HouseholdCharge, "applicationId" | "residentEmail" | "propertyId">,
  managerUserId: string | null,
): string | null {
  const appKey = charge.applicationId ? normalizeApplicationAxisId(charge.applicationId) : "";
  const email = charge.residentEmail.trim().toLowerCase();
  const leases = readLeasePipeline(managerUserId).filter((lease) => lease.status !== "Voided");
  const byApplication = appKey
    ? leases.find(
        (lease) =>
          (lease.axisId && normalizeApplicationAxisId(lease.axisId) === appKey) ||
          lease.jointLeaseMembers?.some((member) => normalizeApplicationAxisId(member.applicationId) === appKey),
      )
    : undefined;
  if (byApplication) return byApplication.id;
  const byResident = leases.find(
    (lease) =>
      lease.residentEmail.trim().toLowerCase() === email && (!charge.propertyId || lease.propertyId === charge.propertyId),
  );
  return byResident?.id ?? null;
}

export type LeaseFeeWaiverActionResult = { ok: true } | { ok: false; error: string };

function mirrorWaiverOntoApplications(applicationIds: readonly string[], waiver: LeaseFeeWaiver | null): void {
  const keys = new Set(applicationIds.map((id) => normalizeApplicationAxisId(id)).filter(Boolean));
  if (keys.size === 0) return;
  const touched = [] as ReturnType<typeof readManagerApplicationRows>;
  const rows = readManagerApplicationRows().map((row) => {
    if (!row.application || !keys.has(normalizeApplicationAxisId(row.id))) return row;
    const application = { ...row.application, managerLeaseFeeWaiver: waiver };
    const next = { ...row, application };
    touched.push(next);
    return next;
  });
  if (touched.length === 0) return;
  writeManagerApplicationRows(rows);
  for (const row of touched) upsertApplicationRowToServer(row);
}

async function refreshCharges(): Promise<void> {
  await syncHouseholdChargesFromServer(true, { skipReconcile: true }).catch(() => undefined);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(HOUSEHOLD_CHARGES_EVENT));
}

export async function waiveLeaseFeeForLease(leaseId: string, reason: string): Promise<LeaseFeeWaiverActionResult> {
  try {
    const res = await fetch("/api/manager/lease-fee-waivers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ leaseId, reason }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      waiver?: LeaseFeeWaiver;
      applicationIds?: string[];
    };
    if (!res.ok || !body.waiver) return { ok: false, error: body.error ?? "Could not waive the lease fee." };
    mirrorWaiverOntoApplications(body.applicationIds ?? [], body.waiver);
    await refreshCharges();
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not waive the lease fee. Check your connection and try again." };
  }
}

export async function reinstateLeaseFeeForLease(leaseId: string): Promise<LeaseFeeWaiverActionResult> {
  try {
    const res = await fetch(`/api/manager/lease-fee-waivers/${encodeURIComponent(leaseId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "revoke" }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; applicationIds?: string[] };
    if (!res.ok) return { ok: false, error: body.error ?? "Could not restore the lease fee." };
    mirrorWaiverOntoApplications(body.applicationIds ?? [], null);
    await refreshCharges();
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not restore the lease fee. Check your connection and try again." };
  }
}
