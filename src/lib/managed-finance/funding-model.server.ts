import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";

/**
 * THE one answer to "where does this workspace's resident money go?" (docs/agents/owner-management.md § Funding decision).
 *
 *  - `managed_platform`: the workspace is PropLane-managed (`portal_workspaces.is_service`). Its money is captured on PropLane's
 *    platform Stripe balance (no `transfer_data`, no destination) and allocated in the party ledger. It is NEVER credited to a
 *    manager hold and therefore never transferred to a manager's / client's own Connect account.
 *  - `connect_destination`: a self-serve workspace. Today's per-workspace Connect flow, unchanged.
 *
 * (This is not the `fundingModel: "platform_ledger"` checkout option of `stripe-axis-ach-checkout.ts`; that one credits a
 * manager's PropLane BALANCE and is a different, flag-gated feature. A managed workspace's capture is the platform-hold
 * checkout plus `credit_managed_capture`.)
 *
 * Fail closed: a read that fails THROWS `FundingModelUnreadableError`. Callers refuse the charge (checkout) or refuse to credit /
 * release it (webhook, hold release); an unreadable flag is never read as "self-serve".
 */
export type WorkspaceFundingModel = "managed_platform" | "connect_destination";

export class FundingModelUnreadableError extends Error {
  constructor() {
    super("Could not confirm where this payment goes. Try again in a moment.");
    this.name = "FundingModelUnreadableError";
  }
}

export class ServiceWorkspaceHoldRefusedError extends Error {
  constructor() {
    super("A PropLane-managed workspace's payment cannot be credited to a manager hold.");
    this.name = "ServiceWorkspaceHoldRefusedError";
  }
}

export async function resolveWorkspaceFundingModel(db: SupabaseClient, workspaceId: string): Promise<WorkspaceFundingModel> {
  const id = workspaceId.trim();
  if (!id) throw new FundingModelUnreadableError();
  const { data, error } = await db.from("portal_workspaces").select("id, is_service").eq("id", id).maybeSingle();
  if (error) {
    // Production runs code before migrations: no table / column means nothing is managed.
    if (isMissingSchemaError(error)) return "connect_destination";
    throw new FundingModelUnreadableError();
  }
  if (!data) throw new FundingModelUnreadableError();
  return (data as { is_service?: boolean | null }).is_service === true ? "managed_platform" : "connect_destination";
}

/**
 * The funding model of a set of houses: `managed_platform` when ANY house sits in an is_service workspace. A house with no
 * workspace (legacy) is self-serve. Any failed read throws.
 */
export async function resolveFundingModelForProperties(
  db: SupabaseClient,
  propertyIds: ReadonlyArray<string | null | undefined>,
): Promise<WorkspaceFundingModel> {
  const ids = [...new Set(propertyIds.map((id) => id?.trim() ?? "").filter(Boolean))];
  if (ids.length === 0) return "connect_destination";
  const { data, error } = await db.from("manager_property_records").select("id, workspace_id").in("id", ids);
  if (error) {
    if (isMissingSchemaError(error)) return "connect_destination";
    throw new FundingModelUnreadableError();
  }
  const workspaceIds = [...new Set(((data ?? []) as Array<{ workspace_id?: string | null }>)
    .map((row) => (row.workspace_id ? String(row.workspace_id) : "")).filter(Boolean))];
  for (const workspaceId of workspaceIds) {
    if ((await resolveWorkspaceFundingModel(db, workspaceId)) === "managed_platform") return "managed_platform";
  }
  return "connect_destination";
}

/**
 * Checkout-time guard: a message when the funding model of these houses cannot be read (refuse the charge), else null. A managed
 * workspace is NOT a problem here; its checkout is the platform capture.
 */
export async function fundingModelProblem(
  db: SupabaseClient,
  propertyIds: ReadonlyArray<string | null | undefined>,
): Promise<string | null> {
  try {
    await resolveFundingModelForProperties(db, propertyIds);
    return null;
  } catch {
    return new FundingModelUnreadableError().message;
  }
}

/**
 * Credit-time guard, called wherever a paid source is about to be credited to a MANAGER HOLD (the self-serve path). A managed
 * workspace (or an unreadable flag) throws: Stripe redelivers, nothing is credited, and the money stays on the platform balance
 * until the managed allocation can run. Never falls back to a hold.
 */
export async function assertHoldAllowedForProperties(
  db: SupabaseClient,
  propertyIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  if ((await resolveFundingModelForProperties(db, propertyIds)) === "managed_platform") {
    throw new ServiceWorkspaceHoldRefusedError();
  }
}

/**
 * Release-time guard: is this manager hold the money of an is_service workspace? Resident household / autopay holds name their
 * charge rows by source id (`stripeCheckoutSessionId`). Throws when unreadable (the release stays pending); returns false only
 * when the hold's houses are readable and none is managed.
 */
export async function holdIsServiceWorkspaceMoney(
  db: SupabaseClient,
  hold: { source: string; source_id: string; owner_user_id: string },
): Promise<boolean> {
  if (hold.source !== "household_charge") return false;
  const { data, error } = await db.from("portal_household_charge_records")
    .select("id, row_data")
    .eq("manager_user_id", hold.owner_user_id)
    .eq("row_data->>stripeCheckoutSessionId", hold.source_id)
    .limit(20);
  if (error) {
    if (isMissingSchemaError(error)) return false;
    throw new FundingModelUnreadableError();
  }
  const propertyIds = ((data ?? []) as Array<{ row_data?: { propertyId?: string | null } | null }>)
    .map((row) => row.row_data?.propertyId ?? null);
  return (await resolveFundingModelForProperties(db, propertyIds)) === "managed_platform";
}

/** A resident charge's house, read from its stored row (an autopay PaymentIntent carries a charge id, not a house). Throws when unreadable. */
export async function propertyIdForHouseholdCharge(db: SupabaseClient, chargeId: string | null | undefined): Promise<string | null> {
  const id = chargeId?.trim() ?? "";
  if (!id) throw new FundingModelUnreadableError();
  const { data, error } = await db.from("portal_household_charge_records").select("id, row_data").eq("id", id).maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new FundingModelUnreadableError();
  }
  return ((data as { row_data?: { propertyId?: string | null } | null } | null)?.row_data?.propertyId ?? null) || null;
}
