import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import {
  chargeRefundIdempotencyKey,
  decideChargeRefund,
  type ChargeRefundContext,
} from "@/lib/charge-refund";
import { HouseholdChargeRefundReviewError,
  refundPaidHouseholdCharge } from "@/lib/household-charge-refund-rail.server";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

/** Days after resident signature before move-in charges auto-refund if the manager never countersigns. */
export const UNCOUNTER_SIGN_REFUND_AFTER_DAYS = 45;

const MOVE_IN_CHARGE_KINDS = new Set([
  "security_deposit",
  "prorated_first_month_rent",
  "prorated_first_month_utilities",
  "lease_fee",
  "move_in_fee",
  "other_cost",
  "signing_fee",
]);

type StaleLease = {
  leaseId: string;
  managerUserId: string;
  residentEmail: string;
  residentName: string;
  applicationId: string | null;
  residentSignedAt: string;
};

function parseStaleLease(row: {
  id: string;
  manager_user_id: string;
  resident_email: string | null;
  row_data: unknown;
}): StaleLease | null {
  const data = (row.row_data ?? {}) as LeasePipelineRow & Record<string, unknown>;
  if (data.status === "Voided" || data.status === "Fully Signed") return null;
  if (data.managerSignature) return null;
  if (!data.residentSignature?.signedAtIso) return null;
  if (data.status !== "Manager Signature Pending") return null;
  if (data.rentalType === "short_term") return null;
  const signedAt = Date.parse(data.residentSignature.signedAtIso);
  if (!Number.isFinite(signedAt)) return null;
  const axisId = typeof data.axisId === "string" ? normalizeApplicationAxisId(data.axisId) : "";
  return {
    leaseId: String(row.id),
    managerUserId: String(row.manager_user_id ?? data.managerUserId ?? "").trim(),
    residentEmail: String(data.residentEmail ?? row.resident_email ?? "").trim().toLowerCase(),
    residentName: String(data.residentName ?? "Resident").trim(),
    applicationId: axisId || null,
    residentSignedAt: data.residentSignature.signedAtIso,
  };
}

export async function listUncountersignedLeasesPastDeadline(
  db: SupabaseClient,
  now = new Date(),
): Promise<StaleLease[]> {
  const cutoff = now.getTime() - UNCOUNTER_SIGN_REFUND_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const out: StaleLease[] = [];
  for (let offset = 0; ; offset += 500) {
    // Filtered in the DATABASE, not in JS. `row_data` carries the uploaded lease
    // PDF as a base64 data URL plus the generated HTML, so paging the whole
    // table pulled potentially hundreds of MB through the egress budget on every
    // daily run. `parseStaleLease` re-checks both conditions, so narrowing here
    // can only ever reduce what crosses the wire.
    const { data, error } = await db
      .from("portal_lease_pipeline_records")
      .select("id, manager_user_id, resident_email, row_data")
      .eq("row_data->>status", "Manager Signature Pending")
      .lte("row_data->residentSignature->>signedAtIso", new Date(cutoff).toISOString())
      .order("id")
      .range(offset, offset + 499);
    if (error) throw new Error(`Could not list leases: ${error.message}`);
    for (const row of data ?? []) {
      const parsed = parseStaleLease(row);
      if (!parsed) continue;
      if (Date.parse(parsed.residentSignedAt) > cutoff) continue;
      out.push(parsed);
    }
    if ((data ?? []).length < 500) break;
  }
  return out;
}

/**
 * Three distinct answers, because "no refund happened" is not one thing:
 *
 * - `refunded` — money went back.
 * - `skipped` — there was nothing for THIS flow to send back: a `security_deposit`
 *   (it has its own Return deposit flow), an already-refunded charge, one never paid
 *   through PropLane. No money is outstanding, so the lease may still be voided.
 * - `needs_review` — the charge is paid and refundable but this flow cannot send it
 *   back. The resident's money is still held, so the lease must NOT be voided.
 */
type ChargeRefundOutcome =
  | { kind: "refunded" }
  | { kind: "skipped" }
  | { kind: "needs_review"; error: string };

