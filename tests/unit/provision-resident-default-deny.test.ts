import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/account-recovery.server", () => ({ pendingAccountRecovery: vi.fn(async () => null), recoverySetupRedirect: vi.fn(async () => null) }));

// Keep the auth-user lookup / role-row writes inert so the test exercises only
// the inheritance decision. Returning the same id avoids the migrate path.
const findAuthUserIdByEmail = vi.fn(async (..._args: unknown[]): Promise<string | null> => "user-1");
vi.mock("@/lib/auth/find-auth-user-id-by-email", () => ({
  findAuthUserIdByEmail: (...args: unknown[]) => findAuthUserIdByEmail(...args),
}));
const attachInboxThreadsToResident = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/lib/tour-resident-link.server", () => ({
  attachInboxThreadsToResident: (...args: unknown[]) => attachInboxThreadsToResident(...args),
}));
vi.mock("@/lib/auth/profile-role-row", () => ({
  ensureProfileRoleRow: vi.fn(async () => {}),
}));
const migratePortalUserId = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/auth/migrate-portal-user-id", () => ({
  migratePortalUserId: (...args: unknown[]) => migratePortalUserId(...args),
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

function mockSupabase(options: { shared?: boolean; profile?: Record<string, unknown> } = {}) {
  const captured: { upsert: UpsertPayload | null } = { upsert: null };
  const appLookup = {
    select: () => ({
      eq: (column: string, id: string) => ({ eq: (_emailColumn: string, email: string) => ({ maybeSingle: async () => ({ data: id === APPROVED_APP.id && email === APPROVED_APP.resident_email ? APPROVED_APP : null, error: null }) }) }),
    }),
  };
  const profiles = {
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: options.profile ?? null }) }) }),
    upsert: async (payload: UpsertPayload) => {
      captured.upsert = payload;
      return { error: null };
    },
  };
  const client = {
    from: (table: string) => table === "sms_runtime_config"
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: options.shared ? { line_mode: "shared", shared_number_e164: "+12065550999" } : null }) }) }) }
      // loadSharedLineConfig also reads which workspaces hold a working number; none here. Without this table the
      // read errors and the config deliberately falls back to per-workspace lines, which would hide the shared-line rule under test.
      : table === "manager_sms_numbers"
        ? { select: () => ({ not: async () => ({ data: [], error: null }) }) }
        : (table === "manager_application_records" ? appLookup : profiles),
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: "guest@example.com", email_confirmed_at: "2026-01-01", user_metadata: {} } } }),
        updateUserById: async () => ({ data: {}, error: null }),
      },
    },
  };
  return { client, captured };
}

describe("provisionResidentAccountByEmail default-deny", () => {
  it("cannot overwrite a shared-line verified identity during resident setup", async () => {
    const { client, captured } = mockSupabase({ shared: true, profile: { phone: "+12065550100", phone_verified_at: "2026-10-18" } });
    const result = await provisionResidentAccountByEmail(client as never, {
      userId: "user-1", email: "guest@example.com", phone: "+12065550101", emailProven: false,
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(captured.upsert).toBeNull();
  });

  it("keeps a shared-line verified phone intact when resident setup supplies the same digits", async () => {
    const { client, captured } = mockSupabase({ shared: true, profile: { phone: "+12065550100", phone_verified_at: "2026-10-18" } });
    const result = await provisionResidentAccountByEmail(client as never, {
      userId: "user-1", email: "guest@example.com", phone: "(206) 555-0100", emailProven: false,
    });
    expect(result.ok).toBe(true);
    expect(captured.upsert?.phone).toBe("+12065550100");
    expect(captured.upsert).not.toHaveProperty("phone_verified_at");
  });

  it("inheritFromApplication:false inherits NOTHING even with an approved application on file", async () => {
    const { client, captured } = mockSupabase();
    const result = await provisionResidentAccountByEmail(client as never, {
      userId: "user-1",
      email: "guest@example.com",
      fullName: "New Person",
      phone: "2065559999",
      emailProven: false,
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
      emailProven: false,
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
      emailProven: true,
      applicationId: APPROVED_APP.id,
      inheritFromApplication: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.linkedApplication).toBe(true);
    expect(captured.upsert?.application_approved).toBe(true);
    expect(captured.upsert?.full_name).toBe("Prior Guest");
  });

  it("refuses inheritance for a different application", async () => {
    const { client, captured } = mockSupabase();
    const result = await provisionResidentAccountByEmail(client as never, {
      userId: "user-1", email: "guest@example.com", emailProven: true,
      applicationId: "OTHER-APPLICATION", inheritFromApplication: true,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(captured.upsert).toBeNull();
  });

  it("refuses a proven-email claim when auth reports an unconfirmed mailbox", async () => {
    const { client, captured } = mockSupabase();
    client.auth.admin.getUserById = async () => ({ data: { user: { email: "guest@example.com", email_confirmed_at: "", user_metadata: {} } } });
    const result = await provisionResidentAccountByEmail(client as never, {
      userId: "user-1", email: "guest@example.com", emailProven: true,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(captured.upsert).toBeNull();
  });

  it("emailProven:false skips every email-keyed inheritance: application, account merge and inbox threads", async () => {
    vi.clearAllMocks();
    findAuthUserIdByEmail.mockResolvedValue("victim-user");
    const { client, captured } = mockSupabase();
    const result = await provisionResidentAccountByEmail(client as never, {
      userId: "user-1",
      email: "guest.12065550142@import.proplane.local",
      fullName: "Stranger",
      inheritFromApplication: true,
      emailProven: false,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(captured.upsert).toBeNull();
    expect(findAuthUserIdByEmail).not.toHaveBeenCalled();
    expect(migratePortalUserId).not.toHaveBeenCalled();
    expect(attachInboxThreadsToResident).not.toHaveBeenCalled();
  });

  it("the explicitly proven path does not attach historical threads by email", async () => {
    vi.clearAllMocks();
    findAuthUserIdByEmail.mockResolvedValue("user-1");
    const { client } = mockSupabase();
    await provisionResidentAccountByEmail(client as never, { userId: "user-1", email: "guest@example.com", emailProven: true });
    expect(attachInboxThreadsToResident).not.toHaveBeenCalled();
  });
});
