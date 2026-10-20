import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { ensureServiceFeePolicy, loadActivePolicyForWorkspace, type EnsureFeeFailure } from "@/lib/owner-management/policies.server";
import { feeFlagMessage, flagManagedFeeProblem } from "@/lib/owner-management/fee-flags.server";
import { managedCartProblem, resolveManagedForProperties } from "@/lib/managed-finance/resolve.server";

/**
 * A PropLane Service workspace (`portal_workspaces.is_service`) that has no ACTIVE fee policy is not yet "managed":
 * `resolveManagedForProperties` returns null for it, so its rent would be captured and credited to the manager of record's hold
 * and transferred to that person's own Connect account, instead of the owner / PropLane party ledger. No one signs anything:
 * the first time a workspace is found without one, `ensureServiceFeePolicy` creates the automatic management fee and the
 * workspace is managed from then on. Only when that cannot be done (unreadable, or no owner of record to name) does this module
 * fall back, fail closed, to (a) refusing new resident checkouts, (b) freezing hold releases for the manager of record, and
 * (c) raising an admin attention item that names the reason. docs/agents/owner-management.md § Unsigned service workspace.
 */

export const SERVICE_SETUP_PENDING_MESSAGE =
  "Payments for this home are being set up. Your manager will text you a link shortly.";

/** A workspace still without a fee, and WHY: the attention item must say what an admin has to fix. */
export type UnpoliciedServiceWorkspace = { workspaceId: string; workspaceName: string; cause: EnsureFeeFailure };

/** The pending workspaces, plus whether a policy was created on this pass (which changes what a cart resolves to). */
export type UnpoliciedServiceScan = { pending: UnpoliciedServiceWorkspace[]; created: boolean };

/** Of these workspace ids, the `is_service` ones with no active policy after the automatic fee was tried. A failed read throws (callers fail closed). */
export async function unpoliciedServiceWorkspaces(
  db: SupabaseClient,
  workspaceIds: ReadonlyArray<string | null | undefined>,
  onDate?: string,
): Promise<UnpoliciedServiceScan> {
  const ids = [...new Set(workspaceIds.map((id) => id?.trim() ?? "").filter(Boolean))];
  if (ids.length === 0) return { pending: [], created: false };
  const { data, error } = await db.from("portal_workspaces").select("id, name, is_service").in("id", ids);
  if (error) {
    if (isMissingSchemaError(error)) return { pending: [], created: false };
    throw new Error("Could not confirm the workspace payment setup.");
  }
  const pending: UnpoliciedServiceWorkspace[] = [];
  let created = false;
  for (const row of (data ?? []) as Array<{ id: string; name?: string | null; is_service?: boolean | null }>) {
    if (row.is_service !== true) continue;
    const policy = await loadActivePolicyForWorkspace(db, row.id, onDate);
    if (policy) continue;
    // The automatic management fee: created here, once, instead of refusing. Anything short of an active policy stays pending.
    const ensured = await ensureServiceFeePolicy(db, row.id);
    if (ensured.status === "created") created = true;
    if (ensured.status === "exists" || ensured.status === "created" || ensured.status === "not_service") continue;
    pending.push({ workspaceId: row.id, workspaceName: String(row.name ?? "").trim() || "Service workspace", cause: ensured.reason });
  }
  return { pending, created };
}

/** The houses' workspaces that are service workspaces without an active policy. */
export async function unpoliciedServiceForProperties(
  db: SupabaseClient,
  propertyIds: ReadonlyArray<string | null | undefined>,
  onDate?: string,
): Promise<UnpoliciedServiceScan> {
  const ids = [...new Set(propertyIds.map((id) => id?.trim() ?? "").filter(Boolean))];
  if (ids.length === 0) return { pending: [], created: false };
  const { data, error } = await db.from("manager_property_records").select("id, workspace_id").in("id", ids);
  if (error) {
    if (isMissingSchemaError(error)) return { pending: [], created: false };
    throw new Error("Could not confirm which workspace this payment belongs to.");
  }
  return unpoliciedServiceWorkspaces(db, ((data ?? []) as Array<{ workspace_id?: string | null }>).map((r) => r.workspace_id), onDate);
}

