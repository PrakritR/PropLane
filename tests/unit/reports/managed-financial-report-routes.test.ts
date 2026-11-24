import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerReportFilters } from "@/lib/reports/types";

vi.mock("@/lib/service/service-mode.server", () => ({ loadServiceStaffScope: vi.fn() }));
vi.mock("@/lib/scope/settings-scope", () => ({ serviceStaffSettingsAccess: vi.fn() }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn() }));
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(),
  assertManagerFinancialsAccess: vi.fn().mockResolvedValue({ ok: true }),
  assertResidentFinancialsAccess: vi.fn(),
}));
vi.mock("@/lib/reports/display-context", () => ({ loadManagerReportDisplayContext: vi.fn().mockResolvedValue({
  propertyLabel: (id: string) => id, vendorLabel: () => "Vendor", residentLabel: () => "Resident",
}) }));
vi.mock("@/lib/reports/chart-of-accounts-store", async (original) => ({
  ...await original<object>(), primeSystemChartOfAccounts: vi.fn(),
}));
vi.mock("@/lib/reports/queries", async () => {
  const { queryFinancialActivity, queryMonthlyProfitLoss } = await import("@/lib/reports/queries/financial-activity");
  return { queryResidentLedger: vi.fn(), runManagerReport: (db: never, owner: string, id: string, filters: ManagerReportFilters) =>
    id === "financial-activity" ? queryFinancialActivity(db, owner, filters) : queryMonthlyProfitLoss(db, owner, filters) };
});
vi.mock("@/lib/reports/export/pdf", () => ({ reportToPdf: vi.fn() }));
vi.mock("@/lib/reports/export/quickbooks-csv", () => ({ buildQuickBooksJournalCsv: vi.fn() }));
vi.mock("@/lib/reports/account-financial-activity.server", () => ({ loadAccountFinancialActivity: vi.fn() }));
vi.mock("@/lib/reports/activity-running-balance.server", () => ({ loadActivityRunningBalances: vi.fn() }));

import { GET } from "@/app/api/reports/[reportId]/route";
import { GET as exportGET } from "@/app/api/reports/[reportId]/export/route";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { loadServiceStaffScope } from "@/lib/service/service-mode.server";
import { serviceStaffSettingsAccess } from "@/lib/scope/settings-scope";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import { loadAccountFinancialActivity } from "@/lib/reports/account-financial-activity.server";

type Row = Record<string, string | number>;
function ledgerDb() {
  const base = { manager_user_id: "owner", property_id: "managed-house" };
  const cash = { ...base, posted_date: "2026-11-15", entry_type: "payment" };
  const tables: Record<string, Row[]> = {
    ledger_entries: [
      { ...cash, id: "rent", category_code: "rent_income", amount_cents: 1220000 },
      { ...cash, id: "other", category_code: "other_income", amount_cents: 110000 },
      { ...cash, id: "other-workspace", property_id: "private-house", category_code: "rent_income", amount_cents: 999999 },
      { ...cash, id: "other-owner", manager_user_id: "stranger", category_code: "rent_income", amount_cents: 999999 },
    ],
    manager_expense_entries: [
      { ...base, id: "expense", expense_date: "2026-11-15", category_code: "maintenance", amount_cents: 86361, payment_status: "paid" },
      { ...base, id: "private-expense", property_id: "private-house", expense_date: "2026-11-15", category_code: "maintenance", amount_cents: 999999, payment_status: "paid" },
    ],
    security_deposit_ledger: [
      { ...base, id: "deposit", amount_held_cents: 50000 },
      { ...base, id: "private-deposit", property_id: "private-house", amount_held_cents: 999999 },
    ],
  };
  return { from(table: string) {
    if (!tables[table]) throw new Error(`Unexpected query: ${table}`);
    let rows = [...tables[table]];
    const query = {
      select: () => query, order: () => query,
      eq: (key: string, value: string) => { rows = rows.filter((r) => r[key] === value); return query; },
      neq: (key: string, value: string) => { rows = rows.filter((r) => r[key] !== value); return query; },
      in: (key: string, values: string[]) => { rows = rows.filter((r) => values.includes(String(r[key]))); return query; },
      gte: (key: string, value: string) => { rows = rows.filter((r) => String(r[key]) >= value); return query; },
      lte: (key: string, value: string) => { rows = rows.filter((r) => String(r[key]) <= value); return query; },
      range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
    };
    return query;
  } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getReportsAuthContext).mockResolvedValue({ db: ledgerDb(), userId: "staff", role: "admin", email: "staff@example.test" });
  vi.mocked(loadServiceStaffScope).mockResolvedValue({ workspaceId: "managed", propertyIds: ["managed-house"] });
  vi.mocked(serviceStaffSettingsAccess).mockResolvedValue({ kind: "ok", ownerUserId: "owner", fullGrant: true });
  vi.mocked(activeWorkspacePropertyScope).mockResolvedValue(["managed-house"]);
});
const request = (id: string, extra = "") => new Request(`http://localhost/api/reports/${id}?from=2026-11-01&to=2026-11-30${extra}`);
const context = (reportId: string) => ({ params: Promise.resolve({ reportId }) });

describe("managed workspace financial report routes", () => {
  it.each(["admin", "manager"] as const)("%s sees owner revenue, expenses and deposits only for the active workspace", async (role) => {
    vi.mocked(getReportsAuthContext).mockResolvedValue({ db: ledgerDb(), userId: "staff", role, email: "staff@example.test" });
    const response = await GET(request("financial-activity"), context("financial-activity"));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.rows).toHaveLength(3);
    expect(JSON.parse(result.meta.summary)).toMatchObject({ heldDepositsCents: 50000, months: {
      "2026-11": { revenueCents: 1330000, expenseCents: 86361, profitCents: 1243639 },
    } });
    expect(loadAccountFinancialActivity).not.toHaveBeenCalled();
  });

  it("the P&L and CSV export agree, ignoring an owner selector in service mode", async () => {
    const response = await GET(request("monthly-profit-loss", "&managerUserId=stranger"), context("monthly-profit-loss"));
    expect(response.status).toBe(200);
    expect((await response.json()).totals).toMatchObject({ revenue: "$13300.00", expenses: "$863.61", profit: "$12436.39" });
    const exported = await exportGET(request("monthly-profit-loss", "&format=csv&managerUserId=stranger"), context("monthly-profit-loss"));
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain("2026-11,$13300.00,$863.61,$12436.39");
  });

  it("an explicit property outside the workspace cannot widen the ledger", async () => {
    const response = await GET(request("financial-activity", "&propertyId=private-house"), context("financial-activity"));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.rows).toEqual([]);
    expect(JSON.parse(result.meta.summary).heldDepositsCents).toBe(0);
  });

  it("keeps the staff property boundary if the separate workspace reader fails", async () => {
    vi.mocked(activeWorkspacePropertyScope).mockResolvedValue(null);
    const response = await GET(request("financial-activity"), context("financial-activity"));
    expect(response.status).toBe(200);
    expect((await response.json()).rows).toHaveLength(3);
  });
});
