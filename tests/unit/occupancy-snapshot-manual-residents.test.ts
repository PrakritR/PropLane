import { describe, expect, it } from "vitest";
import { holdRowFromApplication, occupancyHoldEntries } from "@/lib/occupancy/snapshot.server";

const meta = {
  properties: [{ id: "p1", label: "4709A", entireHomeListing: false }],
  roomLabelForId: (_p: string, r: string) => `Room ${r}`,
};

type Read = { column?: string; ids?: string[]; like?: string; from: number; to: number };

/**
 * A tiny PostgREST stand-in: it records every scoped read and answers each from the rows whose
 * property columns (or room choice) match, so a test can see what the snapshot narrowed on.
 */
function fakeDb(rows: Record<string, unknown>[], calls: { reads: Read[]; eqUser?: boolean }) {
  const from = (table: string) => {
    // Who may speak for p1: its owner and one linked teammate (the "other" manager the rows are stamped with).
    if (table === "manager_property_records") {
      const authors = { in: () => authors, then: (resolve: (v: unknown) => unknown) => resolve({ data: [{ id: "p1", manager_user_id: "owner-1" }], error: null }), select: () => authors };
      return authors;
    }
    if (table === "account_link_invites") {
      const links = {
        select: () => links,
        eq: () => links,
        in: () => links,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: [{ inviter_user_id: "owner-1", invitee_user_id: "other-manager", assigned_property_ids: ["p1"], team_role: "leasing" }], error: null }),
      };
      return links;
    }
    const read: Read = { from: 0, to: 0 };
    let match: (row: Record<string, unknown>) => boolean = () => true;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string) => {
        if (col === "manager_user_id") calls.eqUser = true;
        return chain;
      },
      in: (col: string, ids: string[]) => {
        read.column = col;
        read.ids = ids;
        match = (row) => ids.includes(String(row[col] ?? ""));
        return chain;
      },
      like: (col: string, pattern: string) => {
        read.like = pattern;
        const prefix = pattern.replace(/%$/, "");
        match = (row) => {
          const data = (row.row_data ?? {}) as Record<string, unknown>;
          const value = col.includes("assignedRoomChoice") ? String(data.assignedRoomChoice ?? "") : "";
          return value.startsWith(prefix);
        };
        return chain;
      },
      order: () => chain,
      range: (start: number, end: number) => {
        read.from = start;
        read.to = end;
        calls.reads.push(read);
        return Promise.resolve({ data: rows.filter(match).slice(start, end + 1), error: null });
      },
    };
    return chain;
  };
  return { from } as never;
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
    const calls = { reads: [] as Read[] } as { reads: Read[]; eqUser?: boolean };
    const entries = await occupancyHoldEntries(fakeDb([manualRow], calls), ["p1"], [], meta);
    expect(calls.eqUser).toBeFalsy();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ roomId: "r1", start: "2026-10-05", end: "2027-01-31", summary: "Manual Mo" });
  });

  it("narrows on each property source with a value, never interpolated filter grammar", async () => {
    const calls = { reads: [] as Read[] } as { reads: Read[]; eqUser?: boolean };
    const exotic = 'p,1("x)*';
    await occupancyHoldEntries(fakeDb([], calls), [exotic], [], meta);
    expect(calls.reads.filter((r) => r.column === "property_id")[0]?.ids).toEqual([exotic]);
    expect(calls.reads.filter((r) => r.column === "assigned_property_id")[0]?.ids).toEqual([exotic]);
    expect(calls.reads.some((r) => r.like === `${exotic}::%`)).toBe(true);
  });

  it("reads past the first page instead of dropping the holds beyond it", async () => {
    const calls = { reads: [] as Read[] } as { reads: Read[]; eqUser?: boolean };
    const many = Array.from({ length: 501 }, (_, i) => ({
      ...manualRow,
      id: `AXIS-MAN-${String(i).padStart(4, "0")}`,
    }));
    const entries = await occupancyHoldEntries(fakeDb(many, calls), ["p1"], [], meta);
    expect(entries).toHaveLength(501);
    expect(calls.reads.filter((r) => r.column === "property_id").map((r) => r.from)).toEqual([0, 500]);
  });
});
