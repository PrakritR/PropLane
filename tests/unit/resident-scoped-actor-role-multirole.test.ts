/**
 * `resolveResidentScopedActorRole` is the one answer the dual-audience routes (`/api/portal-work-orders`,
 * `/api/portal-service-requests`, `/api/portal-lease-pipeline`, `/api/portal/resident-approval`) use to
 * decide which scope a request is exercising. Every one of them 403s on "denied".
 *
 * Reading roles from stored `profile_roles` alone is the point of this release. But narrowing on the
 * ACTIVE PORTAL as well had turned the absence of an `axis_active_portal` cookie into a denial for a
 * multi-role account, and denied an admin+manager outright — against `AGENTS.md` § "Admin borrows":
 * outside explicit `?oversight=admin` "a platform admin reads and writes as the manager they are."
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ portalContext: vi.fn() }));

vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: mocks.portalContext }));

import { resolveResidentScopedActorRole } from "@/lib/auth/resident-role-access";

const USER = "user-1";

function db(roles: string[] | { error: string }) {
  return {
    from: () => ({
      select: () => ({
        eq: async () =>
          Array.isArray(roles)
            ? { data: roles.map((role) => ({ role })), error: null }
            : { data: null, error: { message: roles.error } },
      }),
    }),
  };
}

const resolve = (roles: string[] | { error: string }) =>
  resolveResidentScopedActorRole(db(roles) as never, { userId: USER, legacyRole: null });

/** The active portal, as `getPortalAccessContext` reports it. `null` = no usable cookie. */
function acting(effectiveRole: string | null, roles: string[], userId = USER) {
  mocks.portalContext.mockResolvedValue({ user: { id: userId }, profile: null, roles, effectiveRole });
}

beforeEach(() => {
  mocks.portalContext.mockReset();
  acting(null, []);
});

describe("a single stored role", () => {
  it.each([
    ["resident", "resident"],
    ["manager", "manager"],
  ])("%s resolves to its own scope", async (role, expected) => {
    await expect(resolve([role])).resolves.toBe(expected);
  });

  it.each([["vendor"], ["admin"]])("%s-only is denied: these routes have no scope for it", async (role) => {
    await expect(resolve([role])).resolves.toBe("denied");
  });

  it("an account with no stored role at all is denied", async () => {
    await expect(resolve([])).resolves.toBe("denied");
  });

  it("an unreadable role list is denied", async () => {
    await expect(resolve({ error: "unavailable" })).resolves.toBe("denied");
  });
});

describe("a multi-role account", () => {
  it("acting as the resident reads as the resident", async () => {
    acting("resident", ["manager", "resident"]);
    await expect(resolve(["manager", "resident"])).resolves.toBe("resident");
  });

  it("acting as the manager reads as the manager", async () => {
    acting("manager", ["manager", "resident"]);
    await expect(resolve(["manager", "resident"])).resolves.toBe("manager");
  });

  it("with NO active-portal cookie reads as the manager it stores, not denied", async () => {
    acting(null, ["manager", "resident"]);
    await expect(resolve(["manager", "resident"])).resolves.toBe("manager");
  });

  it("an admin+manager reads as the manager they are, in either portal", async () => {
    for (const active of ["admin", null, "manager"] as const) {
      acting(active, ["admin", "manager"]);
      await expect(resolve(["admin", "manager"])).resolves.toBe("manager");
    }
  });

  it("an admin+resident acting as admin still reads as the resident it stores", async () => {
    acting("admin", ["admin", "resident"]);
    await expect(resolve(["admin", "resident"])).resolves.toBe("resident");
  });

  it("an admin+vendor is denied: it stores neither resident nor manager", async () => {
    acting("admin", ["admin", "vendor"]);
    await expect(resolve(["admin", "vendor"])).resolves.toBe("denied");
  });

  it("never invents a role the account does not store", async () => {
    acting("manager", ["manager"]);
    await expect(resolve(["resident", "vendor"])).resolves.toBe("resident");
  });
});

/**
 * Widening to the manager scope is a decision, and a decision needs a context this request can
 * trust. A read that failed, a phone-gate `redirect()` thrown out of `getPortalAccessContext` and
 * swallowed by the same catch, a context for someone else's session, or a context whose own role
 * list disagrees with the stored roles are all absence of evidence — they must narrow, never widen.
 */
describe("an untrustworthy portal context fails closed", () => {
  it("narrows to resident when the context read throws", async () => {
    mocks.portalContext.mockRejectedValue(new Error("no request scope"));
    await expect(resolve(["manager", "resident"])).resolves.toBe("resident");
  });

  it("narrows to resident when the context is the phone-gate redirect", async () => {
    // `redirect()` throws NEXT_REDIRECT; this call site cannot act on it, only decline to widen.
    mocks.portalContext.mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/auth/verify-phone;307;" }));
    await expect(resolve(["manager", "resident"])).resolves.toBe("resident");
  });

  it("narrows to resident when the context belongs to another session", async () => {
    acting("manager", ["manager", "resident"], "someone-else");
    await expect(resolve(["manager", "resident"])).resolves.toBe("resident");
  });

  it("narrows to resident when the context's own roles disagree with the stored roles", async () => {
    acting("manager", ["manager"]);
    await expect(resolve(["manager", "resident"])).resolves.toBe("resident");
  });

  it("denies a manager-only account rather than widening on an unreadable context", async () => {
    mocks.portalContext.mockRejectedValue(new Error("no request scope"));
    // Two stored roles, neither of them resident: there is no narrower scope to fall back to.
    await expect(resolve(["manager", "admin"])).resolves.toBe("denied");
  });

  it("still denies an account that stores neither resident nor manager", async () => {
    mocks.portalContext.mockRejectedValue(new Error("no request scope"));
    await expect(resolve(["admin", "vendor"])).resolves.toBe("denied");
  });
});
