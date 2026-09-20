/**
 * Pure payout logic — no Stripe SDK, no database. Everything here is a plain
 * function over plain data so it can be unit-tested without mocking the
 * network. `stripe-payouts.server.ts` does the actual Stripe/DB reads and
 * feeds this module's shapes.
 *
 * See PLAN-0920-0853 (`.lavish/plans/…in-app-bank-payouts-redesi/plan.html`)
 * for the product spec this file implements.
 */

export type PayoutMethod = "standard" | "instant";
export type PayoutStatus = "pending" | "in_transit" | "paid" | "failed" | "canceled" | "returned";
export type ScheduleInterval = "daily" | "weekly" | "monthly" | "manual";
export type WeeklyAnchor = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export type PayoutSchedule = {
  interval: ScheduleInterval;
  weeklyAnchor?: WeeklyAnchor;
  monthlyAnchor?: number;
};

export type PayoutScheduleWithNext = PayoutSchedule & { nextPayoutAt: string | null };

export type PayoutSetupState = {
  identity: "done" | "needed" | "pending";
  bank: "done" | "needed";
  ready: boolean;
};

export type PayoutBankInfo = {
  last4: string;
  bankName: string | null;
  accountType: "checking" | "savings" | null;
  instantEligible: boolean;
  verifiedAt: string | null;
};

export type PayoutHistoryItem = {
  id: string;
  amountCents: number;
  feeCents: number;
  netCents: number;
  method: PayoutMethod | null;
  status: PayoutStatus;
  destinationLast4: string | null;
  createdAt: string;
  arrivalDate: string | null;
  initiatedInApp: boolean;
  failureMessage: string | null;
  serviceLabel: string | null;
};

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

/**
 * Confirmed against Stripe's Connect docs (docs.stripe.com/connect/instant-payouts
 * "Pricing"): "Irrespective of your monetization decisions, Stripe charges
 * marketplaces and platforms a 1% fee for all Instant Payouts." That page
 * lists a $0.50 USD "Instant Payout minimum" — the smallest amount you may
 * REQUEST as an instant payout, not a separate minimum fee floor — so there
 * is no fee floor to apply here; the fallback the plan asks for ("else 1%")
 * is what's implemented.
 */
export const INSTANT_PAYOUT_FEE_BPS = 100; // 1%

export function computeInstantPayoutFeeCents(amountCents: number): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  return Math.round((amountCents * INSTANT_PAYOUT_FEE_BPS) / 10_000);
}

export function feeCentsForMethod(method: PayoutMethod, amountCents: number): number {
  return method === "instant" ? computeInstantPayoutFeeCents(amountCents) : 0;
}

export function netCentsForPayout(amountCents: number, feeCents: number): number {
  return Math.max(0, amountCents - feeCents);
}

// ---------------------------------------------------------------------------
// Instant eligibility
// ---------------------------------------------------------------------------

export type InstantAllowedResult = { allowed: boolean; reason: string | null };

/**
 * ACH rent still clearing is never Instant — `instantAvailableCents` is
 * Stripe's own `balance.instant_available`, a subset of `available` limited
 * to funds Stripe has decided are eligible for same-day movement. A bank that
 * cannot receive Instant payouts at all (`bankInstantEligible: false`) fails
 * regardless of amount.
 */
export function instantAllowed(opts: {
  amountCents: number;
  instantAvailableCents: number;
  bankInstantEligible: boolean;
}): InstantAllowedResult {
  if (!opts.bankInstantEligible) {
    return { allowed: false, reason: "This bank isn't eligible for Instant Payouts." };
  }
  if (!Number.isFinite(opts.amountCents) || opts.amountCents <= 0) {
    return { allowed: false, reason: "Enter an amount." };
  }
  if (opts.amountCents > opts.instantAvailableCents) {
    return {
      allowed: false,
      reason: `up to ${formatUsd(opts.instantAvailableCents)} now`,
    };
  }
  return { allowed: true, reason: null };
}

