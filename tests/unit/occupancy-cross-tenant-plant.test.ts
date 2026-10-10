/**
 * An approved resident row only holds a house's room when its AUTHOR is that house's owner or a
 * teammate the owner linked to it. Occupancy is read by property, so without this a row any
 * manager wrote naming a victim's house published the victim's room as occupied.
 */
import { describe, expect, it, vi } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { occupancyHoldEntries } from "@/lib/occupancy/snapshot.server";

vi.mock("server-only", () => ({}));

const OWNER = "owner-1";
const LINKED = "co-manager-1";
const STRANGER = "stranger-1";
const HOUSE = "victim-house";

function listing() {
  const submission = createDefaultListingSubmission();
  submission.rooms = [{ ...submission.rooms[0]!, id: "room-a", name: "Room A", occupancyCapacity: 1 }];
  return { id: HOUSE, submission };
}

type Stamped = { id: string; manager: string };

function row(entry: Stamped) {
  return {
    id: entry.id,
    manager_user_id: entry.manager,
    // The plant: filed under the stranger's own house but pointing the room at the victim's.
    property_id: entry.manager === STRANGER ? "stranger-house" : HOUSE,
    assigned_property_id: HOUSE,
    assigned: HOUSE,
    choice: `${HOUSE}::room-a`,
    manually_added: "true",
    manual_start: "2026-10-01",
    manual_end: "2026-12-31",
    row_data: {
      bucket: "approved",
      manuallyAdded: true,
      assignedPropertyId: HOUSE,
      assignedRoomChoice: `${HOUSE}::room-a`,
      manualResidentDetails: { moveInDate: "2026-10-01", moveOutDate: "2026-12-31" },
    },
  };
}

function fakeDb(submission: ReturnType<typeof listing>["submission"], applications: ReturnType<typeof row>[]) {
  return {
    from(table: string) {
      const query = {
        select() {
          return this;
        },
        in() {
          return this;
        },
        eq() {
          return this;
        },
        or() {
          return this;
        },
        like() {
          return this;
        },
        order() {
          return this;
        },
        range(start: number) {
          const rows = table === "manager_application_records" ? applications : [];
          return Promise.resolve({ data: rows.slice(start), error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data =
            table === "manager_property_records"
              ? [{ id: HOUSE, manager_user_id: OWNER, property_data: { listingSubmission: submission } }]
              : table === "account_link_invites"
                ? [
                    { inviter_user_id: OWNER, invitee_user_id: LINKED, assigned_property_ids: [HOUSE], team_role: "leasing" },
                    // A property owner (investor) link is never an author.
                    { inviter_user_id: OWNER, invitee_user_id: "investor-1", assigned_property_ids: [HOUSE], team_role: "property_owner" },
                  ]
                : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as never;
}

async function publicSpans(applications: ReturnType<typeof row>[]) {
  const { id, submission } = listing();
  const rooms = await loadPublicRoomOccupancy(fakeDb(submission, applications), [{ id, listingSubmission: submission }], OWNER);
  return rooms.find((room) => room.roomChoice === `${HOUSE}::room-a`)?.spans ?? [];
}

describe("public room occupancy ignores rows a stranger authored", () => {
  it("does not show the room occupied for a planted row", async () => {
    expect(await publicSpans([row({ id: "AXIS-PLANT", manager: STRANGER })])).toEqual([]);
  });

  it("still counts the owner's own row", async () => {
    expect(await publicSpans([row({ id: "AXIS-OWNER", manager: OWNER })])).toHaveLength(1);
  });

  it("still counts a row a linked co-manager authored", async () => {
    expect(await publicSpans([row({ id: "AXIS-LINKED", manager: LINKED })])).toHaveLength(1);
  });

  it("does not count a property-owner (investor) link as an author", async () => {
    expect(await publicSpans([row({ id: "AXIS-INV", manager: "investor-1" })])).toEqual([]);
  });
});

describe("Bookings holds ignore rows a stranger authored", () => {
  async function holds(applications: ReturnType<typeof row>[]) {
    const { submission } = listing();
    const fake = fakeDb(submission, applications);
    return occupancyHoldEntries(
      fake,
      [HOUSE],
      [],
      { properties: [{ id: HOUSE, label: "House", entireHomeListing: false }], roomLabelForId: () => "Room A" },
    );
  }

  it("drops the planted hold, keeps the owner's and a linked co-manager's", async () => {
    // The plant names the victim's house in assigned_property_id, so the Bookings read picks it up.
    const planted = row({ id: "AXIS-PLANT", manager: STRANGER });
    const owner = row({ id: "AXIS-OWNER", manager: OWNER });
    const linked = row({ id: "AXIS-LINKED", manager: LINKED });
    expect(await holds([planted])).toEqual([]);
    expect((await holds([owner])).map((entry) => entry.applicationId)).toEqual(["AXIS-OWNER"]);
    expect((await holds([linked])).map((entry) => entry.applicationId)).toEqual(["AXIS-LINKED"]);
  });
});
