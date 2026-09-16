import { describe, expect, it } from "vitest";
import { listPropertyTourHostUserIds } from "@/lib/tour-host-enumeration.server";

/**
 * `listOpenTourSlots` (public availability union) and `createTourInquiry`
 * (eligible-to-claim derivation) both call this SAME function to enumerate
 * "who may host this property" — so a test here is a test of parity between
 * see and claim, not just of the enumeration itself.
 */

const PROPERTY_ID = "mgr-demo-ballard";
const OWNER = "mgr-owner";
const CO_MANAGER = "mgr-co";
const READ_ONLY_CO_MANAGER = "mgr-read-only";
const UNASSIGNED_CO_MANAGER = "mgr-unassigned";

type LinkRow = {
  invitee_user_id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
};

function editEverywhere(propertyId: string, permissionId: string) {
  return { [propertyId]: { [permissionId]: { read: true, edit: true } } };
}

function fakeDb(opts: { links?: LinkRow[]; linkError?: boolean }) {
  return {
    from(table: string) {
      if (table === "account_link_invites") {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({
                data: opts.linkError ? null : (opts.links ?? []),
                error: opts.linkError ? { message: "boom" } : null,
              }),
            }),
          }),
        };
      }
      return {};
    },
  };
}

describe("listPropertyTourHostUserIds", () => {
  it("always includes the owner, even with no co-managers", async () => {
    const hosts = await listPropertyTourHostUserIds(fakeDb({}) as never, {
      propertyId: PROPERTY_ID,
      ownerUserId: OWNER,
    });
    expect(hosts).toEqual([OWNER]);
  });

  it("unions an assigned co-manager with calendar edit", async () => {
    const hosts = await listPropertyTourHostUserIds(
      fakeDb({
        links: [
          {
            invitee_user_id: CO_MANAGER,
            assigned_property_ids: [PROPERTY_ID],
            property_co_manager_permissions: editEverywhere(PROPERTY_ID, "calendar"),
          },
        ],
      }) as never,
      { propertyId: PROPERTY_ID, ownerUserId: OWNER },
    );
    expect(new Set(hosts)).toEqual(new Set([OWNER, CO_MANAGER]));
  });

  it("unions a co-manager with applications edit too", async () => {
    const hosts = await listPropertyTourHostUserIds(
      fakeDb({
        links: [
          {
            invitee_user_id: CO_MANAGER,
            assigned_property_ids: [PROPERTY_ID],
            property_co_manager_permissions: editEverywhere(PROPERTY_ID, "applications"),
          },
        ],
      }) as never,
      { propertyId: PROPERTY_ID, ownerUserId: OWNER },
    );
    expect(hosts).toContain(CO_MANAGER);
  });

  it("excludes a co-manager with read-only calendar access — hosting commits time", async () => {
    const hosts = await listPropertyTourHostUserIds(
      fakeDb({
        links: [
          {
            invitee_user_id: READ_ONLY_CO_MANAGER,
            assigned_property_ids: [PROPERTY_ID],
            property_co_manager_permissions: { [PROPERTY_ID]: { calendar: { read: true } } },
          },
        ],
      }) as never,
      { propertyId: PROPERTY_ID, ownerUserId: OWNER },
    );
    expect(hosts).not.toContain(READ_ONLY_CO_MANAGER);
  });

  it("excludes a co-manager never assigned this property", async () => {
    const hosts = await listPropertyTourHostUserIds(
      fakeDb({
        links: [
          {
            invitee_user_id: UNASSIGNED_CO_MANAGER,
            assigned_property_ids: ["some-other-house"],
            property_co_manager_permissions: editEverywhere("some-other-house", "calendar"),
          },
        ],
      }) as never,
      { propertyId: PROPERTY_ID, ownerUserId: OWNER },
    );
    expect(hosts).not.toContain(UNASSIGNED_CO_MANAGER);
  });

  it("degrades to owner-only when the link table cannot be read, never widens on error", async () => {
    const hosts = await listPropertyTourHostUserIds(fakeDb({ linkError: true }) as never, {
      propertyId: PROPERTY_ID,
      ownerUserId: OWNER,
    });
    expect(hosts).toEqual([OWNER]);
  });

  it("returns only the owner when propertyId or ownerUserId is blank", async () => {
    expect(
      await listPropertyTourHostUserIds(fakeDb({}) as never, { propertyId: "", ownerUserId: OWNER }),
    ).toEqual([OWNER]);
    expect(
      await listPropertyTourHostUserIds(fakeDb({}) as never, { propertyId: PROPERTY_ID, ownerUserId: "" }),
    ).toEqual([]);
  });
});
