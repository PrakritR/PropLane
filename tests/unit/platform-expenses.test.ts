import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import type Stripe from "stripe";
import {
  createExpenseSchema,
  createPlatformExpense,
  deletePlatformExpense,
  expenseRangeSchema,
  getReceiptSignedUrl,
  isPlatformReceiptPath,
  listPlatformExpenses,
  updatePlatformExpense,
  createReceiptUpload,
} from "@/lib/admin/platform-expenses.server";
import {
  clearPlatformRevenueCache,
  groupBalanceTransactions,
  indexInvoiceCharges,
  loadMonthlyPlatformRevenue,
  loadPlatformPnl,
} from "@/lib/admin/platform-pnl.server";
import {
  computeMonthlyPnl,
  emptyStreams,
  expandExpensesForMonth,
  expenseDateInMonth,
  expenseTotalsByCategory,
  expenseTotalsByMonth,
  monthsEndingAt,
  type PlatformExpense,
} from "@/lib/admin/platform-expense-rules";
import { COMMS_CREDIT_PURPOSE } from "@/lib/comms-billing/credit-packs";
import { NUMBER_SUBSCRIPTION_PURPOSE } from "@/lib/number-subscription/constants";
import { parseExpenseAmountCents } from "@/components/portal/admin-add-expense-wizard";

const UUID = "11111111-1111-4111-8111-111111111111";
const RECEIPT = `receipts/${UUID}/invoice.pdf`;

type Row = Record<string, unknown> & { id: string };

