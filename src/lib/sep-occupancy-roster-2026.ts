/**
 * Sep 3–11, 2026 occupancy from the captain's room grid (4709A, 5257 Brooklyn, 5259 Brooklyn).
 * Each segment is one resident row: long-term tenants use standard lease; names prefixed
 * "Airbnb" are off-platform Airbnb stays (no PropLane billing).
 */
export type OccupancySegment = {
  propertyId: string;
  roomNumber: number;
  name: string;
  leaseTerm: "standard" | "airbnb";
  moveIn: string;
  moveOut: string;
};

const P4709 = "mgr-seed-4709a-8th-ave-ne";
const P5257 = "mgr--9-rooms-b1wf3z";
const P5259 = "mgr-seed-5259-brooklyn-ave-ne";

function airbnb(displayName: string): OccupancySegment["leaseTerm"] {
  return displayName.trim().toLowerCase().startsWith("airbnb") ? "airbnb" : "standard";
}

/** Stable import id so re-runs update the same application row. */
export function occupancyImportAxisId(propertyId: string, roomNumber: number, moveIn: string, name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `OCC-2026-09-${propertyId.slice(-6)}-r${roomNumber}-${moveIn}-${slug}`;
}

export const SEP_2026_OCCUPANCY_SEGMENTS: OccupancySegment[] = [
  // 4709 A 8th Ave NE
  { propertyId: P4709, roomNumber: 1, name: "Grace", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P4709, roomNumber: 2, name: "Airbnb Shaqran", leaseTerm: "airbnb", moveIn: "2026-09-03", moveOut: "2026-09-08" },
  { propertyId: P4709, roomNumber: 5, name: "Sam Clark", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-07" },
  { propertyId: P4709, roomNumber: 5, name: "Post", leaseTerm: "standard", moveIn: "2026-09-08", moveOut: "2026-09-11" },
  { propertyId: P4709, roomNumber: 6, name: "Aaron", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P4709, roomNumber: 7, name: "Airbnb Anna", leaseTerm: "airbnb", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P4709, roomNumber: 8, name: "Airbnb Vikrant", leaseTerm: "airbnb", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P4709, roomNumber: 9, name: "Airbnb Karthik", leaseTerm: "airbnb", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P4709, roomNumber: 10, name: "Airbnb Khue", leaseTerm: "airbnb", moveIn: "2026-09-03", moveOut: "2026-09-11" },

  // 5259 Brooklyn Ave NE
  { propertyId: P5259, roomNumber: 1, name: "Airbnb Andrew", leaseTerm: "airbnb", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P5259, roomNumber: 2, name: "Fekadu", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P5259, roomNumber: 3, name: "Tarif", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P5259, roomNumber: 4, name: "Airbnb Ghassan", leaseTerm: "airbnb", moveIn: "2026-09-03", moveOut: "2026-09-03" },
  { propertyId: P5259, roomNumber: 4, name: "Airbnb Arlan", leaseTerm: "airbnb", moveIn: "2026-09-04", moveOut: "2026-09-04" },
  { propertyId: P5259, roomNumber: 4, name: "Airbnb Arpan", leaseTerm: "airbnb", moveIn: "2026-09-05", moveOut: "2026-09-06" },
  { propertyId: P5259, roomNumber: 5, name: "Dashnyam", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P5259, roomNumber: 6, name: "Baljinnyam", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-10" },
  { propertyId: P5259, roomNumber: 6, name: "Dagvadorj", leaseTerm: "standard", moveIn: "2026-09-11", moveOut: "2026-09-11" },
  { propertyId: P5259, roomNumber: 7, name: "Connor", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-04" },
  { propertyId: P5259, roomNumber: 7, name: "Ochirsaikhan", leaseTerm: "standard", moveIn: "2026-09-05", moveOut: "2026-09-11" },
  { propertyId: P5259, roomNumber: 8, name: "Dagvadorj", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-10" },
  { propertyId: P5259, roomNumber: 9, name: "Shivansh", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },

  // 5257 Brooklyn Ave NE
  { propertyId: P5257, roomNumber: 1, name: "Heesu", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P5257, roomNumber: 2, name: "Alexander", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P5257, roomNumber: 3, name: "Akshaya", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P5257, roomNumber: 4, name: "Airbnb Karen", leaseTerm: "airbnb", moveIn: "2026-09-03", moveOut: "2026-09-03" },
  { propertyId: P5257, roomNumber: 4, name: "Airbnb Feiyang", leaseTerm: "airbnb", moveIn: "2026-09-04", moveOut: "2026-09-06" },
  { propertyId: P5257, roomNumber: 4, name: "Airbnb Krishnan", leaseTerm: "airbnb", moveIn: "2026-09-08", moveOut: "2026-09-10" },
  { propertyId: P5257, roomNumber: 4, name: "Airbnb Jan", leaseTerm: "airbnb", moveIn: "2026-09-11", moveOut: "2026-09-11" },
  { propertyId: P5257, roomNumber: 5, name: "Rentao", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-04" },
  { propertyId: P5257, roomNumber: 5, name: "Airbnb Christoph", leaseTerm: "airbnb", moveIn: "2026-09-05", moveOut: "2026-09-06" },
  { propertyId: P5257, roomNumber: 5, name: "Airbnb Christopher", leaseTerm: "airbnb", moveIn: "2026-09-07", moveOut: "2026-09-07" },
  { propertyId: P5257, roomNumber: 5, name: "Airbnb Michelle", leaseTerm: "airbnb", moveIn: "2026-09-08", moveOut: "2026-09-08" },
  { propertyId: P5257, roomNumber: 5, name: "Airbnb Andrew", leaseTerm: "airbnb", moveIn: "2026-09-09", moveOut: "2026-09-11" },
  { propertyId: P5257, roomNumber: 6, name: "Airbnb Richard", leaseTerm: "airbnb", moveIn: "2026-09-03", moveOut: "2026-09-04" },
  { propertyId: P5257, roomNumber: 6, name: "Airbnb Adrien", leaseTerm: "airbnb", moveIn: "2026-09-05", moveOut: "2026-09-07" },
  { propertyId: P5257, roomNumber: 6, name: "Airbnb Marius", leaseTerm: "airbnb", moveIn: "2026-09-08", moveOut: "2026-09-10" },
  { propertyId: P5257, roomNumber: 7, name: "Airbnb Gideon", leaseTerm: "airbnb", moveIn: "2026-09-03", moveOut: "2026-09-04" },
  { propertyId: P5257, roomNumber: 7, name: "Airbnb Jan", leaseTerm: "airbnb", moveIn: "2026-09-05", moveOut: "2026-09-07" },
  { propertyId: P5257, roomNumber: 7, name: "Airbnb Daniel", leaseTerm: "airbnb", moveIn: "2026-09-09", moveOut: "2026-09-11" },
  { propertyId: P5257, roomNumber: 8, name: "Riko", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },
  { propertyId: P5257, roomNumber: 9, name: "Prakrit", leaseTerm: "standard", moveIn: "2026-09-03", moveOut: "2026-09-11" },
].map((row) => ({ ...row, leaseTerm: airbnb(row.name) }));
