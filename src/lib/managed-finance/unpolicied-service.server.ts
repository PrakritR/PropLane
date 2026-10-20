import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { ensureServiceFeePolicy, loadActivePolicyForWorkspace } from "@/lib/owner-management/policies.server";
import { managedCartProblem, resolveManagedForProperties } from "@/lib/managed-finance/resolve.server";

/**
 * A PropLane Service workspace (`portal_workspaces.is_service`) that has no ACTIVE fee policy is not yet "managed":
 * `resolveManagedForProperties` returns null for it, so its rent would be captured and credited to the manager of record's hold
 * and transferred to that person's own Connect account, instead of the owner / PropLane party ledger. No one signs anything:
 * the first time a workspace is found without one, `ensureServiceFeePolicy` creates the automatic management fee and the
 * workspace is managed from then on. Only when that cannot be done (unreadable, or no owner of record to name) does this module
 * fall back, fail closed, to (a) refusing new resident checkouts, (b) freezing hold releases for the manager of record, and
 * (c) raising an admin attention item. docs/agents/owner-management.md § Unsigned service workspace.
 */

export const SERVICE_SETUP_PENDING_MESSAGE =
  "Payments for this home are being set up. Your manager will text you a link shortly.";

export type UnpoliciedServiceWorkspace = { workspaceId: string; workspaceName: string };

/** Of these workspace ids, the `is_service` ones with no active policy after the automatic fee was tried. A failed read throws (callers fail closed). */
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
    if (policy) continue;
    // The automatic management fee: created here, once, instead of refusing. Anything short of an active policy stays pending.
    const ensured = await ensureServiceFeePolicy(db, row.id);
    if (ensured.status === "exists" || ensured.status === "created") continue;
    out.push({ workspaceId: row.id, workspaceName: String(row.name ?? "").trim() || "Service workspace" });
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

/** The admin attention item when the automatic fee could not be set: one flag per workspace per day, in Admin > Finances > Flags. Never throws. */
export async function flagUnsignedFeeAgreement(db: SupabaseClient, ws: UnpoliciedServiceWorkspace, reason: "checkout_refused" | "hold_frozen"): Promise<void> {
  try {
    await db.from("owner_ledger_flags").upsert(
      {
        check_name: "fee_agreement_unsigned",
        subject: ws.workspaceId,
        detail: { message: `Could not set the management fee for ${ws.workspaceName}: name its owner of record`, reason, workspace: ws.workspaceName },
      },
      { onConflict: "check_name,subject,day", ignoreDuplicates: true },
    );
  } catch {
    /* an attention item must never fail the money path that raised it */
  }
}

/**
 * Checkout-time guard, next to `managedCartProblem`: a resident cannot pay a house in a service workspace that has no management
 * fee and could not be given one. A workspace without one gets its automatic fee here and the checkout proceeds; the cart is then
 * re-checked, because the workspace just became managed (a cart that mixes it with another payment setup is refused). Returns the
 * message to show, or null. A failed read refuses (never "assume self-serve").
 */
export async function serviceSetupPendingProblem(
  db: SupabaseClient,
  propertyIds: ReadonlyArray<string | null | undefined>,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const pending = await unpoliciedServiceForProperties(db, propertyIds, now.toISOString().slice(0, 10));
    if (pending.length === 0) return await managedCartProblem(db, propertyIds, now);
    for (const ws of pending) await flagUnsignedFeeAgreement(db, ws, "checkout_refused");
    return SERVICE_SETUP_PENDING_MESSAGE;
  } catch {
    return "Could not confirm where this payment goes. Try again in a moment.";
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
    if ((await unpoliciedServiceForProperties(db, [id])).length > 0) return true;
    return (await resolveManagedForProperties(db, [id], new Date().toISOString())) !== null;
  } catch {
    return true;
  }
}
