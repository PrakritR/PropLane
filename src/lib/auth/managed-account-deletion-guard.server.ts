import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveManagedPayee } from "@/lib/managed-finance/payee.server";
import { loadActivePolicyForWorkspace } from "@/lib/owner-management/policies.server";
import { ownerParty, readPartyBalance } from "@/lib/managed-finance/ledger.server";

/**
 * Deleting an account must never take a PropLane-managed workspace's books with it. Every managed workspace is OWNED by the
 * service owner (the admin) and its client is the Property owner seat that the fee policy and the owner party ledger are
 * keyed on (`account-purge-manifest.ts`: the fee policy is purged with `owner_user_id`). So:
 *   - the service owner, or any account that owns an `is_service` workspace, cannot be deleted (the workspaces would go with it);
 *   - a client who is the payee of a managed workspace with a fee policy, or who is owed (or owes) a non-zero owner payable
 *     balance, cannot be deleted until an admin replaces the owner of record.
 * A read that fails refuses: "could not verify" is never "safe to delete".
 */
export class AccountDeletionBlockedError extends Error {
  readonly status = 409;
  readonly code = "ACCOUNT_DELETION_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "AccountDeletionBlockedError";
  }
}

const UNVERIFIED = "PropLane could not check whether this account is tied to a managed workspace, so nothing was deleted. Please retry.";

/** The reason this account may not be deleted, or null. Never throws. */
export async function managedAccountDeletionBlocker(db: SupabaseClient, userId: string): Promise<string | null> {
  const id = userId.trim();
  if (!id) return null;
  try {
    const settings = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
    if (settings.error && !["42P01", "42703", "PGRST204", "PGRST205"].includes(String(settings.error.code ?? ""))) return UNVERIFIED;
    if (String((settings.data as { owner_user_id?: unknown } | null)?.owner_user_id ?? "") === id) {
      return "This is the PropLane service owner account. Name another service owner before deleting it.";
    }
    const owned = await db.from("portal_workspaces").select("id").eq("owner_user_id", id).eq("is_service", true).limit(1);
    if (owned.error) return UNVERIFIED;
    if ((owned.data ?? []).length > 0) return "This account owns PropLane-managed workspaces. Move them to the service owner before deleting it.";

    const seats = await db
      .from("account_link_invites")
      .select("workspace_id")
      .eq("invitee_user_id", id)
      .eq("status", "accepted")
      .eq("team_role", "property_owner");
    if (seats.error) return UNVERIFIED;
    const workspaceIds = [...new Set(((seats.data ?? []) as { workspace_id: string | null }[]).map((s) => String(s.workspace_id ?? "")).filter(Boolean))];
    if (workspaceIds.length === 0) return null;
    const managed = await db.from("portal_workspaces").select("id").in("id", workspaceIds).eq("is_service", true);
    if (managed.error) return UNVERIFIED;
    for (const row of (managed.data ?? []) as { id: string }[]) {
      const ws = String(row.id);
      if ((await resolveManagedPayee(db, ws)) !== id) continue;
      if (await loadActivePolicyForWorkspace(db, ws)) {
        return "This account is the property owner of a PropLane-managed workspace. A PropLane admin must name a new owner of record first.";
      }
      const balance = await readPartyBalance(db, "owner_payable", ownerParty(id), ws);
      if (balance.owedCents !== 0 || balance.pendingCents !== 0) {
        return "This account has a balance with PropLane to settle first. A PropLane admin must resolve it before the account is deleted.";
      }
    }
    return null;
  } catch {
    return UNVERIFIED;
  }
}

export async function assertManagedAccountDeletable(db: SupabaseClient, userId: string): Promise<void> {
  const reason = await managedAccountDeletionBlocker(db, userId);
  if (reason) throw new AccountDeletionBlockedError(reason);
}
