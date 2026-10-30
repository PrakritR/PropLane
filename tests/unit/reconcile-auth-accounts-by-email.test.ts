import { describe, expect, it, vi, beforeEach } from "vitest";
const pendingRecovery = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock("@/lib/auth/account-recovery.server", () => ({ pendingAccountRecovery: pendingRecovery }));

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

  it("does nothing for an unconfirmed session", async () => {
    const { reconcileAuthAccountsByEmail } = await import("@/lib/auth/reconcile-auth-accounts-by-email");
    const db = mockDb({ profile: { role: "admin" } });
    await reconcileAuthAccountsByEmail(db as never, { id: "session-user", email: "admin@axis.test", email_confirmed_at: null } as never);
    expect(db.from).not.toHaveBeenCalled();
    expect(migratePortalUserId).not.toHaveBeenCalled();
  });

  it("does not grant roles from user-editable metadata or legacy profile role", async () => {
    const { reconcileAuthAccountsByEmail } = await import("@/lib/auth/reconcile-auth-accounts-by-email");
    const { ensureProfileRoleRow } = await import("@/lib/auth/profile-role-row");
    const db = mockDb({ profile: { role: "admin" } });
    await reconcileAuthAccountsByEmail(db as never, { id: "session-user", email: "person@example.com", email_confirmed_at: "2026-01-01", user_metadata: { role: "admin" }, identities: [] } as never);
    expect(ensureProfileRoleRow).not.toHaveBeenCalled();
  });

  it("does not migrate another auth user based on matching email", async () => {
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
      email_confirmed_at: "2026-01-01",
      identities: [{ provider: "google" }],
      user_metadata: {},
    } as never);

    expect(migratePortalUserId).not.toHaveBeenCalled();
  });

  it("does not claim orphan manager purchases by email", async () => {
    const { reconcileAuthAccountsByEmail } = await import("@/lib/auth/reconcile-auth-accounts-by-email");
    const db = mockDb({
      users: [{ id: "session-user", email: "mgr@test.com" }],
      purchases: [{ id: "purchase-1", user_id: null }],
      profile: { role: "manager" },
    });

    await reconcileAuthAccountsByEmail(db as never, {
      id: "session-user",
      email: "mgr@test.com",
      email_confirmed_at: "2026-01-01",
      identities: [],
      user_metadata: {},
    } as never);

    expect(db.purchaseUpdates).toEqual([]);
  });

  it("does not grant roles from a primary-admin email or legacy profile", async () => {
    const { reconcileAuthAccountsByEmail } = await import("@/lib/auth/reconcile-auth-accounts-by-email");
    const { ensureProfileRoleRow } = await import("@/lib/auth/profile-role-row");
    const db = mockDb({
      users: [{ id: "session-user", email: "admin@axis.test" }],
      profile: { role: "admin", full_name: "Founder" },
    });

    await reconcileAuthAccountsByEmail(db as never, {
      id: "session-user",
      email: "admin@axis.test",
      email_confirmed_at: "2026-01-01",
      identities: [],
      user_metadata: {},
    } as never);

    expect(ensureProfileRoleRow).not.toHaveBeenCalled();
  });
});
