import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  householdChargeDueDate,
  isUnpaidHouseholdCharge,
  type HouseholdCharge,
  type HouseholdChargeKind,
} from "@/lib/household-charges";
import {
  householdChargeAmountCents,
  HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE,
  markHouseholdChargePaidFromPaymentIntent,
} from "@/lib/stripe-household-charge";
import {
  loadHouseholdChargesForCheckout,
  resolveHouseholdChargeFeePayer,
} from "@/lib/stripe-household-charge-checkout.server";
import { residentServiceFeeBreakdown, type ResidentAxisPaymentMethod } from "@/lib/payment-policy";
import { resolveConnectDestinationIfReady } from "@/lib/stripe-connect";
import { creditHoldFromPaymentIntent } from "@/lib/stripe-platform-hold.server";
import { getStripe } from "@/lib/stripe";
import { deliverPaymentReminder, reminderHtmlFromText } from "@/lib/payment-reminder-delivery";
import { loadManagerAutomationSettings, DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";

/**
 * Autopay only covers rent and recurring charges — one-off charges (fees,
 * damages, application/holding money) still need a manual Pay. Captain
 * decision, PLAN-0920-1051 Wave 1.
 */
export const AUTOPAY_RECURRING_KINDS: ReadonlySet<HouseholdChargeKind> = new Set(["rent", "utilities"]);

/** The first charge plus the one allowed retry — `resident_autopay_runs.attempt` never passes this. */
export const AUTOPAY_MAX_ATTEMPTS = 2;

/**
 * `manager_user_id`/`resident_user_id` columns this module queries are typed
 * `uuid`. A profile can carry a non-UUID `manager_id`/user id (a legacy or
 * malformed link — e.g. a pre-migration fixture row), and handing that
 * straight to `.eq(...)` makes Postgres reject the whole query with
 * `22P02 invalid input syntax for type uuid` instead of just returning zero
 * rows. Treat that one error the same way an empty result already is: no
 * valid manager link means no autopay household, not a 500 — every other
 * not-linked-yet resident already gets the same "no household" response.
 */
function isInvalidUuidInputError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "22P02" || /invalid input syntax for type uuid/i.test(error.message ?? "");
}

/** The same `residentEmail|propertyId` key `recurringRentProfileKey` groups a resident's recurring charges by. */
export function residentAutopayHouseholdKey(residentEmail: string, propertyId: string): string {
  return `${residentEmail.trim().toLowerCase()}|${propertyId}`;
}

export type ResidentAutopaySettingsRow = {
  id: string;
  residentUserId: string;
  managerId: string;
  householdKey: string;
  enabled: boolean;
  paymentMethodId: string | null;
  runDaysBeforeDue: number;
};

function normalizeSettingsRow(row: Record<string, unknown>): ResidentAutopaySettingsRow {
  return {
    id: String(row.id ?? ""),
    residentUserId: String(row.resident_user_id ?? ""),
    managerId: String(row.manager_id ?? ""),
    householdKey: String(row.household_key ?? ""),
    enabled: row.enabled === true,
    paymentMethodId: typeof row.payment_method_id === "string" && row.payment_method_id ? row.payment_method_id : null,
    runDaysBeforeDue: Math.min(5, Math.max(0, Number(row.run_days_before_due ?? 0))),
  };
}

/** The resident's own autopay settings row for one household, or null if never saved. */
export async function loadResidentAutopaySettings(
  db: SupabaseClient,
  residentUserId: string,
  householdKey: string,
): Promise<ResidentAutopaySettingsRow | null> {
  const { data, error } = await db
    .from("resident_autopay_settings")
    .select("id, resident_user_id, manager_id, household_key, enabled, payment_method_id, run_days_before_due")
    .eq("resident_user_id", residentUserId)
    .eq("household_key", householdKey)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normalizeSettingsRow(data as Record<string, unknown>) : null;
}

/**
 * Enroll/update/turn off autopay for one resident's household. Upserts on the
 * `(resident_user_id, household_key)` unique key so a resident can only ever
 * hold one row per household.
 */
