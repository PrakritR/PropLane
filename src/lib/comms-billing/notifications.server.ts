import type { SupabaseClient } from "@supabase/supabase-js";
import { formatUsdFromCents } from "@/lib/comms-billing/rates";


const DEFAULT_FROM = "PropLane <notifications@prop-lane.space>";

async function loadManagerEmail(
  db: SupabaseClient,
  managerUserId: string,
): Promise<string | null> {
  const { data } = await db.from("profiles").select("email").eq("id", managerUserId).maybeSingle();
  const email = String(data?.email ?? "").trim();
  return email.includes("@") ? email : null;
}

async function sendManagerCommsBillingEmail(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_NOTIFICATIONS_FROM?.trim() || DEFAULT_FROM,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
    }),
  }).catch(() => undefined);
}

export async function notifyCommsBillingPaymentMethodUpdated(
  db: SupabaseClient,
  managerUserId: string,
): Promise<void> {
  const email = await loadManagerEmail(db, managerUserId);
  if (!email) return;
  await sendManagerCommsBillingEmail({
    to: email,
    subject: "PropLane — payment method updated",
    text: [
      "Your payment method for PropLane communication usage was updated.",
      "",
      "Communication uses prepaid credit. A saved card never authorizes automatic usage charges.",
      "View usage in Settings → Billing & plan.",
    ].join("\n"),
  });
}

export async function notifyCommsBillingPaymentFailed(
  db: SupabaseClient,
  managerUserId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .from("manager_comms_billing_accounts")
    .upsert(
      {
        manager_user_id: managerUserId,
        billing_paused_at: now,
        billing_pause_reason: "payment_failed",
        last_payment_failed_at: now,
        updated_at: now,
      },
      { onConflict: "manager_user_id" },
    );

  const email = await loadManagerEmail(db, managerUserId);
  if (!email) return;
  await sendManagerCommsBillingEmail({
    to: email,
    subject: "PropLane — communication billing paused",
    text: [
      "We could not charge your card for communication usage.",
      "",
      "Outbound texts and voice on your work number are paused until you update your payment method in Settings.",
    ].join("\n"),
  });
}

export async function maybeNotifyCommsBudgetThreshold(
  db: SupabaseClient,
  managerUserId: string,
): Promise<void> {
  if (!process.env.RESEND_API_KEY?.trim()) return;
  const { data: account, error } = await db.from("manager_comms_billing_accounts")
    .select("monthly_budget_cents").eq("manager_user_id", managerUserId).maybeSingle();
  if (error || !account?.monthly_budget_cents) return;
  const email = await loadManagerEmail(db, managerUserId);
  if (!email) return;
  const { data: alert, error: claimError } = await db.rpc("claim_comms_budget_alert", { p_owner: managerUserId });
  if (claimError || !alert) return;
  await sendManagerCommsBillingEmail({ to: email,
    subject: `PropLane — communication usage at ${alert.threshold}% of budget`,
    text: `Your communication usage this month is ${formatUsdFromCents(alert.used)}. Your budget is ${formatUsdFromCents(alert.budget)}.\n\nView usage and buy credit in Settings → Billing & plan. New outgoing activity stops when credit runs out.`,
  });
}

export async function clearCommsBillingPause(
  db: SupabaseClient,
  managerUserId: string,
): Promise<void> {
  await db.from("manager_comms_billing_accounts")
    .update({ billing_paused_at: null, billing_pause_reason: null, updated_at: new Date().toISOString() })
    .eq("manager_user_id", managerUserId).eq("billing_pause_reason", "payment_failed");
  await notifyCommsBillingPaymentMethodUpdated(db, managerUserId);
}
