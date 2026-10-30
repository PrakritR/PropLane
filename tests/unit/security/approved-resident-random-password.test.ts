import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: vi.fn().mockResolvedValue(undefined) }));

import { provisionApprovedResidentAccount } from "@/lib/auth/provision-approved-resident";


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

describe("manager approval without mailbox proof", () => {
  it.each([undefined, { mode: "silent_migration" } as const])("requires an invitation without creating or confirming an account", async (options) => {
    const passwords: string[] = [];
    const service = fakeService(passwords);
    const result = await provisionApprovedResidentAccount(service, { id: "PROPLANE-TEST1", bucket: "approved", email: "resident@example.test" } as never, options);
    expect(result).toMatchObject({ ok: false, reason: "invitation_required" });
    expect(passwords).toEqual([]);
    expect(service.auth.admin.createUser).not.toHaveBeenCalled();
    expect(service.auth.admin.updateUserById).not.toHaveBeenCalled();
  });
});
