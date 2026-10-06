import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import {
  chargeRefundIdempotencyKey,
  decideChargeRefund,
  type ChargeRefundContext,
} from "@/lib/charge-refund";
import { HouseholdChargeRefundReviewError, refundPaidHouseholdCharge,
  resolveHouseholdChargeRefundRail } from "@/lib/household-charge-refund-rail.server";
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
 * A move-in charge classified WITHOUT touching Stripe, so the whole lease can be
 * decided before any money moves. A half-refunded lease is the one outcome this
 * flow must never produce: the charges it returned are gone, but the lease is still
 * countersignable, and nothing downstream checks for that.
 *
 * - `refundable` — paid, refundable here, and its rail resolved.
 * - `skipped` — this job sends nothing back. Either nothing is outstanding (never
 *   paid, or already refunded/returned), or it is a `security_deposit`: deposits are
 *   returned by the manager through Return deposit, not by this job, so a held one
 *   does not block the void. `depositHeldCents` carries it so it stays visible.
 * - `needs_review` — paid and outstanding, but this job cannot return it: a payment
 *   still clearing, one taken outside PropLane, or a rail refusal such as a
 *   pre-arbitration hold. One of these refunds NOTHING on the lease.
 */
type MoveInChargePlan =
  | {
      kind: "refundable";
      chargeId: string;
      managerUserId: unknown;
      status: unknown;
      charge: Record<string, unknown>;
      stripeChargeId: string;
      amountCents: number;
      alreadyRefundedCents: number;
      attempt: number;
    }
  | { kind: "skipped"; depositHeldCents: number }
  | { kind: "needs_review"; chargeId: string; error: string };

/**
 * What the manager still holds of this charge. A security deposit tracks its returns in
 * `depositReturnedCents` (Return deposit) while every other kind uses `refundedCents`,
 * so the larger of the two is the amount already sent back either way.
 */
function outstandingHeldCents(charge: Record<string, unknown>, paidCents: number): number {
  const sentBack = Math.max(
    Math.round(Number(charge.refundedCents ?? 0)) || 0,
    Math.round(Number(charge.depositReturnedCents ?? 0)) || 0,
  );
  return Math.max(0, Math.round(paidCents) - sentBack);
}

async function planMoveInChargeRefund(
  db: SupabaseClient,
  chargeId: string,
): Promise<MoveInChargePlan> {
  const { data: row } = await db
    .from("portal_household_charge_records")
    .select("id, manager_user_id, status, row_data")
    .eq("id", chargeId)
    .maybeSingle();
  if (!row) return { kind: "skipped", depositHeldCents: 0 };
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
  if (!decision.ok) {
    const outstanding = outstandingHeldCents(charge, ctx.paidCents);
    if (decision.reason === "not_paid" || decision.reason === "nothing_left" || outstanding <= 0) {
      return { kind: "skipped", depositHeldCents: 0 };
    }
    if (decision.reason === "is_a_deposit") {
      return { kind: "skipped", depositHeldCents: outstanding };
    }
    return { kind: "needs_review", chargeId, error: decision.message };
  }

  try {
    await resolveHouseholdChargeRefundRail(db, {
      chargeId,
      stripeChargeId: decision.stripeChargeId,
      amountCents: decision.amountCents,
    });
  } catch (error) {
    if (error instanceof HouseholdChargeRefundReviewError) {
      return { kind: "needs_review", chargeId, error: error.message };
    }
    throw error;
  }

  return {
    kind: "refundable",
    chargeId,
    managerUserId: row.manager_user_id,
    status: row.status,
    charge,
    stripeChargeId: decision.stripeChargeId,
    amountCents: decision.amountCents,
    alreadyRefundedCents: ctx.alreadyRefundedCents,
    attempt: Number(charge.refundAttempts ?? 0) + 1,
  };
}

async function executeMoveInChargeRefund(
  stripe: Stripe,
  db: SupabaseClient,
  plan: Extract<MoveInChargePlan, { kind: "refundable" }>,
): Promise<void> {
  // One rail decision, made by the payment: a central platform capture is refunded
  // through its reservation, a legacy destination charge reverses its transfer. See
  // `household-charge-refund-rail.server.ts`.
  await refundPaidHouseholdCharge(stripe, db, {
    chargeId: plan.chargeId,
    stripeChargeId: plan.stripeChargeId,
    amountCents: plan.amountCents,
    idempotencyKey: chargeRefundIdempotencyKey({
      chargeId: plan.chargeId, amountCents: plan.amountCents, attempt: plan.attempt,
    }),
    metadata: { proplane_charge_id: plan.chargeId, kind: "uncountersigned_lease_refund" },
  });
  const now = new Date().toISOString();
  await db.from("portal_household_charge_records").upsert(
    {
      id: plan.chargeId,
      manager_user_id: plan.managerUserId,
      resident_email: String(plan.charge.residentEmail ?? "").trim().toLowerCase(),
      status: plan.status,
      row_data: {
        ...plan.charge,
        refundedCents: plan.alreadyRefundedCents + plan.amountCents,
        refundAttempts: plan.attempt,
        lastRefundedAt: now,
        uncountersignedRefundAt: now,
      },
      updated_at: now,
    },
    { onConflict: "id" },
  );
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
  /** Security deposits left with the manager on voided leases, for Return deposit to settle. */
  depositHeldCents: number;
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
    depositHeldCents: 0,
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
      const moveInRows = (charges ?? []).filter((row) =>
        MOVE_IN_CHARGE_KINDS.has(String((row.row_data as { kind?: string })?.kind ?? "")));

      // Plan the whole lease before any money moves. A charge this job cannot return
      // means it returns NOTHING here: a lease whose rent was refunded but whose void
      // was blocked stays countersignable, and nothing downstream notices.
      const plans: MoveInChargePlan[] = [];
      for (const row of moveInRows) {
        plans.push(await planMoveInChargeRefund(db, String(row.id)));
      }
      const review = plans.filter((plan): plan is Extract<MoveInChargePlan, { kind: "needs_review" }> =>
        plan.kind === "needs_review");
      if (review.length > 0) {
        result.failed += 1;
        for (const plan of review) {
          result.errors.push(`${lease.leaseId}/${plan.chargeId}: ${plan.error}`);
        }
        continue;
      }

      const depositHeldCents = plans.reduce(
        (sum, plan) => sum + (plan.kind === "skipped" ? plan.depositHeldCents : 0), 0);
      let refundedAny = false;
      for (const plan of plans) {
        if (plan.kind !== "refundable") continue;
        await executeMoveInChargeRefund(stripe, db, plan);
        refundedAny = true;
        result.refundedCharges += 1;
      }
      result.depositHeldCents += depositHeldCents;

      if (refundedAny || moveInRows.length === 0) {
        const held = depositHeldCents > 0
          ? " The security deposit is not included and is still held for Return deposit."
          : "";
        await voidLeaseRow(
          db,
          lease.leaseId,
          `Move-in charges were refunded automatically after ${UNCOUNTER_SIGN_REFUND_AFTER_DAYS} days without a manager countersignature.${held}`,
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
