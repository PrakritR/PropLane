import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the REAL availability gate — `isRoomChoiceAvailable` and friends in
 * `rental-application/data.ts` — rather than the pure evaluator underneath it.
 * That gate is read by public listings, search, the room catalog and the apply
 * wizard, so "the evaluator is correct" is not evidence the product is.
 */

type TestRow = {
  id: string;
  bucket: string;
  assignedRoomChoice?: string;
  manuallyAdded?: boolean;
  application?: { roomChoice1?: string; leaseStart?: string; leaseEnd?: string | null };
};

const rows: TestRow[] = [];
const leaseRows: Record<string, unknown>[] = [];
let roomCapacity: number | undefined;

vi.mock("@/lib/manager-applications-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-applications-storage")>();
  return {
    ...actual,
    readManagerApplicationRows: () => rows,
    effectiveApplicationForRow: (row: TestRow) => row.application,
  };
});

vi.mock("@/lib/lease-pipeline-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lease-pipeline-storage")>();
  return {
    ...actual,
    readLeasePipeline: () => leaseRows.map((row) => actual.normalizeLeasePipelineRow(row)),
  };
});

vi.mock("@/lib/demo-property-pipeline", () => ({
  buildMockPropertyFromDraft: () => undefined,
  isPropertyActiveForLeads: () => true,
  readAllExtraListings: () => [],
  readAllPendingManagerProperties: () => [],
  readExtraListings: () => [],
}));

// Built from the REAL submission factory: the normalizer walks bathrooms, shared
// spaces, bundles and quick facts, so a hand-rolled stub is not a valid listing.
vi.mock("@/data/mock-properties", () => ({
  get mockProperties() {
    const base = createDefaultListingSubmission();
    const template = base.rooms[0]!;
    return [
      {
        id: "prop-1",
        title: "Ballard House",
        unitLabel: "Room A",
        listingSubmission: {
          ...base,
          rooms: [
            { ...template, id: "r1", name: "Room A", monthlyRent: 700, availability: "Now", occupancyCapacity: roomCapacity },
            { ...template, id: "r2", name: "Room B", monthlyRent: 700, availability: "Now", occupancyCapacity: 1 },
          ],
        },
      },
    ];
  },
}));

import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  effectiveRoomAvailabilityLabel,
  getRoomUnavailabilityWindows,
  isRoomApprovedConflict,
  isRoomChoiceAvailable,
  roomBedAvailability,
} from "@/lib/rental-application/data";

const ROOM = "prop-1::r1";

function approved(id: string, leaseStart: string, leaseEnd: string | null): TestRow {
  return { id, bucket: "approved", assignedRoomChoice: ROOM, application: { leaseStart, leaseEnd } };
}

function executedLease(appId: string) {
  leaseRows.push({
    id: `lease_${appId}`,
    residentName: "Resident",
    residentEmail: "resident@test.com",
    unit: "A",
    updated: "2026-01-01",
    bucket: "signed",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-01-01T00:00:00Z",
    axisId: appId,
    fullySignedAt: "2026-01-01T00:00:00Z",
    status: "Fully Signed",
    thread: [],
    managerSignature: { role: "manager", name: "Manager", signedAtIso: "2026-01-01" },
    residentSignature: { role: "resident", name: "Resident", signedAtIso: "2026-01-01" },
  });
}

function holdingResident(id: string, leaseStart: string, leaseEnd: string | null) {
  rows.push(approved(id, leaseStart, leaseEnd));
  executedLease(id);
}

beforeEach(() => {
  rows.length = 0;
  leaseRows.length = 0;
  roomCapacity = undefined;
});

describe("unsigned approvals do not block public availability", () => {
  it("keeps the room available when approved but not yet signed", () => {
    rows.push(approved("app-1", "2026-03-01", "2026-06-30"));
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2026-04-01", leaseEnd: "2026-04-30" })).toBe(true);
    expect(getRoomUnavailabilityWindows(ROOM)).toEqual([]);
  });

  it("manual residents still block without a signed lease", () => {
    rows.push({ ...approved("app-1", "2026-01-01", "2026-12-31"), manuallyAdded: true });
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2026-04-01", leaseEnd: "2026-04-30" })).toBe(false);
  });
});

describe("a single-occupancy room is completely unchanged", () => {
  it("stays available when empty", () => {
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2026-04-01", leaseEnd: "2026-04-30" })).toBe(true);
  });

  it("becomes unavailable the moment one signed resident overlaps — the pre-existing rule", () => {
    holdingResident("app-1", "2026-03-01", "2026-06-30");
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2026-04-01", leaseEnd: "2026-04-30" })).toBe(false);
    expect(isRoomApprovedConflict(ROOM, "2026-04-01", "2026-04-30")).toBe(true);
  });

  it("frees up the day after an inclusive end date", () => {
    holdingResident("app-1", "2026-03-01", "2026-03-31");
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2026-04-01", leaseEnd: "2026-04-30" })).toBe(true);
  });
});

