// A stay built from an executed lease carries a lease id but no resident email; the house chat names the
// resident from the lease row's own resident_email column, in one batched read, and never guesses.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/occupancy/snapshot.server", () => ({
  occupancySnapshotForManager: vi.fn(async () => ({
    stays: [
      { propertyId: "prop-a", roomLabel: "Room 1", start: "2026-06-01", end: "2027-05-31", name: "Maya Lopez", resident: { source: "proplane", leaseId: "lease-1" } },
      { propertyId: "prop-a", roomLabel: "Room 2", start: "2026-06-01", end: "2027-05-31", name: "Resident", resident: { source: "proplane", leaseId: "lease-2" } },
      { propertyId: "prop-a", roomLabel: "Room 3", start: "2026-06-01", end: "2027-05-31", resident: { source: "hold", residentEmail: "kept@example.com", residentName: "Kept One" } },
    ],
  })),
}));

import { loadOwnerStays } from "@/lib/house-chat/access.server";
import { houseResidentsFromStays } from "@/lib/house-chat/model";
import { chatDb } from "../helpers/house-chat-fixtures";

describe("loadOwnerStays", () => {
  it("fills a lease stay's resident email from the lease row and keeps a stay that already has one", async () => {
    const db = chatDb({
      portal_lease_pipeline_records: [
        { id: "lease-1", resident_email: "Maya@Example.com" },
        { id: "lease-2", resident_email: "noah@example.com" },
      ],
    });
    const stays = await loadOwnerStays(db.db, "owner-1", ["prop-a"]);
    const residents = houseResidentsFromStays(stays, { propertyId: "prop-a", today: "2026-10-20" });
    expect(residents.map((r) => [r.email, r.firstName])).toEqual([
      ["kept@example.com", "Kept"],
      ["maya@example.com", "Maya"],
      ["noah@example.com", "Noah"],
    ]);
  });

  it("leaves a lease stay unnamed (so it is not a member) when the lease read fails", async () => {
    const db = chatDb();
    (db as unknown as { rows: Record<string, unknown[]> }).rows.portal_lease_pipeline_records = [];
    const stays = await loadOwnerStays(db.db, "owner-1", ["prop-a"]);
    expect(houseResidentsFromStays(stays, { propertyId: "prop-a", today: "2026-10-20" }).map((r) => r.email)).toEqual(["kept@example.com"]);
  });
});