export async function saveResidentAutopaySettings(
  db: SupabaseClient,
  input: {
    residentUserId: string;
    managerId: string;
    householdKey: string;
    enabled: boolean;
    paymentMethodId: string | null;
    runDaysBeforeDue: number;
  },
): Promise<ResidentAutopaySettingsRow> {
  const runDaysBeforeDue = Math.min(5, Math.max(0, Math.round(input.runDaysBeforeDue)));
  const { data, error } = await db
    .from("resident_autopay_settings")
    .upsert(
      {
        resident_user_id: input.residentUserId,
        manager_id: input.managerId,
        household_key: input.householdKey,
        enabled: input.enabled,
        payment_method_id: input.paymentMethodId,
        run_days_before_due: runDaysBeforeDue,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "resident_user_id,household_key" },
    )
    .select("id, resident_user_id, manager_id, household_key, enabled, payment_method_id, run_days_before_due")
    .single();
  if (error) throw new Error(error.message);
  return normalizeSettingsRow(data as Record<string, unknown>);
}

export type ResidentAutopayHousehold = { propertyId: string; householdKey: string; nextCharge: HouseholdCharge | null };

function compareByDueThen(a: HouseholdCharge, b: HouseholdCharge, tieBreak: (c: HouseholdCharge) => string): number {
  const at = householdChargeDueDate(a)?.getTime() ?? Infinity;
  const bt = householdChargeDueDate(b)?.getTime() ?? Infinity;
  if (at !== bt) return at - bt;
  return tieBreak(a).localeCompare(tieBreak(b));
}

/**
 * The resident's current household for autopay — the same
 * `residentEmail|propertyId` grouping `recurringRentProfileKey` already uses
 * for a recurring rent profile. A resident with more than one tenancy under
 * this manager names the one they mean with `propertyId`, which must be a
 * property they actually hold a recurring charge for; otherwise the pick is
 * deterministic — the property of the soonest-due unpaid recurring charge,
 * ties broken by `propertyId` ascending — so GET/PUT on the settings route
 * and the `set_autopay` tool always land on the same household. A resident
 * with no recurring charge yet has no household to enroll.
 *
 * `nextCharge` is the soonest unpaid recurring charge for that property that
 * has no run row yet — i.e. exactly what {@link listAutopayDueCharges} will
 * pick up — so the enroll preview never names a charge the sweep will not pay.
 */
export async function resolveResidentAutopayHousehold(
  db: SupabaseClient,
  input: { residentEmail: string; managerId: string; propertyId?: string | null },
): Promise<ResidentAutopayHousehold | null> {
  const { data: rows, error } = await db
    .from("portal_household_charge_records")
    .select("row_data")
    .eq("manager_user_id", input.managerId)
    .eq("resident_email", input.residentEmail.trim().toLowerCase())
    .in("kind", [...AUTOPAY_RECURRING_KINDS])
    .limit(500);
  if (error) {
    if (isInvalidUuidInputError(error)) return null;
    throw new Error(error.message);
  }

  const charges = (rows ?? [])
    .map((row) => row.row_data as HouseholdCharge | null)
    .filter((charge): charge is HouseholdCharge => Boolean(charge?.id && charge?.propertyId));
  if (charges.length === 0) return null;

  const requestedPropertyId = input.propertyId?.trim() ?? "";
  let propertyId: string;
  if (requestedPropertyId) {
    if (!charges.some((c) => c.propertyId === requestedPropertyId)) return null;
    propertyId = requestedPropertyId;
  } else {
    const soonestUnpaid = charges
      .filter(isUnpaidHouseholdCharge)
      .sort((a, b) => compareByDueThen(a, b, (c) => c.propertyId))[0];
    propertyId = soonestUnpaid?.propertyId ?? [...new Set(charges.map((c) => c.propertyId))].sort()[0]!;
  }
  const householdKey = residentAutopayHouseholdKey(input.residentEmail, propertyId);

  const unpaid = charges
    .filter((c) => c.propertyId === propertyId && isUnpaidHouseholdCharge(c))
    .sort((a, b) => compareByDueThen(a, b, (c) => c.id));
  const alreadyRun = new Set<string>();
  if (unpaid.length > 0) {
    const { data: runRows, error: runErr } = await db
      .from("resident_autopay_runs")
      .select("charge_id")
      .in(
        "charge_id",
        unpaid.map((c) => c.id),
      );
    if (runErr) throw new Error(runErr.message);
    for (const row of runRows ?? []) alreadyRun.add(String(row.charge_id));
  }
  const nextCharge = unpaid.find((c) => !alreadyRun.has(c.id)) ?? null;

  return { propertyId, householdKey, nextCharge };
}

