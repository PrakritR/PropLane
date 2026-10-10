import { describe, expect, it } from "vitest";
import { holdRowFromApplication, occupancyHoldEntries } from "@/lib/occupancy/snapshot.server";

const meta = {
  properties: [{ id: "p1", label: "4709A", entireHomeListing: false }],
  roomLabelForId: (_p: string, r: string) => `Room ${r}`,
};

/** The read is paged and ordered by the primary key, so the fake answers `.range()` once. */
function fakeDb(rows: unknown[], calls: { or?: string; eqUser?: boolean; ordered?: string } = {}) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (col: string) => {
      if (col === "manager_user_id") calls.eqUser = true;
      return chain;
    },
    or: (expr: string) => {
      calls.or = expr;
      return chain;
    },
    order: (col: string) => {
      calls.ordered = col;
      return chain;
    },
    range: (from: number) => Promise.resolve({ data: from === 0 ? rows : [], error: null }),
  };
  return { from: () => chain } as never;
}

const manualRow = {
  id: "AXIS-MAN1",
  property_id: "p1",
  assigned_property_id: null,
  manager_user_id: "other-manager",
  row_data: {
    bucket: "approved",
    name: "Manual Mo",
    assignedRoomChoice: "p1::r1",
    manualResidentDetails: { moveInDate: "2026-10-05", moveOutDate: "2027-01-31" },
  },
};

describe("occupancyHoldEntries - manually added residents", () => {
  it("maps manualResidentDetails dates", () => {
    expect(holdRowFromApplication(manualRow).manualResidentDetails).toEqual({
      moveInDate: "2026-10-05",
      moveOutDate: "2027-01-31",
    });
  });

  it("counts a hold row owned by another manager_user_id on a scoped property, without an owner filter", async () => {
    const calls: { or?: string; eqUser?: boolean; ordered?: string } = {};
    const entries = await occupancyHoldEntries(fakeDb([manualRow], calls), ["p1"], [], meta);
    expect(calls.eqUser).toBeFalsy();
    expect(calls.or).toContain("p1");
    // Paged by primary key: a truncated read would show an occupied room as free.
    expect(calls.ordered).toBe("id");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ roomId: "r1", start: "2026-10-05", end: "2027-01-31", summary: "Manual Mo" });
  });
});
