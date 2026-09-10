import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("@/lib/auth/delete-portal-account", () => ({ cancelActiveManagerSubscription: vi.fn() }));
vi.mock("@/lib/auth/purge-portal-account-data", () => ({ purgeManagerPortalData: vi.fn(), purgeResidentPortalData: vi.fn(), purgeVendorPortalData: vi.fn() }));
vi.mock("@/lib/auth/purge-shared-account-attachments", () => ({ purgeSharedAccountAttachments: vi.fn() }));
vi.mock("@/lib/sms-relay.server", () => ({ closeRelayThreadsForUser: vi.fn() }));
import { pendingAccountRecovery, recoverySetupRedirect, schedulePortalAccountDeletion } from "@/lib/auth/account-recovery.server";
import { cancelActiveManagerSubscription } from "@/lib/auth/delete-portal-account";
import { closeRelayThreadsForUser } from "@/lib/sms-relay.server";

const missing = { code: "PGRST205", message: "Could not find the table 'public.account_recovery_requests' in the schema cache" };
function fixture(error: { code: string; message: string } | null, data: unknown = null) {
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data, error }) };
  const from = vi.fn(() => query);
  const db = { from } as unknown as SupabaseClient;
  return { db, query, from };
}

describe("account recovery schema compatibility", () => {
  it.each([missing, { code: "42P01", message: 'relation "public.account_recovery_requests" does not exist' }])("allows login before the recovery table is deployed ($code)", async error => {
    const { db } = fixture(error);
    await expect(pendingAccountRecovery(db, "user")).resolves.toBeNull();
    await expect(recoverySetupRedirect(db, "user")).resolves.toBeNull();
  });
  it.each([
    { code: "42501", message: "permission denied for table account_recovery_requests" },
    { code: "42703", message: "column account_recovery_requests.plan does not exist" },
    { code: "PGRST204", message: "Column missing from schema cache" },
    { code: "PGRST002", message: "Could not query the database for the schema cache" },
    { code: "", message: "fetch failed" },
    { code: "PGRST205", message: "Could not find the table 'public.other_table' in the schema cache" },
  ])("keeps other failures closed ($code)", async error => {
    await expect(recoverySetupRedirect(fixture(error).db, "user")).rejects.toThrow(error.message);
  });
  it("still routes retained accounts to recovery and scopes the lookup", async () => {
    const { db, query } = fixture(null, { id: "request", portal: "vendor", state: "retained" });
    await expect(recoverySetupRedirect(db, "user", "vendor")).resolves.toBe("/auth/recover-account?portal=vendor");
    expect(query.eq).toHaveBeenCalledWith("user_id", "user");
    expect(query.eq).toHaveBeenCalledWith("portal", "vendor");
  });
  it("returns no pending recovery for an ordinary account", async () => {
    await expect(pendingAccountRecovery(fixture(null).db, "user")).resolves.toBeNull();
  });
  it("refuses deletion before external side effects when the schema is missing", async () => {
    const { db, from, query } = fixture(missing);
    const profile = { role: "manager" };
    from.mockImplementation((...args: unknown[]) => {
      if (args[0] === "profiles") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) } as typeof query;
      if (args[0] === "profile_roles") return { select: () => ({ eq: async () => ({ data: [{ role: "manager" }], error: null }) }) } as unknown as typeof query;
      return query;
    });
    Object.assign(db, { auth: { admin: { getUserById: async () => ({ data: { user: { email: "manager@example.test" } }, error: null }) } } });
    await expect(schedulePortalAccountDeletion(db, "user", "manager")).rejects.toThrow(missing.message);
    expect(cancelActiveManagerSubscription).not.toHaveBeenCalled();
    expect(closeRelayThreadsForUser).not.toHaveBeenCalled();
  });
});