/** "Oct 1 · $1,510.00" — the run date (due date minus days-before) and amount, for GET/set_autopay to show. */
export function autopayNextScheduledChargeLabel(
  charge: HouseholdCharge | null,
  runDaysBeforeDue: number,
  formatDate: (date: Date) => string,
): string | null {
  if (!charge) return null;
  const due = householdChargeDueDate(charge);
  if (!due) return null;
  const runDate = autopayRunDate(due, runDaysBeforeDue);
  const amountCents = householdChargeAmountCents(charge);
  const amount = `$${(amountCents / 100).toFixed(2)}`;
  return `${formatDate(runDate)} · ${amount}`;
}

export type AutopayDueItem = {
  chargeId: string;
  residentUserId: string;
  residentEmail: string;
  managerId: string;
  propertyId: string;
  paymentMethodId: string;
};

/**
 * The calendar day a due date resolves to. `householdChargeDueDate` anchors
 * the day at local noon, so its own calendar fields are the day it means on
 * any server; "today" is the Pacific calendar date, the same frame every
 * resident-facing due-date label (`formatPacificDate`) is rendered in.
 */
function calendarYmd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Due date minus the resident's days-before-due, as the Pacific-frame calendar day the charge should run on. */
export function autopayRunDate(due: Date, runDaysBeforeDue: number): Date {
  const runDate = new Date(due);
  runDate.setDate(runDate.getDate() - runDaysBeforeDue);
  return runDate;
}

/**
 * Enrolled residents whose run date (due date minus their chosen
 * run-days-before-due) is `today` or earlier in Pacific time — recurring-kind,
 * unpaid, and with no run row yet (a run row of ANY status blocks a re-list;
 * the retry path is separate and explicit, never this listing). Listing
 * every past-due run date rather than only today's means a charge missed by
 * a skipped pass, or one already due when the resident enrolled, is still
 * paid; the unique run row per charge is what keeps that from ever charging
 * twice.
 */
