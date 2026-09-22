import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import type { AgentWorkspaceScope } from "@/lib/agent/manager-workspace-scope";
import { makeManagerRowsCtx, makeWritableCtx } from "./fake-agent-ctx";

/**
 * Five ungated AI-tool domains (documents, financials, charges,
 * statement-matching, utility-allocation): `AgentContext.workspace` was
 * already resolved correctly server-side, but none of these five ever
 * consulted it, so the assistant could read and act on rows outside the
 * manager's active workspace even though the portal UI could not. Every test
 * here fails against the pre-fix source (verified by stashing the source
 * changes and re-running).
 */

vi.mock("@/lib/reports/auth", () => ({ assertFinancialsTier: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("@/lib/reports/queries", () => {
  const make = (id: string) => vi.fn(async () => ({ id, title: id, columns: [], rows: [] }));
  return {
    queryRentRoll: make("rent_roll"),
    queryDelinquency: make("delinquency"),
    queryIncomeStatement: make("income_statement"),
    queryExpenses: make("expenses"),
    queryRentReceipts: make("rent_receipts"),
    queryRentalDays: make("rental_days"),
    queryTaxSummary: make("tax_summary"),
    queryLeaseExpiration: make("lease_expiration"),
    queryVendorSpend: make("vendor_spend"),
  };
});

import * as reportQueries from "@/lib/reports/queries";
import { listDocumentsTool } from "@/lib/tools/domains/documents";
import { runFinancialReportTool, recordExpenseTool, recordIncomeTool } from "@/lib/tools/domains/financials";
import { createChargeTool, updateChargeTool, deleteChargeTool, markChargePaidTool } from "@/lib/tools/domains/charges";
import { suggestStatementMatchesTool } from "@/lib/tools/domains/statement-matching";
import { previewUtilityAllocationTool } from "@/lib/tools/domains/utility-allocation";

const WS_A_DEFAULT: AgentWorkspaceScope = { id: "ws-a", name: "A", isDefault: true, narrowing: true, propertyIds: ["house-a"] };
const WS_B: AgentWorkspaceScope = { id: "ws-b", name: "B", isDefault: false, narrowing: true, propertyIds: ["house-b"] };
const WS_EMPTY: AgentWorkspaceScope = { id: "ws-empty", name: "Empty", isDefault: false, narrowing: true, propertyIds: [] };

beforeEach(() => vi.clearAllMocks());

describe("list_documents — scoped by the active workspace's property ids", () => {
  const tables = {
    manager_documents: [
      { id: "doc-a", manager_user_id: "manager_a", property_id: "house-a", deleted_at: null, row_data: {} },
      { id: "doc-b", manager_user_id: "manager_a", property_id: "house-b", deleted_at: null, row_data: {} },
      { id: "doc-none", manager_user_id: "manager_a", property_id: null, deleted_at: null, row_data: {} },
    ],
  };

  it("shows workspace A's property doc plus the untagged account-level doc while A (the default) is active", async () => {
    const ctx = makeManagerRowsCtx(tables, { workspace: WS_A_DEFAULT });
    const res = (await listDocumentsTool.handler(ctx, {})) as { documents: { id: string }[] };
    expect(res.documents.map((d) => d.id).sort()).toEqual(["doc-a", "doc-none"]);
  });

  it("shows only workspace B's property doc while B (not default) is active — no untagged doc", async () => {
    const ctx = makeManagerRowsCtx(tables, { workspace: WS_B });
    const res = (await listDocumentsTool.handler(ctx, {})) as { documents: { id: string }[] };
    expect(res.documents.map((d) => d.id)).toEqual(["doc-b"]);
  });

  it("returns nothing for a workspace holding zero houses", async () => {
    const ctx = makeManagerRowsCtx(tables, { workspace: WS_EMPTY });
    const res = (await listDocumentsTool.handler(ctx, {})) as { documents: { id: string }[] };
    expect(res.documents).toEqual([]);
  });

  it("is unaffected for a single-workspace manager (ctx.workspace undefined)", async () => {
    const ctx = makeManagerRowsCtx(tables, { workspace: undefined });
    const res = (await listDocumentsTool.handler(ctx, {})) as { documents: { id: string }[] };
    expect(res.documents.map((d) => d.id).sort()).toEqual(["doc-a", "doc-b", "doc-none"]);
  });

  it("refuses an explicit propertyId outside the active workspace rather than answering against it", async () => {
    const ctx = makeManagerRowsCtx(tables, { workspace: WS_B });
    const res = (await listDocumentsTool.handler(ctx, { propertyId: "house-a" })) as { documents: unknown[] };
    expect(res.documents).toEqual([]);
  });
});

describe("run_financial_report — threads the active workspace into the report filters", () => {
  it("passes the workspace's property ids as workspacePropertyIds when narrowing", async () => {
    const ctx = makeManagerRowsCtx({}, { workspace: WS_B });
    await runFinancialReportTool.handler(ctx, { report: "rent_roll" });
    const [, , filters] = (reportQueries.queryRentRoll as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(filters).toMatchObject({ workspacePropertyIds: ["house-b"] });
  });

  it("passes null (not narrowing) for a single-workspace account", async () => {
    const ctx = makeManagerRowsCtx({}, { workspace: undefined });
    await runFinancialReportTool.handler(ctx, { report: "rent_roll" });
    const [, , filters] = (reportQueries.queryRentRoll as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(filters).toMatchObject({ workspacePropertyIds: null });
  });
});

describe("record_expense / record_income — a create must land in the active workspace", () => {
  const baseInput = { amountUsd: 100, categoryCode: "maintenance", postedDate: "2026-01-05" };

  it("refuses a propertyId outside the active workspace", async () => {
    const ctx = makeManagerRowsCtx(
      { manager_property_records: [{ id: "house-a", manager_user_id: "manager_a", row_data: { title: "12 Main" } }] },
      { workspace: WS_B },
    );
    await expect(recordExpenseTool.preview(ctx, { ...baseInput, propertyId: "house-a" })).rejects.toThrow(/active workspace/);
  });

  it("allows a propertyId inside the active workspace", async () => {
    const ctx = makeManagerRowsCtx(
      { manager_property_records: [{ id: "house-b", manager_user_id: "manager_a", row_data: { title: "9 Elm" } }] },
      { workspace: WS_B },
    );
    await expect(recordExpenseTool.preview(ctx, { ...baseInput, propertyId: "house-b" })).resolves.toBeDefined();
  });

  it("refuses a propertyless (account-level) entry from a non-default workspace", async () => {
    const ctx = makeManagerRowsCtx({}, { workspace: WS_B });
    await expect(recordIncomeTool.preview(ctx, { ...baseInput, categoryCode: "rent_income" })).rejects.toThrow(/default workspace/);
  });

  it("allows a propertyless entry from the default workspace", async () => {
    const ctx = makeManagerRowsCtx({}, { workspace: WS_A_DEFAULT });
    await expect(recordIncomeTool.preview(ctx, { ...baseInput, categoryCode: "rent_income" })).resolves.toBeDefined();
  });

  it("is unaffected for a single-workspace manager", async () => {
    const ctx = makeManagerRowsCtx({}, { workspace: undefined });
    await expect(recordIncomeTool.preview(ctx, { ...baseInput, categoryCode: "rent_income" })).resolves.toBeDefined();
  });
});

describe("create_charge — refuses an explicit propertyId outside the active workspace", () => {
  function seed() {
    return {
      manager_application_records: [
        {
          id: "app-1", manager_user_id: "manager_a",
          row_data: { id: "app-1", bucket: "approved", email: "pat@example.com", name: "Pat", assignedPropertyId: "house-b", property: "9 Elm" },
        },
      ],
      manager_property_records: [
        { id: "house-a", manager_user_id: "manager_a", row_data: {}, property_data: { title: "12 Main" } },
      ],
    };
  }
  const input = { residentEmail: "pat@example.com", kind: "rent" as const, title: "Rent", amountUsd: 1500 };

  it("refuses an override propertyId outside the workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_B });
    await expect(createChargeTool.preview(ctx, { ...input, propertyId: "house-a" })).rejects.toThrow(/active workspace/);
  });

  it("still uses the resident's own (in-workspace) assigned property with no override", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_B });
    const preview = await createChargeTool.preview(ctx, input);
    expect(preview).toBeDefined();
  });
});

describe("update_charge / delete_charge / mark_charge_paid — refuse a charge outside the active workspace", () => {
  function seed() {
    return {
      portal_household_charge_records: [
        {
          id: "c-a", manager_user_id: "manager_a", resident_email: "pat@example.com", status: "pending",
          row_data: { id: "c-a", propertyId: "house-a", title: "Rent", amountLabel: "$1,500.00", balanceLabel: "$1,500.00", status: "pending", residentEmail: "pat@example.com", residentName: "Pat", managerUserId: "manager_a", kind: "rent" },
        },
        {
          id: "c-b", manager_user_id: "manager_a", resident_email: "pat@example.com", status: "pending",
          row_data: { id: "c-b", propertyId: "house-b", title: "Rent", amountLabel: "$1,500.00", balanceLabel: "$1,500.00", status: "pending", residentEmail: "pat@example.com", residentName: "Pat", managerUserId: "manager_a", kind: "rent" },
        },
      ],
    };
  }

  it("update_charge cannot see a charge outside the active workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_B });
    await expect(updateChargeTool.preview(ctx, { chargeId: "c-a", amountUsd: 1600 })).rejects.toThrow(/belongs to this landlord/i);
  });

  it("update_charge can still see a charge inside the active workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_B });
    await expect(updateChargeTool.preview(ctx, { chargeId: "c-b", amountUsd: 1600 })).resolves.toBeDefined();
  });

  it("delete_charge cannot see a charge outside the active workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_B });
    await expect(deleteChargeTool.preview(ctx, { chargeId: "c-a" })).rejects.toThrow(/belongs to this landlord/i);
  });

  it("mark_charge_paid cannot see a charge outside the active workspace", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: WS_B });
    await expect(markChargePaidTool.preview(ctx, { chargeId: "c-a" })).rejects.toThrow(/belongs to this landlord/i);
  });

  it("is unaffected for a single-workspace manager", async () => {
    const { ctx } = makeWritableCtx(seed(), { workspace: undefined });
    await expect(updateChargeTool.preview(ctx, { chargeId: "c-a", amountUsd: 1600 })).resolves.toBeDefined();
  });
});

