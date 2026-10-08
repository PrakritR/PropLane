import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadAccountProfilesByKind,
  type AdminAccountKind,
  type AdminAccountProfile,
} from "@/lib/admin/admin-accounts.server";

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

/** Stripe dispute statuses that need nobody any more. */
const CLOSED_DISPUTE_STATUSES = ["won", "lost", "warning_closed", "charge_refunded"];
const SMS_FAILED_STATUSES = ["failed", "undelivered"];
const SMS_ATTEMPT_FAILED_STATES = ["provider_rejected", "pre_dispatch_failed"];

async function countOrNull(run: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try {
    const { count, error } = await run();
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

export async function loadAdminOverview(db: SupabaseClient, now = new Date()): Promise<AdminOverview> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [managers, residents, vendors, feedbackRes, smsLog, smsAttempts, disputes] = await Promise.all([
    loadAccountProfilesByKind(db, "manager"),
    loadAccountProfilesByKind(db, "resident"),
    loadAccountProfilesByKind(db, "vendor"),
    db.from("portal_bug_feedback_records").select("id, status:row_data->>status").limit(5000),
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
      db
        .from("stripe_disputes")
        .select("id", { count: "exact", head: true })
        .not("status", "in", `(${CLOSED_DISPUTE_STATUSES.join(",")})`),
    ),
  ]);

  const active = (rows: AdminAccountProfile[]) => rows.filter((row) => row.active);

  let openFeedback: number | null = null;
  if (!feedbackRes.error) {
    openFeedback = ((feedbackRes.data ?? []) as unknown as { status: string | null }[]).filter((row) => {
      const status = String(row.status ?? "open").trim().toLowerCase();
      return status !== "completed" && status !== "in_progress";
    }).length;
  }

  const smsFailures24h = smsLog === null && smsAttempts === null ? null : (smsLog ?? 0) + (smsAttempts ?? 0);

  const signupCandidates: { row: AdminAccountProfile; kind: AdminAccountKind }[] = [
    ...managers.map((row) => ({ row, kind: "manager" as const })),
    ...residents.map((row) => ({ row, kind: "resident" as const })),
    ...vendors.map((row) => ({ row, kind: "vendor" as const })),
  ];
  const recentSignups = signupCandidates
    .sort((a, b) => (Date.parse(b.row.joinedAt ?? "") || 0) - (Date.parse(a.row.joinedAt ?? "") || 0))
    .slice(0, 6)
    .map(({ row, kind }) => ({
      id: row.id,
      kind,
      name: row.fullName || row.email,
      email: row.email,
      joinedAt: row.joinedAt,
    }));

  return {
    activeManagers: active(managers).length,
    activeResidents: active(residents).length,
    activeVendors: active(vendors).length,
    openFeedback,
    smsFailures24h,
    openDisputes: disputes,
    managersWithoutPayouts: active(managers).filter((row) => !row.stripeConnectAccountId).length,
    recentSignups,
  };
}
