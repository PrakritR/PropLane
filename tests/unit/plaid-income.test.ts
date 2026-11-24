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

  // The figure a manager is shown beside what the applicant stated is the rate their paychecks ACTUALLY arrive at:
  // the deposits' own earning period (span + one cycle), never the window the bank was asked for. Oracle for every
  // case below: the paycheck amount annualized from its observed cycle, amount x (365.25 / cycleDays) / 12 - which
  // comes from the calendar, not from this module. Each case also names the figure the window-based divisors
  // reported, so the test rejects both of them.
  const monthlyFromCycle = (amount: number, cycleDays: number) => (amount * (365.25 / cycleDays)) / 12;
  const figureOf = (outcome: ReturnType<typeof estimateMonthlyIncome>) =>
    (outcome.ok ? outcome.estimate.monthlyIncomeCents : 0) / 100;
  const within1Percent = (figure: number, truth: number) => Math.abs(figure - truth) / truth < 0.01;

  it("three monthly paychecks read as one a month, labelled with the history the bank shared", () => {
    const estimate = estimateMonthlyIncome([dated(2425, "2026-09-15"), dated(2425, "2026-10-15"), dated(2425, "2026-11-15")]);
    expect(estimate).toEqual({ ok: true, estimate: { monthlyIncomeCents: 242023, months: 2, depositCount: 3 } });
    expect(within1Percent(figureOf(estimate), monthlyFromCycle(2425, 30.5))).toBe(true);
  });

  it("five weekly paychecks from a bank that shared only one month read at the weekly rate", () => {
    // The trace that matters most: $1,000 a week is $4,333/mo (1000 x 52 / 12). Dividing those five deposits by the
    // three months requested reported $1,667/mo - 38% of a real income, on the screen beside what they stated.
    const dates = ["2026-10-22", "2026-10-29", "2026-11-05", "2026-11-12", "2026-11-19"];
    const estimate = estimateMonthlyIncome(dates.map((date) => dated(1000, date)));
    expect(within1Percent(figureOf(estimate), monthlyFromCycle(1000, 7))).toBe(true);
    expect(figureOf(estimate)).toBeGreaterThan(4000);
  });

  it("three biweekly paychecks read at the biweekly rate, not as a third of it", () => {
    const estimate = estimateMonthlyIncome([dated(2425, "2026-10-22"), dated(2425, "2026-11-05"), dated(2425, "2026-11-19")]);
    expect(estimate).toEqual({ ok: true, estimate: { monthlyIncomeCents: 527264, months: 1, depositCount: 3 } });
    expect(within1Percent(figureOf(estimate), monthlyFromCycle(2425, 14))).toBe(true);
  });

  it("reads a semi-monthly cadence too", () => {
    const dates = ["2026-09-01", "2026-09-15", "2026-10-01", "2026-10-15", "2026-11-01", "2026-11-15"];
    // 1212.50 twice a month is 2425/mo; the derived figure lands within a couple of percent.
    const estimate = estimateMonthlyIncome(dates.map((date) => dated(1212.5, date)));
    expect(estimate).toEqual({ ok: true, estimate: { monthlyIncomeCents: 248821, months: 2, depositCount: 6 } });
    expect(Math.abs(figureOf(estimate) - 2425) / 2425).toBeLessThan(0.03);
  });

  // A bonus, a correction run or a final check is money that arrived once, not a monthly rate. Counted as pay it
  // lands in the figure AND shortens the period the figure is spread over, so it moves the number twice. Oracle:
  // the regular paycheck annualized from its own cycle, 2425 x (365.25/14) / 12 = $5,272/mo. Plausible wrong
  // behaviour this rejects: the mean-gap divisor, which read this account as $8,089/mo - 54% above what it pays.
  it("leaves an off-cycle deposit out of the monthly rate", () => {
    const biweekly = ["2026-10-22", "2026-11-05", "2026-11-19"].map((date) => dated(2425, date));
    const bonus = { ...dated(3000, "2026-11-20"), name: "ACME CORP PAYROLL BONUS" };
    const estimate = estimateMonthlyIncome([...biweekly, bonus]);
    expect(within1Percent(figureOf(estimate), monthlyFromCycle(2425, 14))).toBe(true);
    expect(estimate).toEqual({ ok: true, estimate: { monthlyIncomeCents: 527264, months: 1, depositCount: 3 } });
    // Dropping the bonus leaves the same rate: the figure is the pay, whatever else landed beside it.
    expect(estimateMonthlyIncome(biweekly)).toEqual(estimate);
  });

  // Same deposit, four positions: an extra deposit is not pay whether it lands before the first paycheck, between
  // two of them, beside one, or on its own mid-cycle. Oracle: the biweekly paycheck annualized from its own cycle,
  // 2425 x (365.25/14) / 12 = $5,272/mo. Plausible wrong behaviours this rejects: anchoring the cadence on a
  // leading bonus ($7,588/mo), and keeping a bonus whose amount is close enough to a paycheck ($7,274/mo).
  it("sets an off-cycle deposit aside wherever in the history it sits", () => {
    const biweekly = ["2026-10-01", "2026-10-15", "2026-10-29", "2026-11-12", "2026-11-26"];
    const pay = biweekly.map((date) => dated(2425, date));
    const extra = (amount: number, date: string) => ({ ...dated(amount, date), name: "ACME CORP PAYROLL BONUS" });
    const cases: Record<string, IncomeTransactionInput[]> = {
      "before the first paycheck": [extra(8000, "2026-09-30"), ...pay],
      "the day after a paycheck": [...pay, extra(3000, "2026-11-27")],
      "the day before a middle paycheck": [...pay, extra(3000, "2026-10-28")],
      "alone between two paychecks": [...pay, extra(5000, "2026-10-08")],
    };
    for (const [where, rows] of Object.entries(cases)) {
      const estimate = estimateMonthlyIncome(rows);
      expect(within1Percent(figureOf(estimate), monthlyFromCycle(2425, 14)), where).toBe(true);
      expect(estimate.ok && estimate.estimate.depositCount, where).toBe(5);
    }
    // And the pay alone reads the same: the figure is the cadence, never what landed beside it.
    expect(within1Percent(figureOf(estimateMonthlyIncome(pay)), monthlyFromCycle(2425, 14))).toBe(true);
  });

  // Two jobs add up. Oracle: each payer's own rate from the calendar — $5,000 a month plus $500 a week is
  // 5000 + 500 x (365.25/7)/12 = $7,167/mo. Plausible wrong behaviour this rejects: one amount band across both
  // payers, which dropped all three $5,000 salary deposits as outliers of the more numerous $500 stream and
  // reported $2,174/mo — a 70% understatement shown to the manager as verified.
  it("adds up two payrolls instead of reading only the more numerous one", () => {
    const salary = ["2026-09-01", "2026-10-01", "2026-11-01"].map((date) => dated(5000, date));
    const weekly = [
      "2026-08-26", "2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30", "2026-10-07",
      "2026-10-14", "2026-10-21", "2026-10-28", "2026-11-04", "2026-11-11", "2026-11-18",
    ].map((date) => ({ ...wages(500, "SIDE GIG PAYROLL"), date }));
    const estimate = estimateMonthlyIncome([...salary, ...weekly]);
    expect(within1Percent(figureOf(estimate), 5000 + monthlyFromCycle(500, 7))).toBe(true);
    expect(estimate.ok && estimate.estimate.depositCount).toBe(16);
    // Each payroll on its own reads its own rate, and the two together read their sum.
    expect(within1Percent(figureOf(estimateMonthlyIncome(salary)), monthlyFromCycle(5000, 30.5))).toBe(true);
    expect(within1Percent(figureOf(estimateMonthlyIncome(weekly)), monthlyFromCycle(500, 7))).toBe(true);
  });

  // The in-stream tests still carry the bonus cases when the bonus arrives under the SAME payer name, so the
  // figure does not rely on a payer string differing.
  it("sets aside a bonus paid under the paycheck's own payer name", () => {
    const pay = ["2026-10-01", "2026-10-15", "2026-10-29", "2026-11-12"].map((date) => dated(2425, date));
    const sameName = (amount: number, date: string) => dated(amount, date);
    for (const [where, rows] of Object.entries({
      "the day after": [...pay, sameName(3000, "2026-11-13")],
      "the day before": [...pay, sameName(3000, "2026-10-14")],
      "before the first paycheck": [sameName(8000, "2026-09-30"), ...pay],
      "alone mid-cycle": [...pay, sameName(5000, "2026-10-08")],
    })) {
      expect(within1Percent(figureOf(estimateMonthlyIncome(rows)), monthlyFromCycle(2425, 14)), where).toBe(true);
    }
  });

  it("gives no figure when only a pair of paychecks survives the off-cycle test", () => {
    // Two monthly paychecks plus a $5,000 deposit the next day: the pair is one gap, which cannot tell a cadence
    // from a paycheck plus a bonus (`INCOME_MIN_DEPOSITS`). The mean-gap divisor reported $5,892/mo on $2,000 pay.
    const rows = [dated(2000, "2026-09-01"), dated(2000, "2026-10-01"), { ...dated(5000, "2026-10-02"), name: "ACME PAYROLL FINAL" }];
    expect(estimateMonthlyIncome(rows)).toEqual({ ok: false, reason: "not_enough_history", depositCount: 3 });
  });

  it("reports paychecks spread wider than the window at the rate they actually arrive", () => {
    // One paycheck every 45 days across the whole window is NOT one a month: 2425 x (365.25/45) / 12 = $1,640/mo.
    // Capping the divisor at the window reported $2,425/mo, 48% above what the account shows.
    const estimate = estimateMonthlyIncome([dated(2425, "2026-08-20"), dated(2425, "2026-10-05"), dated(2425, "2026-11-18")]);
    expect(estimate).toMatchObject({ ok: true, estimate: { months: 3 } });
    expect(within1Percent(figureOf(estimate), monthlyFromCycle(2425, 45))).toBe(true);
    expect(figureOf(estimate)).toBeLessThan(2425);
  });

  it("never reports a biweekly earner above their biweekly rate, even when the window catches an extra paycheck", () => {
    // Seven $2,425 paychecks 14 days apart earn $5,272/mo. A 91-day window holds 6.5 of them on average, so
    // dividing seven by three months reported $5,658/mo, 7% too high.
    const dates = ["2026-08-27", "2026-09-10", "2026-09-24", "2026-10-08", "2026-10-22", "2026-11-05", "2026-11-19"];
    const estimate = estimateMonthlyIncome(dates.map((date) => dated(2425, date)));
    expect(within1Percent(figureOf(estimate), monthlyFromCycle(2425, 14))).toBe(true);
    expect(figureOf(estimate)).toBeLessThan((7 * 2425) / 3);
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
    // An applicant's free text is quoted as they wrote it: stripping the punctuation out of "4,800 - 5,200" used to
    // read it as $48,005,200/mo, a figure nobody stated, and "4.8k" as $5/mo.
    expect(incomeStatedVsVerifiedLine("4,800 - 5,200", v)).toBe("4,800 - 5,200 stated · ✓ $4,850/mo verified (Plaid, 3 mo)");
    expect(incomeStatedVsVerifiedLine("4.8k", v)).toBe("4.8k stated · ✓ $4,850/mo verified (Plaid, 3 mo)");
    expect(incomeStatedVsVerifiedLine("varies", v)).toBe("varies stated · ✓ $4,850/mo verified (Plaid, 3 mo)");
    expect(incomeStatedVsVerifiedLine("$4,800.50", v)).toBe("$4,801/mo stated · ✓ $4,850/mo verified (Plaid, 3 mo)");
  });
});

