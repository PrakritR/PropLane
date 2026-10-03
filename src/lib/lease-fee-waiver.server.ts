import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { managerCanAccessLeaseRecord } from "@/lib/auth/manager-lease-scope";
import type { HouseholdCharge } from "@/lib/household-charges";
import { readLeaseFeeWaiver, type LeaseFeeWaiver } from "@/lib/lease-at-signing";
import { normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { restoreFuturePaymentRemindersForCharge, cancelFuturePaymentRemindersForCharge } from "@/lib/payment-reminder-lifecycle.server";
import { syncLedgerChargeEntry } from "@/lib/reports/ledger-sync";

/**
 * Lease fee waivers - the lease-fee twin of `application-fee-waiver.ts`.
 *
 * A manager waives the lease fee for ONE resident/lease: the fee is not charged and drops out of the
 * at-signing total. The same shape as the application-fee waivers: manager-scoped routes, an audit row
 * (who, when, why), and the waiver is refused once the money has actually been paid (refund it instead).
 * Where an application-fee waiver is a CODE an applicant redeems, this one is a direct grant on the lease,
 * because the lease already names the resident.
 *
 * Effects, all server-side so the resident can never set or clear them:
 *  - the lease row's own application copy carries `managerLeaseFeeWaiver`, so a regenerated lease document
 *    and the billing snapshot both read it;
 *  - the lease's pending `lease_fee` charge becomes `cancelled` with the waiver stamped on it (cancelled is
 *    what "waived" has always meant for a charge: settled, no balance, not in any total);
 *  - the ledger entry for that charge is re-synced and its payment reminders are cancelled.
 */

const LEASE_TABLE = "portal_lease_pipeline_records";
const CHARGE_TABLE = "portal_household_charge_records";
const WAIVER_ACTION = "lease_fee_waived";
const REINSTATE_ACTION = "lease_fee_reinstated";
const MAX_REASON_LENGTH = 300;

type LeaseRecord = {
  id: string;
  manager_user_id: string | null;
  property_id: string | null;
  resident_email: string | null;
  row_data: Record<string, unknown> | null;
};

type ChargeRecord = { id: string; status: string | null; manager_user_id: string | null; row_data: HouseholdCharge };

export type LeaseFeeWaiverEntry = {
  leaseId: string;
  residentName: string;
  residentEmail: string;
  propertyId: string | null;
  waiver: LeaseFeeWaiver;
};

export type WaiveResult =
  | { ok: true; waiver: LeaseFeeWaiver; applicationIds: string[]; cancelledChargeIds: string[] }
  | { ok: false; status: number; error: string };

export type ReinstateResult =
  | { ok: true; applicationIds: string[]; reinstatedChargeIds: string[] }
  | { ok: false; status: number; error: string };

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function loadManagedLease(
  db: SupabaseClient,
  managerUserId: string,
  leaseId: string,
): Promise<{ ok: true; record: LeaseRecord } | { ok: false; status: number; error: string }> {
  const id = leaseId.trim();
  if (!id) return { ok: false, status: 400, error: "leaseId is required." };
  const { data, error } = await db
    .from(LEASE_TABLE)
    .select("id, manager_user_id, property_id, resident_email, row_data")
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  const record = (data ?? null) as LeaseRecord | null;
  // A lease the caller cannot manage is indistinguishable from one that does not exist.
  if (!record || !(await managerCanAccessLeaseRecord(db, managerUserId, record, "edit"))) {
    return { ok: false, status: 404, error: "Lease not found." };
  }
  return { ok: true, record };
}

function applicationIdsOf(row: ReturnType<typeof normalizeLeasePipelineRow>): string[] {
  const members = row.leaseKind === "joint_bundle" ? row.jointLeaseMembers ?? [] : [];
  return [row.axisId ?? "", ...members.map((m) => m.applicationId ?? "")].map((id) => id.trim()).filter(Boolean);
}

async function loadLeaseFeeCharges(
  db: SupabaseClient,
  record: LeaseRecord,
  row: ReturnType<typeof normalizeLeasePipelineRow>,
): Promise<{ ok: true; charges: ChargeRecord[] } | { ok: false; status: number; error: string }> {
  const propertyId = (record.property_id ?? row.propertyId ?? "").trim();
  let query = db.from(CHARGE_TABLE).select("id, status, manager_user_id, row_data").eq("kind", "lease_fee");
  if (propertyId) query = query.eq("property_id", propertyId);
  const { data, error } = await query;
  if (error) return { ok: false, status: 500, error: error.message };
  const appKeys = new Set(applicationIdsOf(row).map((id) => normalizeApplicationAxisId(id)));
  const emails = new Set(
    [row.residentEmail, record.resident_email ?? "", ...(row.jointLeaseMembers ?? []).map((m) => m.residentEmail ?? "")]
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  const charges = ((data ?? []) as ChargeRecord[]).filter((c) => {
    const charge = c.row_data;
    if (!charge || charge.kind !== "lease_fee") return false;
    const appId = charge.applicationId?.trim();
    if (appId && appKeys.size > 0) return appKeys.has(normalizeApplicationAxisId(appId));
    return emails.has(charge.residentEmail.trim().toLowerCase());
  });
  return { ok: true, charges };
}

async function writeAudit(
  db: SupabaseClient,
  input: { managerUserId: string; action: string; leaseId: string; reason: string; chargeIds: string[] },
): Promise<void> {
  const { error } = await db.from("audit_log").insert({
    actor_user_id: input.managerUserId,
    landlord_id: input.managerUserId,
    action: input.action,
    tool_name: input.action,
    input_summary: { leaseId: input.leaseId, reason: input.reason },
    result_summary: { chargeIds: input.chargeIds },
    dedupe_key: null,
    created_at: new Date().toISOString(),
  });
  // The waiver itself is already stamped on the lease and the charge; a missing audit row must not undo
  // money that was correctly waived, but it must not be silent either.
  if (error) console.error("[lease-fee-waiver] audit_log insert failed", error.message);
}

/** Waive the lease fee for one lease. Idempotent: waiving twice changes nothing. */
export async function waiveLeaseFee(
  db: SupabaseClient,
  input: { managerUserId: string; leaseId: string; reason?: string | null },
): Promise<WaiveResult> {
  const loaded = await loadManagedLease(db, input.managerUserId, input.leaseId);
  if (!loaded.ok) return loaded;
  const { record } = loaded;
  const rowData = asObject(record.row_data);
  const lease = normalizeLeasePipelineRow(rowData);
  if (lease.status === "Voided" || lease.voidedAt) {
    return { ok: false, status: 409, error: "This lease was voided." };
  }

  const found = await loadLeaseFeeCharges(db, record, lease);
  if (!found.ok) return found;
  // Money already collected (or clearing) is not waivable: that is a refund, with its own audit trail.
  const collected = found.charges.find((c) => {
    const status = c.status ?? c.row_data.status;
    return status === "paid" || status === "processing" || status === "partially_paid" || status === "refunded";
  });
  if (collected) {
    return { ok: false, status: 409, error: "The lease fee was already paid. Refund it instead of waiving it." };
  }

  const reason = (input.reason ?? "").trim().slice(0, MAX_REASON_LENGTH) || "Waived by manager";
  const existing = readLeaseFeeWaiver(asObject(rowData.application));
  const waiver: LeaseFeeWaiver = existing ?? {
    waivedAtIso: new Date().toISOString(),
    waivedByUserId: input.managerUserId,
    reason,
  };

  // 1. The lease row's application copy. Only when it already carries one: a stub application would be
  //    mistaken for a full application elsewhere.
  const application = asObject(rowData.application);
  if (Object.keys(application).length > 0 && !existing) {
    const { error } = await db
      .from(LEASE_TABLE)
      .update({ row_data: { ...rowData, application: { ...application, managerLeaseFeeWaiver: waiver } }, updated_at: waiver.waivedAtIso })
      .eq("id", record.id);
    if (error) return { ok: false, status: 500, error: error.message };
  }

  // 2. The charge(s): cancelled with the waiver stamped on, ledger re-synced, reminders stopped.
  const cancelledChargeIds: string[] = [];
  for (const c of found.charges) {
    const status = c.status ?? c.row_data.status;
    if (status === "cancelled") continue;
    const ownerId = c.manager_user_id ?? input.managerUserId;
    const next: HouseholdCharge = {
      ...c.row_data,
      status: "cancelled",
      waivedAt: waiver.waivedAtIso,
      waivedByUserId: waiver.waivedByUserId,
      waiverReason: waiver.reason,
    };
    const { error } = await db
      .from(CHARGE_TABLE)
      .update({ status: "cancelled", row_data: next, updated_at: waiver.waivedAtIso })
      .eq("id", c.id);
    if (error) return { ok: false, status: 500, error: error.message };
    await cancelFuturePaymentRemindersForCharge(db, ownerId, c.id).catch(() => undefined);
    await syncLedgerChargeEntry(db, { ...next, managerUserId: ownerId }).catch(() => undefined);
    cancelledChargeIds.push(c.id);
  }

  await writeAudit(db, {
    managerUserId: input.managerUserId,
    action: WAIVER_ACTION,
    leaseId: record.id,
    reason: waiver.reason,
    chargeIds: cancelledChargeIds,
  });
  return { ok: true, waiver, applicationIds: applicationIdsOf(lease), cancelledChargeIds };
}

/** Undo a waiver: the fee is owed again (a cancelled lease_fee goes back to pending with its amount). */
export async function reinstateLeaseFee(
  db: SupabaseClient,
  input: { managerUserId: string; leaseId: string },
): Promise<ReinstateResult> {
  const loaded = await loadManagedLease(db, input.managerUserId, input.leaseId);
  if (!loaded.ok) return loaded;
  const { record } = loaded;
  const rowData = asObject(record.row_data);
  const lease = normalizeLeasePipelineRow(rowData);
  const now = new Date().toISOString();

  const application = asObject(rowData.application);
  if (readLeaseFeeWaiver(application)) {
    const { managerLeaseFeeWaiver: _removed, ...rest } = application;
    void _removed;
    const { error } = await db
      .from(LEASE_TABLE)
      .update({ row_data: { ...rowData, application: rest }, updated_at: now })
      .eq("id", record.id);
    if (error) return { ok: false, status: 500, error: error.message };
  }

  const found = await loadLeaseFeeCharges(db, record, lease);
  if (!found.ok) return found;
  const reinstatedChargeIds: string[] = [];
  for (const c of found.charges) {
    const status = c.status ?? c.row_data.status;
    // Only a charge a waiver cancelled comes back; a charge cancelled for another reason stays cancelled.
    if (status !== "cancelled" || !c.row_data.waivedAt) continue;
    const ownerId = c.manager_user_id ?? input.managerUserId;
    const { waivedAt: _a, waivedByUserId: _b, waiverReason: _c, ...base } = c.row_data;
    void _a; void _b; void _c;
    const next: HouseholdCharge = {
      ...base,
      status: "pending",
      balanceLabel: base.amountLabel,
    };
    const { error } = await db
      .from(CHARGE_TABLE)
      .update({ status: "pending", row_data: next, updated_at: now })
      .eq("id", c.id);
    if (error) return { ok: false, status: 500, error: error.message };
    await restoreFuturePaymentRemindersForCharge(db, ownerId, c.id).catch(() => undefined);
    await syncLedgerChargeEntry(db, { ...next, managerUserId: ownerId }).catch(() => undefined);
    reinstatedChargeIds.push(c.id);
  }

  await writeAudit(db, {
    managerUserId: input.managerUserId,
    action: REINSTATE_ACTION,
    leaseId: record.id,
    reason: "Waiver removed",
    chargeIds: reinstatedChargeIds,
  });
  return { ok: true, applicationIds: applicationIdsOf(lease), reinstatedChargeIds };
}

/** The manager's OWN waived leases - never another manager's. */
export async function listLeaseFeeWaivers(db: SupabaseClient, managerUserId: string): Promise<LeaseFeeWaiverEntry[]> {
  const { data, error } = await db
    .from(LEASE_TABLE)
    .select("id, property_id, resident_email, row_data")
    .eq("manager_user_id", managerUserId.trim())
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  const out: LeaseFeeWaiverEntry[] = [];
  for (const record of (data ?? []) as Array<Omit<LeaseRecord, "manager_user_id">>) {
    const waiver = readLeaseFeeWaiver(asObject(asObject(record.row_data).application));
    if (!waiver) continue;
    const row = asObject(record.row_data);
    out.push({
      leaseId: record.id,
      residentName: typeof row.residentName === "string" ? row.residentName : "",
      residentEmail: (record.resident_email ?? (typeof row.residentEmail === "string" ? row.residentEmail : "")).trim(),
      propertyId: record.property_id ?? null,
      waiver,
    });
  }
  return out;
}
