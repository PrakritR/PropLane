/**
 * Manager assistant-email identity, the mail twin of `manager-sms-access`.
 *
 * Every manager gets their own work email, co-manager or not, and it must carry the same
 * scope their own work number does: their own houses PLUS the houses they co-manage for
 * someone else. The two channels deliberately share `resolveManagerSmsAccess` so a scope
 * decision can never drift between texting and emailing the assistant — these cases pin the
 * email side of that contract, which had none.
 */
import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { resolveManagerEmailInboundIdentity } from "@/lib/manager-assistant-email/manager-email-access.server";

const OWNER = "owner-1";
const CO = "co-1";
const STRANGER = "stranger-1";
const ASSIGNED = "prop-assigned";

function seed() {
  return createMemoryDb({
    profiles: [
      { id: OWNER, email: "owner@axis.test" },
      { id: CO, email: "co@axis.test" },
      { id: STRANGER, email: "stranger@axis.test" },
    ],
    account_link_invites: [
      {
        id: "link-1",
        status: "accepted",
        inviter_user_id: OWNER,
        invitee_user_id: CO,
        assigned_property_ids: [ASSIGNED],
      },
    ],
  }) as never;
}

describe("resolveManagerEmailInboundIdentity", () => {
  it("gives a co-manager writing to their OWN assistant email their own houses plus the co-managed ones", async () => {
    const identity = await resolveManagerEmailInboundIdentity(seed(), {
      workNumberOwnerId: CO,
      fromEmail: "co@axis.test",
    });

    expect(identity?.actorUserId).toBe(CO);
    expect(identity?.access.mode).toBe("combined");
    expect(identity?.access.dataOwnerIds).toEqual(expect.arrayContaining([CO, OWNER]));
    expect(identity?.access.assignedPropertyIds).toEqual([ASSIGNED]);
  });

  it("scopes a co-manager writing to the OWNER's assistant email to the assigned houses only", async () => {
    const identity = await resolveManagerEmailInboundIdentity(seed(), {
      workNumberOwnerId: OWNER,
      fromEmail: "co@axis.test",
    });

    expect(identity?.actorUserId).toBe(CO);
    expect(identity?.access.mode).toBe("delegated");
    // The co-manager's own houses stay out: this is the owner's mailbox.
    expect(identity?.access.dataOwnerIds).toEqual([OWNER]);
    expect(identity?.access.assignedPropertyIds).toEqual([ASSIGNED]);
  });

  it("treats the owner's own address as an unrestricted owner turn", async () => {
    const identity = await resolveManagerEmailInboundIdentity(seed(), {
      workNumberOwnerId: OWNER,
      fromEmail: "OWNER@Axis.TEST",
    });

    expect(identity?.actorUserId).toBe(OWNER);
    expect(identity?.access.mode).toBe("owner");
  });

  it("refuses a manager who is not an invitee of this mailbox owner", async () => {
    expect(
      await resolveManagerEmailInboundIdentity(seed(), {
        workNumberOwnerId: OWNER,
        fromEmail: "stranger@axis.test",
      }),
    ).toBeNull();
  });

  it("refuses an unknown sender rather than falling back to the mailbox owner", async () => {
    expect(
      await resolveManagerEmailInboundIdentity(seed(), {
        workNumberOwnerId: OWNER,
        fromEmail: "nobody@axis.test",
      }),
    ).toBeNull();
  });

  it("fails closed when two invitees share one address", async () => {
    const db = createMemoryDb({
      profiles: [
        { id: OWNER, email: "owner@axis.test" },
        { id: CO, email: "shared@axis.test" },
        { id: "co-2", email: "shared@axis.test" },
      ],
      account_link_invites: [
        { id: "l1", status: "accepted", inviter_user_id: OWNER, invitee_user_id: CO, assigned_property_ids: [ASSIGNED] },
        { id: "l2", status: "accepted", inviter_user_id: OWNER, invitee_user_id: "co-2", assigned_property_ids: [ASSIGNED] },
      ],
    }) as never;

    expect(
      await resolveManagerEmailInboundIdentity(db, {
        workNumberOwnerId: OWNER,
        fromEmail: "shared@axis.test",
      }),
    ).toBeNull();
  });
});
