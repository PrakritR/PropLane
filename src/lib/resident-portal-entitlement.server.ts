import "server-only";

import { cache } from "react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationPropertyId } from "@/lib/application-property-id";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { hasMoveOutDatePassed, isCurrentResidentApplicationRow } from "@/lib/current-resident";
import { getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";
import { resolvePropertyOwnerUserId } from "@/lib/property-owner.server";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { leaseRowAttestsTenancy, leaseRowIsFullySigned } from "@/lib/resident-portal-access";
import type { ManagerSubscriptionTier } from "@/lib/resident-portal-access-types";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

const MAX_SUBJECT_ROWS = 200;
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

/**
 * profiles.manager_id is an application id, not a purchase code. Only a
 * subject-bound placement and its current property owner establish this tier.
 * The shared portal has no multi-owner entitlement policy, so ambiguity denies.
 */
export const getResidentPortalManagerTier = cache(async (residentUserId: string | null | undefined): Promise<ManagerSubscriptionTier> => {
  const subject = residentUserId?.trim();
  if (!subject) return "free";
  try {
    const db = createSupabaseServiceRoleClient();
    if (!await authorizeResidentRole(db, { userId: subject, legacyRole: null })) return "free";
    const [applications, leases] = await Promise.all([
      db.from("manager_application_records")
        .select("manager_user_id,property_id,assigned_property_id,row_data")
        .eq("row_data->>residentUserId", subject).limit(MAX_SUBJECT_ROWS + 1),
      db.from("portal_lease_pipeline_records")
        .select("manager_user_id,resident_user_id,row_data")
        .eq("resident_user_id", subject).limit(MAX_SUBJECT_ROWS + 1),
    ]);
    if (applications.error || leases.error || !applications.data || !leases.data ||
      applications.data.length > MAX_SUBJECT_ROWS || leases.data.length > MAX_SUBJECT_ROWS) return "free";
    const owners = new Set<string>();
    const placements: { owner: string; propertyId: string }[] = [];
    for (const record of applications.data) {
      const row = object(record.row_data);
      if (!row || text(row.residentUserId) !== subject) return "free";
      const owner = text(record.manager_user_id);
      if (!owner) return "free";
      owners.add(owner);
      const application = object(row.application);
      if (!isCurrentResidentApplicationRow(row as unknown as DemoApplicantRow) ||
        isWithdrawnApplicationRow(row as unknown as DemoApplicantRow) ||
        hasMoveOutDatePassed(text(application?.leaseEnd))) continue;
      placements.push({ owner, propertyId: applicationPropertyId(record) });
    }
    for (const record of leases.data) {
      if (text(record.resident_user_id) !== subject) return "free";
      const row = object(record.row_data);
      const owner = text(record.manager_user_id);
      if (!row || !owner) return "free";
      owners.add(owner);
      const application = object(row.application);
      if (text(row.status).toLowerCase() === "voided" || text(row.voidedAt) ||
        hasMoveOutDatePassed(text(application?.leaseEnd)) ||
        (!leaseRowIsFullySigned(row) && !leaseRowAttestsTenancy(row))) continue;
      placements.push({ owner, propertyId: applicationPropertyId({ row_data: row }) });
    }
    if (owners.size !== 1 || placements.length === 0) return "free";
    const unique = new Map(placements.map((placement) => [placement.propertyId, placement.owner]));
    for (const [propertyId, owner] of unique) {
      if (!propertyId || await resolvePropertyOwnerUserId(db, propertyId) !== owner) return "free";
    }
    const tier = await getManagerSubscriptionTierByManagerId(placements[0]!.owner);
    return tier === "paid" ? "paid" : "free";
  } catch {
    return "free";
  }
});