function fakePlaid(transactions: IncomeTransactionInput[], opts: { notReady?: number } = {}) {
  let notReady = opts.notReady ?? 0;
  return {
    itemPublicTokenExchange: vi.fn(async () => ({ data: { access_token: "access-sandbox-secret", item_id: "item-1" } })),
    accountsGet: vi.fn(async () => ({ data: { accounts: [], item: { institution_id: "ins_1" } } })),
    institutionsGetById: vi.fn(async () => ({ data: { institution: { name: "First Platypus Bank" } } })),
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

  it("stamps the bank the figure came from, and keeps the figure when that lookup fails", async () => {
    const paychecks = [wages(2400), wages(2450), wages(2500), wages(2400), wages(2450), wages(2500)];
    const client = fakePlaid(paychecks);
    const named = await computeIncomeFromPublicToken({ publicToken: "p", now, wait }, client as never);
    expect(named.ok && named.verification.institutionName).toBe("First Platypus Bank");

    const blind = fakePlaid(paychecks);
    blind.institutionsGetById.mockRejectedValue({ response: { data: { error_code: "INSTITUTION_NOT_FOUND" }, status: 400 } });
    const anonymous = await computeIncomeFromPublicToken({ publicToken: "p", now, wait }, blind as never);
    expect(anonymous).toMatchObject({ ok: true, verification: { monthlyIncomeCents: 490000, institutionName: null } });
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