function formatUsd(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Arrival estimate
// ---------------------------------------------------------------------------

function isWeekendUtc(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Adds `days` business days (Mon–Fri) to `date`, in UTC calendar days. */
export function addBusinessDaysUtc(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  let added = 0;
  while (added < days) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (!isWeekendUtc(result)) added++;
  }
  return result;
}

/**
 * Standard ACH payouts arrive the next business day, then take ~2 more
 * business days to actually settle at the bank — so "next business day + 2"
 * is 3 business days out from now. Returned as an ISO date (`YYYY-MM-DD`).
 */
export function standardPayoutArrivalDate(now: Date = new Date()): string {
  return addBusinessDaysUtc(now, 3).toISOString().slice(0, 10);
}

/** `null` for instant — it settles in minutes, not on a calendar date. */
export function estimateArrivalDate(method: PayoutMethod, now: Date = new Date()): string | null {
  return method === "instant" ? null : standardPayoutArrivalDate(now);
}

/** Human label for the Pay-out sheet's speed rows. */
export function estimateArrivalLabel(method: PayoutMethod, now: Date = new Date()): string {
  if (method === "instant") return "about 30 minutes";
  const date = new Date(`${standardPayoutArrivalDate(now)}T00:00:00.000Z`);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// Schedule mapping (Stripe settings.payouts.schedule)
// ---------------------------------------------------------------------------

export type StripeScheduleShape = {
  interval?: string;
  weekly_anchor?: string;
  monthly_anchor?: number;
};

const WEEKLY_ANCHORS: readonly WeeklyAnchor[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export function fromStripePayoutSchedule(schedule: StripeScheduleShape | null | undefined): PayoutSchedule {
  const interval = schedule?.interval;
  if (interval === "weekly") {
    const anchor = WEEKLY_ANCHORS.includes(schedule?.weekly_anchor as WeeklyAnchor)
      ? (schedule!.weekly_anchor as WeeklyAnchor)
      : "friday";
    return { interval: "weekly", weeklyAnchor: anchor };
  }
  if (interval === "monthly") {
    return { interval: "monthly", monthlyAnchor: schedule?.monthly_anchor ?? 1 };
  }
  if (interval === "manual") return { interval: "manual" };
  return { interval: "daily" };
}

export function toStripePayoutSchedule(schedule: PayoutSchedule): StripeScheduleShape {
  if (schedule.interval === "weekly") {
    return { interval: "weekly", weekly_anchor: schedule.weeklyAnchor ?? "friday" };
  }
  if (schedule.interval === "monthly") {
    return { interval: "monthly", monthly_anchor: schedule.monthlyAnchor ?? 1 };
  }
  if (schedule.interval === "manual") return { interval: "manual" };
  return { interval: "daily" };
}

const WEEKDAY_INDEX: Record<WeeklyAnchor, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Next automatic payout date, or `null` for manual. Pure — takes `now` explicitly for tests. */
export function computeNextPayoutDate(schedule: PayoutSchedule, now: Date = new Date()): string | null {
  if (schedule.interval === "manual") return null;

  if (schedule.interval === "daily") {
    const next = new Date(now.getTime());
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10);
  }

  if (schedule.interval === "weekly") {
    const targetDow = WEEKDAY_INDEX[schedule.weeklyAnchor ?? "friday"];
    const next = new Date(now.getTime());
    do {
      next.setUTCDate(next.getUTCDate() + 1);
    } while (next.getUTCDay() !== targetDow);
    return next.toISOString().slice(0, 10);
  }

  // monthly — Stripe treats an anchor past the month's last day as that last
  // day, so the anchor is clamped per month rather than overflowing into the
  // next one (Sep 31 → Sep 30, Feb 30 → Feb 28/29).
  const anchor = Math.min(Math.max(schedule.monthlyAnchor ?? 1, 1), 31);
  const monthlyPayoutDate = (year: number, month: number): Date => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(anchor, lastDay)));
  };
  let next = monthlyPayoutDate(now.getUTCFullYear(), now.getUTCMonth());
  if (next.getTime() <= now.getTime()) {
    next = monthlyPayoutDate(now.getUTCFullYear(), now.getUTCMonth() + 1);
  }
  return next.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Setup state
// ---------------------------------------------------------------------------

/**
 * Everything Stripe reports under `requirements` that is NOT about the bank
 * external account is treated as identity/business verification. This is a
 * heuristic over Stripe's requirement-key strings — the real backstop is
 * Stripe itself refusing `payouts.create` on an account that isn't ready.
 */
