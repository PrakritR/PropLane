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
