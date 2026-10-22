import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countActiveAccounts,
  countActiveAccountsWithPayouts,
  listAccountIdsForEveryKind,
  listSandboxAccountIds,
  scanNewestProfiles,
  type AdminAccountKind,
} from "@/lib/admin/admin-accounts.server";
import { CLOSED_DISPUTE_STATUSES_FILTER } from "@/lib/admin/admin-dispute-status";
import { loadMonthExpensesCents } from "@/lib/admin/admin-expense-month.server";
import { currentRevenueMonth, loadAdminMonthEarnings } from "@/lib/admin/admin-revenue.server";
import { loadAdminSubscriberFigures } from "@/lib/admin/admin-subscribers.server";
import { readAllPages } from "@/lib/auth/admin-portal-manager-ids.server";
import { normalizeBugFeedbackStatus } from "@/lib/portal-bug-feedback-utils";

/**
 * Server-authoritative aggregates for the admin Dashboard. Every number is a
 * count of real rows; a figure that cannot be sourced is left out of the
 * response (`null`) so the UI omits its card rather than guessing.
 *
 * Sources: `profile_roles` (+ legacy `profiles.role`) for account counts,
 * `portal_bug_feedback_records.row_data.status` for feedback,
 * `sms_delivery_log` + `sms_delivery_attempts` for SMS failures,
 * `stripe_disputes` for disputes, `profiles.stripe_connect_account_id` for
 * payout setup.
 *
 * Deliberately NOT here: email delivery failures (no table records a failed
 * send — `portal_outbound_mail_records` only says whether a send was
 * attempted) and listings pending review (the approval queue was removed;
 * listings publish immediately).
 */
/**
 * The Dashboard money row. Every field is `null` when its source could not be read, and the card
 * for a `null` field is omitted - an unknown figure is never drawn as $0.
 *
 * Sources: MRR / Paid / Trial / Promo from the Subscribers population (the resolvers enforcement
 * uses); Earned from the Payments feed (a live read of the platform Stripe account, cached five
 * minutes); Profit = Earned - Stripe fees - the month's `platform_expenses`.
 */
export type AdminMoneyOverview = {
  mrrCents: number | null;
  earnedCents: number | null;
  profitCents: number | null;
  paidSubscribers: number | null;
  onTrial: number | null;
  promoUsers: number | null;
};

/** Pure: how the money row is assembled from its three sources. Exported for the tests. */
export function buildAdminMoneyOverview(input: {
  subscribers: { counts: { paid: number; trial: number; promo: number }; mrrCents: number } | null;
  earnings: { earnedCents: number; stripeFeesCents: number } | null;
  expensesCents: number | null;
}): AdminMoneyOverview {
  const { subscribers, earnings, expensesCents } = input;
  return {
    mrrCents: subscribers ? subscribers.mrrCents : null,
    earnedCents: earnings ? earnings.earnedCents : null,
    profitCents:
      earnings && expensesCents !== null ? earnings.earnedCents - earnings.stripeFeesCents - expensesCents : null,
    paidSubscribers: subscribers ? subscribers.counts.paid : null,
    onTrial: subscribers ? subscribers.counts.trial : null,
    promoUsers: subscribers ? subscribers.counts.promo : null,
  };
}

export type AdminOverview = {
  money: AdminMoneyOverview;
  /** Null when the source could not be read inside its budget, so the card is omitted (never drawn as 0). */
  activeManagers: number | null;
  activeResidents: number | null;
  activeVendors: number | null;
  openFeedback: number | null;
  smsFailures24h: number | null;
  openDisputes: number | null;
  managersWithoutPayouts: number | null;
  /** Null when the read failed, so the card is omitted instead of reading as "no sign-ups yet". */
  recentSignups:
    | {
        id: string;
        kind: AdminAccountKind;
        name: string;
        email: string;
        joinedAt: string | null;
      }[]
    | null;
};

/**
 * How long the Dashboard waits for its sources, END TO END. The route answers once, so one source that hangs
 * held the whole page on "Loading…" until the browser gave up; a source that misses the budget reads as
 * `null` and its card is left out (the same contract as an unreadable source), and the rest of the page
 * draws. The figures are read in two stages (the account ids, then every count derived from them), and they
 * share ONE deadline: two full budgets in a row would be an 18 second page.
 */
export const OVERVIEW_SOURCE_BUDGET_MS = 9_000;

/** What is left of a shared deadline, never negative (a passed deadline budgets nothing). */
function msUntil(deadline: number, now = Date.now()): number {
  return Math.max(0, deadline - now);
}

/** Pure: the promise's value, or `fallback` when it rejects or has not settled within `ms`. Exported for the tests. */
export async function withBudget<T>(work: PromiseLike<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work).catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SMS_FAILED_STATUSES = ["failed", "undelivered"];
const SMS_ATTEMPT_FAILED_STATES = ["provider_rejected", "pre_dispatch_failed"];
/** How many newest sign-ups the dashboard card lists. */
const RECENT_SIGNUP_COUNT = 6;

