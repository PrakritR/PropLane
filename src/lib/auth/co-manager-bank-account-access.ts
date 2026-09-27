import "server-only";

import { coManagerHasOwnerBankAccountAccess } from "@/lib/auth/manager-stripe-payout-access.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type CoManagerBankAccountAccessResult =
  | { ok: true }
  | { ok: false; status: 403; error: string };

/**
 * Co-manager bank-account access is owner-scoped, not tied to one property
 * row — but it is still a GRANT, never a standing privilege of being an
 * accepted co-manager on any module. A `read` request used to pass
 * unconditionally for any accepted co-manager regardless of their actual
 * `bankAccount` permission, letting a co-manager with NO grant at all (e.g. a
 * "Leasing"-role invite, which never touches `bankAccount`) view the owner's
 * Stripe Connect readiness, balance, and identity state — the exact "empty
 * permissions = no access" invariant every other module in
 * `docs/agents/co-manager-access.md` already enforces. Both levels now check
 * the real grant.
 */
export async function assertCoManagerBankAccountAccess(
  db: ServiceClient,
  userId: string,
  ownerManagerUserId: string | null | undefined,
  level: "read" | "edit" = "edit",
): Promise<CoManagerBankAccountAccessResult> {
  const ownerId = (ownerManagerUserId ?? "").trim();
  if (!ownerId || ownerId === userId) return { ok: true };
  const allowed = await coManagerHasOwnerBankAccountAccess(db, userId, ownerId, level);
  if (allowed) return { ok: true };
  return {
    ok: false,
    status: 403,
    error:
      level === "read"
        ? "You do not have permission to view this account's payout details."
        : "You do not have permission to change this account's bank details.",
  };
}
