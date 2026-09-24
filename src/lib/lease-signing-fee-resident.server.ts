import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { LEASE_SIGNING_FEE_CHECKOUT_PURPOSE } from "@/lib/lease-signing-fee-checkout.server";
import {
  recordLeaseSigningFeePaid,
  residentHasPaidLeaseSigningFee,
  resolveLeaseSigningFeeCentsForProperty,
} from "@/lib/lease-signing-fee";
import { normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";

const LEASE_TABLE = "portal_lease_pipeline_records";

type LeaseRecord = {
  id: string;
  row_data: unknown;
  manager_user_id?: string | null;
  property_id?: string | null;
  resident_email?: string | null;
  resident_user_id?: string | null;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * The lease row is only this resident's when the stored identity matches. The
 * `or()` scope narrows the query; this re-checks the row it returned, because a
 * lease may carry one identity and not the other.
 */
function residentOwnsLease(record: LeaseRecord, residentUserId: string, email: string): boolean {
  const storedUserId = String(record.resident_user_id ?? "").trim();
  const storedEmail = String(record.resident_email ?? "").trim().toLowerCase();
  if (storedUserId) return storedUserId === residentUserId;
  return Boolean(storedEmail) && storedEmail === email;
}

async function loadOwnedLease(
  db: SupabaseClient,
  input: { leaseId: string; residentUserId: string; residentEmail: string },
): Promise<LeaseRecord | null> {
  const leaseId = input.leaseId.trim();
  const email = input.residentEmail.trim().toLowerCase();
  if (!leaseId) return null;
  const identityFilter = orFilterForIdentity([
    ["resident_user_id", input.residentUserId],
    ["resident_email", email],
  ]);
  if (!identityFilter) return null;

  const { data } = await db
    .from(LEASE_TABLE)
    .select("id, row_data, manager_user_id, property_id, resident_email, resident_user_id")
    .eq("id", leaseId)
    .or(identityFilter)
    .maybeSingle();

  const record = (data ?? null) as LeaseRecord | null;
  if (!record || !residentOwnsLease(record, input.residentUserId, email)) return null;
  return record;
}

export type ResidentLeaseSigningFeeStatus = {
  leaseId: string;
  feeCents: number;
  paid: boolean;
  managerUserId: string;
  propertyId: string | null;
};

/**
 * What this resident still owes to seal their signature on one lease.
 *
 * The amount is resolved from the manager's leasing-pipeline settings — never
 * from a client body — and `paid` is read off the lease row, so a resident who
 * has already paid is never asked twice.
 */
export async function loadResidentLeaseSigningFeeStatus(
  db: SupabaseClient,
  input: { leaseId: string; residentUserId: string; residentEmail: string },
): Promise<ResidentLeaseSigningFeeStatus | null> {
  const record = await loadOwnedLease(db, input);
  if (!record) return null;

  const rowData = asObject(record.row_data);
  const row = normalizeLeasePipelineRow(rowData);
  const managerUserId = String(record.manager_user_id ?? row.managerUserId ?? "").trim();
  const propertyId =
    String(record.property_id ?? row.propertyId ?? row.application?.propertyId ?? "").trim() || null;

  // No manager means no settings to price against; treat it as no fee rather
  // than blocking a signature on a lookup that cannot succeed.
  const feeCents = managerUserId
    ? await resolveLeaseSigningFeeCentsForProperty(db, managerUserId, propertyId)
    : 0;

  return {
    leaseId: record.id,
    feeCents,
    paid: residentHasPaidLeaseSigningFee(rowData, input.residentUserId),
    managerUserId,
    propertyId,
  };
}

export function isLeaseSigningFeeCheckoutSession(session: Stripe.Checkout.Session): boolean {
  return session.metadata?.purpose === LEASE_SIGNING_FEE_CHECKOUT_PURPOSE;
}

/**
 * Stamp the payer onto the lease row after a verified Stripe session.
 *
 * Both the lease id and the payer come from the session metadata Stripe signed
 * for us, and the write is still scoped to a row this resident owns.
 */
export async function markResidentLeaseSigningFeePaid(
  db: SupabaseClient,
  input: { leaseId: string; residentUserId: string; residentEmail: string },
): Promise<{ ok: true; alreadyPaid: boolean } | { ok: false; error: string }> {
  const record = await loadOwnedLease(db, input);
  if (!record) return { ok: false, error: "Lease not found." };

  const rowData = asObject(record.row_data);
  if (residentHasPaidLeaseSigningFee(rowData, input.residentUserId)) {
    return { ok: true, alreadyPaid: true };
  }

  const { error } = await db
    .from(LEASE_TABLE)
    .update({ row_data: recordLeaseSigningFeePaid(rowData, input.residentUserId) })
    .eq("id", record.id);

  if (error) return { ok: false, error: error.message };
  return { ok: true, alreadyPaid: false };
}
