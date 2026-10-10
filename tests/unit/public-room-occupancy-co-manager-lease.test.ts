/**
 * The public room picker reads the lease pipeline by PROPERTY as well as by the
 * listing owner.
 *
 * A lease row is stamped with whoever generated it (`manager_user_id = ctx.user.id`),
 * so a lease a co-manager executed on the owner's house is not in the owner's
 * slice. Scoping the executed-lease read to the owner therefore dropped that
 * application from `executedIds`, `applicationHoldsRoomPublicly` answered false,
 * and the anonymous listing calendar published the room's occupied nights as free.
 */
import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";

const OWNER = "owner-1";
const CO_MANAGER = "co-manager-9";
const HOUSE = "home-1";

function listing() {
  const submission = createDefaultListingSubmission();
  submission.rooms = [{ ...submission.rooms[0]!, id: "room-a", name: "Room A", occupancyCapacity: 1 }];
  return { id: HOUSE, submission };
}

/** An approved application with no `manuallyAdded`: only an executed lease holds its room. */
const application = {
  id: "AXIS-SIGNED1",
  manager_user_id: CO_MANAGER,
  assigned: HOUSE,
  choice: `${HOUSE}::room-a`,
  lease_start: "2026-10-01",
  lease_end: "2026-12-31",
};

/** Fully executed, stamped to the co-manager who generated it, carrying the house. */
const leaseRow = {
  manager_user_id: CO_MANAGER,
  property_id: HOUSE,
  row_data: { axisId: "AXIS-SIGNED1", status: "Fully Signed", fullySignedAt: "2026-09-30T00:00:00.000Z" },
};

/** Answers the lease read only for the filter the test is proving. */
function fakeDb(
  submission: ReturnType<typeof listing>["submission"],
  leaseRowsFor: "property_id" | "manager_user_id",
) {
  return {
    from(table: string) {
      let leaseColumn = "";
      const query = {
        select() {
          return this;
        },
        in(column: string) {
          if (table === "portal_lease_pipeline_records") leaseColumn = column;
          return this;
        },
        eq() {
          return this;
        },
        or() {
          return this;
        },
        order() {
          return this;
        },
        range(start: number) {
          const rows =
            table === "manager_application_records"
              ? [application]
              : table === "portal_lease_pipeline_records" && leaseColumn === leaseRowsFor
                ? [leaseRow]
                : [];
          return Promise.resolve({ data: rows.slice(start), error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data =
            table === "manager_property_records"
              ? [{ id: HOUSE, manager_user_id: OWNER, property_data: { listingSubmission: submission } }]
              : table === "account_link_invites"
                ? [{ inviter_user_id: OWNER, invitee_user_id: CO_MANAGER, assigned_property_ids: [HOUSE], team_role: "leasing" }]
                : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as never;
}

describe("public room occupancy: a lease executed by a co-manager still holds the room", () => {
  it("finds the lease by the house, not only by the listing owner's id", async () => {
    const { id, submission } = listing();
    const rooms = await loadPublicRoomOccupancy(
      fakeDb(submission, "property_id"),
      [{ id, listingSubmission: submission }],
      OWNER,
    );
    expect(rooms.find((room) => room.roomChoice === `${HOUSE}::room-a`)?.spans).toEqual([
      { start: "2026-10-01", end: "2026-12-31", count: 1 },
    ]);
  });

  it("still finds the owner's own lease rows", async () => {
    const { id, submission } = listing();
    const rooms = await loadPublicRoomOccupancy(
      fakeDb(submission, "manager_user_id"),
      [{ id, listingSubmission: submission }],
      OWNER,
    );
    expect(rooms.find((room) => room.roomChoice === `${HOUSE}::room-a`)?.spans).toHaveLength(1);
  });
});
