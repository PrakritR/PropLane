import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthRole } from "@/components/auth/portal-switcher";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import {
  adminBlockedFromManagerPortal,
  isPortalRoleReachable,
  reachablePortalRoles,
  type PortalAccessContext,
} from "@/lib/auth/portal-access";

function ctx(roles: AuthRole[], email = "staff@prop-lane.space"): PortalAccessContext {
  return {
    user: { id: "user-1", email },
    profile: null,
    roles,
    effectiveRole: roles.length === 1 ? roles[0]! : null,
  };
}

describe("founder/admin cannot reach the property portal in production", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("live production (VERCEL_ENV=production)", () => {
    beforeEach(() => {
      process.env = { ...originalEnv, NODE_ENV: "production", VERCEL_ENV: "production" };
    });

    it("still blocks an admin-only identity from the manager/property portal", () => {
      const account = ctx(["admin"]);
      expect(adminBlockedFromManagerPortal(account)).toBe(true);
      // Switch/route authorization decision — must refuse manager.
      expect(isPortalRoleReachable(account, "manager")).toBe(false);
      // The portal switch + choose-portal chooser never offer the property portal.
      expect(reachablePortalRoles(account)).toEqual(["admin"]);
    });

    it("still blocks a non-primary admin who also holds the manager role — that role is self-grantable", () => {
      // An admin can hand themselves `manager` through the get-started
      // "Set up as a property manager" flow, so the role is not a grant the
      // production control may key on.
      const account = ctx(["admin", "manager"]);
      expect(adminBlockedFromManagerPortal(account)).toBe(true);
      expect(isPortalRoleReachable(account, "manager")).toBe(false);
      expect(reachablePortalRoles(account)).toEqual(["admin"]);
    });

    it("lets the primary admin reach both admin and property portals", () => {
      const account = ctx(["admin", "manager"], PRIMARY_ADMIN_EMAIL);
      expect(adminBlockedFromManagerPortal(account)).toBe(false);
      expect(isPortalRoleReachable(account, "manager")).toBe(true);
      expect(isPortalRoleReachable(account, "admin")).toBe(true);
      expect(reachablePortalRoles(account)).toEqual(["admin", "manager"]);
    });

    it("still lets a non-primary admin identity reach the admin portal", () => {
      const account = ctx(["admin", "manager"]);
      expect(isPortalRoleReachable(account, "admin")).toBe(true);
    });

    it("does not touch genuine manager accounts (no admin role)", () => {
      const account = ctx(["manager", "resident"]);
      expect(adminBlockedFromManagerPortal(account)).toBe(false);
      expect(isPortalRoleReachable(account, "manager")).toBe(true);
      expect(reachablePortalRoles(account)).toEqual(["manager", "resident"]);
    });
  });

  describe("non-production keeps the crossing available", () => {
    it("allows admin→manager on a Vercel preview deploy", () => {
      process.env = { ...originalEnv, NODE_ENV: "production", VERCEL_ENV: "preview" };
      const account = ctx(["admin", "manager"]);
      expect(adminBlockedFromManagerPortal(account)).toBe(false);
      expect(isPortalRoleReachable(account, "manager")).toBe(true);
      expect(reachablePortalRoles(account)).toEqual(["admin", "manager"]);
    });

    it("allows admin→manager on local/dev (no VERCEL_ENV)", () => {
      process.env = { ...originalEnv, NODE_ENV: "development", VERCEL_ENV: undefined };
      const account = ctx(["admin", "manager"]);
      expect(adminBlockedFromManagerPortal(account)).toBe(false);
      expect(isPortalRoleReachable(account, "manager")).toBe(true);
    });
  });
});
