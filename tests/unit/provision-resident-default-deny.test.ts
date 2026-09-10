import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/account-recovery.server", () => ({ pendingAccountRecovery: vi.fn(async () => null), recoverySetupRedirect: vi.fn(async () => null) }));

// Keep the auth-user lookup / role-row writes inert so the test exercises only
// the inheritance decision. Returning the same id avoids the migrate path.
vi.mock("@/lib/auth/find-auth-user-id-by-email", () => ({
  findAuthUserIdByEmail: vi.fn(async () => "user-1"),
}));
vi.mock("@/lib/auth/profile-role-row", () => ({
  ensureProfileRoleRow: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/migrate-portal-user-id", () => ({
  migratePortalUserId: vi.fn(async () => {}),
}));

import { provisionResidentAccountByEmail } from "@/lib/auth/provision-resident-account";

type UpsertPayload = {
  application_approved?: boolean;
  full_name?: string | null;
  phone?: string | null;
};

/** An APPROVED guest application on file for the email — the takeover bait. */
const APPROVED_APP = {
  id: "PROPLANE-APP1",
  resident_email: "guest@example.com",
  row_data: { bucket: "approved", name: "Prior Guest", application: { phone: "2065551111" } },
};

function mockSupabase() {
  const captured: { upsert: UpsertPayload | null } = { upsert: null };
  const appLookup = {
    select: () => ({
      eq: () => ({ order: () => ({ limit: async () => ({ data: [APPROVED_APP], error: null }) }) }),
    }),
  };
  const profiles = {
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    upsert: async (payload: UpsertPayload) => {
      captured.upsert = payload;
      return { error: null };
    },
  };
  const client = {
    from: (table: string) => (table === "manager_application_records" ? appLookup : profiles),
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { user_metadata: {} } } }),
        updateUserById: async () => ({ data: {}, error: null }),
      },
    },
  };
  return { client, captured };
}

describe("provisionResidentAccountByEmail default-deny", () => {
  it("inheritFromApplication:false inherits NOTHING even with an approved application on file", async () => {
    const { client, captured } = mockSupabase();
    const result = await provisionResidentAccountByEmail(client as never, {
      userId: "user-1",
      email: "guest@example.com",
      fullName: "New Person",
      phone: "2065559999",
      inheritFromApplication: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.linkedApplication).toBe(false);
    // No approval inherited, and no PII copied from the prior applicant.
    expect(captured.upsert?.application_approved).toBe(false);
    expect(captured.upsert?.full_name).toBe("New Person");
    expect(captured.upsert?.full_name).not.toBe("Prior Guest");
    // Phone is the caller's own, never the application's.
    expect(captured.upsert?.phone).not.toContain("2065551111");
  });

  it("the DEFAULT (no flag) inherits nothing — fail-safe: a forgotten flag never grants inheritance", async () => {
    const { client, captured } = mockSupabase();
    const result = await provisionResidentAccountByEmail(client as never, {
      userId: "user-1",
      email: "guest@example.com",
      fullName: "New Person",
      // No inheritFromApplication flag at all → default-deny.
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.linkedApplication).toBe(false);
    expect(captured.upsert?.application_approved).toBe(false);
    expect(captured.upsert?.full_name).toBe("New Person");
  });

  it("inheritFromApplication:true (proven caller) DOES inherit — proving the flag is the gate", async () => {
    const { client, captured } = mockSupabase();
    const result = await provisionResidentAccountByEmail(client as never, {
      userId: "user-1",
      email: "guest@example.com",
      // No fullName so we can observe the application's name being inherited.
      inheritFromApplication: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.linkedApplication).toBe(true);
    expect(captured.upsert?.application_approved).toBe(true);
    expect(captured.upsert?.full_name).toBe("Prior Guest");
  });
});
