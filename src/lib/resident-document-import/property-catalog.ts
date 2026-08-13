import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

export type PropertyCatalogEntry = {
  propertyId: string;
  label: string;
  address: string;
  rooms: Array<{ id: string; label: string; monthlyRent: number | null }>;
};

function slugScore(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase().trim();
  if (!n) return 0;
  if (h === n) return 100;
  if (h.includes(n)) return 70;
  const tokens = n.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((t) => h.includes(t)).length;
  return Math.round((matched / tokens.length) * 50);
}

export function propertyCatalogFromSubmission(
  propertyId: string,
  sub: ManagerListingSubmissionV1,
): PropertyCatalogEntry {
  // ManagerListingSubmissionV1 carries `buildingName`, `address` and `zip` —
  // there is no propertyTitle/streetAddress/city/state/zipCode on it.
  const label = sub.buildingName?.trim() || propertyId;
  const address = [sub.address?.trim(), sub.zip?.trim()].filter(Boolean).join(", ");
  const rooms = (sub.rooms ?? [])
    .filter((room) => room.name?.trim())
    .map((room) => ({
      id: room.id,
      label: room.name.trim(),
      monthlyRent: Number.isFinite(room.monthlyRent) && room.monthlyRent > 0 ? room.monthlyRent : null,
    }));
  return { propertyId, label, address, rooms };
}

export type PropertyCatalogMatch = PropertyCatalogEntry & { confidence: "high" | "medium" | "low" };

export function matchPropertyFromCatalog(
  catalog: PropertyCatalogEntry[],
  input: { propertyId?: string; addressText?: string; unitText?: string },
): PropertyCatalogMatch | null {
  const explicit = input.propertyId?.trim();
  if (explicit) {
    const hit = catalog.find((row) => row.propertyId === explicit);
    if (hit) return { ...hit, confidence: "high" };
  }

  const addressText = input.addressText?.trim() ?? "";
  const unitText = input.unitText?.trim() ?? "";
  let best: (PropertyCatalogEntry & { score: number }) | null = null;
  for (const row of catalog) {
    const score =
      slugScore(`${row.label} ${row.address}`, addressText) +
      (unitText ? slugScore(row.rooms.map((r) => r.label).join(" "), unitText) * 0.5 : 0);
    if (!best || score > best.score) best = { ...row, score };
  }
  if (!best || best.score < 25) return null;
  const confidence: "high" | "medium" | "low" = best.score >= 90 ? "high" : best.score >= 50 ? "medium" : "low";
  return { propertyId: best.propertyId, label: best.label, address: best.address, rooms: best.rooms, confidence };
}

export function matchRoomInProperty(
  property: PropertyCatalogEntry,
  unitText: string,
): { roomId: string; roomLabel: string } | null {
  const needle = unitText.trim().toLowerCase();
  if (!needle) return null;
  let best: { roomId: string; roomLabel: string; score: number } | null = null;
  for (const room of property.rooms) {
    const score = slugScore(room.label, needle);
    if (!best || score > best.score) best = { roomId: room.id, roomLabel: room.label, score };
  }
  if (!best || best.score < 40) return null;
  return { roomId: best.roomId, roomLabel: best.roomLabel };
}
