import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { estimateMonthlyIncome, looksLikePayrollDeposit, type IncomeTransactionInput } from "@/lib/plaid/income-calc";
import {
  computeIncomeFromPublicToken,
  incomeCheckOffered,
  loadIncomeVerification,
} from "@/lib/plaid/income.server";
import { incomeStatedVsVerifiedLine, incomeVerifiedLine } from "@/lib/screening/income-verification";
import { defaultApplicantScreeningSettings } from "@/lib/screening/applicant-screening";

const wages = (amount: number, name = "ACME CORP PAYROLL"): IncomeTransactionInput => ({
  amount: -amount,
  name,
  personal_finance_category: { primary: "INCOME", detailed: "INCOME_WAGES" },
});

describe("income calc", () => {
  it("averages payroll deposits over 3 months", () => {
    const estimate = estimateMonthlyIncome([wages(2425), wages(2425), wages(2425), wages(2425), wages(2425), wages(2425)]);
    expect(estimate).toEqual({ ok: true, estimate: { monthlyIncomeCents: 485000, months: 3, depositCount: 6 } });
  });

  it("recognises payroll by name when the category is missing", () => {
    expect(looksLikePayrollDeposit({ amount: -1800, name: "GUSTO DIRECT DEP 4412" })).toBe(true);
    expect(looksLikePayrollDeposit({ amount: -1800, name: "ADP PAYROLL" })).toBe(true);
  });

  it("never counts transfers, refunds, peer payments, spending or pending lines", () => {
    expect(looksLikePayrollDeposit({ amount: -500, name: "ZELLE FROM AKSHAYA", personal_finance_category: { primary: "TRANSFER_IN" } })).toBe(false);
    expect(looksLikePayrollDeposit({ amount: -500, name: "VENMO CASHOUT" })).toBe(false);
    expect(looksLikePayrollDeposit({ amount: -25, name: "AMAZON REFUND" })).toBe(false);
    expect(looksLikePayrollDeposit({ amount: 2400, name: "PAYROLL" })).toBe(false);
    expect(looksLikePayrollDeposit({ ...wages(2400), pending: true })).toBe(false);
    expect(looksLikePayrollDeposit({ amount: -900, name: "ACH PAYROLL TRANSFER" })).toBe(false);
  });

  const dated = (amount: number, date: string) => ({ ...wages(amount), date });

  it("divides by the period the paychecks earn over, not the window asked for", () => {
    // Three monthly paychecks: the figure is one paycheck a month, whatever window was requested, and the
    // label is the history the bank really shared (61 days), never the derived 3-month earning period.
    expect(estimateMonthlyIncome([dated(2425, "2026-09-15"), dated(2425, "2026-10-15"), dated(2425, "2026-11-15")])).toEqual({
      ok: true,
      estimate: { monthlyIncomeCents: 242500, months: 2, depositCount: 3 },
    });
  });

  it("reads a biweekly cadence as biweekly, not as the calendar span", () => {
    // Three biweekly paychecks over 28 days: 2425 x 26 / 12 is about 5254/mo.
    const estimate = estimateMonthlyIncome([dated(2425, "2026-10-22"), dated(2425, "2026-11-05"), dated(2425, "2026-11-19")]);
    expect(estimate).toEqual({ ok: true, estimate: { monthlyIncomeCents: 527264, months: 1, depositCount: 3 } });
  });

  it("reads a semi-monthly cadence too", () => {
    const dates = ["2026-09-01", "2026-09-15", "2026-10-01", "2026-10-15", "2026-11-01", "2026-11-15"];
    // 1212.50 twice a month is 2425/mo; the derived figure lands within a couple of percent.
    expect(estimateMonthlyIncome(dates.map((date) => dated(1212.5, date)))).toEqual({
      ok: true,
      estimate: { monthlyIncomeCents: 246057, months: 2, depositCount: 6 },
    });
  });

  it("keeps the full window when the bank shared it all", () => {
    const estimate = estimateMonthlyIncome([dated(2425, "2026-08-20"), dated(2425, "2026-10-05"), dated(2425, "2026-11-18")]);
    expect(estimate).toMatchObject({ ok: true, estimate: { months: 3, monthlyIncomeCents: 242500 } });
  });

  it("gives no figure when the paychecks span less than a month of real observation", () => {
    const close = ["2026-11-05", "2026-11-12", "2026-11-19"].map((date) => dated(2425, date));
    expect(estimateMonthlyIncome(close)).toEqual({ ok: false, reason: "not_enough_history", depositCount: 3 });
  });

  it("gives no figure from a cadence guessed off a single gap", () => {
    // Two deposits are one interval: a monthly paycheck pair and a paycheck plus a bonus look identical,
    // and the period that single gap implies is what would double the figure.
    expect(estimateMonthlyIncome([dated(2425, "2026-10-10"), dated(2425, "2026-11-09")])).toEqual({
      ok: false,
      reason: "not_enough_history",
      depositCount: 2,
    });
    expect(estimateMonthlyIncome([wages(2400), wages(2400)])).toMatchObject({ ok: false, reason: "not_enough_history" });
  });

  it("says paychecks were FOUND but the history is short, apart from finding none at all", () => {
    // Paychecks are plainly there in both short cases above; only an account with none says so.
    expect(estimateMonthlyIncome([])).toEqual({ ok: false, reason: "no_payroll_deposits", depositCount: 0 });
    expect(estimateMonthlyIncome([{ amount: 12, name: "COFFEE" }])).toEqual({ ok: false, reason: "no_payroll_deposits", depositCount: 0 });
    expect(estimateMonthlyIncome([wages(2400)])).toMatchObject({ ok: false, reason: "not_enough_history", depositCount: 1 });
  });
});

