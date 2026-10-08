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
export type AdminOverview = {
  activeManagers: number;
  activeResidents: number;
  activeVendors: number;
  openFeedback: number | null;
  smsFailures24h: number | null;
  openDisputes: number | null;
  managersWithoutPayouts: number;
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

export async function loadAdminOverview(db: SupabaseClient, now = new Date()): Promise<AdminOverview> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // One paged id read per role (one column, every kind resolved in that pass),
  // then the numbers are counted in the database: the dashboard never
  // materializes the account table to count it.
  const [idsByKind, sandboxIds] = await Promise.all([listAccountIdsForEveryKind(db), listSandboxAccountIds(db)]);
  const real = (ids: string[]) => ids.filter((id) => !sandboxIds.has(id));
  const realManagers = real(idsByKind.manager);
  const realResidents = real(idsByKind.resident);
  const realVendors = real(idsByKind.vendor);

  const kindById = new Map<string, AdminAccountKind>();
  for (const id of realManagers) kindById.set(id, "manager");
  for (const id of realResidents) if (!kindById.has(id)) kindById.set(id, "resident");
  for (const id of realVendors) if (!kindById.has(id)) kindById.set(id, "vendor");

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
  ] = await Promise.all([
    countActiveAccounts(db, realManagers),
    countActiveAccounts(db, realResidents),
    countActiveAccounts(db, realVendors),
    countActiveAccountsWithPayouts(db, realManagers),
    countOpenFeedback(db),
    countOrNull(() =>
      db
        .from("sms_delivery_log")
        .select("id", { count: "exact", head: true })
        .in("status", SMS_FAILED_STATUSES)
        .gte("created_at", since),
    ),
    countOrNull(() =>
      db
        .from("sms_delivery_attempts")
        .select("id", { count: "exact", head: true })
        .in("state", SMS_ATTEMPT_FAILED_STATES)
        .gte("started_at", since),
    ),
    countOrNull(() =>
      db.from("stripe_disputes").select("id", { count: "exact", head: true }).not("status", "in", CLOSED_DISPUTE_STATUSES_FILTER),
    ),
    recentSignupsOf(db, kindById),
  ]);

  const smsFailures24h = smsLog === null && smsAttempts === null ? null : (smsLog ?? 0) + (smsAttempts ?? 0);

  return {
    activeManagers,
    activeResidents,
    activeVendors,
    openFeedback,
    smsFailures24h,
    openDisputes: disputes,
    managersWithoutPayouts: Math.max(0, activeManagers - managersWithPayouts),
    recentSignups,
  };
}
