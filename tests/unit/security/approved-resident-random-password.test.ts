import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: vi.fn().mockResolvedValue(undefined) }));

import { provisionApprovedResidentAccount } from "@/lib/auth/provision-approved-resident";

/** The password this public repository used to ship for every approved resident. */
const PUBLISHED_PASSWORD = "123Password$";

/** Minimal service-role surface: records the password each createUser call was given. */
function fakeService(passwords: string[]) {
  return {
    auth: {
      admin: {
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] }, error: null }),
        getUserById: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
        createUser: vi.fn(async (args: { password?: string }) => {
          passwords.push(String(args.password ?? ""));
          return { data: { user: { id: `user-${passwords.length}` } }, error: null };
        }),
        updateUserById: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
    },
    from: vi.fn(() => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
    })),
  } as unknown as SupabaseClient;
}

async function approve(service: SupabaseClient, email: string) {
  return provisionApprovedResidentAccount(service, {
    id: "PROPLANE-TEST1",
    bucket: "approved",
    email,
    name: "Approved Resident",
  } as never);
}

describe("an account created when a manager approves an application", () => {
  it("gets a random password, never the one printed in this repository", async () => {
    const passwords: string[] = [];
    const service = fakeService(passwords);

    await approve(service, "first@test.proplane.local");
    await approve(service, "second@test.proplane.local");

    expect(passwords).toHaveLength(2);
    for (const password of passwords) {
      expect(password).not.toBe(PUBLISHED_PASSWORD);
      // 32 random bytes, base64url: nothing a reader of the source can predict.
      expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(passwords[0]).not.toBe(passwords[1]);
  });

  it("gets a random password on the silent-migration path too", async () => {
    const passwords: string[] = [];
    const service = fakeService(passwords);

    await provisionApprovedResidentAccount(
      service,
      { id: "PROPLANE-TEST2", bucket: "approved", email: "migrated@test.proplane.local", name: "Migrated" } as never,
      { mode: "silent_migration" },
    );

    expect(passwords[0]).not.toBe(PUBLISHED_PASSWORD);
    expect(passwords[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
