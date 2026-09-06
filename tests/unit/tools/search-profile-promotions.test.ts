import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeManagerRowsCtx, managerRow, type FakeRecord } from "./fake-agent-ctx";
import type { AgentContext } from "@/lib/tools/context";

// The financials write tools gate on the manager's subscription tier and emit
// PostHog events via the shared manual-entries lib; both are mocked so tests
// control the gate and never touch analytics/Supabase-backed tier resolution.
vi.mock("@/lib/reports/auth", () => ({
  assertFinancialsTier: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn(async () => ({
    tier: "pro",
    billing: "monthly",
    stripeCustomerId: null,
    stripeSubscriptionId: "sub_x",
    stripeCheckoutSessionId: null,
    promoCode: null,
    paidAt: null,
  })),
  getManagerSubscriptionTier: vi.fn(async () => "paid" as const),
}));
// Mock the full report-query module (financials.ts imports all nine; the
// dashboard uses rent_roll + delinquency).
vi.mock("@/lib/reports/queries", () => {
  const make = (id: string) => vi.fn(async () => ({ id, title: id, columns: [], rows: [] }));
  return {
    queryRentRoll: vi.fn(async () => ({
      id: "rent-roll",
      title: "Rent roll",
      columns: [],
      rows: [{}, {}],
      totals: { monthlyRent: "$3,000.00" },
    })),
    queryDelinquency: vi.fn(async () => ({
      id: "delinquency",
      title: "Delinquency",
      columns: [],
      rows: [{}],
      totals: { balance: "$450.00" },
    })),
    queryIncomeStatement: make("income_statement"),
    queryExpenses: make("expenses"),
    queryRentReceipts: make("rent_receipts"),
    queryRentalDays: make("rental_days"),
    queryTaxSummary: make("tax_summary"),
    queryLeaseExpiration: make("lease_expiration"),
    queryVendorSpend: make("vendor_spend"),
  };
});

import { assertFinancialsTier } from "@/lib/reports/auth";
import { track } from "@/lib/analytics/posthog";
import * as reportQueries from "@/lib/reports/queries";
import { buildRegistry } from "@/lib/tools/registry";
import { recordExpenseTool, recordIncomeTool } from "@/lib/tools/domains/financials";
import { findRecordsTool } from "@/lib/tools/domains/search";
import { getManagerProfileTool, getDashboardSummaryTool } from "@/lib/tools/domains/profile";
import {
  listPromotionsTool,
  createPromotionTool,
  generatePromotionFlyerTool,
  updatePromotionTool,
  deletePromotionTool,
} from "@/lib/tools/domains/promotions";
import { normalizeReferenceImageUrls } from "@/lib/promotion-generate-flyer.server";
import { listCoManagersTool } from "@/lib/tools/domains/team";
import { executeWrite, previewWrite } from "./fake-agent-ctx";

type AnyRow = Record<string, unknown>;

/**
 * Local extension of the FakeQuery pattern in fake-agent-ctx.ts (that file is
 * shared and stays read-only): adds writes (insert/upsert/update/delete),
 * maybeSingle/single, `.in`, and a minimal `.or`, so write tools and the
 * profile/team reads are exercisable. audit_log enforces a unique dedupe_key
 * (code 23505 on conflict) so idempotency paths are testable.
 */
class LocalQuery {
  private filters: ((row: AnyRow) => boolean)[] = [];
  private op:
    | { type: "select" }
    | { type: "insert"; values: AnyRow[] }
    | { type: "upsert"; values: AnyRow[] }
    | { type: "update"; patch: AnyRow }
    | { type: "delete" } = { type: "select" };

  constructor(
    private table: string,
    private store: Record<string, AnyRow[]>,
  ) {}

