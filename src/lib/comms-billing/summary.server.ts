import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMMS_BILLING_METER_LABELS,
  COMMS_BILLING_RATES_CENTS,
  type CommsBillingMeter,
  formatUsdFromCents,
  isCommsPaygBillingEnabled,
} from "./rates";
import {
  commsBillingBlockMessage,
  type CommsBillingBlockReason,
} from "./eligibility.server";
import { loadCommsWallet, type CommsWallet } from "./wallet.server";

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
  wallet: CommsWallet;
  purchases: {
    id: string;
    creditCents: number;
    status: string;
    createdAt: string;
    reversedCents: number;
  }[];
};

async function usageRows(
  db: SupabaseClient,
  owner: string,
  start: string,
  end: string,
) {
  const rows: {
    meter: string;
    quantity: number;
    total_cents: number;
    credit_state: string;
  }[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .from("manager_comms_usage_events")
      .select("meter, quantity, total_cents, credit_state")
      .eq("manager_user_id", owner)
      .gte("created_at", start)
      .lt("created_at", end)
      .order("id")
      .range(offset, offset + 499);
    if (error) throw new Error("Communication usage could not be loaded.");
    rows.push(...(data ?? []).filter((row) => row.credit_state !== "released"));
    if ((data?.length ?? 0) < 500) return rows;
  }
}

export async function monthToDateUsageCents(db: SupabaseClient, owner: string) {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  ).toISOString();
  return (await usageRows(db, owner, start, end)).reduce(
    (total, row) => total + Number(row.total_cents),
    0,
  );
}

export async function loadManagerCommsBillingSummary(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerCommsBillingSummary> {
  const wallet = await loadCommsWallet(db, managerUserId);
  const [events, accountResult, purchasesResult] = await Promise.all([
    usageRows(db, managerUserId, wallet.periodStart, wallet.periodEnd),
    db
      .from("manager_comms_billing_accounts")
      .select("monthly_budget_cents, has_default_payment_method")
      .eq("manager_user_id", managerUserId)
      .maybeSingle(),
    db
      .from("manager_comms_credit_purchases")
      .select("id, credit_cents, status, created_at, reversed_cents")
      .eq("manager_user_id", managerUserId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  if (accountResult.error || purchasesResult.error)
    throw new Error("Communication billing could not be loaded.");
  const meterTotals = (
    Object.keys(COMMS_BILLING_RATES_CENTS) as CommsBillingMeter[]
  )
    .map((meter) => {
      const rows = events.filter((row) => row.meter === meter);
      return {
        meter,
        label: COMMS_BILLING_METER_LABELS[meter],
        quantity: rows.reduce((sum, row) => sum + Number(row.quantity), 0),
        totalCents: rows.reduce((sum, row) => sum + Number(row.total_cents), 0),
      };
    })
    .filter((row) => row.quantity > 0);
  const monthToDateCents = meterTotals.reduce(
    (sum, row) => sum + row.totalCents,
    0,
  );
  const blockReason = wallet.paused
    ? "billing_paused"
    : wallet.remainingCents === 0
      ? "allowance_exhausted"
      : null;
  return {
    wallet,
    paygEnabled: isCommsPaygBillingEnabled(),
    allowed: !blockReason,
    blockReason,
    blockMessage: blockReason ? commsBillingBlockMessage(blockReason) : null,
    monthToDateCents,
    formattedMonthToDate: formatUsdFromCents(monthToDateCents),
    monthlyBudgetCents: accountResult.data?.monthly_budget_cents ?? null,
    hasPaymentMethod: accountResult.data?.has_default_payment_method === true,
    billingPaused: wallet.paused,
    ratesCents: COMMS_BILLING_RATES_CENTS,
    meterTotals,
    periodStart: wallet.periodStart,
    periodEnd: wallet.periodEnd,
    purchases: (purchasesResult.data ?? []).map((row) => ({
      id: row.id,
      creditCents: row.credit_cents,
      status: row.status,
      createdAt: row.created_at,
      reversedCents: row.reversed_cents,
    })),
  };
}
