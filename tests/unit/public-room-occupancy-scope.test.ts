import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { availabilityLabelFromPublicSpans } from "@/lib/public-room-occupancy";

describe("public occupancy reader scope", () => {
  it("refuses a listing whose stored owner differs from the SMS manager", async () => {
    const query = {
      select() { return this; },
      in() { return Promise.resolve({ data: [{ id: "home-1", manager_user_id: "other-manager", property_data: {} }], error: null }); },
    };
    const db = { from: () => query };
    await expect(loadPublicRoomOccupancy(db as never, [{ id: "home-1", listingSubmission: createDefaultListingSubmission() }], "manager-1"))
      .rejects.toThrow("owner could not be verified");
  });

  it("counts slot-qualified approved residents in a shared room", async () => {
    const submission = createDefaultListingSubmission();
    submission.rooms = [{ ...submission.rooms[0]!, id: "room-a", name: "Room A", occupancyCapacity: 2 }];
    const applications = [1, 2].map((slot) => ({
      id: `app-${slot}`,
      manager_user_id: "manager-1",
      assigned: "home-1",
      choice: `home-1::room-a::r${slot}`,
      manually_added: "true",
      manual_start: "2020-01-01",
    }));
    const db = {
      from(table: string) {
        const query = {
          select() { return this; },
          in() { return this; },
          eq() { return this; },
          order() { return this; },
          range(start: number) {
            if (table === "portal_lease_pipeline_records") return Promise.resolve({ data: [], error: null });
            if (table === "manager_application_records") return Promise.resolve({ data: applications.slice(start), error: null });
            throw new Error(`Unexpected paged table: ${table}`);
          },
          then(resolve: (value: unknown) => unknown) {
            const data = table === "manager_property_records"
              ? [{ id: "home-1", manager_user_id: "manager-1", property_data: { listingSubmission: submission } }]
              : table === "external_calendar_connections" ? [] : null;
            if (data === null) throw new Error(`Unexpected table: ${table}`);
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
        return query;
      },
    };
    const listing = [{ id: "home-1", listingSubmission: submission }];
    const full = await loadPublicRoomOccupancy(db as never, listing, "manager-1");
    expect(full).toEqual([{ roomChoice: "home-1::room-a", spans: [{ start: "2020-01-01", end: null, count: 2 }] }]);
    expect(availabilityLabelFromPublicSpans(full[0]!.spans, 2, new Date(2026, 8, 26))).toBe("Unavailable (occupied)");

    applications.pop();
    const partial = await loadPublicRoomOccupancy(db as never, listing, "manager-1");
    expect(partial[0]?.spans).toEqual([{ start: "2020-01-01", end: null, count: 1 }]);
    expect(availabilityLabelFromPublicSpans(partial[0]!.spans, 2, new Date(2026, 8, 26))).toBe("Available now");
  });
});
