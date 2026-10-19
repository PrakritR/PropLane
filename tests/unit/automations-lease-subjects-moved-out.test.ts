import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("server-only", () => ({}));

import { loadLeaseSubjects } from "@/lib/automations/sources.server";
import { houseMoments } from "@/lib/automations/moments";
import type { HouseSubject } from "@/lib/automations/moments";

/**
 * House-wide notices and announcements go to the current roster: a resident whose move-out date is
 * in the past drops out, while today's move-out stays so the move-out moment still fires.
 */

const OWNER = "owner-1";
const NOW = new Date("2026-10-19T20:00:00Z"); // Monday 1pm Pacific, 2026-10-19

const house: HouseSubject = {
  ownerUserId: OWNER,
  workspaceId: "ws-1",
  propertyId: "prop-1",
  propertyLabel: "5259 Brooklyn",
  houseInfo: {} as HouseSubject["houseInfo"],
};
const houses = new Map([["prop-1", house]]);

const lease = (id: string, email: string) => ({
  manager_user_id: OWNER,
  row_data: { id, propertyId: "prop-1", residentEmail: email, residentName: `Res ${id}`, fullySignedAt: "2026-01-02T00:00:00Z", application: { leaseStart: "2026-01-05" } },
});
const application = (id: string, email: string, moveOutDate: string | null) => ({
  id,
  manager_user_id: OWNER,
  resident_email: email,
  row_data: { bucket: "approved", manualResidentDetails: moveOutDate ? { moveOutDate } : {}, property: "5259 Brooklyn" },
});

function world(apps: ReturnType<typeof application>[]) {
  return createMemoryDb({
    portal_lease_pipeline_records: [lease("l-gone", "gone@x.com"), lease("l-today", "today@x.com"), lease("l-future", "future@x.com"), lease("l-open", "open@x.com"), lease("l-back", "back@x.com")],
    manager_application_records: apps,
    profiles: [],
  });
}

describe("loadLeaseSubjects drops residents who already moved out", () => {
  it("excludes a past move-out, keeps today's, a future one, and an open stay", async () => {
    const db = world([
      application("a1", "gone@x.com", "2026-10-10"),
      application("a2", "today@x.com", "2026-10-19"),
      application("a3", "future@x.com", "2026-11-30"),
      application("a4", "open@x.com", null),
    ]);
    const subjects = await loadLeaseSubjects(db as never, { houses, now: NOW });
    expect(subjects.map((s) => s.leaseId).sort()).toEqual(["l-back", "l-future", "l-open", "l-today"]);
  });

  it("an old tenancy row never hides a returning resident who also has a later one", async () => {
    const db = world([application("old", "back@x.com", "2025-08-01"), application("new", "back@x.com", "2027-06-30")]);
    const subjects = await loadLeaseSubjects(db as never, { houses, now: NOW });
    expect(subjects.map((s) => s.leaseId)).toContain("l-back");
    expect(subjects.find((s) => s.leaseId === "l-back")!.moveOut).toBe("2027-06-30");
  });

  it("the move-out moment still fires on the move-out day itself", async () => {
    const db = world([application("a2", "today@x.com", "2026-10-19")]);
    const roster = await loadLeaseSubjects(db as never, { houses, now: NOW });
    const moments = houseMoments({
      house,
      roster,
      rentDueToday: false,
      clock: { todayKey: "2026-10-19", hour: 13, dayOfMonth: 19 } as never,
    });
    expect(moments.map((m) => m.preset)).toContain("move_out");
  });
});