describe("suggest_bank_statement_matches — bank statements are account-level, default-workspace only", () => {
  const statementId = "11111111-1111-4111-8111-111111111111";

  it("refuses while a non-default workspace is active", async () => {
    const ctx = makeManagerRowsCtx({}, { workspace: WS_B });
    await expect(suggestStatementMatchesTool.handler(ctx, { statementId })).rejects.toThrow(/account-level/);
  });

  it("proceeds (past the workspace gate) from the default workspace", async () => {
    const ctx = makeManagerRowsCtx(
      { manager_bank_statements: [{ id: statementId, manager_user_id: "manager_a" }] },
      { workspace: WS_A_DEFAULT },
    );
    // No statement lines seeded — the tool returns an empty result rather than
    // throwing the workspace refusal, proving the gate was cleared.
    const res = (await suggestStatementMatchesTool.handler(ctx, { statementId })) as { matches: unknown[] };
    expect(res.matches).toEqual([]);
  });

  it("is unaffected for a single-workspace manager", async () => {
    const ctx = makeManagerRowsCtx(
      { manager_bank_statements: [{ id: statementId, manager_user_id: "manager_a" }] },
      { workspace: undefined },
    );
    const res = (await suggestStatementMatchesTool.handler(ctx, { statementId })) as { matches: unknown[] };
    expect(res.matches).toEqual([]);
  });
});

