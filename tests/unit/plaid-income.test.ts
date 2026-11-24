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
  // The figure is an OBSERVATION: the payroll that landed in the last 90 days, divided by those 3 months. Oracle for
  // every case below is that worked sum, stated as dollars in the comment — not a rate derived from the deposits.
  // docs/agents/plaid.md § Income check owns the contract. Each case also names the figure the old rate estimator
  // reported, so the test rejects it.
  const NOW = new Date("2026-11-30T00:00:00.000Z");
  const observe = (rows: IncomeTransactionInput[]) => estimateMonthlyIncome(rows, 3, NOW);

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

  it("counts both sides of a job change: $14,550 of payroll over the window is $4,850/mo", () => {
    const old = ["2026-09-04", "2026-09-18", "2026-10-02"].map((date) => dated(2425, date));
    const next = ["2026-10-16", "2026-10-30", "2026-11-13"].map((date) => ({ ...wages(2425, "GLOBEX PAYROLL"), date }));
    // Per-payer rates added each job's own $5,272/mo and reported $10,545/mo on $4,850 of real payroll.
    expect(observe([...old, ...next])).toEqual({
      ok: true,
      estimate: { monthlyIncomeCents: 485000, months: 3, depositCount: 6, historyDays: 87 },
    });
  });

  it("counts a variable hourly paycheck in full: $12,500 over the window is $4,167/mo", () => {
    const amounts = [1200, 2600, 1500, 1800, 1300, 2400, 1700];
    const dates = ["2026-09-04", "2026-09-18", "2026-10-02", "2026-10-16", "2026-10-30", "2026-11-13", "2026-11-27"];
    // The ±25% amount band called $1,200, $2,600 and $2,400 off-cycle and reported $2,740/mo.
    expect(observe(amounts.map((amount, i) => dated(amount, dates[i]!)))).toMatchObject({
      ok: true,
      estimate: { monthlyIncomeCents: 416667, depositCount: 7 },
    });
  });

  it("counts a bonus: it is money that arrived, and the window never claims it repeats", () => {
    const pay = ["2026-10-02", "2026-10-16", "2026-10-30"].map((date) => dated(2425, date));
    const bonus = { ...dated(3000, "2026-10-31"), name: "ACME CORP PAYROLL BONUS" };
    // $7,275 + $3,000 over 3 months. The cadence estimators set the bonus aside and reported $5,272/mo.
    expect(observe([...pay, bonus])).toMatchObject({ ok: true, estimate: { monthlyIncomeCents: 342500, depositCount: 4 } });
  });

  it("says how little bank history a short one is, instead of scaling it up", () => {
    const pay = ["2026-10-30", "2026-11-13", "2026-11-27"].map((date) => dated(2425, date));
    const firstTransaction = { amount: 42, name: "COFFEE", date: "2026-10-16" };
    const estimate = observe([firstTransaction, ...pay]);
    // $7,275 over 3 months is $2,425/mo, from an account only 45 days old - which the manager's line has to say.
    expect(estimate).toMatchObject({ ok: true, estimate: { monthlyIncomeCents: 242500, depositCount: 3, historyDays: 45 } });
    expect(estimate.ok && incomeVerifiedLine({ source: "plaid", verifiedAt: NOW.toISOString(), ...estimate.estimate })).toBe(
      "✓ $2,425/mo avg of payroll deposits, last 90 days (3 deposits) · only 45 days of bank history · as of Nov 29",
    );
  });

  it("ignores a deposit with no usable date rather than guessing at one", () => {
    const pay = ["2026-10-02", "2026-10-16", "2026-10-30"].map((date) => dated(2425, date));
    expect(observe([...pay, wages(5000)])).toMatchObject({
      ok: true,
      estimate: { monthlyIncomeCents: 242500, depositCount: 3 },
    });
  });

  it("gives no figure from fewer than three deposits in the window", () => {
    const inside = ["2026-10-16", "2026-11-13"].map((date) => dated(2425, date));
    const before = dated(2425, "2026-06-01");
    expect(observe([...inside, before])).toEqual({ ok: false, reason: "not_enough_history", depositCount: 3 });
    expect(observe(inside)).toEqual({ ok: false, reason: "not_enough_history", depositCount: 2 });
  });

  it("says paychecks were FOUND but the window holds too few, apart from finding none at all", () => {
    // Paychecks are plainly there in the short cases above; only an account with none says so.
    expect(observe([])).toEqual({ ok: false, reason: "no_payroll_deposits", depositCount: 0 });
    expect(observe([{ amount: 12, name: "COFFEE" }])).toEqual({ ok: false, reason: "no_payroll_deposits", depositCount: 0 });
    expect(observe([wages(2400)])).toEqual({ ok: false, reason: "not_enough_history", depositCount: 1 });
  });
});