describe("a room configured for two residents", () => {
  beforeEach(() => {
    roomCapacity = 2;
  });

  it("still has a bed while only one is taken — the whole point of the feature", () => {
    holdingResident("app-1", "2026-03-01", "2026-06-30");
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2026-04-01", leaseEnd: "2026-04-30" })).toBe(true);
    expect(isRoomApprovedConflict(ROOM, "2026-04-01", "2026-04-30")).toBe(false);
  });

  it("refuses a third resident once both beds overlap the request", () => {
    holdingResident("app-1", "2026-03-01", "2026-06-30");
    holdingResident("app-2", "2026-03-15", "2026-08-31");
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2026-04-01", leaseEnd: "2026-04-30" })).toBe(false);
  });

  it("counts PEAK occupancy, so two consecutive single stays leave a bed free", () => {
    // A long search window spans both stays, but they never coincide.
    holdingResident("app-1", "2026-01-01", "2026-03-31");
    holdingResident("app-2", "2026-06-01", "2026-09-30");
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2026-01-01", leaseEnd: "2026-12-31" })).toBe(true);
  });

  it("excludes the application being edited so a resident never blocks themselves", () => {
    holdingResident("app-1", "2026-03-01", "2026-06-30");
    holdingResident("app-2", "2026-03-01", "2026-06-30");
    expect(
      isRoomChoiceAvailable(ROOM, "Now", {
        leaseStart: "2026-04-01",
        leaseEnd: "2026-04-30",
        excludeApplicationId: "app-2",
      }),
    ).toBe(true);
  });

  it("treats an open-ended resident as occupying one bed indefinitely", () => {
    holdingResident("app-1", "2026-01-01", null);
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2030-01-01", leaseEnd: "2030-12-31" })).toBe(true);
    holdingResident("app-2", "2026-01-01", null);
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2030-01-01", leaseEnd: "2030-12-31" })).toBe(false);
  });

  it("ignores an approved resident in a DIFFERENT room of the same property", () => {
    rows.push({
      id: "app-other",
      bucket: "approved",
      assignedRoomChoice: "prop-1::r2",
      application: { leaseStart: "2026-01-01", leaseEnd: "2026-12-31" },
    });
    executedLease("app-other");
    holdingResident("app-1", "2026-01-01", "2026-12-31");
    holdingResident("app-2", "2026-01-01", "2026-12-31");
    // Only the two in r1 count; the r2 resident must not push it over capacity.
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2026-04-01", leaseEnd: "2026-04-30" })).toBe(false);
    rows.splice(rows.findIndex((r) => r.id === "app-2"), 1);
    leaseRows.splice(leaseRows.findIndex((r) => r.axisId === "app-2"), 1);
    expect(isRoomChoiceAvailable(ROOM, "Now", { leaseStart: "2026-04-01", leaseEnd: "2026-04-30" })).toBe(true);
  });
});

describe("what the manager and prospect are shown agrees with the gate", () => {
  it("reports no unavailable window while a bed is still free", () => {
    roomCapacity = 2;
    holdingResident("app-1", "2026-01-01", "2026-12-31");
    expect(getRoomUnavailabilityWindows(ROOM)).toEqual([]);
  });

  it("reports the stretch where BOTH beds are taken, not one window per resident", () => {
    roomCapacity = 2;
    holdingResident("app-1", "2026-01-01", "2026-06-30");
    holdingResident("app-2", "2026-04-01", "2026-09-30");
    const windows = getRoomUnavailabilityWindows(ROOM);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.start).toEqual(new Date(2026, 3, 1));
    expect(windows[0]!.end).toEqual(new Date(2026, 5, 30));
    expect(windows[0]!.label).toContain("Fully booked");
  });

  it("keeps a capacity-1 room's window wording as it has always read", () => {
    holdingResident("app-1", "2026-01-01", "2026-06-30");
    const windows = getRoomUnavailabilityWindows(ROOM);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.label).toContain("Occupied");
  });

  it("does not label a partly-filled shared room as occupied", () => {
    roomCapacity = 2;
    holdingResident("app-1", "2020-01-01", null);
    // One resident, two beds: a prospect must not be told the room is taken.
    expect(effectiveRoomAvailabilityLabel(ROOM, "Now")).toBe("Available now");
  });

  it("still labels a FULL shared room as unavailable", () => {
    roomCapacity = 2;
    holdingResident("app-1", "2020-01-01", null);
    holdingResident("app-2", "2020-01-01", null);
    expect(effectiveRoomAvailabilityLabel(ROOM, "Now")).toBe("Unavailable (occupied)");
  });
});

describe("bed counts shown to a prospect", () => {
  it("reports both beds free on an empty shared room", () => {
    roomCapacity = 2;
    expect(roomBedAvailability(ROOM)).toEqual({ capacity: 2, remaining: 2 });
  });

  it("counts down as beds fill", () => {
    roomCapacity = 2;
    holdingResident("app-1", "2020-01-01", null);
    expect(roomBedAvailability(ROOM)).toEqual({ capacity: 2, remaining: 1 });
    holdingResident("app-2", "2020-01-01", null);
    expect(roomBedAvailability(ROOM)).toEqual({ capacity: 2, remaining: 0 });
  });

  it("reads a single room as one bed, which is what the old flat label assumed", () => {
    expect(roomBedAvailability(ROOM)).toEqual({ capacity: 1, remaining: 1 });
    holdingResident("app-1", "2020-01-01", null);
    expect(roomBedAvailability(ROOM)).toEqual({ capacity: 1, remaining: 0 });
  });
});
