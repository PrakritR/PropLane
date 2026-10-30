import { describe, expect, it } from "vitest";
import { resolveInboxSenderRoleForPortal } from "@/lib/inbox-portal-sender";
const db = (roles: string[], error: unknown = null) => ({ from: () => ({ select: () => ({ eq: async () => ({ data: roles.map(role => ({ role })), error }) }) }) });
describe("inbox sender authority", () => {
  it("does not grant manager, vendor or admin from a legacy role", async () => {
    for (const legacyRole of ["manager", "vendor", "admin"]) expect(await resolveInboxSenderRoleForPortal(db([]) as never, { userId: "user", legacyRole, portal: "manager", isAdmin: false })).toBeNull();
  });
  it("uses the selected held role and fails closed on read errors", async () => {
    expect(await resolveInboxSenderRoleForPortal(db(["manager", "resident"]) as never, { userId: "user", legacyRole: "manager", portal: "resident", isAdmin: false })).toBe("resident");
    expect(await resolveInboxSenderRoleForPortal(db(["manager"], { message: "unavailable" }) as never, { userId: "user", legacyRole: "manager", portal: "manager", isAdmin: false })).toBeNull();
  });
});
