import { describe, expect, it, vi } from "vitest";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import { syncOAuthProfile } from "@/lib/auth/sync-oauth-profile";

function mockSupabase(existingProfile: Record<string, unknown> | null) {
  const update = vi.fn().mockResolvedValue({ error: null });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const profileRolesUpsert = vi.fn().mockResolvedValue({ error: null });

  const from = vi.fn((table: string) => {
    if (table === "profiles") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: existingProfile }),
          }),
        }),
        update: (...args: unknown[]) => ({
          eq: () => update(...args),
        }),
        upsert: (...args: unknown[]) => upsert(...args),
      };
    }
    if (table === "profile_roles") {
      return {
        upsert: profileRolesUpsert,
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { from, update, upsert, profileRolesUpsert };
}

describe("syncOAuthProfile", () => {
  it("updates missing full name on existing profiles", async () => {
    const supabase = mockSupabase({
      id: "user-1",
      email: "resident@test.com",
      full_name: null,
      role: "resident",
    });

    await syncOAuthProfile(supabase as never, {
      id: "user-1",
      email: "resident@test.com",
      user_metadata: { full_name: "Resident User" },
    } as never);

    expect(supabase.update).toHaveBeenCalled();
  });

  it("records a primary-email OAuth account's own profile row without granting it anything", async () => {
    const supabase = mockSupabase(null);

    await syncOAuthProfile(supabase as never, {
      id: "admin-1",
      email: PRIMARY_ADMIN_EMAIL,
      user_metadata: { name: "Prakrit" },
    } as never);

    // No role row: roles come from stored `profile_roles` alone, and nothing here writes one.
    expect(supabase.profileRolesUpsert).not.toHaveBeenCalled();
    // But the row itself has to exist: `profiles.email` is what the primary-admin protection in
    // `holdsAdminOutsideRoleRow` reads, and without it the account has no recorded email or name.
    expect(supabase.upsert).toHaveBeenCalledTimes(1);
    expect(supabase.upsert.mock.calls[0]![0]).toEqual({
      id: "admin-1",
      email: PRIMARY_ADMIN_EMAIL,
      full_name: "Prakrit",
      role: "admin",
      manager_id: null,
    });
    // Never overwrites a row that already exists.
    expect(supabase.upsert.mock.calls[0]![1]).toMatchObject({ onConflict: "id", ignoreDuplicates: true });
  });

  it("does not re-grant a revoked admin role on OAuth sign-in", async () => {
    const supabase = mockSupabase({
      id: "admin-1",
      email: PRIMARY_ADMIN_EMAIL,
      full_name: "Axis Admin",
      role: "admin",
    });

    await syncOAuthProfile(supabase as never, {
      id: "admin-1",
      email: PRIMARY_ADMIN_EMAIL,
      user_metadata: { full_name: "Axis Admin" },
      identities: [{ provider: "google" }],
      app_metadata: { provider: "google" },
    } as never);

    expect(supabase.update).toHaveBeenCalled();
    expect(supabase.profileRolesUpsert).not.toHaveBeenCalled();
  });
});