function isBankRequirement(key: string): boolean {
  return key === "external_account" || key.startsWith("external_account");
}

export function resolveSetupState(input: {
  detailsSubmitted: boolean;
  currentlyDue: string[];
  pendingVerification: string[];
  hasExternalAccount: boolean;
}): PayoutSetupState {
  const identityCurrentlyDue = input.currentlyDue.filter((k) => !isBankRequirement(k));
  const identityPendingVerification = input.pendingVerification.filter((k) => !isBankRequirement(k));
  const bankCurrentlyDue = input.currentlyDue.some(isBankRequirement);

  const bank: PayoutSetupState["bank"] = input.hasExternalAccount && !bankCurrentlyDue ? "done" : "needed";

  let identity: PayoutSetupState["identity"];
  if (!input.detailsSubmitted || identityCurrentlyDue.length > 0) {
    identity = "needed";
  } else if (identityPendingVerification.length > 0) {
    identity = "pending";
  } else {
    identity = "done";
  }

  return { identity, bank, ready: identity === "done" && bank === "done" };
}

// ---------------------------------------------------------------------------
// Payout status normalisation
// ---------------------------------------------------------------------------

/**
 * Stripe has no native "returned by the bank" status — a bank return shows up
 * as `payout.failed` with one of these failure codes. We surface it as its
 * own status so the product can say "returned" instead of the more alarming
 * "failed" (the money comes back to the available balance either way).
 */
const BANK_RETURN_FAILURE_CODES = new Set([
  "account_closed",
  "account_frozen",
  "bank_account_restricted",
  "could_not_process",
  "debit_not_authorized",
  "invalid_account_number",
  "incorrect_account_holder_name",
  "no_account",
  "unsupported_card",
]);

export function normalizePayoutStatus(stripeStatus: string, failureCode?: string | null): PayoutStatus {
  if (stripeStatus === "failed" && failureCode && BANK_RETURN_FAILURE_CODES.has(failureCode)) {
    return "returned";
  }
  const allowed: PayoutStatus[] = ["pending", "in_transit", "paid", "failed", "canceled"];
  return (allowed as string[]).includes(stripeStatus) ? (stripeStatus as PayoutStatus) : "pending";
}

// ---------------------------------------------------------------------------
// History row normaliser
// ---------------------------------------------------------------------------

export type StripePayoutDbRow = {
  id: string;
  amount_cents: number | string;
  fee_cents?: number | string | null;
  method?: string | null;
  status: string;
  destination_last4?: string | null;
  created_at: string;
  arrival_date?: string | null;
  initiated_in_app?: boolean | null;
  failure_message?: string | null;
};

export function normalizePayoutHistoryRow(
  row: StripePayoutDbRow,
  opts: { serviceLabel?: string | null } = {},
): PayoutHistoryItem {
  const amountCents = Number(row.amount_cents) || 0;
  const feeCents = Number(row.fee_cents ?? 0) || 0;
  const method = row.method === "instant" || row.method === "standard" ? row.method : null;
  const allowedStatus: PayoutStatus[] = ["pending", "in_transit", "paid", "failed", "canceled", "returned"];
  const status = (allowedStatus as string[]).includes(row.status) ? (row.status as PayoutStatus) : "pending";

  return {
    id: row.id,
    amountCents,
    feeCents,
    netCents: netCentsForPayout(amountCents, feeCents),
    method,
    status,
    destinationLast4: row.destination_last4 ?? null,
    createdAt: row.created_at,
    arrivalDate: row.arrival_date ?? null,
    initiatedInApp: Boolean(row.initiated_in_app),
    failureMessage: row.failure_message ?? null,
    serviceLabel: opts.serviceLabel ?? null,
  };
}

// ---------------------------------------------------------------------------
// Create-payout request validation
// ---------------------------------------------------------------------------

export type CreatePayoutInput = { amountCents: number; method: PayoutMethod };
export type ValidateCreatePayoutResult =
  | { ok: true; input: CreatePayoutInput }
  | { ok: false; error: string };

