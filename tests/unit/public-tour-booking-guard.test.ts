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

/**
 * Hosting a tour means taking a stranger to somebody's house. The public
 * booking route calls `managerMayHostPropertyTour` with a host id supplied by
 * the browser, so this predicate is the only thing between a stranger and that
 * front door.
 *
 * It used to answer YES for any manager holding a `manager_property_availability`
 * row naming the property — a row that manager writes themselves. Knowing a
 * property id was therefore enough to become a bookable host on someone else's
 * listing.
 */
const OWNER = "mgr-owner";
const CO_MANAGER = "mgr-co";
const STRANGER = "mgr-stranger";

type LinkRow = {
  invitee_user_id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
  co_manager_permissions?: unknown;
};

function hostDb(opts: {
  ownerUserId?: string | null;
  status?: string;
  links?: LinkRow[];
  linkError?: boolean;
  /** Availability rows the OLD predicate would have accepted as a grant. */
  availabilityFor?: string;
}) {
  return {
    from(table: string) {
      if (table === "manager_property_records") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  opts.ownerUserId === null
                    ? null
                    : { manager_user_id: opts.ownerUserId ?? OWNER, status: opts.status ?? "live" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "account_link_invites") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: async (_col: string, inviteeId: string) => ({
                  data: opts.linkError
                    ? null
                    : (opts.links ?? []).filter((row) => row.invitee_user_id === inviteeId),
                  error: opts.linkError ? { message: "boom" } : null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "portal_schedule_records") {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({
                data: opts.availabilityFor
                  ? [
                      {
                        manager_user_id: opts.availabilityFor,
                        property_id: PROPERTY_ID,
                        record_type: "manager_property_availability",
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

function editEverywhere(propertyId: string, permissionId: string) {
  return { [propertyId]: { [permissionId]: { read: true, edit: true } } };
}

async function mayHost(db: unknown, managerUserId: string) {
  const { managerMayHostPropertyTour } = await import("@/lib/public-tour-booking-guard");
  return managerMayHostPropertyTour(db as never, { managerUserId, propertyId: PROPERTY_ID });
}

describe("managerMayHostPropertyTour", () => {
  it("lets the owner of a live property host", async () => {
    expect(await mayHost(hostDb({}), OWNER)).toBe(true);
  });

  it("lets an assigned co-manager with calendar edit host", async () => {
    const db = hostDb({
      links: [
        {
          invitee_user_id: CO_MANAGER,
          assigned_property_ids: [PROPERTY_ID],
          property_co_manager_permissions: editEverywhere(PROPERTY_ID, "calendar"),
        },
      ],
    });
    expect(await mayHost(db, CO_MANAGER)).toBe(true);
  });

  it("accepts applications edit too, so nobody loses hosting they have today", async () => {
    const db = hostDb({
      links: [
        {
          invitee_user_id: CO_MANAGER,
          assigned_property_ids: [PROPERTY_ID],
          property_co_manager_permissions: editEverywhere(PROPERTY_ID, "applications"),
        },
      ],
    });
    expect(await mayHost(db, CO_MANAGER)).toBe(true);
  });

  it("refuses a stranger who published availability against the property", async () => {
    // The whole point: availability is self-written, so it can never be a grant.
    expect(await mayHost(hostDb({ availabilityFor: STRANGER }), STRANGER)).toBe(false);
  });

  it("refuses a co-manager the property was never assigned to", async () => {
    const db = hostDb({
      links: [
        {
          invitee_user_id: CO_MANAGER,
          assigned_property_ids: ["some-other-house"],
          property_co_manager_permissions: editEverywhere("some-other-house", "calendar"),
        },
      ],
    });
    expect(await mayHost(db, CO_MANAGER)).toBe(false);
  });

  it("refuses a co-manager with read-only access — hosting commits time", async () => {
    const db = hostDb({
      links: [
        {
          invitee_user_id: CO_MANAGER,
          assigned_property_ids: [PROPERTY_ID],
          property_co_manager_permissions: { [PROPERTY_ID]: { calendar: { read: true } } },
        },
      ],
    });
    expect(await mayHost(db, CO_MANAGER)).toBe(false);
  });

  it("refuses when the property is not live, whoever asks", async () => {
    expect(await mayHost(hostDb({ status: "draft" }), OWNER)).toBe(false);
  });

  it("refuses when the grant cannot be read, rather than assuming one", async () => {
    expect(await mayHost(hostDb({ linkError: true }), CO_MANAGER)).toBe(false);
  });

  it("refuses an ownerless row instead of letting anyone claim it", async () => {
    expect(await mayHost(hostDb({ ownerUserId: "" }), STRANGER)).toBe(false);
  });
});
