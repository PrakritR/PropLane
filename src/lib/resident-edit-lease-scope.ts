import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

/** A resident edit may touch only the lease for the exact application and owner. */
export function residentEditLeaseIds(
  leases: LeasePipelineRow[], current: DemoApplicantRow, previous?: DemoApplicantRow,
): { ids: string[]; skippedJointMember: boolean } {
  const id = current.id?.trim().toUpperCase();
  const owner = current.managerUserId?.trim();
  const property = (row: DemoApplicantRow | undefined) => row?.assignedPropertyId?.trim() || row?.propertyId?.trim() || row?.application?.propertyId?.trim() || "";
  const properties = new Set([property(current), property(previous)].filter(Boolean));
  if (!id || !owner || !properties.size) return { ids: [], skippedJointMember: false };
  let skippedJointMember = false;
  const ids = leases.flatMap((lease) => {
    if (lease.managerUserId?.trim() !== owner || !lease.propertyId || !properties.has(lease.propertyId.trim())) return [];
    const axis = lease.axisId?.trim().toUpperCase();
    if (lease.leaseKind === "joint_bundle") {
      const primary = lease.primaryApplicationId?.trim().toUpperCase() || axis;
      if (primary !== id) {
        if (lease.jointLeaseMembers?.some((member) => member.applicationId.trim().toUpperCase() === id)) skippedJointMember = true;
        return [];
      }
      if (axis !== id) return [];
    } else if (axis !== id) return [];
    return [lease.id];
  });
  return { ids, skippedJointMember };
}