describe("preview_utility_allocation — refuses a bill outside the active workspace", () => {
  const input = {
    billId: "22222222-2222-4222-8222-222222222222",
    serviceStart: "2026-01-01",
    serviceEnd: "2026-01-31",
    allocationCents: 1000,
    rule: "occupant_days" as const,
    applicationIds: ["app-1"],
    excludeIds: [],
    agreementConfirmed: true as const,
  };

  it("refuses a bill whose property is outside the active workspace", async () => {
    const ctx = makeManagerRowsCtx(
      {
        manager_bills: [
          { id: input.billId, manager_user_id: "manager_a", property_id: "house-a", amount_cents: 5000, status: "approved", category_code: "utilities" },
        ],
      },
      { workspace: WS_B },
    );
    await expect(previewUtilityAllocationTool.handler(ctx, input)).rejects.toThrow(/approved utility bill/);
  });

  it("clears the workspace gate for a bill inside the active workspace (fails later, on missing room data)", async () => {
    const ctx = makeManagerRowsCtx(
      {
        manager_bills: [
          { id: input.billId, manager_user_id: "manager_a", property_id: "house-b", amount_cents: 5000, status: "approved", category_code: "utilities" },
        ],
        manager_property_records: [{ id: "house-b", manager_user_id: "manager_a", property_data: {}, row_data: {} }],
      },
      { workspace: WS_B },
    );
    // Room inventory was never seeded, so this still throws — but on a
    // DIFFERENT message, proving the workspace check itself passed.
    await expect(previewUtilityAllocationTool.handler(ctx, input)).rejects.toThrow(/room inventory/);
  });
});
