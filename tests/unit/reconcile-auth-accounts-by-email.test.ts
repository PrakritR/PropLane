import { describe, expect, it, vi, beforeEach } from "vitest";

const { migratePortalUserId } = vi.hoisted(() => ({
  migratePortalUserId: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/migrate-portal-user-id", () => ({
  migratePortalUserId,
}));

vi.mock("@/lib/auth/profile-role-row", () => ({
  ensureProfileRoleRow: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/primary-admin", () => ({
  isPrimaryAdminEmail: vi.fn((email: string) => email === "admin@axis.test"),
}));

function mockDb(options: {
  users?: Array<{ id: string; email?: string; identities?: Array<{ provider: string }> }>;
  profile?: Record<string, unknown> | null;
  purchases?: Array<{ id: string; user_id: string | null }>;
}) {
  const updateUserById = vi.fn(async () => ({ data: {}, error: null }));
  const purchaseUpdates: unknown[] = [];

  const from = vi.fn((table: string) => {
    if (table === "profiles") {
      return {
        select: () => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: vi.fn(async () => ({
              data: val === "session-user" ? options.profile ?? null : null,
            })),
          }),
        }),
        update: (patch: unknown) => ({
          eq: () => ({ error: null, patch }),
        }),
        upsert: vi.fn(async () => ({ error: null })),
      };
    }
    if (table === "manager_purchases") {
      return {
        select: () => ({
          eq: () => ({
            is: () => ({
              data: options.purchases ?? [],
              error: null,
            }),
          }),
        }),
        update: (patch: unknown) => ({
          eq: (_col: string, id: string) => {
            purchaseUpdates.push({ id, patch });
            return { error: null };
          },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return {
    from,
    auth: {
      admin: {
        listUsers: vi.fn(async () => ({ data: { users: options.users ?? [] }, error: null })),
        updateUserById,
      },
    },
    purchaseUpdates,
  };
}

describe("findAuthUsersByEmail", () => {
  it("returns all auth users with the same normalized email", async () => {
    const { findAuthUsersByEmail } = await import("@/lib/auth/reconcile-auth-accounts-by-email");
    const db = mockDb({
      users: [
        { id: "a", email: "User@Test.com" },
        { id: "b", email: "user@test.com" },
        { id: "c", email: "other@test.com" },
      ],
    });

    const matches = await findAuthUsersByEmail(db as never, "user@test.com");
    expect(matches.map((u) => u.id).sort()).toEqual(["a", "b"]);
  });
});

describe("reconcileAuthAccountsByEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("migrates portal data from duplicate auth users into the session user", async () => {
    const { reconcileAuthAccountsByEmail } = await import("@/lib/auth/reconcile-auth-accounts-by-email");
    const db = mockDb({
      users: [
        { id: "session-user", email: "mgr@test.com", identities: [{ provider: "google" }] },
        { id: "email-user", email: "mgr@test.com", identities: [{ provider: "email" }] },
      ],
      profile: { role: "manager" },
    });

    await reconcileAuthAccountsByEmail(db as never, {
      id: "session-user",
      email: "mgr@test.com",
      identities: [{ provider: "google" }],
      user_metadata: {},
    } as never);

    expect(migratePortalUserId).toHaveBeenCalledWith(db, "email-user", "session-user");
  });

  it("links orphan manager purchases by email", async () => {
    const { reconcileAuthAccountsByEmail } = await import("@/lib/auth/reconcile-auth-accounts-by-email");
    const db = mockDb({
      users: [{ id: "session-user", email: "mgr@test.com" }],
      purchases: [{ id: "purchase-1", user_id: null }],
      profile: { role: "manager" },
    });

    await reconcileAuthAccountsByEmail(db as never, {
      id: "session-user",
      email: "mgr@test.com",
      identities: [],
      user_metadata: {},
    } as never);

    expect(db.purchaseUpdates).toEqual([{ id: "purchase-1", patch: { user_id: "session-user" } }]);
  });

  it("ensures manager role for an existing primary-admin profile on reconcile", async () => {
    const { reconcileAuthAccountsByEmail } = await import("@/lib/auth/reconcile-auth-accounts-by-email");
    const { ensureProfileRoleRow } = await import("@/lib/auth/profile-role-row");
    const db = mockDb({
      users: [{ id: "session-user", email: "admin@axis.test" }],
      profile: { role: "admin", full_name: "Founder" },
    });

    await reconcileAuthAccountsByEmail(db as never, {
      id: "session-user",
      email: "admin@axis.test",
      identities: [],
      user_metadata: {},
    } as never);

    expect(ensureProfileRoleRow).toHaveBeenCalledWith(db, "session-user", "admin");
    expect(ensureProfileRoleRow).toHaveBeenCalledWith(db, "session-user", "manager");
  });
});
