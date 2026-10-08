import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countActiveAccounts,
  countActiveAccountsWithPayouts,
  listAccountIdsByKind,
  listSandboxAccountIds,
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
  recentSignups: {
    id: string;
    kind: AdminAccountKind;
    name: string;
    email: string;
    joinedAt: string | null;
  }[];
};

const SMS_FAILED_STATUSES = ["failed", "undelivered"];
const SMS_ATTEMPT_FAILED_STATES = ["provider_rejected", "pre_dispatch_failed"];
/**
 * How far back the newest-sign-ups card looks. The six it shows come from the
 * newest profiles, so this is a bounded read instead of every account row.
 */
const RECENT_SIGNUP_SCAN = 200;

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

export async function loadAdminOverview(db: SupabaseClient, now = new Date()): Promise<AdminOverview> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // One paged id read per kind (one column), then the numbers are counted in the
  // database: the dashboard never materializes the account table to count it.
  const [managerIds, residentIds, vendorIds, sandboxIds] = await Promise.all([
    listAccountIdsByKind(db, "manager"),
    listAccountIdsByKind(db, "resident"),
    listAccountIdsByKind(db, "vendor"),
    listSandboxAccountIds(db),
  ]);
  const real = (ids: string[]) => ids.filter((id) => !sandboxIds.has(id));
  const realManagers = real(managerIds);
  const realResidents = real(residentIds);
  const realVendors = real(vendorIds);

  const [
    activeManagers,
    activeResidents,
    activeVendors,
    managersWithPayouts,
    openFeedback,
    smsLog,
    smsAttempts,
    disputes,
    newestProfiles,
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
    db
      .from("profiles")
      .select("id, email, full_name, created_at")
      .order("created_at", { ascending: false })
      .limit(RECENT_SIGNUP_SCAN),
  ]);

  const smsFailures24h = smsLog === null && smsAttempts === null ? null : (smsLog ?? 0) + (smsAttempts ?? 0);

  const kindById = new Map<string, AdminAccountKind>();
  for (const id of realManagers) kindById.set(id, "manager");
  for (const id of realResidents) if (!kindById.has(id)) kindById.set(id, "resident");
  for (const id of realVendors) if (!kindById.has(id)) kindById.set(id, "vendor");

  type NewestRow = { id: string; email: string | null; full_name: string | null; created_at: string | null };
  const recentSignups = ((newestProfiles.data ?? []) as unknown as NewestRow[])
    .filter((row) => kindById.has(String(row.id)))
    .slice(0, 6)
    .map((row) => ({
      id: String(row.id),
      kind: kindById.get(String(row.id))!,
      name: row.full_name?.trim() || (row.email ?? ""),
      email: row.email ?? "",
      joinedAt: row.created_at ?? null,
    }));

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