export async function listAutopayDueCharges(db: SupabaseClient, today: Date = new Date()): Promise<AutopayDueItem[]> {
  const todayYmd = pacificCalendarDateYmd(today);
  const { data: settingsRows, error: settingsErr } = await db
    .from("resident_autopay_settings")
    .select("id, resident_user_id, manager_id, household_key, enabled, payment_method_id, run_days_before_due")
    .eq("enabled", true);
  if (settingsErr) throw new Error(settingsErr.message);
  const enrolled = (settingsRows ?? [])
    .map((row) => normalizeSettingsRow(row as Record<string, unknown>))
    .filter((row) => row.enabled && row.paymentMethodId);
  if (enrolled.length === 0) return [];

  const residentUserIds = [...new Set(enrolled.map((row) => row.residentUserId))];
  const { data: chargeRows, error: chargeErr } = await db
    .from("portal_household_charge_records")
    .select("id, row_data, status, resident_user_id, manager_user_id")
    .in("resident_user_id", residentUserIds)
    .eq("status", "pending");
  if (chargeErr) throw new Error(chargeErr.message);

  const chargeIds = (chargeRows ?? []).map((row) => String(row.id));
  const runRows =
    chargeIds.length > 0
      ? await db.from("resident_autopay_runs").select("charge_id").in("charge_id", chargeIds)
      : { data: [] as { charge_id: string }[], error: null };
  if (runRows.error) throw new Error(runRows.error.message);
  const alreadyRun = new Set((runRows.data ?? []).map((row) => String(row.charge_id)));

  const settingsByKey = new Map(enrolled.map((row) => [`${row.residentUserId}|${row.householdKey}`, row]));

  const out: AutopayDueItem[] = [];
  for (const row of chargeRows ?? []) {
    const charge = row.row_data as HouseholdCharge | null;
    if (!charge?.id) continue;
    if (!AUTOPAY_RECURRING_KINDS.has(charge.kind)) continue;
    if (!isUnpaidHouseholdCharge(charge)) continue;
    if (alreadyRun.has(String(row.id))) continue;

    const residentUserId = String(row.resident_user_id ?? charge.residentUserId ?? "");
    if (!residentUserId) continue;
    const householdKey = residentAutopayHouseholdKey(charge.residentEmail, charge.propertyId);
    const settings = settingsByKey.get(`${residentUserId}|${householdKey}`);
    if (!settings) continue;

    const managerId = String(row.manager_user_id ?? charge.managerUserId ?? "");
    if (!managerId || managerId !== settings.managerId) continue;

    const due = householdChargeDueDate(charge);
    if (!due) continue;
    if (calendarYmd(autopayRunDate(due, settings.runDaysBeforeDue)) > todayYmd) continue;

    out.push({
      chargeId: String(row.id),
      residentUserId,
      residentEmail: charge.residentEmail,
      managerId,
      propertyId: charge.propertyId,
      paymentMethodId: settings.paymentMethodId!,
    });
  }
  return out;
}

export type ClaimRunResult = { claimed: true; runId: string } | { claimed: false };

/**
 * Claim a charge for an autopay attempt. The insert's unique `charge_id`
 * constraint IS the double-charge guard: a unique violation means another
 * pass (or an overlapping cron invocation) already claimed this charge, so
 * the caller skips rather than charging twice. Never update an existing row
 * here — a retry attempt goes through {@link retryAutopayRun} instead, which
 * makes the "new attempt" explicit rather than silently reusing a claim.
 */
export async function claimRun(
  db: SupabaseClient,
  input: { chargeId: string; residentUserId: string; managerId: string },
): Promise<ClaimRunResult> {
  const { data, error } = await db
    .from("resident_autopay_runs")
    .insert({
      charge_id: input.chargeId,
      resident_user_id: input.residentUserId,
      manager_id: input.managerId,
      status: "claimed",
    })
    .select("id")
    .single();
  if (error) {
    // Postgres unique_violation. Some fakes/older drivers surface it without a
    // code, so also treat Postgres's own message text as the same signal.
    if (error.code === "23505" || /duplicate key/i.test(error.message)) {
      return { claimed: false };
    }
    throw new Error(error.message);
  }
  return { claimed: true, runId: String((data as { id: unknown }).id) };
}