async function refundChargeIfPaid(
  stripe: Stripe,
  db: SupabaseClient,
  chargeId: string,
): Promise<ChargeRefundOutcome> {
  const { data: row } = await db
    .from("portal_household_charge_records")
    .select("id, manager_user_id, status, row_data")
    .eq("id", chargeId)
    .maybeSingle();
  if (!row) return { kind: "skipped" };
  const charge = (row.row_data ?? {}) as Record<string, unknown>;
  const { data: payment } = await db
    .from("ledger_entries")
    .select("stripe_charge_id, amount_cents")
    .eq("source_charge_id", chargeId)
    .eq("entry_type", "payment")
    .maybeSingle();

  const ctx: ChargeRefundContext = {
    kind: String(charge.kind ?? ""),
    status: String(row.status ?? charge.status ?? ""),
    paidCents: Number(payment?.amount_cents ?? 0),
    alreadyRefundedCents: Number(charge.refundedCents ?? 0),
    stripeChargeId: (payment?.stripe_charge_id as string | null) ?? null,
    settled: charge.stripePaymentStatus !== "processing" && charge.stripePaymentStatus !== "pending",
  };
  const decision = decideChargeRefund(ctx);
  if (!decision.ok) return { kind: "skipped" };

  const attempt = Number(charge.refundAttempts ?? 0) + 1;
  // One rail decision, made by the payment: a central platform capture is
  // refunded through its reservation, a legacy destination charge reverses its
  // transfer. See `household-charge-refund-rail.server.ts`.
  try {
    await refundPaidHouseholdCharge(stripe, db, {
      chargeId,
      stripeChargeId: decision.stripeChargeId,
      amountCents: decision.amountCents,
      idempotencyKey: chargeRefundIdempotencyKey({ chargeId, amountCents: decision.amountCents, attempt }),
      metadata: { proplane_charge_id: chargeId, kind: "uncountersigned_lease_refund" },
    });
  } catch (error) {
    if (error instanceof HouseholdChargeRefundReviewError) {
      return { kind: "needs_review", error: error.message };
    }
    throw error;
  }
  const now = new Date().toISOString();
  await db.from("portal_household_charge_records").upsert(
    {
      id: chargeId,
      manager_user_id: row.manager_user_id,
      resident_email: String(charge.residentEmail ?? "").trim().toLowerCase(),
      status: row.status,
      row_data: {
        ...charge,
        refundedCents: ctx.alreadyRefundedCents + decision.amountCents,
        refundAttempts: attempt,
        lastRefundedAt: now,
        uncountersignedRefundAt: now,
      },
      updated_at: now,
    },
    { onConflict: "id" },
  );
  return { kind: "refunded" };
}

async function voidLeaseRow(db: SupabaseClient, leaseId: string, reason: string): Promise<void> {
  const { data } = await db.from("portal_lease_pipeline_records").select("row_data, manager_user_id").eq("id", leaseId).maybeSingle();
  if (!data) return;
  const current = (data.row_data && typeof data.row_data === "object" ? data.row_data : {}) as Record<string, unknown>;
  if (current.status === "Voided") return;
  const nowIso = new Date().toISOString();
  const thread = Array.isArray(current.thread) ? current.thread : [];
  const nextRowData = {
    ...current,
    voidedAt: nowIso,
    status: "Voided",
    stageLabel: "Voided",
    currentActorRole: "system",
    uncountersignedRefundAt: nowIso,
    thread: [
      ...thread,
      {
        id: `void-${nowIso}`,
        at: nowIso,
        actorRole: "system",
        text: reason,
      },
    ],
  };
  await db.from("portal_lease_pipeline_records").upsert(
    {
      id: leaseId,
      manager_user_id: data.manager_user_id,
      row_data: nextRowData,
      updated_at: nowIso,
    },
    { onConflict: "id" },
  );
}

export type UncountersignedRefundResult = {
  checked: number;
  refundedLeases: number;
  refundedCharges: number;
  failed: number;
  errors: string[];
};

/**
 * Refund move-in charges when a resident signed but the manager never countersigned
 * within {@link UNCOUNTER_SIGN_REFUND_AFTER_DAYS} days, then void the lease.
 */
export async function refundUncountersignedMoveInCharges(
  stripe: Stripe,
  db: SupabaseClient,
  now = new Date(),
): Promise<UncountersignedRefundResult> {
  const leases = await listUncountersignedLeasesPastDeadline(db, now);
  const result: UncountersignedRefundResult = {
    checked: leases.length,
    refundedLeases: 0,
    refundedCharges: 0,
    failed: 0,
    errors: [],
  };

  for (const lease of leases) {
    try {
      let chargeQuery = db
        .from("portal_household_charge_records")
        .select("id, status, row_data")
        .eq("manager_user_id", lease.managerUserId)
        .eq("resident_email", lease.residentEmail)
        .eq("status", "paid");
      if (lease.applicationId) {
        chargeQuery = chargeQuery.filter("row_data->>applicationId", "eq", lease.applicationId);
      }
      const { data: charges } = await chargeQuery;
      let refundedAny = false;
      let needsReview = false;
      for (const row of charges ?? []) {
        const kind = String((row.row_data as { kind?: string })?.kind ?? "");
        if (!MOVE_IN_CHARGE_KINDS.has(kind)) continue;
        const outcome = await refundChargeIfPaid(stripe, db, String(row.id));
        if (outcome.kind === "needs_review") {
          needsReview = true;
          result.errors.push(`${lease.leaseId}/${row.id}: ${outcome.error}`);
          continue;
        }
        if (outcome.kind === "refunded") {
          refundedAny = true;
          result.refundedCharges += 1;
        }
      }
      // Money still held on any move-in charge means the lease stays as it is — voiding it
      // would report a full refund over a resident who was never made whole. The refunds
      // that did succeed stay recorded; the lease is counted failed, as a throw used to.
      if (needsReview) {
        result.failed += 1;
        continue;
      }
      if (refundedAny || !(charges ?? []).some((c) => MOVE_IN_CHARGE_KINDS.has(String((c.row_data as { kind?: string })?.kind ?? "")))) {
        await voidLeaseRow(
          db,
          lease.leaseId,
          `Move-in charges were refunded automatically after ${UNCOUNTER_SIGN_REFUND_AFTER_DAYS} days without a manager countersignature.`,
        );
        result.refundedLeases += 1;
      }
    } catch (e) {
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push(`${lease.leaseId}: ${message}`);
    }
  }
  return result;
}
