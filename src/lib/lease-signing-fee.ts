/**
 * Lease signing fee — Stripe checkout before a resident signature seals
 * (PLAN-0924-1254). Each signer pays (Decide default).
 *
 * Fee amount comes from `leasingPipeline.leaseSigningFeeCents`. Zero / null =
 * no gate. Payment is recorded on the lease row as
 * `leaseSigningFeePaidByUserIds: string[]` so multi-signer leases track each
 * payer without marking the lease signed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  effectiveLeaseSigningFeeCents,
  loadLeasingPipelineState,
  resolveLeasingPipelineForProperty,
} from "@/lib/leasing-pipeline-preferences";

export function leaseSigningFeePaidUserIds(rowData: Record<string, unknown> | null | undefined): string[] {
  const raw = rowData?.leaseSigningFeePaidByUserIds;
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => String(id).trim()).filter(Boolean);
}

export function residentHasPaidLeaseSigningFee(
  rowData: Record<string, unknown> | null | undefined,
  userId: string | null | undefined,
): boolean {
  const id = userId?.trim() ?? "";
  if (!id) return false;
  return leaseSigningFeePaidUserIds(rowData).includes(id);
}

/**
 * True when this resident may complete their signature for the fee rule.
 * Free fee → always true. Unpaid → false.
 */
export function leaseSigningFeeAllowsSignature(input: {
  feeCents: number;
  rowData: Record<string, unknown> | null | undefined;
  userId: string | null | undefined;
}): boolean {
  if (input.feeCents <= 0) return true;
  return residentHasPaidLeaseSigningFee(input.rowData, input.userId);
}

export async function resolveLeaseSigningFeeCentsForProperty(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string | null | undefined,
): Promise<number> {
  const state = await loadLeasingPipelineState(db, managerUserId);
  return effectiveLeaseSigningFeeCents(resolveLeasingPipelineForProperty(state, propertyId));
}

export function recordLeaseSigningFeePaid(
  rowData: Record<string, unknown>,
  userId: string,
): Record<string, unknown> {
  const id = userId.trim();
  if (!id) return rowData;
  const paid = new Set(leaseSigningFeePaidUserIds(rowData));
  paid.add(id);
  return {
    ...rowData,
    leaseSigningFeePaidByUserIds: [...paid],
    leaseSigningFeePaidAtIso: new Date().toISOString(),
  };
}
