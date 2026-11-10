import type { DemoApplicantRow } from "@/data/demo-portal";

type PlacementControls = { propertyId: string; roomId: string; bundleId: string; moveInDate: string; moveOutDate: string; leaseTerm: string; leaseTermCustomMode: boolean };

/** Preserve the stored occupancy representation when no placement control changed. */
export function preserveUnchangedResidentPlacement(
  previous: DemoApplicantRow,
  next: DemoApplicantRow,
  baseline: PlacementControls | null | undefined,
  current: PlacementControls,
): DemoApplicantRow {
  if (!baseline || (Object.keys(current) as (keyof PlacementControls)[]).some((key) => baseline[key] !== current[key])) return next;
  const copyFields = (source: object | undefined, target: object, keys: string[]) => {
    const result = { ...target } as Record<string, unknown>;
    const original = source as Record<string, unknown> | undefined;
    for (const key of keys) {
      if (original && Object.hasOwn(original, key)) result[key] = original[key];
      else delete result[key];
    }
    return result;
  };
  const result = copyFields(previous, next, ["assignedPropertyId", "assignedRoomChoice"]);
  if (next.application) result.application = copyFields(previous.application, next.application, ["propertyId", "roomChoice1", "bundleId", "leaseStart", "leaseEnd"]);
  if (next.manualResidentDetails) result.manualResidentDetails = copyFields(previous.manualResidentDetails, next.manualResidentDetails, ["roomNumber", "moveInDate", "moveOutDate"]);
  return result as DemoApplicantRow;
}
