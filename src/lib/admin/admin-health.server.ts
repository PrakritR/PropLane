import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { CLOSED_DISPUTE_STATUSES_FILTER } from "@/lib/admin/admin-dispute-status";

/**
 * The admin Health page: things that are broken right now, grouped by kind.
 * Every row names the account it belongs to so staff can open it. Nothing is
 * mutated here and no payload, URL or message body leaves the server — only
 * the status, an error code and a time.
 *
 * Not included: bounced / failed email. No table records a failed send
 * (`portal_outbound_mail_records` only notes whether one was attempted), so
 * there is nothing to list honestly.
 */
export type AdminHealthRow = {
  id: string;
  title: string;
  /** One plain fact: an error code, an HTTP status, an age. */
  fact: string;
  at: string | null;
  /** The account the row belongs to (a manager, for every group today). */
  accountId: string | null;
};

export type AdminHealthGroupId = "sms" | "webhooks" | "disputes" | "applications";

export type AdminHealth = {
  groups: { id: AdminHealthGroupId; label: string; rows: AdminHealthRow[] }[];
};

const WINDOW_DAYS = 7;
const STUCK_APPLICATION_DAYS = 7;
const ROW_CAP = 50;

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D+/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "•••";
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ageLabel(iso: string | null, now: Date): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
}

export function isStuckApplication(row: { bucket: string; stage: string }): boolean {
  if (row.bucket.trim().toLowerCase() !== "pending") return false;
  const stage = row.stage.trim().toLowerCase();
  // An applicant still filling it in is not stuck on anyone; a rejected or
  // withdrawn row is already decided.
  return stage !== "in progress" && !stage.includes("reject") && !stage.includes("withdraw");
}

export async function loadAdminHealth(db: SupabaseClient, now = new Date()): Promise<AdminHealth> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const stuckBefore = new Date(now.getTime() - STUCK_APPLICATION_DAYS * 86_400_000).toISOString();

  const [smsLogRes, smsAttemptRes, webhookRes, disputeRes, appRes] = await Promise.all([
    db
      .from("sms_delivery_log")
      .select("id, to_phone, status, error_code, manager_user_id, created_at")
      .in("status", ["failed", "undelivered"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(ROW_CAP),
    db
      .from("sms_delivery_attempts")
      .select("id, outbox_id, state, provider_error_code, started_at")
      .in("state", ["provider_rejected", "pre_dispatch_failed"])
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(ROW_CAP),
    db
      .from("webhook_deliveries")
      .select("id, subscription_id, event_type, status, response_status, attempt, last_error, created_at")
      .in("status", ["failed", "exhausted"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(ROW_CAP),
    db
      .from("stripe_disputes")
      .select("id, manager_user_id, amount_cents, status, reason, created_at")
      .not("status", "in", CLOSED_DISPUTE_STATUSES_FILTER)
      .order("created_at", { ascending: false })
      .limit(ROW_CAP),
    db
      .from("manager_application_records")
      .select("id, manager_user_id, created_at, bucket:row_data->>bucket, stage:row_data->>stage")
      .is("test_workspace_id", null)
      .eq("row_data->>bucket", "pending")
      .lt("created_at", stuckBefore)
      .order("created_at", { ascending: true })
      .limit(200),
  ]);

  // The attempt rows carry no manager; their outbox row does.
  const attempts = (smsAttemptRes.data ?? []) as Row[];
  const outboxIds = [...new Set(attempts.map((a) => str(a.outbox_id)).filter(Boolean))];
  const outboxById = new Map<string, Row>();
  if (outboxIds.length > 0) {
    const { data } = await db
      .from("sms_outbox")
      .select("id, manager_user_id, recipient_phone, purpose")
      .in("id", outboxIds);
    for (const row of (data ?? []) as Row[]) outboxById.set(str(row.id), row);
  }

  const sms: AdminHealthRow[] = [
    ...((smsLogRes.data ?? []) as Row[]).map((r) => ({
      id: `log-${str(r.id)}`,
      title: `Text to ${maskPhone(str(r.to_phone))}`,
      fact: str(r.error_code) ? `Error ${str(r.error_code)}` : str(r.status),
      at: strOrNull(r.created_at),
      accountId: strOrNull(r.manager_user_id),
    })),
    ...attempts.map((a) => {
      const outbox = outboxById.get(str(a.outbox_id));
      return {
        id: `attempt-${str(a.id)}`,
        title: `Text to ${maskPhone(str(outbox?.recipient_phone))} was not sent`,
        fact: str(a.provider_error_code) ? `Error ${str(a.provider_error_code)}` : str(a.state).replace(/_/g, " "),
        at: strOrNull(a.started_at),
        accountId: strOrNull(outbox?.manager_user_id),
      };
    }),
  ]
    .sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0))
    .slice(0, ROW_CAP);

  const webhookRows = (webhookRes.data ?? []) as Row[];
  const subscriptionIds = [...new Set(webhookRows.map((w) => str(w.subscription_id)).filter(Boolean))];
  const managerBySubscription = new Map<string, string>();
  if (subscriptionIds.length > 0) {
    const { data } = await db.from("webhook_subscriptions").select("id, manager_user_id").in("id", subscriptionIds);
    for (const row of (data ?? []) as Row[]) managerBySubscription.set(str(row.id), str(row.manager_user_id));
  }
  const webhooks: AdminHealthRow[] = webhookRows.map((w) => ({
    id: `webhook-${str(w.id)}`,
    title: str(w.event_type) || "Webhook delivery",
    fact:
      w.response_status != null && w.response_status !== ""
        ? `HTTP ${String(w.response_status)} after ${String(w.attempt ?? 0)} tries`
        : `No response after ${String(w.attempt ?? 0)} tries`,
    at: strOrNull(w.created_at),
    accountId: managerBySubscription.get(str(w.subscription_id)) ?? null,
  }));

  const disputes: AdminHealthRow[] = ((disputeRes.data ?? []) as Row[]).map((d) => ({
    id: `dispute-${str(d.id)}`,
    title: `Dispute for ${money(Number(d.amount_cents) || 0)}`,
    fact: [str(d.reason).replace(/_/g, " "), str(d.status).replace(/_/g, " ")].filter(Boolean).join(" · "),
    at: strOrNull(d.created_at),
    accountId: strOrNull(d.manager_user_id),
  }));

  const applications: AdminHealthRow[] = ((appRes.data ?? []) as unknown as Row[])
    .filter((r) => isStuckApplication({ bucket: str(r.bucket), stage: str(r.stage) }))
    .slice(0, ROW_CAP)
    .map((r) => ({
      id: `application-${str(r.id)}`,
      title: "Application waiting on its manager",
      fact: `Pending ${ageLabel(strOrNull(r.created_at), now)}`,
      at: strOrNull(r.created_at),
      accountId: strOrNull(r.manager_user_id),
    }));

  return {
    groups: [
      { id: "sms", label: "Failed text messages", rows: sms },
      { id: "webhooks", label: "Failed webhooks", rows: webhooks },
      { id: "disputes", label: "Open Stripe disputes", rows: disputes },
      { id: "applications", label: "Stuck applications", rows: applications },
    ],
  };
}