async function updateRun(
  db: SupabaseClient,
  runId: string,
  patch: { status: "succeeded" | "failed"; stripePaymentIntentId?: string; failureReason?: string },
): Promise<void> {
  const { error } = await db
    .from("resident_autopay_runs")
    .update({
      status: patch.status,
      stripe_payment_intent_id: patch.stripePaymentIntentId ?? null,
      failure_reason: patch.failureReason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw new Error(error.message);
}

export type ChargeAutopayResult =
  | { ok: true; paymentIntentId: string }
  | { ok: false; reason: string; declined?: boolean };

/**
 * Charge ONE claimed autopay run: an off-session PaymentIntent on the
 * connected account, using the SAME amount/fee/transfer computation a manual
 * household-charge checkout uses — {@link loadHouseholdChargesForCheckout} for
 * ownership/eligibility, {@link resolveHouseholdChargeFeePayer} for who pays
 * the service fee, and {@link residentServiceFeeBreakdown} for the numbers.
 * Never forks that math: only the Stripe object differs (a PaymentIntent
 * instead of a Checkout Session), because nobody is present to redirect.
 */
export async function chargeAutopay(
  db: SupabaseClient,
  run: {
    id: string;
    chargeId: string;
    residentUserId: string;
    residentEmail: string;
    managerId: string;
    paymentMethodId: string;
    /** The run row's `attempt` — 1 for the first charge, 2 for the one allowed retry (see {@link retryAutopayRun}). */
    attempt?: number;
  },
): Promise<ChargeAutopayResult> {
  const attempt = Math.max(1, Math.round(run.attempt ?? 1));
  const fail = (reason: string) => updateRun(db, run.id, { status: "failed", failureReason: reason });

  const resolved = await loadHouseholdChargesForCheckout(db, {
    userId: run.residentUserId,
    userEmail: run.residentEmail,
    chargeIds: [run.chargeId],
    expectedManagerUserId: run.managerId,
  });
  if (!resolved.ok) {
    await fail(resolved.error);
    return { ok: false, reason: resolved.error };
  }
  const { loaded, managerUserId } = resolved;
  const loadedCharge = loaded[0]!;

  const feePayerResolved = await resolveHouseholdChargeFeePayer(db, managerUserId, loaded);
  if (!feePayerResolved.ok) {
    await fail(feePayerResolved.error);
    return { ok: false, reason: feePayerResolved.error };
  }
  const { feePayer } = feePayerResolved;

  const stripe = getStripe();
  const destinationAccountId = await resolveConnectDestinationIfReady(stripe, db, managerUserId);

  const { data: profile } = await db
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", run.residentUserId)
    .maybeSingle();
  const customerId = String(profile?.stripe_customer_id ?? "").trim();
  if (!customerId) {
    const reason = "No saved payment method on file.";
    await fail(reason);
    return { ok: false, reason };
  }

  let method: ResidentAxisPaymentMethod = "ach";
  try {
    const pm = await stripe.paymentMethods.retrieve(run.paymentMethodId);
    method = pm.type === "us_bank_account" ? "ach" : "card";
  } catch {
    const reason = "Saved payment method could not be verified.";
    await fail(reason);
    return { ok: false, reason };
  }

  const subtotalCents = householdChargeAmountCents(loadedCharge.charge);
  if (subtotalCents < 100) {
    const reason = "Charge amount is invalid.";
    await fail(reason);
    return { ok: false, reason };
  }

  const fee = residentServiceFeeBreakdown(subtotalCents, method, feePayer);
  if (fee.applicationFeeCents > 0 && fee.applicationFeeCents >= fee.totalCents) {
    const reason = "Service fee configuration prevents this charge.";
    await fail(reason);
    return { ok: false, reason };
  }

  try {
    const holdPath = !destinationAccountId;
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: fee.totalCents,
        currency: "usd",
        customer: customerId,
        payment_method: run.paymentMethodId,
        off_session: true,
        confirm: true,
        ...(destinationAccountId ? { transfer_data: { destination: destinationAccountId } } : {}),
        ...(!holdPath && fee.applicationFeeCents > 0 ? { application_fee_amount: fee.applicationFeeCents } : {}),
        metadata: {
          purpose: HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE,
          autopay_run_id: run.id,
          autopay_attempt: String(attempt),
          charge_id: run.chargeId,
          manager_user_id: managerUserId,
          resident_email: run.residentEmail.trim().toLowerCase(),
          payment_method: method,
          fee_payer: feePayer,
          manager_payout_cents: String(fee.managerPayoutCents),
          ...(holdPath ? { platform_hold: "1", hold_amount_cents: String(fee.managerPayoutCents) } : {}),
        },
      },
      { idempotencyKey: `autopay:${run.id}:${attempt}` },
    );
    // The webhook (payment_intent.succeeded / .payment_failed) is the
    // authoritative settle path — a synchronous card decline still arrives
    // there too, but marking succeeded here when Stripe already confirmed it
    // synchronously avoids waiting on webhook delivery to show the resident a
    // paid charge.
    if (paymentIntent.status === "succeeded") {
      await markHouseholdChargePaidFromPaymentIntent(db, paymentIntent, run.chargeId);
      await creditHoldFromPaymentIntent(db, paymentIntent).catch(() => undefined);
      await updateRun(db, run.id, { status: "succeeded", stripePaymentIntentId: paymentIntent.id });
    }
    return { ok: true, paymentIntentId: paymentIntent.id };
  } catch (e) {
    const reason = (e instanceof Error && e.message) || "The payment was declined.";
    await fail(reason);
    await notifyAutopayDeclined(db, {
      charge: loadedCharge.charge,
      managerId: managerUserId,
      declineMessage: reason,
    }).catch(() => undefined);
    return { ok: false, reason, declined: true };
  }
}

