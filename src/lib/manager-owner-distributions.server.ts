import type { SupabaseClient } from "@supabase/supabase-js";
import { postGlOwnerDistribution } from "@/lib/reports/gl-posting";
import {
  computeDistributionCents,
  mapOwnerDistributionRow,
  mapPropertyOwnerRow,
  OWNER_DISTRIBUTION_SELECT,
  PROPERTY_OWNER_SELECT,
  type DistributionComponents,
  type OwnerDistribution,
  type PropertyOwner,
} from "@/lib/manager-owner-distributions";
import {
  applyWorkspaceRowScope,
  resolveActiveWorkspaceRowScope,
  rowAllowedInWorkspaceScope,
} from "@/lib/workspaces/row-scope.server";

export type CreateOwnerDistributionInput = DistributionComponents & {
  managerUserId: string;
  propertyId: string;
  ownerId?: string | null;
  periodStart: string;
  periodEnd: string;
  memo?: string | null;
};

export async function createOwnerDistribution(
  db: SupabaseClient,
  input: CreateOwnerDistributionInput,
): Promise<OwnerDistribution> {
  const propertyId = input.propertyId.trim();
  if (!propertyId) throw new Error("A property is required.");
  const periodStart = input.periodStart.slice(0, 10);
  const periodEnd = input.periodEnd.slice(0, 10);
  if (!periodStart || !periodEnd || periodEnd < periodStart) {
    throw new Error("A valid statement period is required.");
  }

  // Every distribution carries a required house — it must land in the
  // manager's active workspace, never one they have merely switched away
  // from.
  const scope = await resolveActiveWorkspaceRowScope(db, input.managerUserId);
  if (scope.propertyIds !== null && !scope.propertyIds.includes(propertyId)) {
    throw new Error("This property is outside your active workspace.");
  }

  const distributionCents = computeDistributionCents(input);
  const now = new Date().toISOString();

  const { data, error } = await db
    .from("manager_owner_distributions")
    .insert({
      manager_user_id: input.managerUserId,
      property_id: propertyId,
      owner_id: input.ownerId ?? null,
      period_start: periodStart,
      period_end: periodEnd,
      beginning_balance_cents: Math.round(input.beginningBalanceCents ?? 0),
      cash_in_cents: Math.round(input.cashInCents ?? 0),
      cash_out_cents: Math.round(input.cashOutCents ?? 0),
      management_fee_cents: Math.round(input.managementFeeCents ?? 0),
      reserve_holdback_cents: Math.round(input.reserveHoldbackCents ?? 0),
      adjustments_cents: Math.round(input.adjustmentsCents ?? 0),
      distribution_cents: distributionCents,
      status: "draft",
      memo: input.memo?.trim() || null,
      updated_at: now,
    })
    .select(OWNER_DISTRIBUTION_SELECT)
    .single();

  if (error || !data) throw new Error(error?.message ?? "Owner distribution create failed.");
  return mapOwnerDistributionRow(data as Record<string, unknown>);
}

async function loadDistribution(
  db: SupabaseClient,
  managerUserId: string,
  id: string,
): Promise<OwnerDistribution | null> {
  const { data, error } = await db
    .from("manager_owner_distributions")
    .select(OWNER_DISTRIBUTION_SELECT)
    .eq("id", id)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapOwnerDistributionRow(data as Record<string, unknown>) : null;
}

/**
 * A distribution outside the manager's active workspace is refused exactly
 * like a missing one — same error, so the workspace boundary never leaks
 * which distributions exist elsewhere.
 */
async function assertDistributionInActiveWorkspace(
  db: SupabaseClient,
  managerUserId: string,
  distribution: OwnerDistribution,
): Promise<void> {
  const scope = await resolveActiveWorkspaceRowScope(db, managerUserId);
  if (!rowAllowedInWorkspaceScope(scope, distribution.propertyId)) {
    throw new Error("Owner distribution not found.");
  }
}

