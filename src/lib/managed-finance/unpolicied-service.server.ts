import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { loadActivePolicyForWorkspace } from "@/lib/owner-management/policies.server";
import { resolveManagedForProperties } from "@/lib/managed-finance/resolve.server";

/**
 * A PropLane Service workspace (`portal_workspaces.is_service`) that has no ACTIVE, signed fee policy is not yet "managed":
 * `resolveManagedForProperties` returns null for it, so its rent would be captured and credited to the manager of record's hold
 * and transferred to that person's own Connect account, instead of the owner / PropLane party ledger. Until the fee agreement is
 * signed this module (a) refuses new resident checkouts for the workspace, (b) freezes hold releases for its manager of record,
 * and (c) raises an admin attention item. docs/agents/owner-management.md § Unsigned service workspace.
 */

export const SERVICE_SETUP_PENDING_MESSAGE =
  "Payments for this home are being set up. Your manager will text you a link shortly.";

export type UnpoliciedServiceWorkspace = { workspaceId: string; workspaceName: string };

/** Of these workspace ids, the `is_service` ones with no active signed policy. A failed read throws (callers fail closed). */
export async function unpoliciedServiceWorkspaces(
  db: SupabaseClient,
  workspaceIds: ReadonlyArray<string | null | undefined>,
  onDate?: string,
): Promise<UnpoliciedServiceWorkspace[]> {
  const ids = [...new Set(workspaceIds.map((id) => id?.trim() ?? "").filter(Boolean))];
  if (ids.length === 0) return [];
  const { data, error } = await db.from("portal_workspaces").select("id, name, is_service").in("id", ids);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new Error("Could not confirm the workspace payment setup.");
  }
  const out: UnpoliciedServiceWorkspace[] = [];
  for (const row of (data ?? []) as Array<{ id: string; name?: string | null; is_service?: boolean | null }>) {
    if (row.is_service !== true) continue;
    const policy = await loadActivePolicyForWorkspace(db, row.id, onDate);
    if (!policy) out.push({ workspaceId: row.id, workspaceName: String(row.name ?? "").trim() || "Service workspace" });
  }
  return out;
}

/** The houses' workspaces that are service workspaces without an active policy. */
export async function unpoliciedServiceForProperties(
  db: SupabaseClient,
  propertyIds: ReadonlyArray<string | null | undefined>,
  onDate?: string,
): Promise<UnpoliciedServiceWorkspace[]> {
  const ids = [...new Set(propertyIds.map((id) => id?.trim() ?? "").filter(Boolean))];
  if (ids.length === 0) return [];
  const { data, error } = await db.from("manager_property_records").select("id, workspace_id").in("id", ids);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new Error("Could not confirm which workspace this payment belongs to.");
  }
  return unpoliciedServiceWorkspaces(db, ((data ?? []) as Array<{ workspace_id?: string | null }>).map((r) => r.workspace_id), onDate);
}

/**
 * The service workspaces without an active policy that this user is the manager of record for (they own a house in one). A hold
 * whose owner is such a user is frozen: it is NOT transferred to a personal Connect account. Deliberately owner-wide (a hold row
 * does not name its house): a manager who also runs a self-serve house is delayed, never misdirected, until the agreement is signed.
 */
export async function unpoliciedServiceForManager(db: SupabaseClient, managerUserId: string): Promise<UnpoliciedServiceWorkspace[]> {
  const uid = managerUserId.trim();
  if (!uid) return [];
  const { data, error } = await db.from("manager_property_records").select("workspace_id").eq("manager_user_id", uid).not("workspace_id", "is", null);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new Error("Could not confirm the workspace payment setup.");
  }
  const owned = await db.from("portal_workspaces").select("id").eq("owner_user_id", uid).eq("is_service", true);
  if (owned.error && !isMissingSchemaError(owned.error)) throw new Error("Could not confirm the workspace payment setup.");
  const ids = [
    ...((data ?? []) as Array<{ workspace_id?: string | null }>).map((r) => r.workspace_id),
    ...((owned.data ?? []) as Array<{ id?: string | null }>).map((r) => r.id),
  ];
  return unpoliciedServiceWorkspaces(db, ids);
}

/** The admin attention item: one flag per workspace per day, shown in Admin > Finances > Flags. Never throws. */
export async function flagUnsignedFeeAgreement(db: SupabaseClient, ws: UnpoliciedServiceWorkspace, reason: "checkout_refused" | "hold_frozen"): Promise<void> {
  try {
    await db.from("owner_ledger_flags").upsert(
      {
        check_name: "fee_agreement_unsigned",
        subject: ws.workspaceId,
        detail: { message: `Sign the fee agreement for ${ws.workspaceName}`, reason, workspace: ws.workspaceName },
      },
      { onConflict: "check_name,subject,day", ignoreDuplicates: true },
    );
  } catch {
    /* an attention item must never fail the money path that raised it */
  }
}

/**
 * Checkout-time guard, next to `managedCartProblem`: a resident cannot pay a house in a service workspace whose fee agreement is
 * not signed. Returns the message to show, or null. A failed read refuses (never "assume self-serve").
 */
export async function serviceSetupPendingProblem(
  db: SupabaseClient,
  propertyIds: ReadonlyArray<string | null | undefined>,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const pending = await unpoliciedServiceForProperties(db, propertyIds, now.toISOString().slice(0, 10));
    if (pending.length === 0) return null;
    for (const ws of pending) await flagUnsignedFeeAgreement(db, ws, "checkout_refused");
    return SERVICE_SETUP_PENDING_MESSAGE;
  } catch {
    return "Could not confirm where this payment goes. Try again in a moment.";
  }
}

/**
 * Must this house's resident money be captured on PropLane's platform balance (never a destination charge to the manager of record's
 * own Connect account)? True for a PropLane-managed workspace and for a service workspace whose fee agreement is not signed yet.
 * A read that fails answers true: the platform capture is the safe side (the hold is frozen / allocated, never paid out).
 */
export async function platformCaptureRequiredForProperty(db: SupabaseClient, propertyId: string | null | undefined): Promise<boolean> {
  const id = propertyId?.trim() ?? "";
  if (!id) return false;
  try {
    const managed = await resolveManagedForProperties(db, [id], new Date().toISOString());
    if (managed) return true;
    return (await unpoliciedServiceForProperties(db, [id])).length > 0;
  } catch {
    return true;
  }
}
