/**
 * A role stamped before the row that justifies it must be reversible.
 *
 * Accepting a team invite stamps the manager role BEFORE the seat flips to `accepted`, so nothing downstream reads
 * the seat as resident-only. If that status update never lands, the invitee keeps a `profile_roles` manager row with
 * no accepted seat behind it - standing manager-portal access that nothing in the invite flow sweeps up, and which
 * `smsProvenSessionVerdict` then reads as manager-side for ever.
 */
import { describe, expect, it, vi } from "vitest";

import { createFakeDb } from "../helpers/fake-table-db";
import { stampProfileRoleRow } from "@/lib/auth/profile-role-row";

const USER = "u-1";

describe("stampProfileRoleRow", () => {
  it("adds the role, and the rollback removes exactly the row it added", async () => {
    const db = createFakeDb({ profile_roles: [] });
    const stamp = await stampProfileRoleRow(db as never, USER, "manager");
    expect(db.tables.profile_roles).toEqual([expect.objectContaining({ user_id: USER, role: "manager" })]);
    await stamp.rollback();
    expect(db.tables.profile_roles).toEqual([]);
  });

  it("never takes away a role the account already held", async () => {
    // The invitee was already a manager in their own right: someone else's failed write must not revoke them.
    const db = createFakeDb({ profile_roles: [{ user_id: USER, role: "manager" }, { user_id: USER, role: "resident" }] });
    const stamp = await stampProfileRoleRow(db as never, USER, "manager");
    await stamp.rollback();
    expect(db.tables.profile_roles).toHaveLength(2);
    expect(db.tables.profile_roles!.some((r) => r.role === "manager")).toBe(true);
  });

  it("rolls back only the stamped role, leaving the account's other roles alone", async () => {
    const db = createFakeDb({ profile_roles: [{ user_id: USER, role: "resident" }, { user_id: "u-2", role: "manager" }] });
    const stamp = await stampProfileRoleRow(db as never, USER, "manager");
    await stamp.rollback();
    expect(db.tables.profile_roles).toEqual([
      expect.objectContaining({ user_id: USER, role: "resident" }),
      expect.objectContaining({ user_id: "u-2", role: "manager" }),
    ]);
  });

  it("throws when it cannot tell whether the role was already there (no silent grant it cannot undo)", async () => {
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }) }),
      }),
    };
    await expect(stampProfileRoleRow(db as never, USER, "manager")).rejects.toMatchObject({ message: "boom" });
  });

  it("reports a rollback that fails rather than swallowing it", async () => {
    const db = createFakeDb({ profile_roles: [] }, {
      failWrite: (table, mode) => (table === "profile_roles" && mode === "delete" ? { message: "delete refused" } : null),
    });
    const stamp = await stampProfileRoleRow(db as never, USER, "manager");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await stamp.rollback();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