function makeDb(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let seq = 0;
  const remove = vi.fn(async () => ({ data: [], error: null }));
  const bucket = {
    remove,
    createSignedUploadUrl: vi.fn(async (path: string) => ({ data: { token: "tok", path, signedUrl: "u" }, error: null })),
    createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed.example/${path}` }, error: null })),
  };
  const db = {
    rows,
    bucket,
    storage: { from: vi.fn(() => bucket) },
    from(table: string) {
      expect(table).toBe("platform_expenses");
      const state: { op: string; filters: Array<(r: Row) => boolean>; payload: Record<string, unknown> | null } = {
        op: "select",
        filters: [],
        payload: null,
      };
      const matching = () => rows.filter((r) => state.filters.every((f) => f(r)));
      const run = (single: boolean, maybe: boolean) => {
        if (state.op === "insert") {
          seq += 1;
          const row = {
            id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
            created_at: "2026-10-08T00:00:00Z",
            updated_at: "2026-10-08T00:00:00Z",
            ...state.payload,
          } as Row;
          rows.push(row);
          return Promise.resolve({ data: row, error: null });
        }
        if (state.op === "update") {
          const row = matching()[0];
          if (!row) return Promise.resolve({ data: null, error: { message: "none" } });
          Object.assign(row, state.payload);
          return Promise.resolve({ data: row, error: null });
        }
        if (state.op === "delete") {
          for (const row of matching()) rows.splice(rows.indexOf(row), 1);
          return Promise.resolve({ data: null, error: null });
        }
        const found = matching();
        return Promise.resolve({ data: single ? (found[0] ?? null) : found, error: null, maybe });
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: (p: Record<string, unknown>) => ((state.op = "insert"), (state.payload = p), chain),
        update: (p: Record<string, unknown>) => ((state.op = "update"), (state.payload = p), chain),
        delete: () => ((state.op = "delete"), chain),
        eq: (col: string, val: unknown) => (state.filters.push((r) => r[col] === val), chain),
        lte: (col: string, val: string) => (state.filters.push((r) => String(r[col]) <= val), chain),
        or: (expr: string) => {
          const m = /ends_on\.is\.null,ends_on\.gte\.(.+)/.exec(expr);
          state.filters.push((r) => r.ends_on === null || r.ends_on === undefined || String(r.ends_on) >= m![1]!);
          return chain;
        },
        order: () => chain,
        single: () => run(true, false),
        maybeSingle: () => run(true, true),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run(false, false).then(res, rej),
      };
      return chain;
    },
  };
  return db;
}

const base = {
  category: "hosting",
  vendor: "Vercel Pro",
  amountCents: 2000,
  spentOn: "2026-10-01",
  recurrence: "none",
  note: "",
};

const expense = (over: Partial<PlatformExpense> = {}): PlatformExpense => ({
  id: "e1",
  category: "hosting",
  vendor: "Vercel Pro",
  amountCents: 2000,
  currency: "usd",
  spentOn: "2026-10-01",
  recurrence: "none",
  endsOn: null,
  receiptPath: null,
  note: "",
  createdAt: "",
  updatedAt: "",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearPlatformRevenueCache();
});

describe("expense validation", () => {
  it("accepts a plain expense and defaults recurrence and note", () => {
    const parsed = createExpenseSchema.parse({ category: "hosting", vendor: " Vercel ", amountCents: 2000, spentOn: "2026-10-01" });
    expect(parsed).toMatchObject({ vendor: "Vercel", recurrence: "none", note: "" });
  });

  it.each([
    [{ category: "snacks" }],
    [{ vendor: "  " }],
    [{ amountCents: 0 }],
    [{ amountCents: 12.5 }],
    [{ spentOn: "2026-02-30" }],
    [{ recurrence: "weekly" }],
    [{ receiptPath: "../../etc/passwd" }],
    [{ recurrence: "none", endsOn: "2026-12-01" }],
    [{ recurrence: "monthly", endsOn: "2026-09-01" }],
  ])("rejects %j", (patch) => {
    expect(createExpenseSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it("only accepts receipt paths this module minted", () => {
    expect(isPlatformReceiptPath(RECEIPT)).toBe(true);
    expect(isPlatformReceiptPath(`receipts/${UUID}/../x.pdf`)).toBe(false);
    expect(isPlatformReceiptPath("receipts/not-a-uuid/x.pdf")).toBe(false);
    expect(isPlatformReceiptPath("vendor-documents/x.pdf")).toBe(false);
  });

  it("validates the month range", () => {
    expect(expenseRangeSchema.safeParse({ from: "2025-11", to: "2026-10" }).success).toBe(true);
    expect(expenseRangeSchema.safeParse({ from: "2026-10", to: "2026-09" }).success).toBe(false);
    expect(expenseRangeSchema.safeParse({ from: "2020-01", to: "2026-10" }).success).toBe(false);
    expect(expenseRangeSchema.safeParse({ from: "2026-13", to: "2026-13" }).success).toBe(false);
  });

  it("parses typed dollars to cents", () => {
    expect(parseExpenseAmountCents("1,234.5")).toBe(123_450);
    expect(parseExpenseAmountCents("20")).toBe(2000);
    expect(parseExpenseAmountCents("0")).toBeNull();
    expect(parseExpenseAmountCents("abc")).toBeNull();
  });
});

describe("expense CRUD", () => {
  it("creates, lists, edits and deletes through the service-role client", async () => {
    const db = makeDb();
    const created = await createPlatformExpense(createExpenseSchema.parse({ ...base, receiptPath: RECEIPT }), "admin-1", { db: db as never });
    expect(created).toMatchObject({ vendor: "Vercel Pro", amountCents: 2000, recurrence: "none", receiptPath: RECEIPT });
    expect(db.rows[0]).toMatchObject({ created_by: "admin-1", currency: "usd", ends_on: null });

    const listed = await listPlatformExpenses({ from: "2026-10", to: "2026-10" }, { db: db as never });
    expect(listed.map((e) => e.id)).toEqual([created.id]);

    const edited = await updatePlatformExpense({ id: created.id, amountCents: 2500, receiptPath: null }, { db: db as never });
    expect(edited.amountCents).toBe(2500);
    expect(edited.receiptPath).toBeNull();
    // The replaced receipt file is removed from the private bucket.
    expect(db.bucket.remove).toHaveBeenCalledWith([RECEIPT]);

    await deletePlatformExpense(created.id, { db: db as never });
    expect(db.rows).toHaveLength(0);
  });

  it("a one-time expense never keeps an end date", async () => {
    const db = makeDb();
    const created = await createPlatformExpense(createExpenseSchema.parse({ ...base, recurrence: "none" }), "a", { db: db as never });
    expect(created.endsOn).toBeNull();
  });

  it("re-validates the merged row on edit", async () => {
    const db = makeDb();
    const created = await createPlatformExpense(
      createExpenseSchema.parse({ ...base, recurrence: "monthly", endsOn: "2026-12-01" }),
      "a",
      { db: db as never },
    );
    await expect(updatePlatformExpense({ id: created.id, spentOn: "2027-01-01" }, { db: db as never })).rejects.toMatchObject({ status: 400 });
    await expect(updatePlatformExpense({ id: UUID }, { db: db as never })).rejects.toMatchObject({ status: 404 });
    await expect(deletePlatformExpense(UUID, { db: db as never })).rejects.toMatchObject({ status: 404 });
  });

  it("lists only what can charge in the range", async () => {
    const db = makeDb();
    const mk = (over: Record<string, unknown>) =>
      createPlatformExpense(createExpenseSchema.parse({ ...base, ...over }), "a", { db: db as never });
    const old = await mk({ spentOn: "2025-01-05" });
    const recurring = await mk({ spentOn: "2025-01-05", recurrence: "monthly" });
    const ended = await mk({ spentOn: "2025-01-05", recurrence: "monthly", endsOn: "2025-06-01" });
    const future = await mk({ spentOn: "2026-12-01" });
    const inRange = await mk({ spentOn: "2026-10-03" });
    const ids = (await listPlatformExpenses({ from: "2026-10", to: "2026-10" }, { db: db as never })).map((e) => e.id);
    expect(ids).toContain(recurring.id);
    expect(ids).toContain(inRange.id);
    expect(ids).not.toContain(old.id);
    expect(ids).not.toContain(ended.id);
    expect(ids).not.toContain(future.id);
  });

  it("mints a signed upload and a signed read, never a public path", async () => {
    const db = makeDb();
    const slot = await createReceiptUpload({ fileName: "My Receipt (1).PDF", mimeType: "application/pdf", sizeBytes: 100 }, { db: db as never });
    expect(slot.bucket).toBe("platform-receipts");
    expect(slot.token).toBe("tok");
    expect(isPlatformReceiptPath(slot.path)).toBe(true);
    expect(slot.path.endsWith(".pdf")).toBe(true);

    const created = await createPlatformExpense(createExpenseSchema.parse({ ...base, receiptPath: RECEIPT }), "a", { db: db as never });
    expect(await getReceiptSignedUrl(created.id, { db: db as never })).toBe(`https://signed.example/${RECEIPT}`);
    const bare = await createPlatformExpense(createExpenseSchema.parse(base), "a", { db: db as never });
    expect(await getReceiptSignedUrl(bare.id, { db: db as never })).toBeNull();
  });
});