export async function approveOwnerDistribution(
  db: SupabaseClient,
  managerUserId: string,
  id: string,
): Promise<OwnerDistribution> {
  const existing = await loadDistribution(db, managerUserId, id);
  if (!existing) throw new Error("Owner distribution not found.");
  await assertDistributionInActiveWorkspace(db, managerUserId, existing);
  if (existing.status !== "draft") throw new Error("Only a draft distribution can be approved.");

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("manager_owner_distributions")
    .update({ status: "approved", updated_at: now })
    .eq("id", id)
    .eq("manager_user_id", managerUserId)
    .select(OWNER_DISTRIBUTION_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Approve failed.");
  return mapOwnerDistributionRow(data as Record<string, unknown>);
}

/**
 * Mark an approved distribution paid and post the cash-out GL entry
 * (DR owner distributions / CR operating cash). Positive distributions only —
 * a non-positive amount records status without a GL movement.
 */
export async function payOwnerDistribution(
  db: SupabaseClient,
  managerUserId: string,
  id: string,
): Promise<OwnerDistribution> {
  const existing = await loadDistribution(db, managerUserId, id);
  if (!existing) throw new Error("Owner distribution not found.");
  await assertDistributionInActiveWorkspace(db, managerUserId, existing);
  if (existing.status !== "approved") throw new Error("Only an approved distribution can be paid.");

  const now = new Date().toISOString();
  const paidDate = now.slice(0, 10);

  if (existing.distributionCents > 0) {
    await postGlOwnerDistribution(db, {
      managerUserId,
      sourceId: `owner-distribution:${existing.id}`,
      entryDate: paidDate,
      amountCents: existing.distributionCents,
      propertyId: existing.propertyId,
      memo: existing.memo ?? `Owner distribution ${existing.periodStart} – ${existing.periodEnd}`,
    });
  }

  const { data, error } = await db
    .from("manager_owner_distributions")
    .update({ status: "paid", paid_at: now, updated_at: now })
    .eq("id", id)
    .eq("manager_user_id", managerUserId)
    .select(OWNER_DISTRIBUTION_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Pay update failed.");
  return mapOwnerDistributionRow(data as Record<string, unknown>);
}

export async function listOwnerDistributions(
  db: SupabaseClient,
  managerUserId: string,
  filters?: { propertyId?: string; status?: string },
): Promise<OwnerDistribution[]> {
  // `property_id` is `not null` on this table (every distribution has a
  // house), so the account-level branch of the scope never fires here — it
  // is still resolved through the shared helper for one consistent rule.
  const scope = await resolveActiveWorkspaceRowScope(db, managerUserId);
  let query = db
    .from("manager_owner_distributions")
    .select(OWNER_DISTRIBUTION_SELECT)
    .eq("manager_user_id", managerUserId)
    .order("period_end", { ascending: false })
    .limit(200);
  if (filters?.propertyId) query = query.eq("property_id", filters.propertyId);
  if (filters?.status) query = query.eq("status", filters.status);
  query = applyWorkspaceRowScope(query, scope);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapOwnerDistributionRow(row as Record<string, unknown>));
}

export async function listPropertyOwners(
  db: SupabaseClient,
  managerUserId: string,
  propertyId?: string,
): Promise<PropertyOwner[]> {
  // `property_id` is `not null` here too (see `upsertPropertyOwner` below).
  const scope = await resolveActiveWorkspaceRowScope(db, managerUserId);
  let query = db
    .from("manager_property_owners")
    .select(PROPERTY_OWNER_SELECT)
    .eq("manager_user_id", managerUserId)
    .order("owner_name", { ascending: true })
    .limit(500);
  if (propertyId) query = query.eq("property_id", propertyId);
  query = applyWorkspaceRowScope(query, scope);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapPropertyOwnerRow(row as Record<string, unknown>));
}

export type UpsertPropertyOwnerInput = {
  managerUserId: string;
  propertyId: string;
  ownerName: string;
  ownerEmail?: string | null;
  ownershipPct?: number;
};

export async function upsertPropertyOwner(
  db: SupabaseClient,
  input: UpsertPropertyOwnerInput,
): Promise<PropertyOwner> {
  const propertyId = input.propertyId.trim();
  const ownerName = input.ownerName.trim();
  if (!propertyId) throw new Error("A property is required.");
  if (!ownerName) throw new Error("An owner name is required.");
  const pct = Math.min(100, Math.max(0.01, Number(input.ownershipPct ?? 100)));

  const scope = await resolveActiveWorkspaceRowScope(db, input.managerUserId);
  if (scope.propertyIds !== null && !scope.propertyIds.includes(propertyId)) {
    throw new Error("This property is outside your active workspace.");
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("manager_property_owners")
    .insert({
      manager_user_id: input.managerUserId,
      property_id: propertyId,
      owner_name: ownerName,
      owner_email: input.ownerEmail?.trim().toLowerCase() || null,
      ownership_pct: pct,
      updated_at: now,
    })
    .select(PROPERTY_OWNER_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Owner save failed.");
  return mapPropertyOwnerRow(data as Record<string, unknown>);
}
