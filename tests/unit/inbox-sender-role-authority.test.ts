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

  /**
   * A PropLane Overall admin seated through `redeemAdminTeamInvite` holds the stored `admin` row and
   * NO manager row, so a plain manager-portal send is refused — correct, and
   * `AGENTS.md` § "Admin borrows" is why. Admin Communication therefore ASKS for the admin surface:
   * its compose posts through `adminOversightUrl` (`?oversight=admin`) and `resolveAdminOversight`
   * confirms the stored role, which arrives here as `isAdmin`. Without that ask the same account
   * stays refused, so the authority is the oversight request plus the role, never the role alone.
   */
  it("an admin-only account sends only when the request asked for oversight", async () => {
    const adminOnly = db(["admin"]) as never;
    expect(await resolveInboxSenderRoleForPortal(adminOnly, { userId: "user", legacyRole: null, portal: "manager", isAdmin: false })).toBeNull();
    expect(await resolveInboxSenderRoleForPortal(adminOnly, { userId: "user", legacyRole: null, portal: "manager", isAdmin: true })).toBe("admin");
  });
});
