/**
 * The resident-role check went from PERMISSIVE-ON-ABSENT to FAIL-CLOSED.
 *
 * Before: `loadResidentPortalAccessStateCached` used
 * `roleOk = !role || role === "resident"`, and `/api/resident/extend-lease` and
 * `/api/resident/check-move-out-availability` used
 * `if (role && role !== "resident") 403` — every one of them ADMITTED an account
 * whose legacy `profiles.role` is null or blank. Now `authorizeResidentRole` is
 * the single predicate for all of them, and an absent legacy role no longer
 * admits anyone by itself.
 *
 * Failing closed is right, but the cost of getting it wrong is asymmetric: a
 * resident locked out of their own lease and payments is worse than a slightly
 * wider check. So the load-bearing property is the FALLTHROUGH — an account
 * whose legacy role is null/blank but which holds the resident role in
 * `profile_roles` must still be admitted. This file pins that in both places it
 * matters: the shared predicate, and one of the named routes end to end.
 *
 * Measured against the production project (`prop-lane production`) on
 * 2026-08-03, replaying both predicates over all 28 accounts: 5 are newly
 * refused and ZERO of them have any resident data — all 5 are `auth.users` rows
 * with no `profiles` row, no `profile_roles` rows, and no application, lease, or
 * charge. 2 accounts are newly ADMITTED (the manager+resident multi-role fix), so
 * for real residents the change is net-widening. No resident was locked out.
 *
 * Sibling coverage: `resident-portal-access.test.ts` (the resolver / nav stage)
 * and `resident-role-authorization-surface.test.ts` (the static drift guard that
 * stops a route hand-rolling the legacy read again).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();

/** Legacy `profiles.role`. `undefined` models an account with no profiles row. */
let LEGACY_ROLE: string | null | undefined = null;
/** Roles held in `profile_roles` — the multi-role source of truth. */
let PROFILE_ROLES: string[] = [];
/** Every `profile_roles` read the predicate issued, to pin the hot path. */
let PROFILE_ROLES_READS = 0;

function serviceDb() {
  return {
    from: (table: string) => {
      if (table === "profile_roles") {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col: string, value: string) => ({
                maybeSingle: async () => {
                  PROFILE_ROLES_READS += 1;
                  return {
                    data: PROFILE_ROLES.includes(value) ? { role: value } : null,
                    error: null,
                  };
                },
              }),
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  LEGACY_ROLE === undefined
                    ? null // no profiles row at all
                    : { email: "resident@example.com", role: LEGACY_ROLE },
                error: null,
              }),
            }),
          }),
        };
      }
      // Lease pipeline: no signed lease, so the route stops right after the
      // role gate. Reaching that point IS the proof the gate let the caller in.
      return {
        select: () => ({
          eq: () => ({ order: async () => ({ data: [], error: null }) }),
        }),
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => serviceDb(),
}));

import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { POST as extendLease } from "@/app/api/resident/extend-lease/route";

const USER_ID = "user-resident-1";

beforeEach(() => {
  vi.clearAllMocks();
  LEGACY_ROLE = null;
  PROFILE_ROLES = [];
  PROFILE_ROLES_READS = 0;
  getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: "resident@example.com" } } });
});

function authorize(legacyRole: string | null | undefined) {
  return authorizeResidentRole(serviceDb() as never, { userId: USER_ID, legacyRole });
}

describe("authorizeResidentRole — an absent legacy role falls through to profile_roles", () => {
  /** The whole point of the requirement: absent legacy role must not lock out. */
  it.each([
    ["null", null],
    ["undefined (no profiles row)", undefined],
    ["empty string", ""],
    ["whitespace", "   "],
  ])("admits a resident whose legacy role is %s but who holds the resident role", async (_label, legacy) => {
    PROFILE_ROLES = ["resident"];

    await expect(authorize(legacy)).resolves.toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined (no profiles row)", undefined],
    ["empty string", ""],
  ])("still refuses an account whose legacy role is %s and holds no resident role", async (_label, legacy) => {
    PROFILE_ROLES = [];

    await expect(authorize(legacy)).resolves.toBe(false);
  });

  it("refuses a genuine non-resident whose only role is manager", async () => {
    PROFILE_ROLES = ["manager"];

    await expect(authorize("manager")).resolves.toBe(false);
    await expect(authorize(null)).resolves.toBe(false);
  });

  it("admits a manager+resident, whose legacy role reads manager forever", async () => {
    PROFILE_ROLES = ["manager", "resident"];

    await expect(authorize("manager")).resolves.toBe(true);
  });

  it("denies a legacy resident without a stored role", async () => {
    PROFILE_ROLES = [];
    await expect(authorize("resident")).resolves.toBe(false);
  });

  it("checks the stored role even for a legacy resident", async () => {
    PROFILE_ROLES = ["resident"];
    await expect(authorize("resident")).resolves.toBe(true);
    expect(PROFILE_ROLES_READS).toBe(1);
  });

  it("denies a legacy resident when the stored-role read fails", async () => {
    const failedDb = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "unavailable" } }) }) }) }) }) };
    await expect(authorizeResidentRole(failedDb as never, { userId: USER_ID, legacyRole: "resident" })).resolves.toBe(false);
  });

  it("refuses rather than guesses when there is no user id to look up", async () => {
    PROFILE_ROLES = ["resident"];

    await expect(
      authorizeResidentRole(serviceDb() as never, { userId: null, legacyRole: null }),
    ).resolves.toBe(false);
  });
});

/**
 * `/api/resident/extend-lease` is one of the two routes the review named. It
 * used to admit a blank legacy role outright (`if (role && role !== "resident")`).
 * A 403 here is a resident who cannot extend their own lease, so the blank-legacy
 * fallthrough has to hold at the route, not only in the predicate.
 */
describe("POST /api/resident/extend-lease — the blank-legacy resident still gets in", () => {
  function post() {
    return extendLease(
      jsonRequest("http://localhost/api/resident/extend-lease", {
        method: "POST",
        body: { newLeaseEnd: "2027-01-31" },
      }) as never,
    );
  }

  it("does not 403 an account with a blank legacy role that holds the resident role", async () => {
    LEGACY_ROLE = "";
    PROFILE_ROLES = ["resident"];

    const res = await post();

    // Past the role gate: the route now fails on the ABSENT LEASE, not the role.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No fully-signed lease found." });
  });

  it("does not 403 an account with NO profiles row that holds the resident role", async () => {
    LEGACY_ROLE = undefined;
    PROFILE_ROLES = ["resident"];

    const res = await post();

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });

  it("still 403s an account with a blank legacy role and no resident role", async () => {
    LEGACY_ROLE = "";
    PROFILE_ROLES = [];

    const res = await post();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Residents only." });
  });

  it("still 403s a manager who holds no resident role", async () => {
    LEGACY_ROLE = "manager";
    PROFILE_ROLES = ["manager"];

    const res = await post();

    expect(res.status).toBe(403);
  });

  it("admits a manager+resident acting as a resident", async () => {
    LEGACY_ROLE = "manager";
    PROFILE_ROLES = ["manager", "resident"];

    const res = await post();

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });
});
