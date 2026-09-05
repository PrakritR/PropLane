import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMMS_BILLING_METER_LABELS,
  COMMS_BILLING_RATES_CENTS,
  type CommsBillingMeter,
  formatUsdFromCents,
  isCommsPaygBillingEnabled,
} from "@/lib/comms-billing/rates";
import {
  commsBillingBlockMessage,
  evaluateManagerCommsBillingGate,
  type CommsBillingBlockReason,
} from "@/lib/comms-billing/eligibility.server";

export type CommsUsageMeterTotal = {
  meter: CommsBillingMeter;
  label: string;
  quantity: number;
  totalCents: number;
};

export type ManagerCommsBillingSummary = {
  paygEnabled: boolean;
  allowed: boolean;
  blockReason: CommsBillingBlockReason | null;
  blockMessage: string | null;
  monthToDateCents: number;
  monthlyBudgetCents: number | null;
  hasPaymentMethod: boolean;
  billingPaused: boolean;
  ratesCents: Record<CommsBillingMeter, number>;
  meterTotals: CommsUsageMeterTotal[];
  periodStart: string;
  periodEnd: string;
  formattedMonthToDate: string;
};

function currentBillingPeriodUtc(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Month-to-date usage in cents, for the allowance gate.
 *
 * Separate from the full summary because the gate runs on the hot path of every
 * send — it needs one number, not the per-meter breakdown and account row the
 * settings panel asks for.
 */
export async function monthToDateUsageCents(
  db: SupabaseClient,
  managerUserId: string,
): Promise<number> {
  const { start, end } = currentBillingPeriodUtc();
  const { data, error } = await db
    .from("manager_comms_usage_events")
    .select("total_cents")
    .eq("manager_user_id", managerUserId)
    .gte("created_at", start)
    .lt("created_at", end);
  // A failed read must not read as "no usage" — that would hand out unlimited
  // free usage whenever the database hiccups. Report the allowance as spent and
  // let the card check decide.
  if (error) return Number.MAX_SAFE_INTEGER;
  let cents = 0;
  for (const row of data ?? []) cents += Number((row as { total_cents?: unknown }).total_cents) || 0;
  return cents;
}

export async function loadManagerCommsBillingSummary(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerCommsBillingSummary> {
  const { start, end } = currentBillingPeriodUtc();
  const paygEnabled = isCommsPaygBillingEnabled();
  const gate = await evaluateManagerCommsBillingGate(db, managerUserId);

  const [{ data: account }, { data: events }] = await Promise.all([
    db
      .from("manager_comms_billing_accounts")
      .select(
        "monthly_budget_cents, has_default_payment_method, billing_paused_at",
      )
      .eq("manager_user_id", managerUserId)
      .maybeSingle(),
    db
      .from("manager_comms_usage_events")
      .select("meter, quantity, total_cents")
      .eq("manager_user_id", managerUserId)
      .gte("created_at", start)
      .lt("created_at", end),
  ]);

  const byMeter = new Map<CommsBillingMeter, { quantity: number; totalCents: number }>();
  let monthToDateCents = 0;
  for (const row of events ?? []) {
    const meter = String(row.meter) as CommsBillingMeter;
    const quantity = Number(row.quantity) || 0;
    const totalCents = Number(row.total_cents) || 0;
    monthToDateCents += totalCents;
    const prev = byMeter.get(meter) ?? { quantity: 0, totalCents: 0 };
    byMeter.set(meter, {
      quantity: prev.quantity + quantity,
      totalCents: prev.totalCents + totalCents,
    });
  }

  const meterTotals = (Object.keys(COMMS_BILLING_RATES_CENTS) as CommsBillingMeter[])
    .map((meter) => {
      const totals = byMeter.get(meter) ?? { quantity: 0, totalCents: 0 };
      return {
        meter,
        label: COMMS_BILLING_METER_LABELS[meter],
        quantity: totals.quantity,
        totalCents: totals.totalCents,
      };
    })
    .filter((row) => row.quantity > 0);

  const blockReason = gate.allowed ? null : gate.reason;

  return {
    paygEnabled,
    allowed: gate.allowed,
    blockReason,
    blockMessage: blockReason ? commsBillingBlockMessage(blockReason) : null,
    monthToDateCents,
    monthlyBudgetCents:
      account?.monthly_budget_cents != null ? Number(account.monthly_budget_cents) : null,
    hasPaymentMethod: Boolean(account?.has_default_payment_method),
    billingPaused: Boolean(account?.billing_paused_at),
    ratesCents: COMMS_BILLING_RATES_CENTS,
    meterTotals,
    periodStart: start,
    periodEnd: end,
    formattedMonthToDate: formatUsdFromCents(monthToDateCents),
  };
}
