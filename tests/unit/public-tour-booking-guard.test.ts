import { describe, expect, it } from "vitest";
import { managerHasPublishedSlot } from "@/lib/public-tour-booking-guard";
import { buildDefaultTourSlotKeys } from "@/lib/tour-slot-math";

const MANAGER = "mgr-tour-host";
const PROPERTY_ID = "mgr-demo-ballard";

function makeDb(publishedSlots: string[]) {
  return {
    from(table: string) {
      if (table === "portal_schedule_records") {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({
                data: publishedSlots.length
                  ? [
                      {
                        property_id: PROPERTY_ID,
                        record_type: "manager_property_availability",
                        row_data: { payload: publishedSlots },
                      },
                    ]
                  : [],
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    },
  };
}

describe("managerHasPublishedSlot", () => {
  it("refuses a default 9-5 slot when the manager has published nothing", async () => {
    // 09af3348 removed implicit default tour availability, so an unpublished
    // slot is not bookable just because it falls in the old 9-5 band. The guard
    // has to agree with the public grid or a prospect could book a time the
    // grid never offered.
    const defaultSlot = buildDefaultTourSlotKeys()[0];
    expect(defaultSlot).toBeTruthy();
    const allowed = await managerHasPublishedSlot(makeDb([]) as never, {
      managerUserId: MANAGER,
      slotKey: defaultSlot!,
      propertyId: PROPERTY_ID,
    });
    expect(allowed).toBe(false);
  });

  it("still requires an explicitly published slot on a day the manager painted", async () => {
    const allowed = await managerHasPublishedSlot(makeDb(["2099-08-06:20"]) as never, {
      managerUserId: MANAGER,
      slotKey: "2099-08-06:21",
      propertyId: PROPERTY_ID,
    });
    expect(allowed).toBe(false);
  });
});
