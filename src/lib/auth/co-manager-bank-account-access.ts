import "server-only";

import { coManagerCanEditOwnerBankAccount } from "@/lib/auth/manager-stripe-payout-access.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type CoManagerBankAccountAccessResult =
  | { ok: true }
  | { ok: false; status: 403; error: string };

/** Co-manager bank-account edits are owner-scoped, not tied to one property row. */
export async function assertCoManagerBankAccountAccess(
  db: ServiceClient,
  userId: string,
  ownerManagerUserId: string | null | undefined,
  level: "read" | "edit" = "edit",
): Promise<CoManagerBankAccountAccessResult> {
  const ownerId = (ownerManagerUserId ?? "").trim();
  if (!ownerId || ownerId === userId) return { ok: true };
  if (level === "read") return { ok: true };
  const allowed = await coManagerCanEditOwnerBankAccount(db, userId, ownerId);
  if (allowed) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: "You do not have permission to change this account's bank details.",
  };
}
