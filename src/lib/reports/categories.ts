import type { HouseholdChargeKind } from "@/lib/household-charges";
import {
  systemChartAccountByCode,
  SYSTEM_CHART_ACCOUNTS_FALLBACK,
  type ChartAccountRow,
} from "@/lib/reports/chart-of-accounts-store";

export type ChartAccount = ChartAccountRow;

/**
 * @deprecated Defense-in-depth fallback only (used by chart-of-accounts-store.ts
 * when the DB read fails) and the source for the dropdown category pickers in
 * manager-finances-panel.tsx / manager-add-outgoing-payment-modal.tsx /
 * the /api/income and /api/expenses routes. The chart_of_accounts table
 * (src/lib/reports/chart-of-accounts-store.ts) is the runtime source of
 * truth for report label/Schedule E lookups — do not add new codes here
 * without also seeding them in supabase/migrations/20260710090000_chart_of_accounts_double_entry.sql.
 */
export const SYSTEM_CHART_ACCOUNTS: ChartAccount[] = SYSTEM_CHART_ACCOUNTS_FALLBACK;

export type WorkOrderCategory = "cleaning" | "plumbing" | "mold" | "electrical" | "hvac" | "general" | "appliance" | "access";

export const WORK_ORDER_CATEGORY_TO_EXPENSE: Record<WorkOrderCategory, string> = {
  cleaning: "cleaning",
  plumbing: "plumbing",
  mold: "mold_remediation",
  electrical: "maintenance",
  hvac: "heating",
  general: "maintenance",
  appliance: "maintenance",
  access: "maintenance",
};

/**
 * Charge-kind → chart-account-code business mapping. This is a hardcoded rule
 * (which kind of charge books to which account), independent of the
 * chart_of_accounts row data itself (names/Schedule E/etc.), so it stays a
 * plain sync lookup rather than a DB-backed wrapper.
 *
 * security_deposit books to the security_deposit_liability account (a
 * liability, not income) — deposits held for a tenant are not the manager's
 * income. move_in_fee stays income: it's genuinely non-refundable, unlike a
 * deposit. Full liability sub-ledger/GL posting lands in a later phase; this
 * mapping only stops new deposit charges from silently miscategorizing.
 */
const KIND_TO_CATEGORY: Record<HouseholdChargeKind, string> = {
  rent: "rent_income",
  stay_total: "rent_income",
  first_month_rent: "rent_income",
  prorated_rent: "rent_income",
  prorated_last_month_rent: "rent_income",
  late_fee: "late_fees",
  application_fee: "application_fee",
  holding_deposit: "security_deposit_liability",
  utilities: "other_income",
  prorated_utilities: "other_income",
  prorated_last_month_utilities: "other_income",
  prorated_fee: "other_income",
  prorated_last_month_fee: "other_income",
  early_move_out_fee: "other_income",
  security_deposit: "security_deposit_liability",
  move_in_fee: "other_income",
  other_cost: "other_income",
  payment_at_signing: "other_income",
  work_order_charge: "other_income",
  nsf_fee: "nsf_fees",
};

export function categoryCodeForChargeKind(kind: string | null | undefined): string {
  if (!kind) return "other_income";
  return KIND_TO_CATEGORY[kind as HouseholdChargeKind] ?? "other_income";
}

/**
 * chart_of_accounts-backed (src/lib/reports/chart-of-accounts-store.ts) label
 * lookup — reads from the store's synchronous system-account cache, which is
 * warmed by an awaited `primeSystemChartOfAccounts(db)` call at the top of
 * report-query functions that loop over rows calling this. Falls back to the
 * SYSTEM_CHART_ACCOUNTS_FALLBACK constant if the cache hasn't been warmed yet.
 */
export function chartAccountLabel(code: string): string {
  return systemChartAccountByCode(code)?.name ?? code;
}

export function chartAccountScheduleE(code: string): { ref: string; label: string } | null {
  const acct = systemChartAccountByCode(code);
  if (!acct?.scheduleERef) return null;
  return { ref: acct.scheduleERef, label: acct.scheduleELabel ?? acct.name };
}

/**
 * Rule-based tax classification: is an expense in this category deductible on
 * Schedule E? Unknown/custom codes default to deductible (Sch. E, Line 19 "Other").
 */
export function isCategoryDeductible(code: string | null | undefined): boolean {
  if (!code) return true;
  const acct = systemChartAccountByCode(code);
  if (!acct) return true;
  if (typeof acct.deductible === "boolean") return acct.deductible;
  return acct.accountType === "expense";
}

/** Stored per-expense override (or the value captured at create) wins; otherwise fall back to the category rule. */
export function resolveExpenseTaxDeductible(
  categoryCode: string | null | undefined,
  stored: boolean | null | undefined,
): boolean {
  return typeof stored === "boolean" ? stored : isCategoryDeductible(categoryCode);
}

export function expenseTaxStatusLabel(deductible: boolean): string {
  return deductible ? "Deductible" : "Non-deductible";
}
