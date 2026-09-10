import type { InspectionKind } from "./model";

/** Resolve requirements only from an explicit, unique room assignment. */
export function roomInspectionRequirements(propertyId: string, assignment: string, rooms: unknown): InspectionKind[] {
  if (!Array.isArray(rooms) || !assignment.trim()) return [];
  const prefix = `${propertyId}::`;
  if (assignment.includes("::") && !assignment.startsWith(prefix)) return [];
  const key = assignment.startsWith(prefix) ? assignment.slice(prefix.length) : assignment;
  const matches = rooms.filter(room => room && typeof room === "object" &&
    (room.id === key || (!assignment.includes("::") && String(room.name ?? "").trim().toLowerCase() === key.trim().toLowerCase())));
  if (matches.length !== 1) return [];
  return [matches[0].moveInInspectionRequired === true ? "move-in" : null,
    matches[0].moveOutInspectionRequired === true ? "move-out" : null].filter((kind): kind is InspectionKind => kind !== null);
}

/* ------------------------------------------------------------------ *
 * Per lease type
 * ------------------------------------------------------------------ */

/** The two rows of the listing's inspection matrix, in display order. */
export const INSPECTION_REQUIREMENT_ROWS: { kind: InspectionKind; label: string }[] = [
  { kind: "move-in", label: "Move-in inspection" },
  { kind: "move-out", label: "Move-out inspection" },
];

type InspectionListingScope = { inspectionsByLeaseType?: Record<string, string[]> | null };

/**
 * The matrix as the listing holds it, expanded across the terms it offers. A term with no
 * stored entry requires nothing, which is what every listing meant before this existed.
 */
export function inspectionRequirementMatrix(
  listing: InspectionListingScope | null | undefined,
  terms: readonly string[],
): Record<string, InspectionKind[]> {
  const stored = listing?.inspectionsByLeaseType ?? undefined;
  const out: Record<string, InspectionKind[]> = {};
  for (const term of terms) {
    const row = stored && Array.isArray(stored[term]) ? stored[term]! : [];
    out[term] = INSPECTION_REQUIREMENT_ROWS.map(r => r.kind).filter(kind => row.includes(kind));
  }
  return out;
}

/** Tick or untick one cell, returning the whole matrix. */
export function setInspectionRequirementCell(
  matrix: Record<string, InspectionKind[]>,
  term: string,
  kind: InspectionKind,
  on: boolean,
): Record<string, InspectionKind[]> {
  const current = matrix[term] ?? [];
  if (on === current.includes(kind)) return matrix;
  const next = on ? [...current, kind] : current.filter(value => value !== kind);
  return { ...matrix, [term]: INSPECTION_REQUIREMENT_ROWS.map(r => r.kind).filter(value => next.includes(value)) };
}

/**
 * What a residency on `leaseTerm` must have. An unnamed term matches nothing rather than
 * everything: requiring an inspection is a real obligation, so it is never inferred from a
 * missing field.
 */
export function leaseTypeInspectionRequirements(
  listing: InspectionListingScope | null | undefined,
  leaseTerm: string | null | undefined,
): InspectionKind[] {
  const term = String(leaseTerm ?? "").trim();
  if (!term) return [];
  const row = listing?.inspectionsByLeaseType?.[term];
  if (!Array.isArray(row)) return [];
  return INSPECTION_REQUIREMENT_ROWS.map(r => r.kind).filter(kind => row.includes(kind));
}

/** Room configuration and lease type both oblige; the union is what the residency owes. */
export function residencyInspectionRequirements(
  roomKinds: readonly InspectionKind[],
  leaseKinds: readonly InspectionKind[],
): InspectionKind[] {
  return INSPECTION_REQUIREMENT_ROWS.map(r => r.kind).filter(kind => roomKinds.includes(kind) || leaseKinds.includes(kind));
}
