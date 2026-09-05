import type { SupabaseClient } from "@supabase/supabase-js";
import { formatUsdFromCents } from "@/lib/comms-billing/rates";
import { loadManagerCommsBillingSummary } from "@/lib/comms-billing/summary.server";

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
      "Text, voice, and AI assistant usage on your work number is billed pay-as-you-go.",
      "View usage in Settings → Messaging.",
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
  const summary = await loadManagerCommsBillingSummary(db, managerUserId);
  if (!summary.paygEnabled || summary.monthlyBudgetCents == null || summary.monthlyBudgetCents <= 0) {
    return;
  }

  const budget = summary.monthlyBudgetCents;
  const used = summary.monthToDateCents;
  const ratio = used / budget;
  if (ratio < 0.8) return;

  const { data: account } = await db
    .from("manager_comms_billing_accounts")
    .select("notified_budget_80_at, notified_budget_100_at")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();

  const now = new Date().toISOString();
  const email = await loadManagerEmail(db, managerUserId);
  if (!email) return;

  if (ratio >= 1 && !account?.notified_budget_100_at) {
    await db
      .from("manager_comms_billing_accounts")
      .upsert(
        {
          manager_user_id: managerUserId,
          notified_budget_100_at: now,
          updated_at: now,
        },
        { onConflict: "manager_user_id" },
      );
    await sendManagerCommsBillingEmail({
      to: email,
      subject: "PropLane — communication usage at 100% of budget",
      text: [
        `Your communication usage this month is ${formatUsdFromCents(used)}.`,
        `Your budget is ${formatUsdFromCents(budget)}.`,
        "",
        "Usage continues to accrue. Update your budget or payment method in Settings if needed.",
      ].join("\n"),
    });
    return;
  }

  if (ratio >= 0.8 && ratio < 1 && !account?.notified_budget_80_at) {
    await db
      .from("manager_comms_billing_accounts")
      .upsert(
        {
          manager_user_id: managerUserId,
          notified_budget_80_at: now,
          updated_at: now,
        },
        { onConflict: "manager_user_id" },
      );
    await sendManagerCommsBillingEmail({
      to: email,
      subject: "PropLane — communication usage at 80% of budget",
      text: [
        `Your communication usage this month is ${formatUsdFromCents(used)} (${Math.round(ratio * 100)}% of your ${formatUsdFromCents(budget)} budget).`,
        "",
        "View details in Settings → Messaging.",
      ].join("\n"),
    });
  }
}

export async function clearCommsBillingPause(
  db: SupabaseClient,
  managerUserId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .from("manager_comms_billing_accounts")
    .upsert(
      {
        manager_user_id: managerUserId,
        billing_paused_at: null,
        billing_pause_reason: null,
        updated_at: now,
      },
      { onConflict: "manager_user_id" },
    );
  await notifyCommsBillingPaymentMethodUpdated(db, managerUserId);
}
