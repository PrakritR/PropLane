import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { cancelActiveManagerSubscription, deleteOwnPortalAccount } = vi.hoisted(() => ({
  cancelActiveManagerSubscription: vi.fn(),
  deleteOwnPortalAccount: vi.fn(async () => ({
    ok: true as const,
    mode: "deleted_auth_user",
    signedOut: true,
    redirectTo: "/auth/sign-in?deleted=1",
  })),
}));

vi.mock("@/lib/auth/delete-portal-account", () => ({
  cancelActiveManagerSubscription,
  deleteOwnPortalAccount,
}));
vi.mock("@/lib/auth/purge-portal-account-data", () => ({
  purgeManagerPortalData: vi.fn(),
  purgeResidentPortalData: vi.fn(),
  purgeVendorPortalData: vi.fn(),
}));
vi.mock("@/lib/auth/purge-shared-account-attachments", () => ({ purgeSharedAccountAttachments: vi.fn() }));
vi.mock("@/lib/sms-relay.server", () => ({ closeRelayThreadsForUser: vi.fn() }));

import {
  isMissingAccountRecoveryRpcError,
  isMissingAccountRecoveryTableError,
  shouldUseLegacyPortalAccountDeletion,
} from "@/lib/auth/account-recovery-schema";
import { pendingAccountRecovery, recoverySetupRedirect, schedulePortalAccountDeletion } from "@/lib/auth/account-recovery.server";
import { resolvePortalSelfDelete } from "@/lib/auth/resolve-portal-self-delete";
import { closeRelayThreadsForUser } from "@/lib/sms-relay.server";

const missingTable = {
  code: "PGRST205",
  message: "Could not find the table 'public.account_recovery_requests' in the schema cache",
};

function fixture(error: { code: string; message: string } | null, data: unknown = null) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  const from = vi.fn(() => query);
  const db = { from } as unknown as SupabaseClient;
  return { db, query, from };
}

describe("account recovery schema helpers", () => {
  it.each([missingTable, { code: "42P01", message: 'relation "public.account_recovery_requests" does not exist' }])(
    "detects a missing recovery table ($code)",
    (error) => {
      expect(isMissingAccountRecoveryTableError(error)).toBe(true);
      expect(shouldUseLegacyPortalAccountDeletion(new Error(error.message))).toBe(true);
    },
  );

  it("detects a missing recovery RPC", () => {
    const error = { code: "PGRST202", message: "Could not find the function public.account_recovery_begin" };
    expect(isMissingAccountRecoveryRpcError(error)).toBe(true);
    expect(shouldUseLegacyPortalAccountDeletion(new Error(error.message))).toBe(true);
  });
});

describe("account recovery schema compatibility", () => {
  it.each([missingTable, { code: "42P01", message: 'relation "public.account_recovery_requests" does not exist' }])(
    "allows login before the recovery table is deployed ($code)",
    async (error) => {
      const { db } = fixture(error);
      await expect(pendingAccountRecovery(db, "user")).resolves.toBeNull();
      await expect(recoverySetupRedirect(db, "user")).resolves.toBeNull();
    },
  );

  it("refuses deletion before external side effects when the schema is missing", async () => {
    const { db, from, query } = fixture(missingTable);
    const profile = { role: "resident" };
    from.mockImplementation((...args: unknown[]) => {
      if (args[0] === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) } as typeof query;
      }
      if (args[0] === "profile_roles") {
        return { select: () => ({ eq: async () => ({ data: [{ role: "resident" }], error: null }) }) } as unknown as typeof query;
      }
      return query;
    });
    Object.assign(db, {
      auth: { admin: { getUserById: async () => ({ data: { user: { email: "resident@example.test" } }, error: null }) } },
    });
    await expect(schedulePortalAccountDeletion(db, "user", "resident")).rejects.toThrow(missingTable.message);
    expect(cancelActiveManagerSubscription).not.toHaveBeenCalled();
    expect(closeRelayThreadsForUser).not.toHaveBeenCalled();
  });
});

describe("resolvePortalSelfDelete", () => {
  it("falls back to immediate delete when retention schema is unavailable", async () => {
    const { db, from, query } = fixture(missingTable);
    const profile = { role: "resident" };
    from.mockImplementation((...args: unknown[]) => {
      if (args[0] === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) } as typeof query;
      }
      if (args[0] === "profile_roles") {
        return { select: () => ({ eq: async () => ({ data: [{ role: "resident" }], error: null }) }) } as unknown as typeof query;
      }
      return query;
    });
    Object.assign(db, {
      auth: { admin: { getUserById: async () => ({ data: { user: { email: "resident@example.test" } }, error: null }) } },
    });

    const result = await resolvePortalSelfDelete(db, "user", "resident");
    expect(deleteOwnPortalAccount).toHaveBeenCalledWith(db, "user", "resident");
    expect(result.signedOut).toBe(true);
    expect(result.retentionDays).toBe(0);
  });
});