describe("recurring expansion", () => {
  it("a one-time expense lands in its own month only", () => {
    const e = expense({ spentOn: "2026-10-15" });
    expect(expenseDateInMonth(e, "2026-10")).toBe("2026-10-15");
    expect(expenseDateInMonth(e, "2026-09")).toBeNull();
    expect(expenseDateInMonth(e, "2026-11")).toBeNull();
  });

  it("a monthly expense is in every month from its first, on the same day", () => {
    const e = expense({ recurrence: "monthly", spentOn: "2026-10-01" });
    expect(expenseDateInMonth(e, "2026-09")).toBeNull();
    expect(expenseDateInMonth(e, "2026-10")).toBe("2026-10-01");
    expect(expenseDateInMonth(e, "2026-11")).toBe("2026-11-01");
    expect(expenseDateInMonth(e, "2027-03")).toBe("2027-03-01");
  });

  it("clamps the 31st into short months", () => {
    const e = expense({ recurrence: "monthly", spentOn: "2026-01-31" });
    expect(expenseDateInMonth(e, "2026-02")).toBe("2026-02-28");
    expect(expenseDateInMonth(e, "2028-02")).toBe("2028-02-29");
    expect(expenseDateInMonth(e, "2026-04")).toBe("2026-04-30");
  });

  it("stops after the end date, inclusive", () => {
    const e = expense({ recurrence: "monthly", spentOn: "2026-10-05", endsOn: "2026-12-05" });
    expect(expenseDateInMonth(e, "2026-12")).toBe("2026-12-05");
    expect(expenseDateInMonth(e, "2027-01")).toBeNull();
    expect(expenseDateInMonth({ ...e, endsOn: "2026-12-04" }, "2026-12")).toBeNull();
  });

  it("a yearly expense repeats in its own month", () => {
    const e = expense({ recurrence: "yearly", spentOn: "2026-03-10", amountCents: 12_000 });
    expect(expenseDateInMonth(e, "2026-03")).toBe("2026-03-10");
    expect(expenseDateInMonth(e, "2026-04")).toBeNull();
    expect(expenseDateInMonth(e, "2027-03")).toBe("2027-03-10");
    expect(expenseDateInMonth(e, "2025-03")).toBeNull();
  });

  it("a monthly expense shows in both October and November totals", () => {
    const rows = [
      expense({ id: "v", recurrence: "monthly", amountCents: 2000 }),
      expense({ id: "t", spentOn: "2026-10-12", amountCents: 500, category: "messaging" }),
    ];
    const totals = expenseTotalsByMonth(rows, ["2026-09", "2026-10", "2026-11"]);
    expect(totals.get("2026-09")).toBe(0);
    expect(totals.get("2026-10")).toBe(2500);
    expect(totals.get("2026-11")).toBe(2000);
    expect(expandExpensesForMonth(rows, "2026-10").map((o) => o.expenseId)).toEqual(["t", "v"]);
    expect(expenseTotalsByCategory(expandExpensesForMonth(rows, "2026-10"))).toEqual([
      { category: "hosting", cents: 2000, count: 1 },
      { category: "messaging", cents: 500, count: 1 },
    ]);
  });

  it("builds twelve months ending at the current one", () => {
    const months = monthsEndingAt("2026-10", 12);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2025-11");
    expect(months.at(-1)).toBe("2026-10");
  });
});