describe("display line", () => {
  const v = { source: "plaid" as const, monthlyIncomeCents: 485000, months: 3, depositCount: 6, verifiedAt: "2026-11-18T00:00:00.000Z" };
  it("draws stated and verified as one plain glyph fact", () => {
    expect(incomeVerifiedLine(v)).toBe("✓ $4,850/mo verified (Plaid, 3 mo)");
    expect(incomeStatedVsVerifiedLine("4,800", v)).toBe("$4,800/mo stated · ✓ $4,850/mo verified (Plaid, 3 mo)");
    expect(incomeStatedVsVerifiedLine("", v)).toBe("✓ $4,850/mo verified (Plaid, 3 mo)");
    expect(incomeStatedVsVerifiedLine("$4800", v, { glyph: false })).toBe("$4,800/mo stated · $4,850/mo verified (Plaid, 3 mo)");
  });
});

function fakePlaid(transactions: IncomeTransactionInput[], opts: { notReady?: number } = {}) {
  let notReady = opts.notReady ?? 0;
  return {
    itemPublicTokenExchange: vi.fn(async () => ({ data: { access_token: "access-sandbox-secret", item_id: "item-1" } })),
    accountsGet: vi.fn(),
    transactionsGet: vi.fn(async () => {
      if (notReady > 0) {
        notReady -= 1;
        throw { response: { data: { error_code: "PRODUCT_NOT_READY", error_type: "ITEM_ERROR", error_message: "x" }, status: 400 } };
      }
      return { data: { transactions, total_transactions: transactions.length } };
    }),
    itemRemove: vi.fn(async () => ({ data: {} })),
  };
}

