/**
 * The `manager` role is one row per ACCOUNT, so a rollback may only revoke it when nothing else justifies it.
 *
 * Accepting a team invite stamps the role before the seat flips to `accepted`. If that flip fails the stamp is undone -
 * but the same account may hold another accepted seat (a second workspace, or a parallel accept of this very invite),
 * and revoking the role then silently takes manager-portal access away from a live teammate and makes
 * `smsProvenSessionVerdict` read them as resident-only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createFakeDb } from "../helpers/fake-table-db";
import { holdsAcceptedManagerSeat } from "@/lib/auth/team-seat-manager-role.server";
import { stampProfileRoleRow } from "@/lib/auth/profile-role-row";

const USER = "u-invitee";

const seat = (over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  invitee_user_id: USER,
  status: "accepted",
  team_role: "property_manager",
  assigned_property_ids: ["p-1"],
  property_co_manager_permissions: null,
  co_manager_permissions: null,
  house_scope: "all",
  ...over,
});

describe("holdsAcceptedManagerSeat", () => {
  it("is true for an accepted non-owner seat and false with none", async () => {
    expect(await holdsAcceptedManagerSeat(createFakeDb({ account_link_invites: [seat()] }) as never, USER)).toBe(true);
    expect(await holdsAcceptedManagerSeat(createFakeDb({ account_link_invites: [] }) as never, USER)).toBe(false);
  });

  it("ignores a pending seat, another account's seat, and a property_owner seat", async () => {
    const pending = createFakeDb({ account_link_invites: [seat({ status: "pending" })] });
    expect(await holdsAcceptedManagerSeat(pending as never, USER)).toBe(false);
    const other = createFakeDb({ account_link_invites: [seat({ invitee_user_id: "someone-else" })] });
    expect(await holdsAcceptedManagerSeat(other as never, USER)).toBe(false);
    // A property owner is a team role, not a portal: it never justifies the manager role.
    const ownerSeat = createFakeDb({ account_link_invites: [seat({ team_role: "property_owner" })] });
    expect(await holdsAcceptedManagerSeat(ownerSeat as never, USER)).toBe(false);
  });

  it("sees the OTHER accepted seat, which is the one a single-invite check misses", async () => {
    const db = createFakeDb({
      account_link_invites: [seat({ id: "inv-a" }), seat({ id: "inv-b", status: "pending" })],
    });
    expect(await holdsAcceptedManagerSeat(db as never, USER)).toBe(true);
  });

  it("fails safe: an unreadable answer keeps the role", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) }) };
    expect(await holdsAcceptedManagerSeat(broken as never, USER)).toBe(true);
    expect(await holdsAcceptedManagerSeat(createFakeDb({}) as never, "   ")).toBe(true);
  });
});

describe("the two halves together", () => {
  it("the parallel accept that lost keeps the role the accepted seat needs", async () => {
    // Both requests stamp; only one insert actually adds the row, and the loser's rollback is gated on the seat
    // question, not on its own invite's status.
    const db = createFakeDb({ profile_roles: [], account_link_invites: [seat({ id: "inv-a" })] });
    const first = await stampProfileRoleRow(db as never, USER, "manager");
    const second = await stampProfileRoleRow(db as never, USER, "manager");
    expect(db.tables.profile_roles).toHaveLength(1);

    for (const stamp of [first, second]) {
      if (await holdsAcceptedManagerSeat(db as never, USER)) continue;
      await stamp.rollback();
    }
    expect(db.tables.profile_roles).toHaveLength(1);
  });

  it("with no seat at all the stamp is undone, so no standing grant is left behind", async () => {
    const db = createFakeDb({ profile_roles: [], account_link_invites: [] });
    const stamp = await stampProfileRoleRow(db as never, USER, "manager");
    if (!(await holdsAcceptedManagerSeat(db as never, USER))) await stamp.rollback();
    expect(db.tables.profile_roles).toEqual([]);
  });
});
