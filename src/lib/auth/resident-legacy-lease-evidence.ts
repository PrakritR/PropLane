import { applicationPropertyId } from "@/lib/application-property-id";

export type BoundLeaseApplication = { id?: unknown; manager_user_id?: unknown; resident_email?: unknown; property_id?: unknown; assigned_property_id?: unknown; row_data?: unknown };
export type LegacyLeaseCandidate = { id?: unknown; manager_user_id?: unknown; resident_user_id?: unknown; resident_email?: unknown; property_id?: unknown; row_data?: unknown };
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Email selects candidates; only an exact, bound application proves the subject. */
export function provenLegacyResidentLeases(applications: BoundLeaseApplication[], leases: LegacyLeaseCandidate[], userId: string, verifiedEmail: string): LegacyLeaseCandidate[] {
  const email = verifiedEmail.trim().toLowerCase();
  if (!userId || !email) return [];
  return leases.filter((lease) => {
    const data = object(lease.row_data);
    if (!data || lease.resident_user_id != null || (data.residentUserId != null && data.residentUserId !== "") || (data.resident_user_id != null && data.resident_user_id !== "")) return false;
    if (data.leaseKind === "joint_bundle") return false;
    const axisId = text(data.axisId);
    const owner = text(lease.manager_user_id);
    const property = text(lease.property_id);
    if (!axisId || !owner || !property || text(lease.resident_email).toLowerCase() !== email) return false;
    for (const [key, expected] of [["managerUserId", owner], ["manager_user_id", owner], ["propertyId", property], ["property_id", property], ["residentEmail", email], ["resident_email", email]] as const) {
      const value = data[key];
      if (value != null && (typeof value !== "string" || (key.toLowerCase().includes("email") ? value.trim().toLowerCase() : value.trim()) !== expected)) return false;
    }
    const matches = applications.filter((app) => text(app.id) === axisId);
    if (matches.length !== 1) return false;
    const app = matches[0];
    const appData = object(app.row_data);
    return Boolean(appData && text(appData.residentUserId) === userId && text(app.manager_user_id) === owner && applicationPropertyId(app) === property && text(app.resident_email).toLowerCase() === email && appData.bucket === "approved" && !appData.withdrawnAt);
  });
}