/**
 * The resident-facing decline notice: "Autopay could not pay <charge title> —
 * <method> was declined. Nothing was charged." Sent through the same delivery
 * path a manual payment reminder uses, so it lands wherever the resident
 * already receives payment notices (email/SMS/inbox per their preferences).
 */
export async function notifyAutopayDeclined(
  db: SupabaseClient,
  input: { charge: HouseholdCharge; managerId: string; declineMessage: string },
): Promise<{ sent: boolean; error?: string }> {
  const { charge, managerId, declineMessage } = input;
  const settings = await loadManagerAutomationSettings(db, managerId).catch(() => DEFAULT_MANAGER_AUTOMATION_SETTINGS);
  const { data: managerProfile } = await db
    .from("profiles")
    .select("full_name, email, sms_from_number")
    .eq("id", managerId)
    .maybeSingle();
  const managerName = managerProfile?.full_name?.trim() || managerProfile?.email?.trim() || "Your property manager";
  const managerSmsFromNumber = String(managerProfile?.sms_from_number ?? "").trim();
  const from = await managerOutboundFromHeader(db, managerId);
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";

  const subject = `Autopay could not pay ${charge.title}`;
  const text = `Autopay could not pay ${charge.title} — ${declineMessage} Nothing was charged. Open Payments to pay now or update your autopay method.`;

  return deliverPaymentReminder({
    db,
    charge,
    managerId,
    dedupId: `autopay_declined_${charge.id}_${new Date().toISOString().slice(0, 10)}`,
    managerName,
    managerSmsFromNumber,
    apiKey,
    from,
    subject,
    text,
    html: reminderHtmlFromText(text),
    slotLabel: "autopay_declined",
    eventCategory: "payments",
    managerDeliverViaEmail: settings.paymentReminderDeliverViaEmail,
    managerDeliverViaSms: settings.paymentReminderDeliverViaSms,
    managerDeliverViaInbox: settings.paymentReminderDeliverViaInbox,
  });
}

/**
 * A declined run may retry ONCE, three days after it failed. `charge_id` is
 * UNIQUE, so a retry cannot claim a second row for the same charge — it
 * transitions the existing failed row back to `claimed` in place and bumps
 * `attempt`, the counter that stops a THIRD attempt: a failed row already at
 * {@link AUTOPAY_MAX_ATTEMPTS} is never retried, whether the failure was
 * recorded synchronously by {@link chargeAutopay} or days later by the
 * `payment_intent.payment_failed` webhook. The update is conditional on the
 * row still being `failed` at the same attempt and reports whether it
 * actually transitioned, so two overlapping passes cannot both claim it.
 */
