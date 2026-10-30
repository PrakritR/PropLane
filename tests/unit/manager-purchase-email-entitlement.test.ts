import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

vi.mock("@/lib/auth/account-recovery.server", () => ({
  recoverySetupRedirect: vi.fn(async () => null),
  pendingAccountRecovery: vi.fn(async () => false),
}));
vi.mock("@/lib/auth/primary-admin", () => ({ isPrimaryAdminEmail: vi.fn(() => false) }));
vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: vi.fn(async () => undefined) }));
vi.mock("@/lib/property-owner/access.server", () => ({
  ownerAccessStateFor: vi.fn(async () => ({ hasOwnerAccess: false, ownerOnly: false, messagesOn: false })),
}));
vi.mock("@/lib/auth/complete-resident-signup-oauth", () => ({
  completeResidentSignupFromOAuth: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/auth/manager-google-services-onboarding.server", () => ({
  resolveManagerPortalEntryPath: vi.fn(async () => "/portal/dashboard"),
  markGoogleServicesOnboardingPending: vi.fn(async () => undefined),
}));
vi.mock("@/lib/resident-portal-access", () => ({
  loadResidentPortalAccessState: vi.fn(async () => ({})),
  residentPortalHomePath: vi.fn(() => "/resident/my-home"),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/manager-landlord-profile", () => ({
  ensureSandboxManagerLandlordProfile: vi.fn(async () => undefined),
}));

const OWNER = "11111111-2222-4333-8444-555555555555";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EMAIL = "legacy@example.test";

type Purchase = {
  id: string;
  email: string;
  manager_id: string;
  tier: string | null;
  billing: string | null;
  stripe_checkout_session_id: string;
  user_id: string | null;
  full_name: string | null;
  paid_at: string | null;
};

const completeRow = (over: Partial<Purchase> = {}): Purchase => ({
  id: "legacy-row",
  email: EMAIL,
  manager_id: "AXIS-900",
  tier: "free",
  billing: "monthly",
  stripe_checkout_session_id: "axis_intent_legacy",
  user_id: null,
  full_name: "Legacy Owner",
  paid_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

/** `manager_purchases` query stub: records every filter, and answers from the rows it is given. */
function purchaseQuery(rows: Purchase[]) {
  const filters: Array<[string, unknown]> = [];
  const matches = () =>
    rows.filter((row) => filters.every(([col, val]) => (row as unknown as Record<string, unknown>)[col] === val));
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return chain;
    },
    is: (col: string, val: unknown) => {
      filters.push([col, val]);
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
    then: (resolve: (value: { data: Purchase[]; error: null }) => unknown) =>
      Promise.resolve({ data: matches(), error: null }).then(resolve),
  };
  return { chain, filters };
}

function mockDb(rows: Purchase[]) {
  const upserts: Array<Record<string, unknown>> = [];
  const purchaseFilters: Array<Array<[string, unknown]>> = [];
  const db = {
    from: (table: string) => {
      if (table === "profile_roles") {
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      }
      if (table === "profiles") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          upsert: async (row: Record<string, unknown>) => {
            upserts.push(row);
            return { error: null };
          },
        };
      }
      if (table === "manager_purchases") {
        const query = purchaseQuery(rows);
        purchaseFilters.push(query.filters);
        return query.chain;
      }
      if (table === "manager_application_records") {
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { db, upserts, purchaseFilters };
}

const sessionUser = (confirmed: boolean): User =>
  ({ id: OWNER, email: EMAIL, email_confirmed_at: confirmed ? "2026-01-01T00:00:00.000Z" : null }) as User;

describe("a legacy email-matched manager purchase is an entitlement, not ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("still grants the manager role and workspace to the confirmed matching mailbox", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");
    const { ensureProfileRoleRow } = await import("@/lib/auth/profile-role-row");
    const { db, upserts } = mockDb([completeRow()]);

    const path = await resolveOAuthPortalRedirect(db as never, sessionUser(true), "/auth/continue");

    expect(ensureProfileRoleRow).toHaveBeenCalledWith(db, OWNER, "manager");
    expect(upserts[0]).toMatchObject({ id: OWNER, manager_id: "AXIS-900" });
    expect(path).toBe("/portal/dashboard");
  });

  it("grants nothing when Auth has not confirmed the account's mailbox", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");
    const { ensureProfileRoleRow } = await import("@/lib/auth/profile-role-row");
    const { db, upserts, purchaseFilters } = mockDb([completeRow()]);

    const path = await resolveOAuthPortalRedirect(db as never, sessionUser(false), "/auth/continue");

    expect(ensureProfileRoleRow).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
    expect(path).toBe("/auth/get-started");
    expect(purchaseFilters.flat()).not.toContainEqual(["email", EMAIL]);
  });

  it("never adopts a same-email row another account already claimed", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");
    const { ensureProfileRoleRow } = await import("@/lib/auth/profile-role-row");
    const { db, upserts } = mockDb([completeRow({ user_id: OTHER })]);

    const path = await resolveOAuthPortalRedirect(db as never, sessionUser(true), "/auth/continue");

    expect(ensureProfileRoleRow).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
    expect(path).toBe("/auth/get-started");
  });
});

describe("findManagerPurchaseForAccount", () => {
  it("reads only unclaimed rows in the by-email half", async () => {
    const { findManagerPurchaseForAccount } = await import("@/lib/auth/manager-onboarding");
    const { db, purchaseFilters } = mockDb([completeRow({ user_id: OTHER })]);

    expect(await findManagerPurchaseForAccount(db as never, OWNER, EMAIL, { emailVerified: true })).toBeNull();
    expect(purchaseFilters[1]).toContainEqual(["user_id", null]);
  });

  it("skips the by-email half entirely for an unproven mailbox", async () => {
    const { findManagerPurchaseForAccount } = await import("@/lib/auth/manager-onboarding");
    const { db, purchaseFilters } = mockDb([completeRow()]);

    expect(await findManagerPurchaseForAccount(db as never, OWNER, EMAIL, { emailVerified: false })).toBeNull();
    expect(purchaseFilters).toHaveLength(1);
  });

  it("still returns the account's own row when its mailbox is unproven", async () => {
    const { findManagerPurchaseForAccount } = await import("@/lib/auth/manager-onboarding");
    const { db } = mockDb([completeRow({ id: "mine", user_id: OWNER })]);

    const purchase = await findManagerPurchaseForAccount(db as never, OWNER, EMAIL, { emailVerified: false });
    expect(purchase?.id).toBe("mine");
  });

  it("grants nothing when the purchase read fails", async () => {
    const { findManagerPurchaseForAccount } = await import("@/lib/auth/manager-onboarding");
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: null, error: { message: "read failed" } }),
    };

    expect(
      await findManagerPurchaseForAccount({ from: () => chain } as never, OWNER, EMAIL, { emailVerified: true }),
    ).toBeNull();
  });
});