describe("computeIncomeFromPublicToken", () => {
  const now = new Date("2026-11-18T12:00:00.000Z");
  const wait = async () => undefined;

  it("computes the figure on the server and removes the Item", async () => {
    const client = fakePlaid([wages(2400), wages(2450), wages(2500), wages(2400), wages(2450), wages(2500)]);
    const result = await computeIncomeFromPublicToken({ publicToken: "public-sandbox-x", now, wait }, client as never);
    expect(result.ok && result.verification).toMatchObject({ source: "plaid", monthlyIncomeCents: 490000, months: 3, depositCount: 6, verifiedAt: now.toISOString() });
    expect(client.itemRemove).toHaveBeenCalledWith({ access_token: "access-sandbox-secret" });
  });

  it("retries a not-ready Item, and still removes the Item when there is no income", async () => {
    const client = fakePlaid([{ amount: 12, name: "COFFEE" }], { notReady: 2 });
    const result = await computeIncomeFromPublicToken({ publicToken: "p", now, wait }, client as never);
    expect(result).toMatchObject({ ok: false, status: 422, error: "We couldn't find regular paychecks in that account." });
    expect(client.transactionsGet).toHaveBeenCalledTimes(3);
    expect(client.itemRemove).toHaveBeenCalledTimes(1);
  });

  it("tells an applicant whose bank shared too little history exactly that, not that no pay was found", async () => {
    const client = fakePlaid([
      { ...wages(2400), date: "2026-10-10" },
      { ...wages(2400), date: "2026-11-09" },
    ]);
    const result = await computeIncomeFromPublicToken({ publicToken: "p", now, wait }, client as never);
    expect(result).toMatchObject({ ok: false, status: 422, error: "That account doesn't have enough paycheck history yet." });
    expect(client.itemRemove).toHaveBeenCalledTimes(1);
  });

  it("removes the Item even when Plaid fails", async () => {
    const client = fakePlaid([]);
    client.transactionsGet.mockRejectedValue({ response: { data: { error_code: "ITEM_LOGIN_REQUIRED" }, status: 400 } });
    await expect(computeIncomeFromPublicToken({ publicToken: "p", now, wait }, client as never)).rejects.toBeTruthy();
    expect(client.itemRemove).toHaveBeenCalledTimes(1);
  });
});

function settingsDb(rowData: Record<string, unknown> | null) {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({
        data: table === "manager_property_records" ? { id: "prop-1", manager_user_id: "mgr-1", workspace_id: "ws-1" } : table === "workspace_automation_settings" ? rowData : null,
        error: null,
      });
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe("the listing setting", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults OFF", () => {
    expect(defaultApplicantScreeningSettings(false).verifyIncomeWithPlaid).toBe(false);
    expect(defaultApplicantScreeningSettings(true).verifyIncomeWithPlaid).toBe(false);
  });

  it("is not offered when Plaid is disabled, even with the setting on", async () => {
    vi.stubEnv("PLAID_CLIENT_ID", "");
    vi.stubEnv("PLAID_SECRET", "");
    vi.stubEnv("PLAID_ENV", "");
    expect(await incomeCheckOffered(settingsDb({ row_data: { applicantScreening: { verifyIncomeWithPlaid: true } } }), "prop-1")).toBe(false);
  });

  it("is offered only when Plaid is on AND the setting is on", async () => {
    vi.stubEnv("PLAID_CLIENT_ID", "id");
    vi.stubEnv("PLAID_SECRET", "secret");
    vi.stubEnv("PLAID_ENV", "sandbox");
    expect(await incomeCheckOffered(settingsDb(null), "prop-1")).toBe(false);
    expect(await incomeCheckOffered(settingsDb({ row_data: { applicantScreening: { verifyIncomeWithPlaid: true } } }), "prop-1")).toBe(true);
  });
});

describe("loadIncomeVerification", () => {
  const dbWith = (row: Record<string, unknown> | null) =>
    ({ from: () => { const c: Record<string, unknown> = {}; c.select = () => c; c.eq = () => c; c.maybeSingle = async () => ({ data: row, error: null }); return c; } }) as unknown as SupabaseClient;
  const now = new Date("2026-11-18T00:00:00.000Z");

  it("returns a fresh stored figure and nothing stale or missing", async () => {
    const fresh = { monthly_income_cents: 485000, months: 3, deposit_count: 6, institution_name: null, verified_at: "2026-11-10T00:00:00.000Z" };
    expect(await loadIncomeVerification(dbWith(fresh), "u", "prop-1", now)).toMatchObject({ monthlyIncomeCents: 485000, months: 3 });
    expect(await loadIncomeVerification(dbWith({ ...fresh, verified_at: "2026-09-01T00:00:00.000Z" }), "u", "prop-1", now)).toBeNull();
    expect(await loadIncomeVerification(dbWith(null), "u", "prop-1", now)).toBeNull();
  });
});