async function countOrNull(run: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try {
    const { count, error } = await run();
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

/**
 * Open feedback: the status is read (one tiny column, paged) and normalized the
 * same way the Feedback page does (`normalizeBugFeedbackStatus` accepts
 * `reviewing` / `resolved` / `closed` and any casing), because a `.in()` on the
 * raw JSON value would count `"Completed"` as open.
 */
async function countOpenFeedback(db: SupabaseClient): Promise<number | null> {
  try {
    const rows = await readAllPages<{ status: string | null }>((from, to) =>
      db
        .from("portal_bug_feedback_records")
        .select("id, status:row_data->>status")
        .order("id")
        .range(from, to),
    );
    return rows.filter((row) => normalizeBugFeedbackStatus(row.status) === "open").length;
  } catch {
    return null;
  }
}

/**
 * The newest real sign-ups, read a window at a time until six of them hold a
 * portal kind or the accounts run out (`scanNewestProfiles`) — a sandbox seed
 * run cannot push the card empty, and the read stays bounded. Null when it
 * failed, which the card reads as "omit me", never as "no sign-ups yet".
 */
async function recentSignupsOf(
  db: SupabaseClient,
  kindById: Map<string, AdminAccountKind>,
): Promise<AdminOverview["recentSignups"]> {
  try {
    const kept = await scanNewestProfiles(
      db,
      { match: null, limit: RECENT_SIGNUP_COUNT },
      (rows) =>
        rows
          .filter((row) => kindById.has(row.id))
          .map((row) => ({
            id: row.id,
            kind: kindById.get(row.id)!,
            name: row.full_name?.trim() || (row.email ?? ""),
            email: row.email ?? "",
            joinedAt: row.created_at ?? null,
          })),
    );
    return kept.slice(0, RECENT_SIGNUP_COUNT);
  } catch {
    return null;
  }
}

/** Every figure unknown: what the dashboard draws when even the account-id read missed its budget. */
function emptyAdminOverview(): AdminOverview {
  return {
    money: buildAdminMoneyOverview({ subscribers: null, earnings: null, expensesCents: null }),
    activeManagers: null,
    activeResidents: null,
    activeVendors: null,
    openFeedback: null,
    smsFailures24h: null,
    openDisputes: null,
    managersWithoutPayouts: null,
    recentSignups: null,
  };
}

export async function loadAdminOverview(db: SupabaseClient, now = new Date()): Promise<AdminOverview> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  // One deadline for the whole page: the id read below and every figure derived from it share it, so a slow
  // first stage shortens the second rather than adding to it.
  const deadline = Date.now() + OVERVIEW_SOURCE_BUDGET_MS;

  // One paged id read per role (one column, every kind resolved in that pass),
  // then the numbers are counted in the database: the dashboard never
  // materializes the account table to count it. Budgeted like every other
  // source: every figure below is derived from these ids, so a read that hangs
  // would hold the whole page rather than one card.
  const base = await withBudget(
    Promise.all([listAccountIdsForEveryKind(db), listSandboxAccountIds(db)]),
    msUntil(deadline),
    null,
  );
  if (!base) return emptyAdminOverview();
  const [idsByKind, sandboxIds] = base;
  const real = (ids: string[]) => ids.filter((id) => !sandboxIds.has(id));
  const realManagers = real(idsByKind.manager);
  const realResidents = real(idsByKind.resident);
  const realVendors = real(idsByKind.vendor);

  const kindById = new Map<string, AdminAccountKind>();
  for (const id of realManagers) kindById.set(id, "manager");
  for (const id of realResidents) if (!kindById.has(id)) kindById.set(id, "resident");
  for (const id of realVendors) if (!kindById.has(id)) kindById.set(id, "vendor");

  // Whatever the first stage left of the shared deadline is what every figure below gets.
  const left = msUntil(deadline);
  const [
    activeManagers,
    activeResidents,
    activeVendors,
    managersWithPayouts,
    openFeedback,
    smsLog,
    smsAttempts,
    disputes,
    recentSignups,
    subscriberFigures,
    earnings,
    expensesCents,
  ] = await Promise.all([
    withBudget(countActiveAccounts(db, realManagers), left, null),
    withBudget(countActiveAccounts(db, realResidents), left, null),
    withBudget(countActiveAccounts(db, realVendors), left, null),
    withBudget(countActiveAccountsWithPayouts(db, realManagers), left, null),
    withBudget(countOpenFeedback(db), left, null),
    withBudget(countOrNull(() =>
      db
        .from("sms_delivery_log")
        .select("id", { count: "exact", head: true })
        .in("status", SMS_FAILED_STATUSES)
        .gte("created_at", since),
    ), left, null),
    withBudget(countOrNull(() =>
      db
        .from("sms_delivery_attempts")
        .select("id", { count: "exact", head: true })
        .in("state", SMS_ATTEMPT_FAILED_STATES)
        .gte("started_at", since),
    ), left, null),
    withBudget(countOrNull(() =>
      db.from("stripe_disputes").select("id", { count: "exact", head: true }).not("status", "in", CLOSED_DISPUTE_STATUSES_FILTER),
    ), left, null),
    withBudget(recentSignupsOf(db, kindById), left, null),
    withBudget(loadAdminSubscriberFigures(db, now.getTime()), left, null),
    withBudget(loadAdminMonthEarnings(db, { now: () => now.getTime() }), left, null),
    withBudget(loadMonthExpensesCents(db, currentRevenueMonth(now.getTime())), left, null),
  ]);

  const smsFailures24h = smsLog === null && smsAttempts === null ? null : (smsLog ?? 0) + (smsAttempts ?? 0);

  return {
    money: buildAdminMoneyOverview({ subscribers: subscriberFigures, earnings, expensesCents }),
    activeManagers,
    activeResidents,
    activeVendors,
    openFeedback,
    smsFailures24h,
    openDisputes: disputes,
    managersWithoutPayouts:
      activeManagers === null || managersWithPayouts === null ? null : Math.max(0, activeManagers - managersWithPayouts),
    recentSignups,
  };
}