describe("P&L math", () => {
  it("profit is revenue minus refunds, Stripe fees and expenses", () => {
    const pnl = computeMonthlyPnl({
      month: "2026-10",
      streams: { subscriptions: 300_000, credits: 50_000, numbers: 10_000, serviceFees: 38_000 },
      refundsCents: 8000,
      stripeFeesCents: 14_200,
      expensesCents: 169_800,
      unclassifiedCents: 1234,
    });
    expect(pnl.grossRevenueCents).toBe(398_000);
    expect(pnl.revenueCents).toBe(390_000);
    expect(pnl.profitCents).toBe(390_000 - 14_200 - 169_800);
    expect(pnl.profitCents).toBe(206_000);
    expect(pnl.unclassifiedCents).toBe(1234);
  });

  it("a month with only expenses is a loss", () => {
    expect(computeMonthlyPnl({ month: "2026-10", streams: emptyStreams(), expensesCents: 2000 }).profitCents).toBe(-2000);
  });
});

describe("Stripe grouping", () => {
  const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const bt = (over: Record<string, unknown>) => ({
    id: "txn",
    amount: 4900,
    fee: 172,
    currency: "usd",
    created: ts("2026-10-07T18:00:00Z"),
    type: "charge",
    reporting_category: "charge",
    source: null,
    ...over,
  });
  const months = ["2026-09", "2026-10"];

  it("splits subscriptions, numbers, credits and service fees; subtracts refunds; counts fees", () => {
    const kinds = indexInvoiceCharges([
      { parent: { subscription_details: { metadata: {} } }, payments: { data: [{ payment: { charge: "ch_sub", payment_intent: "pi_sub" } }] } },
      {
        parent: { subscription_details: { metadata: { purpose: NUMBER_SUBSCRIPTION_PURPOSE } } },
        payments: { data: [{ payment: { charge: "ch_num" } }] },
      },
    ]);
    const grouped = groupBalanceTransactions(
      [
        bt({ id: "1", source: { id: "ch_sub", object: "charge" } }),
        bt({ id: "2", amount: 500, fee: 45, source: { id: "ch_num", object: "charge" } }),
        bt({ id: "3", amount: 2500, fee: 103, source: { id: "ch_cr", object: "charge", metadata: { purpose: COMMS_CREDIT_PURPOSE } } }),
        bt({ id: "4", amount: 380, fee: 0, type: "application_fee", reporting_category: "platform_earning" }),
        bt({ id: "5", amount: -800, fee: 0, type: "refund", reporting_category: "refund" }),
        bt({ id: "6", amount: 7000, fee: 230, source: { id: "ch_other", object: "charge" } }),
        bt({ id: "7", amount: -5000, fee: 0, type: "payout", reporting_category: "payout" }),
        bt({ id: "8", amount: 4900, fee: 172, source: { id: "ch_x", object: "charge", payment_intent: "pi_sub" } }),
        bt({ id: "9", amount: 999, fee: 30, currency: "eur", source: { id: "ch_sub" } }),
        bt({ id: "10", created: ts("2025-01-01T00:00:00Z") }),
      ],
      kinds,
      months,
    );
    const oct = grouped.get("2026-10")!;
    expect(oct.streams).toEqual({ subscriptions: 9800, numbers: 500, credits: 2500, serviceFees: 380 });
    expect(oct.refundsCents).toBe(800);
    expect(oct.stripeFeesCents).toBe(172 + 45 + 103 + 230 + 172);
    expect(oct.unclassifiedCents).toBe(7000);
    expect(grouped.get("2026-09")!.streams).toEqual(emptyStreams());
    expect(grouped.has("2025-01")).toBe(false);
  });

  it("buckets by Pacific month, not UTC", () => {
    const grouped = groupBalanceTransactions(
      [bt({ source: { id: "ch_sub" }, created: ts("2026-11-01T03:00:00Z") })],
      new Map([["ch_sub", "subscriptions" as const]]),
      ["2026-10", "2026-11"],
    );
    expect(grouped.get("2026-10")!.streams.subscriptions).toBe(4900);
    expect(grouped.get("2026-11")!.streams.subscriptions).toBe(0);
  });

  function fakeStripe() {
    const page = <T,>(data: T[]) => ({ autoPagingToArray: async () => data });
    return {
      invoices: {
        list: vi.fn(() =>
          page([{ parent: { subscription_details: { metadata: {} } }, payments: { data: [{ payment: { charge: "ch_sub" } }] } }]),
        ),
      },
      balanceTransactions: {
        list: vi.fn(() => page([bt({ source: { id: "ch_sub", object: "charge" } })])),
      },
    };
  }

  it("loadMonthlyPlatformRevenue reads Stripe balance transactions for the month", async () => {
    const stripe = fakeStripe();
    const month = await loadMonthlyPlatformRevenue("2026-10", { stripe: stripe as unknown as Stripe });
    expect(month.streams.subscriptions).toBe(4900);
    expect(stripe.balanceTransactions.list).toHaveBeenCalledWith(expect.objectContaining({ expand: ["data.source"] }));
  });

  it("loadPlatformPnl joins Stripe revenue to expenses and flags an unreadable Stripe", async () => {
    const expenses = async () => [expense({ recurrence: "monthly", amountCents: 1000, spentOn: "2026-09-01" })];
    const now = ts("2026-10-15T12:00:00Z") * 1000;
    const ok = await loadPlatformPnl({ stripe: fakeStripe() as unknown as Stripe, now, expenses });
    expect(ok.currentMonth).toBe("2026-10");
    expect(ok.months).toHaveLength(12);
    expect(ok.revenueAvailable).toBe(true);
    const oct = ok.months.at(-1)!;
    expect(oct).toMatchObject({ revenueCents: 4900, stripeFeesCents: 172, expensesCents: 1000, profitCents: 4900 - 172 - 1000 });

    const failing = {
      invoices: { list: () => ({ autoPagingToArray: async () => { throw new Error("req_123 network"); } }) },
      balanceTransactions: { list: () => ({ autoPagingToArray: async () => [] }) },
    };
    const down = await loadPlatformPnl({ stripe: failing as unknown as Stripe, now, expenses });
    expect(down.revenueAvailable).toBe(false);
    expect(down.months.at(-1)!.expensesCents).toBe(1000);
  });
});
