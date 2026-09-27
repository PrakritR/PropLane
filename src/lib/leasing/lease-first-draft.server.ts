/**
 * "Send lease to sign" (lease-first), Part 3 hotfix defect 4. Today's send
 * only emails a create-account link — no lease row is created, nothing reads
 * the property it names, and the Lease tab stays locked for the new signup
 * because there is nothing for it to unlock onto.
 *
 * `createLeaseFirstDraft` makes the send real: a genuine `Draft` lease row,
 * server-authorized and server-scoped (never from client-supplied
 * `managerUserId`/`propertyId` alone — the caller must have already run
 * `managerMayFileLeaseUnderProperty`), marked `leaseFirst: true` so
 * `buildResidentLeaseDocumentRows` shows it to the resident before any
 * document exists.
 *
 * Idempotent per (manager, property, room, resident email) — a manager who
 * clicks "Send lease to sign" twice for the same person gets the SAME draft
 * back, never a duplicate. `syncApprovedApplications` /
 * `findLeaseRowIndexForApprovedApp` already match an approval onto an
 * existing lease row by email + property before falling back to axisId, so a
 * later approved application attaches to this same draft with no extra code.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";

export type LeaseFirstDraftParams = {
  managerUserId: string;
  propertyId: string;
  roomChoice?: string | null;
  name?: string | null;
  email: string;
  phone?: string | null;
};

export type LeaseFirstDraftResult =
  | { ok: true; created: boolean; leaseId: string }
  | { ok: false; error: string };

function buildLeaseFirstDraftUpsert(row: LeasePipelineRow) {
  return {
    id: row.id,
    manager_user_id: row.managerUserId ?? null,
    resident_user_id: null,
    resident_email: row.residentEmail,
    property_id: row.propertyId ?? null,
    status: row.bucket,
    row_data: row,
    updated_at: new Date().toISOString(),
  };
}

export async function createLeaseFirstDraft(
  db: SupabaseClient,
  params: LeaseFirstDraftParams,
): Promise<LeaseFirstDraftResult> {
  const managerUserId = params.managerUserId.trim();
  const propertyId = params.propertyId.trim();
  const email = params.email.trim().toLowerCase();
  const name = params.name?.trim() || "";
  const roomChoice = params.roomChoice?.trim() || null;
  if (!managerUserId || !propertyId) return { ok: false, error: "A property is required." };
  if (!email) return { ok: false, error: "A resident email is required." };

  const { data: existingRows, error: findError } = await db
    .from("portal_lease_pipeline_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId)
    .eq("property_id", propertyId)
    .eq("resident_email", email);
  if (findError) return { ok: false, error: findError.message };

  // Match on email + property only, the SAME key `findLeaseRowIndexForApprovedApp`
  // uses — a fresh "Send lease to sign" for the same person and property
  // reuses whatever draft already exists there (this call's own prior draft,
  // or one an approved application already created) rather than creating a
  // second, competing lease record for one tenancy.
  const existing = (existingRows ?? [])[0];
  if (existing) return { ok: true, created: false, leaseId: existing.id as string };

  const iso = new Date().toISOString();
  const leaseId = `lease_first_${randomUUID()}`;
  const row = normalizeLeasePipelineRow({
    id: leaseId,
    residentName: name || email,
    residentEmail: email,
    unit: "—",
    updated: iso,
    bucket: "manager",
    status: "Draft",
    pdfVersion: 1,
    notes: "Lease-first: resident invited to fill in lease details before a document exists.",
    updatedAtIso: iso,
    propertyId,
    roomChoice,
    managerUserId,
    leaseFirst: true,
    thread: [],
  });

  const { error: insertError } = await db
    .from("portal_lease_pipeline_records")
    .insert(buildLeaseFirstDraftUpsert(row));
  // A concurrent duplicate send races this insert; re-read and return the
  // winner rather than surfacing a spurious unique-constraint failure.
  if (insertError) {
    const { data: raced } = await db
      .from("portal_lease_pipeline_records")
      .select("id")
      .eq("manager_user_id", managerUserId)
      .eq("property_id", propertyId)
      .eq("resident_email", email)
      .maybeSingle();
    if (raced?.id) return { ok: true, created: false, leaseId: raced.id as string };
    return { ok: false, error: insertError.message };
  }
  return { ok: true, created: true, leaseId };
}