describe("display line", () => {
  // The manager reads the figure AND its basis in one plain fact, so "$4,850/mo" cannot be mistaken for a promised
  // rate: it is the average of 6 payroll deposits over a stated 90-day window. docs/agents/plaid.md § Income check
  // owns the wording. Plausible wrong behaviour this rejects: a bare "verified" figure with no window or count.
  const v = { source: "plaid" as const, monthlyIncomeCents: 485000, months: 3, depositCount: 6, historyDays: 90, verifiedAt: "2026-11-18T19:00:00.000Z" };
  const fact = "$4,850/mo avg of payroll deposits, last 90 days (6 deposits) · as of Nov 18";
  it("draws stated and verified as one plain glyph fact, with the basis in it", () => {
    expect(incomeVerifiedLine(v)).toBe(`✓ ${fact}`);
    expect(incomeStatedVsVerifiedLine("4,800", v)).toBe(`$4,800/mo stated · ✓ ${fact}`);
    expect(incomeStatedVsVerifiedLine("", v)).toBe(`✓ ${fact}`);
    expect(incomeStatedVsVerifiedLine("$4800", v, { glyph: false })).toBe(`$4,800/mo stated · ${fact}`);
    // An applicant's free text is quoted as they wrote it: stripping the punctuation out of "4,800 - 5,200" used to
    // read it as $48,005,200/mo, a figure nobody stated, and "4.8k" as $5/mo.
    expect(incomeStatedVsVerifiedLine("4,800 - 5,200", v)).toBe(`4,800 - 5,200 stated · ✓ ${fact}`);
    expect(incomeStatedVsVerifiedLine("4.8k", v)).toBe(`4.8k stated · ✓ ${fact}`);
    expect(incomeStatedVsVerifiedLine("varies", v)).toBe(`varies stated · ✓ ${fact}`);
    expect(incomeStatedVsVerifiedLine("$4,800.50", v)).toBe(`$4,801/mo stated · ✓ ${fact}`);
  });

  it("names a short bank history, and says nothing extra for a full one or an unrecorded one", () => {
    expect(incomeVerifiedLine({ ...v, historyDays: 45 })).toBe(
      "✓ $4,850/mo avg of payroll deposits, last 90 days (6 deposits) · only 45 days of bank history · as of Nov 18",
    );
    expect(incomeVerifiedLine({ ...v, historyDays: 84 })).toBe(`✓ ${fact}`);
    expect(incomeVerifiedLine({ ...v, historyDays: null })).toBe(`✓ ${fact}`);
  });

  // A stored row from before a basis field existed, or a projection that dropped one, must not put the word
  // "undefined" on the screen: the clause for a fact we do not have is simply absent. The reported failure was
  // "(undefined deposits)" on an applicant's reload. The as-of date is read in Pacific, the stamp zone the rest
  // of the product uses (`formatInboxStamp`), so a UTC evening is still the same local day.
  it("omits a clause whose basis is missing instead of printing undefined", () => {
    const narrowed = { source: "plaid" as const, monthlyIncomeCents: 485000, months: 3 } as never;
    expect(incomeVerifiedLine(narrowed)).toBe("✓ $4,850/mo avg of payroll deposits, last 90 days");
    expect(incomeVerifiedLine(narrowed)).not.toContain("undefined");
    expect(incomeVerifiedLine({ ...v, depositCount: 1 })).toContain("(1 deposit) ·");
    expect(incomeVerifiedLine({ ...v, verifiedAt: "" })).toBe(
      "✓ $4,850/mo avg of payroll deposits, last 90 days (6 deposits)",
    );
    // 2026-11-04T03:00Z is still Nov 3 in Pacific, where every other stamp in the product is read.
    expect(incomeVerifiedLine({ ...v, verifiedAt: "2026-11-04T03:00:00.000Z" })).toContain("· as of Nov 3");
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
  /** $14,700 of payroll inside the 90-day window: $4,900/mo over the three months it covers. */
  const paychecks = (): IncomeTransactionInput[] =>
    [2400, 2450, 2500, 2400, 2450, 2500].map((amount, i) => ({
      ...wages(amount),
      date: ["2026-09-04", "2026-09-18", "2026-10-02", "2026-10-16", "2026-10-30", "2026-11-13"][i]!,
    }));

  it("computes the figure on the server and removes the Item", async () => {
    const client = fakePlaid(paychecks());
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
    const client = fakePlaid(paychecks());
    const named = await computeIncomeFromPublicToken({ publicToken: "p", now, wait }, client as never);
    expect(named.ok && named.verification.institutionName).toBe("First Platypus Bank");

    const blind = fakePlaid(paychecks());
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