/**
 * The service workspaces without an active policy that this user is the manager of record for (they own a house in one). A hold
 * whose owner is such a user is frozen: it is NOT transferred to a personal Connect account. Deliberately owner-wide (a hold row
 * does not name its house): a manager who also runs a self-serve house is delayed, never misdirected, until the fee exists.
 */
export async function unpoliciedServiceForManager(db: SupabaseClient, managerUserId: string): Promise<UnpoliciedServiceScan> {
  const uid = managerUserId.trim();
  if (!uid) return { pending: [], created: false };
  const { data, error } = await db.from("manager_property_records").select("workspace_id").eq("manager_user_id", uid).not("workspace_id", "is", null);
  if (error) {
    if (isMissingSchemaError(error)) return { pending: [], created: false };
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

/** What an admin has to do, per cause. Only `no_owner` is something to name; the rest are a failure to investigate. */
export function unpoliciedFlagMessage(ws: UnpoliciedServiceWorkspace): string {
  return feeFlagMessage(ws.workspaceName, ws.cause);
}

/** The admin attention item when the automatic fee could not be set: one flag per workspace per day, in Admin > Finances > Flags. Never throws. */
export async function flagUnsignedFeeAgreement(db: SupabaseClient, ws: UnpoliciedServiceWorkspace, reason: "checkout_refused" | "hold_frozen"): Promise<void> {
  await flagManagedFeeProblem(db, { workspaceId: ws.workspaceId, workspaceName: ws.workspaceName, cause: ws.cause, reason });
}

export type ServiceSetupProblem = { code: "SERVICE_SETUP_PENDING" | "MIXED_PAYMENT_SETUP"; message: string };

/**
 * Checkout-time guard, next to `managedCartProblem`: a resident cannot pay a house in a service workspace that has no management
 * fee and could not be given one. A workspace without one gets its automatic fee here and the checkout proceeds; only when the fee
 * was JUST created is the cart re-checked, because that workspace became managed a moment ago and a cart that mixes it with
 * another payment setup can no longer be allocated. Returns the problem to show, or null. A failed read refuses (never "assume
 * self-serve").
 */
export async function serviceSetupPendingProblem(
  db: SupabaseClient,
  propertyIds: ReadonlyArray<string | null | undefined>,
  now: Date = new Date(),
): Promise<ServiceSetupProblem | null> {
  try {
    const { pending, created } = await unpoliciedServiceForProperties(db, propertyIds, now.toISOString().slice(0, 10));
    if (pending.length === 0) {
      if (!created) return null;
      const mixed = await managedCartProblem(db, propertyIds, now);
      return mixed ? { code: "MIXED_PAYMENT_SETUP", message: mixed } : null;
    }
    for (const ws of pending) await flagUnsignedFeeAgreement(db, ws, "checkout_refused");
    return { code: "SERVICE_SETUP_PENDING", message: SERVICE_SETUP_PENDING_MESSAGE };
  } catch {
    return { code: "SERVICE_SETUP_PENDING", message: "Could not confirm where this payment goes. Try again in a moment." };
  }
}

/**
 * Must this house's resident money be captured on PropLane's platform balance (never a destination charge to the manager of record's
 * own Connect account)? True for a PropLane-managed workspace and for a service workspace that could not be given its automatic fee.
 * A read that fails answers true: the platform capture is the safe side (the hold is frozen / allocated, never paid out).
 */
export async function platformCaptureRequiredForProperty(db: SupabaseClient, propertyId: string | null | undefined): Promise<boolean> {
  const id = propertyId?.trim() ?? "";
  if (!id) return false;
  try {
    // Give a service workspace its automatic fee BEFORE resolving, so the first payment is captured on the platform balance and
    // allocated, not left to a destination charge because the policy appeared a moment too late.
    if ((await unpoliciedServiceForProperties(db, [id])).pending.length > 0) return true;
    return (await resolveManagedForProperties(db, [id], new Date().toISOString())) !== null;
  } catch {
    return true;
  }
}