  select() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => !(col in r) || r[col] === val);
    return this;
  }
  neq(col: string, val: unknown) {
    this.filters.push((r) => r[col] !== val);
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push((r) => !(col in r) || String(r[col] ?? "") >= String(val ?? ""));
    return this;
  }
  lte(col: string, val: unknown) {
    this.filters.push((r) => !(col in r) || String(r[col] ?? "") <= String(val ?? ""));
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  or(expr: string) {
    const conds = expr
      .split(",")
      .map((part) => part.trim().match(/^([^.]+)\.eq\.(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null);
    this.filters.push((r) => conds.some((m) => String(r[m[1]!] ?? "") === m[2]));
    return this;
  }

  insert(values: AnyRow | AnyRow[]) {
    this.op = { type: "insert", values: Array.isArray(values) ? values : [values] };
    return this;
  }
  upsert(values: AnyRow | AnyRow[]) {
    this.op = { type: "upsert", values: Array.isArray(values) ? values : [values] };
    return this;
  }
  update(patch: AnyRow) {
    this.op = { type: "update", patch };
    return this;
  }
  delete() {
    this.op = { type: "delete" };
    return this;
  }

  private run(): { data: AnyRow[]; error: { code?: string; message: string } | null } {
    const rows = (this.store[this.table] ??= []);
    if (this.op.type === "insert" || this.op.type === "upsert") {
      for (const value of this.op.values) {
        if (
          this.table === "audit_log" &&
          value.dedupe_key != null &&
          rows.some((r) => r.dedupe_key === value.dedupe_key)
        ) {
          return { data: [], error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        if (this.op.type === "upsert") {
          const idx = rows.findIndex((r) => r.id === value.id);
          if (idx >= 0) {
            rows[idx] = { ...rows[idx], ...value };
            continue;
          }
        }
        rows.push({ ...value });
      }
      return { data: this.op.values, error: null };
    }
    const matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op.type === "update") {
      for (const r of matched) Object.assign(r, this.op.patch);
      return { data: matched, error: null };
    }
    if (this.op.type === "delete") {
      this.store[this.table] = rows.filter((r) => !matched.includes(r));
      return { data: matched, error: null };
    }
    return { data: matched, error: null };
  }

  range(from: number, to: number) {
    const res = this.run();
    return Promise.resolve({ data: res.data.slice(from, to + 1), error: res.error });
  }
  maybeSingle() {
    const res = this.run();
    return Promise.resolve({ data: res.data[0] ?? null, error: res.error });
  }
  single() {
    const res = this.run();
    return Promise.resolve({
      data: res.data[0] ?? null,
      error: res.error ?? (res.data[0] ? null : { message: "No rows returned" }),
    });
  }
  then<T>(resolve: (v: { data: AnyRow[]; error: { code?: string; message: string } | null }) => T) {
    return Promise.resolve(this.run()).then(resolve);
  }
}

/** Writable fake ctx; returns the backing store so tests can assert writes. */
function makeWritableCtx(
  tables: Record<string, AnyRow[]> = {},
  overrides: Partial<AgentContext> = {},
): { ctx: AgentContext; store: Record<string, AnyRow[]> } {
  const store: Record<string, AnyRow[]> = {};
  for (const [table, rows] of Object.entries(tables)) store[table] = rows.map((r) => ({ ...r }));
  const db = { from: (table: string) => new LocalQuery(table, store) };
  const ctx = {
    landlordId: "manager_a",
    userId: "manager_a",
    email: "manager@axis.test",
    roles: ["manager"],
    isAdmin: false,
    db,
    ...overrides,
  } as unknown as AgentContext;
  return { ctx, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("CERTN_API_KEY", "");
  vi.stubEnv("STRIPE_SECRET_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tool registry safety", () => {
  it("registers every new tool without banned identity input fields", () => {
    expect(() =>
      buildRegistry([
        recordExpenseTool,
        recordIncomeTool,
        findRecordsTool,
        getManagerProfileTool,
        getDashboardSummaryTool,
        listPromotionsTool,
        createPromotionTool,
        updatePromotionTool,
        deletePromotionTool,
        listCoManagersTool,
      ]),
    ).not.toThrow();
  });
});

describe("find_records", () => {
  const ctx = makeManagerRowsCtx({
    manager_application_records: [
      managerRow("manager_a", { id: "res1", name: "Sarah Chen", email: "sarah@axis.test", bucket: "approved", property: "12 Main Street" }),
      managerRow("manager_a", { id: "app1", name: "Sam O'Neil", email: "sam@x.test", bucket: "pending", property: "12 Main Street" }),
      managerRow("manager_b", { id: "resF", name: "Sarah Foreign", email: "sarah@foreign.test", bucket: "approved" }),
    ],
    manager_vendor_records: [
      managerRow("manager_a", { id: "v1", name: "Main St Plumbing", email: "joe@plumb.co", trade: "plumbing" }),
      managerRow("manager_b", { id: "vF", name: "Main Foreign Vendor", trade: "hvac" }),
    ],
    manager_property_records: [
      { id: "p1", manager_user_id: "manager_a", status: "live", row_data: { title: "12 Main Street", address: "12 Main St, Seattle" } } as unknown as FakeRecord,
      { id: "pF", manager_user_id: "manager_b", status: "live", row_data: { title: "Main Court Foreign" } } as unknown as FakeRecord,
    ],
    portal_work_order_records: [
      managerRow("manager_a", { id: "w1", title: "Leaky faucet", propertyName: "12 Main Street", unit: "2B", status: "open" }),
    ],
    portal_lease_pipeline_records: [
      managerRow("manager_a", { id: "l1", residentName: "Sarah Chen", residentEmail: "sarah@axis.test", unit: "2B", bucket: "signed" }),
    ],
  });

  it("never returns another landlord's records", async () => {
    const res = (await findRecordsTool.handler(ctx, { query: "sarah" })) as { results: { id: string }[] };
    const ids = res.results.map((r) => r.id);
    expect(ids).toContain("res1");
    expect(ids).not.toContain("resF");
    expect(ids.every((id) => !["resF", "vF", "pF"].includes(id))).toBe(true);

    const main = (await findRecordsTool.handler(ctx, { query: "main" })) as { results: { id: string }[] };
    expect(main.results.map((r) => r.id)).not.toContain("pF");
  });

  it("ranks exact email above prefix above substring", async () => {
    const exact = (await findRecordsTool.handler(ctx, { query: "sarah@axis.test" })) as {
      results: { id: string; type: string }[];
    };
    expect(exact.results[0]!.id).toBe("res1");

    const main = (await findRecordsTool.handler(ctx, { query: "main" })) as { results: { id: string }[] };
    // "Main St Plumbing" is a normalized-prefix match; "12 Main Street" is substring-only.
    expect(main.results.map((r) => r.id).indexOf("v1")).toBeLessThan(main.results.map((r) => r.id).indexOf("p1"));
  });

  it("matches punctuation- and case-insensitively", async () => {
    const res = (await findRecordsTool.handler(ctx, { query: "oneil" })) as { results: { id: string }[] };
    expect(res.results.map((r) => r.id)).toContain("app1");
  });

  it("honors types and limit, and rejects a 1-char query via the schema", async () => {
    const onlyProps = (await findRecordsTool.handler(ctx, { query: "main", types: ["property"] })) as {
      results: { type: string; id: string }[];
    };
    expect(onlyProps.results.every((r) => r.type === "property")).toBe(true);
    expect(onlyProps.results.map((r) => r.id)).toEqual(["p1"]);

    const limited = (await findRecordsTool.handler(ctx, { query: "main", limit: 1 })) as { results: unknown[] };
    expect(limited.results).toHaveLength(1);

    expect(findRecordsTool.inputSchema.safeParse({ query: "a" }).success).toBe(false);
  });
});

describe("record_expense / record_income", () => {
  const seedTables = () => ({
    manager_property_records: [
      { id: "p1", manager_user_id: "manager_a", status: "live", row_data: { title: "12 Main Street" } },
      { id: "p_foreign", manager_user_id: "manager_b", status: "live", row_data: { title: "Foreign House" } },
    ],
    manager_vendor_records: [
      { id: "v1", manager_user_id: "manager_a", row_data: { id: "v1", name: "Ace Plumbing" } },
    ],
  });
  const expenseInput = {
    amountUsd: 125.5,
    categoryCode: "maintenance",
    postedDate: "2026-07-01",
    description: "Gutter repair",
    propertyId: "p1",
  };

  it("preview relays the structured tier error", async () => {
    vi.mocked(assertFinancialsTier).mockResolvedValueOnce({
      ok: false,
      code: "tier_required",
      error: "Recording financials requires the Pro or Business plan. Upgrade in Settings → Subscription.",
    });
    const { ctx } = makeWritableCtx(seedTables());
    const res = await previewWrite(recordExpenseTool, ctx, expenseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Pro or Business/);
  });

  it("preview rejects unknown or wrong-side category codes", async () => {
    const { ctx } = makeWritableCtx(seedTables());
    const bad = await previewWrite(recordExpenseTool, ctx, { ...expenseInput, categoryCode: "not_a_code" });
    expect(bad.ok).toBe(false);
    // Income codes are not expense codes and vice versa.
    const crossed = await previewWrite(recordExpenseTool, ctx, { ...expenseInput, categoryCode: "rent_income" });
    expect(crossed.ok).toBe(false);
    const incomeCrossed = await previewWrite(recordIncomeTool, ctx, {
      amountUsd: 100,
      categoryCode: "maintenance",
      postedDate: "2026-07-01",
    });
    expect(incomeCrossed.ok).toBe(false);
  });

  it("preview rejects a foreign propertyId and foreign vendorId", async () => {
    const { ctx } = makeWritableCtx(seedTables());
    const foreignProperty = await previewWrite(recordExpenseTool, ctx, { ...expenseInput, propertyId: "p_foreign" });
    expect(foreignProperty.ok).toBe(false);
    const foreignVendor = await previewWrite(recordExpenseTool, ctx, { ...expenseInput, vendorId: "v_foreign" });
    expect(foreignVendor.ok).toBe(false);
  });

  it("preview defaults an omitted postedDate to today's Pacific date", async () => {
    const { ctx } = makeWritableCtx(seedTables());
    const { postedDate: _postedDate, ...withoutDate } = expenseInput;
    const res = await previewWrite(recordExpenseTool, ctx, withoutDate);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const date = res.preview.fields.find((field) => field.label === "Date")?.value;
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(date?.slice(0, 4)).not.toBe("2024");
    expect(res.input).toMatchObject({ postedDate: date });
    expect(res.preview).not.toHaveProperty("confirmedInput");
  });

  it("preview warns when the posted year is not the current year", async () => {
    const { ctx } = makeWritableCtx(seedTables());
    const res = await previewWrite(recordExpenseTool, ctx, { ...expenseInput, postedDate: "2024-09-04" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.warnings?.some((warning) => warning.includes("2024"))).toBe(true);
  });

  it("preview shows server-derived amount, category label, and property", async () => {
    const { ctx } = makeWritableCtx(seedTables());
    const res = await previewWrite(recordExpenseTool, ctx, { ...expenseInput, vendorId: "v1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byLabel = new Map(res.preview.fields.map((l) => [l.label, l.value]));
    expect(byLabel.get("Amount")).toBe("$125.50");
    expect(byLabel.get("Category")).toBe("Maintenance");
    expect(byLabel.get("Schedule E")).toBe("Sch. E, Line 14");
    expect(byLabel.get("Property")).toBe("12 Main Street");
    expect(byLabel.get("Vendor")).toBe("Ace Plumbing");
  });

  it("execute books the expense, audits first, and is idempotent on retry", async () => {
    const { ctx, store } = makeWritableCtx(seedTables());
    const res = await executeWrite(recordExpenseTool, ctx, expenseInput);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.reply).toContain("$125.50");

    expect(store.manager_expense_entries).toHaveLength(1);
    const entry = store.manager_expense_entries![0]!;
    expect(entry.manager_user_id).toBe("manager_a");
    expect(entry.amount_cents).toBe(12550);
    expect(entry.category_code).toBe("maintenance");

    expect(store.audit_log).toHaveLength(1);
    const audit = store.audit_log![0]!;
    expect(audit.tool_name).toBe("record_expense");
    expect(String(audit.dedupe_key)).toMatch(/^record_expense:manager_a:12550:maintenance:2026-07-01:[0-9a-f]+$/);
    expect(vi.mocked(track)).toHaveBeenCalledWith("expense_created", "manager_a", expect.any(Object));

    // Same amount/category/date/description again → already recorded, no new row.
    const again = await executeWrite(recordExpenseTool, ctx, expenseInput);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.reply).toMatch(/already/i);
    expect(store.manager_expense_entries).toHaveLength(1);
  });

  it("execute books income into ledger_entries with the income dedupe key", async () => {
    const { ctx, store } = makeWritableCtx(seedTables());
    const res = await executeWrite(recordIncomeTool, ctx, {
      amountUsd: 1500,
      categoryCode: "rent_income",
      postedDate: "2026-07-02",
      propertyId: "p1",
      residentEmail: "Sarah@Axis.Test",
    });
    expect(res.ok).toBe(true);
    expect(store.ledger_entries).toHaveLength(1);
    const entry = store.ledger_entries![0]!;
    expect(entry.manager_user_id).toBe("manager_a");
    expect(entry.entry_type).toBe("payment");
    expect(entry.amount_cents).toBe(150000);
    expect(entry.resident_email).toBe("sarah@axis.test");
    expect(String(store.audit_log![0]!.dedupe_key)).toMatch(/^record_income:manager_a:150000:rent_income:2026-07-02:/);
    expect(vi.mocked(track)).toHaveBeenCalledWith("income_created", "manager_a", { category_code: "rent_income" });
  });
});

describe("get_manager_profile", () => {
  const seed = () => ({
    profiles: [{ id: "manager_a", full_name: "Pat Manager", email: "Pat@Axis.Test" }],
    manager_property_records: [
      { id: "p1", manager_user_id: "manager_a", status: "live", row_data: {} },
      { id: "p2", manager_user_id: "manager_a", status: "pending", row_data: {} },
      { id: "pF", manager_user_id: "manager_b", status: "live", row_data: {} },
    ],
  });

  it("returns own profile, plan vs property limit, and readiness booleans", async () => {
    const { ctx } = makeWritableCtx(seed());
    const res = (await getManagerProfileTool.handler(ctx, {})) as {
      name: string | null;
      email: string | null;
      subscription: { tier: string | null; plan: string; propertyCount: number; propertyLimit: number | null };
      payments: Record<string, unknown>;
      emailConfigured: boolean;
      screeningConfigured: boolean;
    };
    expect(res.name).toBe("Pat Manager");
    expect(res.email).toBe("pat@axis.test");
    expect(res.subscription).toEqual({ tier: "paid", plan: "Pro", propertyCount: 2, propertyLimit: 2 });
    expect(res.payments.connected).toBe(false);
    expect(res.payments.paymentReady).toBe(false);
    expect(res.emailConfigured).toBe(false);
    expect(res.screeningConfigured).toBe(false);
  });

  it("reports configured email/screening and never leaks the Connect account id", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("CERTN_API_KEY", "certn_test");
    const tables = seed();
    tables.profiles[0] = { ...tables.profiles[0]!, stripe_connect_account_id: "acct_secret_123" } as never;
    const { ctx } = makeWritableCtx(tables);
    const res = (await getManagerProfileTool.handler(ctx, {})) as {
      payments: Record<string, unknown>;
      emailConfigured: boolean;
      screeningConfigured: boolean;
    };
    expect(res.emailConfigured).toBe(true);
    expect(res.screeningConfigured).toBe(true);
    // Stripe keys are absent in tests: an account id exists but live status
    // cannot be confirmed — booleans only, id never present anywhere.
    expect(res.payments.connected).toBe(true);
    expect(res.payments.stripeConfigured).toBe(false);
    expect(res.payments.paymentReady).toBe(false);
    expect(JSON.stringify(res)).not.toContain("acct_secret_123");
  });
});

describe("get_dashboard_summary", () => {
  it("composes landlord-scoped counts and report totals", async () => {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const far = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { ctx } = makeWritableCtx({
      manager_property_records: [
        { id: "p1", manager_user_id: "manager_a", status: "live", row_data: {} },
        { id: "p2", manager_user_id: "manager_a", status: "live", row_data: {} },
        { id: "p3", manager_user_id: "manager_a", status: "pending", row_data: {} },
        { id: "pF", manager_user_id: "manager_b", status: "live", row_data: {} },
      ],
      // `bucket`/`unread` mirror the row_data->>… projections the tool selects.
      portal_work_order_records: [
        { id: "w1", manager_user_id: "manager_a", bucket: "open", row_data: {} },
        { id: "w2", manager_user_id: "manager_a", bucket: "scheduled", row_data: {} },
        { id: "w3", manager_user_id: "manager_a", bucket: "completed", row_data: {} },
        { id: "wF", manager_user_id: "manager_b", bucket: "open", row_data: {} },
      ],
      manager_application_records: [
        { id: "a1", manager_user_id: "manager_a", bucket: "pending", row_data: {} },
        { id: "a2", manager_user_id: "manager_a", bucket: "approved", row_data: {} },
        { id: "aF", manager_user_id: "manager_b", bucket: "pending", row_data: {} },
      ],
      portal_inbox_thread_records: [
        { id: "t1", scope: "axis_portal_inbox_manager_v1", owner_user_id: "manager_a", unread: "true", row_data: {} },
        { id: "t2", scope: "axis_portal_inbox_manager_v1", owner_user_id: "manager_a", unread: "false", row_data: {} },
        { id: "tF", scope: "axis_portal_inbox_manager_v1", owner_user_id: "manager_b", unread: "true", row_data: {} },
      ],
      portal_schedule_records: [
        { id: "s1", manager_user_id: "manager_a", starts_at: soon, row_data: {} },
        { id: "s2", manager_user_id: "manager_a", starts_at: far, row_data: {} },
        { id: "sF", manager_user_id: "manager_b", starts_at: soon, row_data: {} },
      ],
    });

    const res = (await getDashboardSummaryTool.handler(ctx, {})) as {
      rentRoll: { occupiedUnits: number; monthlyRentTotal: string | null };
      delinquency: { overdueCharges: number; totalOutstanding: string | null };
      properties: { total: number; byStatus: Record<string, number> };
      workOrders: { open: number; scheduled: number };
      applications: { pending: number };
      inbox: { unreadThreads: number };
      calendar: { eventsNext7Days: number };
    };

    expect(res.rentRoll).toEqual({ occupiedUnits: 2, monthlyRentTotal: "$3,000.00" });
    expect(res.delinquency).toEqual({ overdueCharges: 1, totalOutstanding: "$450.00" });
    expect(res.properties).toEqual({ total: 3, byStatus: { live: 2, pending: 1 } });
    expect(res.workOrders).toEqual({ open: 1, scheduled: 1 });
    expect(res.applications).toEqual({ pending: 1 });
    expect(res.inbox).toEqual({ unreadThreads: 1 });
    expect(res.calendar).toEqual({ eventsNext7Days: 1 });

    // Report totals must come from the landlord-scoped query functions.
    const [, managerUserId] = vi.mocked(reportQueries.queryRentRoll).mock.calls[0]!;
    expect(managerUserId).toBe("manager_a");
  });
});

describe("promotions tools", () => {
  const promoRow = (id: string, managerUserId: string, extra: AnyRow = {}) => ({
    id,
    manager_user_id: managerUserId,
    row_data: {
      id,
      managerUserId,
      propertyId: null,
      propertyLabel: "",
      title: `Promo ${id}`,
      theme: "sunset",
      flyerSize: "letter",
      template: "photo_hero",
      status: "draft",
      inputs: { headline: "H", sellingPoints: "", price: "", promo: "", cta: "", contact: "", tone: "Warm & welcoming", customDetails: "", images: ["data:image/png;base64,AAAA"] },
      copy: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      ...extra,
    },
  });

  it("list_promotions projects safe fields only and stays landlord-scoped", async () => {
    const { ctx } = makeWritableCtx({
      manager_promotion_records: [
        promoRow("promo-1", "manager_a"),
        promoRow("promo-2", "manager_a", { status: "generated" }),
        promoRow("promo-F", "manager_b"),
      ],
    });
    const res = (await listPromotionsTool.handler(ctx, {})) as { count: number; promotions: Record<string, unknown>[] };
    expect(res.count).toBe(2);
    expect(res.promotions.map((p) => p.id).sort()).toEqual(["promo-1", "promo-2"]);
    for (const p of res.promotions) {
      expect(p).not.toHaveProperty("inputs");
      expect(JSON.stringify(p)).not.toContain("base64");
    }
    const generated = (await listPromotionsTool.handler(ctx, { status: "generated" })) as {
      promotions: { id: string }[];
    };
    expect(generated.promotions.map((p) => p.id)).toEqual(["promo-2"]);
  });

  it("create_promotion validates property ownership and writes an audited promotion with flyer", async () => {
    const { ctx, store } = makeWritableCtx({
      manager_property_records: [
        { id: "p1", manager_user_id: "manager_a", status: "live", row_data: { title: "12 Main Street" } },
        { id: "pF", manager_user_id: "manager_b", status: "live", row_data: { title: "Foreign" } },
      ],
    });
    const foreign = await previewWrite(createPromotionTool, ctx, { title: "Summer special", propertyId: "pF" });
    expect(foreign.ok).toBe(false);

    const preview = await previewWrite(createPromotionTool, ctx, { title: "Summer special", propertyId: "p1" });
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.preview.summary).toMatch(/flyer/i);

    const res = await executeWrite(createPromotionTool, ctx, { title: "Summer special", propertyId: "p1", notes: "Near park" });
    expect(res.ok).toBe(true);
    expect(store.manager_promotion_records).toHaveLength(1);
    const created = store.manager_promotion_records![0]!;
    expect(created.manager_user_id).toBe("manager_a");
    const rowData = created.row_data as {
      title: string;
      status: string;
      propertyLabel: string;
      inputs: { customDetails: string };
      flyers?: unknown[];
      copy?: unknown;
    };
    expect(rowData.title).toBe("Summer special");
    expect(rowData.status).toBe("generated");
    expect(rowData.propertyLabel).toBe("12 Main Street");
    expect(rowData.inputs.customDetails).toBe("Near park");
    expect(rowData.flyers?.length ?? (rowData.copy ? 1 : 0)).toBeGreaterThan(0);
    expect(store.audit_log).toHaveLength(1);
    expect(String(store.audit_log![0]!.dedupe_key)).toMatch(/^create_promotion:manager_a:[0-9a-f]+:\d{4}-\d{2}-\d{2}$/);

    // Same title+property again today → duplicate short-circuit, no second row.
    const again = await executeWrite(createPromotionTool, ctx, { title: "Summer special", propertyId: "p1" });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.reply).toMatch(/already/i);
    expect(store.manager_promotion_records).toHaveLength(1);
  });

  it("normalizeReferenceImageUrls keeps only listing-photos URLs", () => {
    const urls = normalizeReferenceImageUrls([
      "https://evil.test/photo.jpg",
      "https://x.supabase.co/storage/v1/object/public/listing-photos/u/1.jpg",
    ]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("listing-photos");
  });

  it("generate_promotion_flyer preview accepts style notes and reference URLs", async () => {
    const { ctx } = makeWritableCtx({
      manager_promotion_records: [promoRow("promo-1", "manager_a")],
    });
    const ref = "https://x.supabase.co/storage/v1/object/public/listing-photos/u/ref.jpg";
    const preview = await previewWrite(generatePromotionFlyerTool, ctx, {
      promotionId: "promo-1",
      extraInstructions: "Match the reference: bold headline, navy background, large hero photo.",
      referenceImageUrls: [ref],
    });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.preview.fields?.some((f) => f.label === "Style notes")).toBe(true);
      expect(preview.preview.fields?.some((f) => f.label === "Reference images")).toBe(true);
    }
  });

  it("update_promotion refuses foreign rows and merges onto current row_data", async () => {
    const { ctx, store } = makeWritableCtx({
      manager_promotion_records: [promoRow("promo-1", "manager_a"), promoRow("promo-F", "manager_b")],
    });
    const foreign = await previewWrite(updatePromotionTool, ctx, { promotionId: "promo-F", title: "Hacked" });
    expect(foreign.ok).toBe(false);
    const noChange = await previewWrite(updatePromotionTool, ctx, { promotionId: "promo-1" });
    expect(noChange.ok).toBe(false);

    const res = await executeWrite(updatePromotionTool, ctx, { promotionId: "promo-1", title: "Renamed", status: "generated" });
    expect(res.ok).toBe(true);
    const rowData = store.manager_promotion_records![0]!.row_data as {
      title: string;
      status: string;
      theme: string;
      updatedAt: string;
    };
    expect(rowData.title).toBe("Renamed");
    expect(rowData.status).toBe("generated");
    // Merge preserves fields the tool does not manage.
    expect(rowData.theme).toBe("sunset");
    expect(rowData.updatedAt).not.toBe("2026-07-01T00:00:00.000Z");
    expect(store.audit_log).toHaveLength(1);
    expect(String(store.audit_log![0]!.dedupe_key)).toMatch(/^update_promotion:manager_a:promo-1:/);
    // The foreign row is untouched.
    expect((store.manager_promotion_records![1]!.row_data as { title: string }).title).toBe("Promo promo-F");
  });

  it("delete_promotion is destructive, audited one-shot, and landlord-scoped", async () => {
    const { ctx, store } = makeWritableCtx({
      manager_promotion_records: [promoRow("promo-1", "manager_a"), promoRow("promo-F", "manager_b")],
    });
    expect(deletePromotionTool.destructive).toBe(true);

    const foreign = await executeWrite(deletePromotionTool, ctx, { promotionId: "promo-F" });
    expect(foreign.ok).toBe(false);
    expect(store.manager_promotion_records).toHaveLength(2);

    const preview = await previewWrite(deletePromotionTool, ctx, { promotionId: "promo-1" });
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.preview.warnings?.[0]).toMatch(/permanently/i);

    const res = await executeWrite(deletePromotionTool, ctx, { promotionId: "promo-1" });
    expect(res.ok).toBe(true);
    expect(store.manager_promotion_records!.map((r) => r.id)).toEqual(["promo-F"]);
    expect(store.audit_log![0]!.dedupe_key).toBe("delete_promotion:manager_a:promo-1");
  });
});

describe("list_co_managers", () => {
  it("returns accepted links either direction plus legacy rows, never other workspaces", async () => {
    const { ctx } = makeWritableCtx({
      account_link_invites: [
        {
          id: "i1",
          inviter_user_id: "manager_a",
          invitee_user_id: "user_b",
          inviter_display_name: "Pat Manager",
          invitee_display_name: "Bella Co",
          assigned_property_ids: ["p1", "p2"],
          status: "accepted",
          created_at: "2026-01-01",
          responded_at: "2026-01-02",
        },
        {
          id: "i2",
          inviter_user_id: "manager_a",
          invitee_user_id: "user_c",
          inviter_display_name: "Pat Manager",
          invitee_display_name: "Pending Person",
          assigned_property_ids: ["p1"],
          status: "pending",
          created_at: "2026-01-03",
          responded_at: null,
        },
        {
          id: "i3",
          inviter_user_id: "user_e",
          invitee_user_id: "manager_a",
          inviter_display_name: "Evan Owner",
          invitee_display_name: "Pat Manager",
          assigned_property_ids: [],
          status: "accepted",
          created_at: "2026-02-01",
          responded_at: "2026-02-02",
        },
        {
          id: "iF",
          inviter_user_id: "user_x",
          invitee_user_id: "user_y",
          inviter_display_name: "X",
          invitee_display_name: "Y",
          assigned_property_ids: ["pX"],
          status: "accepted",
          created_at: "2026-03-01",
          responded_at: "2026-03-02",
        },
      ],
      profiles: [
        { id: "user_b", email: "Bella@Co.Test" },
        { id: "user_e", email: "evan@owner.test" },
      ],
      portal_pro_relationship_records: [
        {
          id: "legacy1",
          manager_user_id: "manager_a",
          related_email: "Old@Link.Test",
          row_data: { linkedDisplayName: "Old Link", assignedPropertyIds: ["p9"], createdAt: "2025-05-05" },
        },
        {
          id: "legacyF",
          manager_user_id: "manager_b",
          related_email: "foreign@link.test",
          row_data: { linkedDisplayName: "Foreign Link", assignedPropertyIds: [] },
        },
      ],
    });

    const res = (await listCoManagersTool.handler(ctx, {})) as {
      count: number;
      coManagers: { name: string | null; email: string | null; direction: string; assignedPropertyIds: string[]; source: string }[];
    };
    expect(res.count).toBe(3);
    const bySource = (source: string) => res.coManagers.filter((c) => c.source === source);
    const links = bySource("account_link");
    expect(links).toHaveLength(2);
    const outgoing = links.find((c) => c.direction === "outgoing")!;
    expect(outgoing.name).toBe("Bella Co");
    expect(outgoing.email).toBe("bella@co.test");
    expect(outgoing.assignedPropertyIds).toEqual(["p1", "p2"]);
    const incoming = links.find((c) => c.direction === "incoming")!;
    expect(incoming.name).toBe("Evan Owner");
    expect(incoming.email).toBe("evan@owner.test");

    const legacy = bySource("legacy_link");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.email).toBe("old@link.test");
    expect(legacy[0]!.assignedPropertyIds).toEqual(["p9"]);

    // Other workspaces' links never appear.
    const all = JSON.stringify(res);
    expect(all).not.toContain("user_x");
    expect(all).not.toContain("foreign@link.test");
    expect(all).not.toContain("Pending Person");
  });
});