export function validateCreatePayoutRequestBody(body: unknown): ValidateCreatePayoutResult {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request." };
  const amountCents = Number((body as Record<string, unknown>).amountCents);
  const method = (body as Record<string, unknown>).method;
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { ok: false, error: "Enter an amount greater than $0." };
  }
  if (method !== "standard" && method !== "instant") {
    return { ok: false, error: "Choose Standard or Instant." };
  }
  return { ok: true, input: { amountCents: Math.round(amountCents), method } };
}

/**
 * The full server-side amount/method check for a create request, given a
 * freshly-read balance snapshot. Pure so every branch (422s) is testable
 * without a fake Stripe client.
 */
export function validatePayoutAgainstBalance(
  input: CreatePayoutInput,
  balance: { availableCents: number; instantAvailableCents: number; bankInstantEligible: boolean },
  setup: { ready: boolean },
): { ok: true } | { ok: false; error: string } {
  if (!setup.ready) {
    return { ok: false, error: "Finish setting up payouts before paying out." };
  }
  if (input.method === "standard") {
    if (input.amountCents > balance.availableCents) {
      return { ok: false, error: `Amount is more than what's available (${formatUsd(balance.availableCents)}).` };
    }
    return { ok: true };
  }
  const instant = instantAllowed({
    amountCents: input.amountCents,
    instantAvailableCents: balance.instantAvailableCents,
    bankInstantEligible: balance.bankInstantEligible,
  });
  if (!instant.allowed) {
    return { ok: false, error: instant.reason ?? "Instant Payouts isn't available for this amount." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Schedule request validation
// ---------------------------------------------------------------------------

export type ValidateScheduleResult = { ok: true; schedule: PayoutSchedule } | { ok: false; error: string };

export function validateScheduleRequestBody(body: unknown): ValidateScheduleResult {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request." };
  const interval = (body as Record<string, unknown>).interval;
  if (interval !== "daily" && interval !== "weekly" && interval !== "monthly" && interval !== "manual") {
    return { ok: false, error: "Choose a valid schedule." };
  }
  if (interval === "weekly") {
    const weeklyAnchor = (body as Record<string, unknown>).weeklyAnchor;
    if (!WEEKLY_ANCHORS.includes(weeklyAnchor as WeeklyAnchor)) {
      return { ok: false, error: "Choose a day of the week." };
    }
    return { ok: true, schedule: { interval, weeklyAnchor: weeklyAnchor as WeeklyAnchor } };
  }
  if (interval === "monthly") {
    const monthlyAnchor = Number((body as Record<string, unknown>).monthlyAnchor);
    if (!Number.isInteger(monthlyAnchor) || monthlyAnchor < 1 || monthlyAnchor > 31) {
      return { ok: false, error: "Choose a day of the month (1–31)." };
    }
    return { ok: true, schedule: { interval, monthlyAnchor } };
  }
  return { ok: true, schedule: { interval } };
}

// ---------------------------------------------------------------------------
// Best-effort vendor service-label matching
// ---------------------------------------------------------------------------

export type VendorPayoutCandidate = {
  workOrderId: string;
  amountCents: number;
  updatedAt: string;
  label: string | null;
};

/**
 * Best-effort only: a single bank payout usually bundles several transfers,
 * so there is no reliable 1:1 link from a `stripe_payouts` row back to one
 * work order. We only claim a match when exactly one paid vendor_payouts row
 * has the SAME amount and settled at or before the payout, within a 14-day
 * window — anything ambiguous stays `null` rather than guessing.
 */
export function matchServiceLabelForPayout(
  payout: { amountCents: number; createdAt: string },
  candidates: VendorPayoutCandidate[],
): string | null {
  const payoutTime = new Date(payout.createdAt).getTime();
  if (!Number.isFinite(payoutTime)) return null;
  const windowMs = 14 * 24 * 60 * 60 * 1000;

  const matches = candidates.filter((c) => {
    if (c.amountCents !== payout.amountCents) return false;
    const t = new Date(c.updatedAt).getTime();
    if (!Number.isFinite(t)) return false;
    return t <= payoutTime && payoutTime - t <= windowMs;
  });

  if (matches.length !== 1) return null;
  return matches[0]!.label;
}