export async function retryAutopayRun(
  db: SupabaseClient,
  failedRun: { id: string; updatedAt: string; attempt: number },
  now: Date = new Date(),
): Promise<{ retried: true; attempt: number } | { retried: false }> {
  const currentAttempt = Math.max(1, Math.round(failedRun.attempt));
  if (currentAttempt >= AUTOPAY_MAX_ATTEMPTS) return { retried: false };
  const failedAt = new Date(failedRun.updatedAt);
  const daysSinceFailure = (now.getTime() - failedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceFailure < 3) return { retried: false };

  const nextAttempt = currentAttempt + 1;
  const { data, error } = await db
    .from("resident_autopay_runs")
    .update({ status: "claimed", attempt: nextAttempt, failure_reason: null, updated_at: now.toISOString() })
    .eq("id", failedRun.id)
    .eq("status", "failed")
    .eq("attempt", currentAttempt)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return { retried: false };
  return { retried: true, attempt: nextAttempt };
}

export type AutopayRetryCandidate = {
  runId: string;
  chargeId: string;
  residentUserId: string;
  residentEmail: string;
  managerId: string;
  propertyId: string;
  paymentMethodId: string;
  /** The failed row's current attempt; {@link retryAutopayRun} bumps it. */
  attempt: number;
  /** When the failure was recorded — the three-day clock starts here. */
  updatedAt: string;
};

/** `resident_autopay_runs.attempt` as stored; rows from before the column existed read as the first attempt. */
export function runAttempt(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
}

/**
 * Failed runs that are candidates for the one allowed retry: three-plus days
 * old, never retried before, still enrolled with a saved method, and their
 * charge is still actually unpaid. The manager's own
 * `workspaceAutopayRetryEnabled` gate is checked by the caller per property
 * (it needs a workspace lookup this module does not own), not here.
 */
export async function listFailedAutopayRunsEligibleForRetry(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<AutopayRetryCandidate[]> {
  const { data: failedRuns, error } = await db
    .from("resident_autopay_runs")
    .select("id, charge_id, resident_user_id, manager_id, attempt, updated_at")
    .eq("status", "failed");
  if (error) throw new Error(error.message);

  const candidates = (failedRuns ?? []).filter((row) => {
    if (runAttempt(row.attempt) >= AUTOPAY_MAX_ATTEMPTS) return false;
    const updatedAt = new Date(String(row.updated_at));
    const daysSinceFailure = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceFailure >= 3;
  });
  if (candidates.length === 0) return [];

  const chargeIds = candidates.map((row) => String(row.charge_id));
  const { data: chargeRows, error: chargeErr } = await db
    .from("portal_household_charge_records")
    .select("id, row_data")
    .in("id", chargeIds);
  if (chargeErr) throw new Error(chargeErr.message);
  const chargeById = new Map((chargeRows ?? []).map((row) => [String(row.id), row.row_data as HouseholdCharge | null]));

  const residentUserIds = [...new Set(candidates.map((row) => String(row.resident_user_id)))];
  const { data: settingsRows, error: settingsErr } = await db
    .from("resident_autopay_settings")
    .select("resident_user_id, household_key, payment_method_id, enabled")
    .in("resident_user_id", residentUserIds);
  if (settingsErr) throw new Error(settingsErr.message);
  const settingsByKey = new Map(
    (settingsRows ?? []).map((row) => [
      `${row.resident_user_id}|${row.household_key}`,
      { enabled: row.enabled === true, paymentMethodId: row.payment_method_id as string | null },
    ]),
  );

  const out: AutopayRetryCandidate[] = [];
  for (const run of candidates) {
    const charge = chargeById.get(String(run.charge_id));
    if (!charge?.id || !isUnpaidHouseholdCharge(charge)) continue;
    const householdKey = residentAutopayHouseholdKey(charge.residentEmail, charge.propertyId);
    const settings = settingsByKey.get(`${run.resident_user_id}|${householdKey}`);
    if (!settings?.enabled || !settings.paymentMethodId) continue;
    out.push({
      runId: String(run.id),
      chargeId: String(run.charge_id),
      residentUserId: String(run.resident_user_id),
      residentEmail: charge.residentEmail,
      managerId: String(run.manager_id),
      propertyId: charge.propertyId,
      paymentMethodId: settings.paymentMethodId,
      attempt: runAttempt(run.attempt),
      updatedAt: String(run.updated_at),
    });
  }
  return out;
}
