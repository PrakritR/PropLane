/**
 * WS4(shared-avail): the set that can SEE a pending tour request (a
 * co-manager's calendar access) must match the set that can CLAIM it
 * (`eligibleHostUserIds`, checked by `confirmTourInquiry`). Both now derive
 * from the same roster (`listPropertyTourHostUserIds`), so a co-manager shown
 * "Approve & take it" can actually take it.
 */
import { describe, expect, it } from "vitest";
import { resolveEligibleTourHostUserIds } from "@/lib/tour-inquiry-create.server";
import { listPropertyTourHostUserIds } from "@/lib/tour-host-enumeration.server";

const PROPERTY_ID = "mgr-demo-eligible";
const OWNER = "mgr-owner-eligible";
const CO_MANAGER = "mgr-co-eligible";
const STRANGER = "mgr-stranger-eligible";
const SLOT_KEY = "2099-08-06:20";

function fakeDb(opts: { coManagerPublishedSlot?: boolean } = {}) {
  return {
    from(table: string) {
      if (table === "manager_property_records") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { manager_user_id: OWNER, status: "live" },
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
              eq: async () => ({
                data: [
                  {
                    invitee_user_id: CO_MANAGER,
                    assigned_property_ids: [PROPERTY_ID],
                    property_co_manager_permissions: {
                      [PROPERTY_ID]: { calendar: { read: true, edit: true } },
                    },
                  },
                ],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "portal_schedule_records") {
        return {
          select: () => ({
            eq: (_col: string, managerUserId: string) => ({
              in: async () => ({
                data:
                  managerUserId === OWNER || (managerUserId === CO_MANAGER && opts.coManagerPublishedSlot !== false)
                    ? [
                        {
                          property_id: PROPERTY_ID,
                          record_type: "manager_property_availability",
                          row_data: { payload: [SLOT_KEY] },
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

describe("resolveEligibleTourHostUserIds", () => {
  it("includes the filed host plus every roster host who published the slot", async () => {
    const eligible = await resolveEligibleTourHostUserIds(fakeDb() as never, {
      filedHost: OWNER,
      propertyId: PROPERTY_ID,
      slotKey: SLOT_KEY,
      clientCandidateHostUserIds: [],
    });
    expect(new Set(eligible)).toEqual(new Set([OWNER, CO_MANAGER]));
  });

  it("never trusts a client-supplied id that is not actually a host", async () => {
    const eligible = await resolveEligibleTourHostUserIds(fakeDb() as never, {
      filedHost: OWNER,
      propertyId: PROPERTY_ID,
      slotKey: SLOT_KEY,
      clientCandidateHostUserIds: [STRANGER],
    });
    expect(eligible).not.toContain(STRANGER);
  });

  it("excludes a roster host who never published this slot", async () => {
    const eligible = await resolveEligibleTourHostUserIds(fakeDb({ coManagerPublishedSlot: false }) as never, {
      filedHost: OWNER,
      propertyId: PROPERTY_ID,
      slotKey: SLOT_KEY,
      clientCandidateHostUserIds: [],
    });
    expect(eligible).not.toContain(CO_MANAGER);
  });

  it("see == claim: matches exactly the host roster listOpenTourSlots would offer", async () => {
    const roster = await listPropertyTourHostUserIds(fakeDb() as never, {
      propertyId: PROPERTY_ID,
      ownerUserId: OWNER,
    });
    const eligible = await resolveEligibleTourHostUserIds(fakeDb() as never, {
      filedHost: OWNER,
      propertyId: PROPERTY_ID,
      slotKey: SLOT_KEY,
      clientCandidateHostUserIds: [],
    });
    // Everyone who could see this pending request via the roster (and had the
    // slot open, as everyone here does) must also be able to claim it.
    expect(new Set(eligible)).toEqual(new Set(roster));
  });
});
