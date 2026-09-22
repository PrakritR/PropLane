import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * A manager with more than one workspace must see and manage only the
 * active workspace's budget lines — including the portfolio-level
 * (`property_id: null`) case the unique-key comment calls out as a real,
 * common shape. These fail against pre-fix `manager-budgets.server.ts`
 * (`.eq("manager_user_id", …)` alone — every workspace's budgets merged).
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined) })),
}));

const mocks = vi.hoisted(() => ({ loadWorkspaces: vi.fn() }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));

import { listManagerBudgets, upsertManagerBudget } from "@/lib/manager-budgets.server";

const MANAGER = "mgr-1";
const WS_A = { id: "ws-a", name: "A", ownerUserId: MANAGER, owned: true, isDefault: true, propertyIds: ["p1"] };
const WS_B = { id: "ws-b", name: "B", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: ["p2"] };
const WS_EMPTY = { id: "ws-empty", name: "Empty", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: [] };

function budgetRow(id: string, propertyId: string | null, categoryCode = "maintenance") {
  return {
    id,
    manager_user_id: MANAGER,
    property_id: propertyId,
    fiscal_year: 2026,
    category_code: categoryCode,
    monthly_amounts_cents: {},
  };
}

beforeEach(() => {
  state.cookieValue = undefined;
  mocks.loadWorkspaces.mockReset();
});

describe("listManagerBudgets — active-workspace scoping", () => {
  it("a manager with two workspaces sees only workspace A's budgets while A is active", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = fakeSupabaseClient({ manager_budgets: [budgetRow("b-a", "p1"), budgetRow("b-b", "p2")] });
    const budgets = await listManagerBudgets(db as never, MANAGER);
    expect(budgets.map((b) => b.id)).toEqual(["b-a"]);
  });

  it("switching to workspace B shows only B's budgets", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    const db = fakeSupabaseClient({ manager_budgets: [budgetRow("b-a", "p1"), budgetRow("b-b", "p2")] });
    const budgets = await listManagerBudgets(db as never, MANAGER);
    expect(budgets.map((b) => b.id)).toEqual(["b-b"]);
  });

  it("an empty active workspace yields no property-tied budgets", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_EMPTY]);
    state.cookieValue = WS_EMPTY.id;
    const db = fakeSupabaseClient({ manager_budgets: [budgetRow("b-a", "p1")] });
    const budgets = await listManagerBudgets(db as never, MANAGER);
    expect(budgets).toEqual([]);
  });

  it("a single-workspace manager is unaffected", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A]);
    const db = fakeSupabaseClient({ manager_budgets: [budgetRow("b-a", "p1")] });
    const budgets = await listManagerBudgets(db as never, MANAGER);
    expect(budgets.map((b) => b.id)).toEqual(["b-a"]);
  });

  it("account-level (portfolio) budgets follow the default-workspace rule", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);

    state.cookieValue = WS_A.id; // A is the owned default
    const db1 = fakeSupabaseClient({ manager_budgets: [budgetRow("b-portfolio", null)] });
    expect((await listManagerBudgets(db1 as never, MANAGER)).map((b) => b.id)).toEqual(["b-portfolio"]);

    state.cookieValue = WS_B.id; // B is not the default
    const db2 = fakeSupabaseClient({ manager_budgets: [budgetRow("b-portfolio", null)] });
    expect(await listManagerBudgets(db2 as never, MANAGER)).toEqual([]);
  });

  it("resolution failure (loadWorkspaces throws) never narrows — behaves exactly as today", async () => {
    mocks.loadWorkspaces.mockRejectedValue(new Error("db down"));
    const db = fakeSupabaseClient({ manager_budgets: [budgetRow("b-a", "p1"), budgetRow("b-portfolio", null)] });
    const budgets = await listManagerBudgets(db as never, MANAGER);
    expect(budgets.map((b) => b.id).sort()).toEqual(["b-a", "b-portfolio"]);
  });
});

describe("upsertManagerBudget — active-workspace guard", () => {
  it("refuses a budget for a property outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = fakeSupabaseClient({ manager_budgets: [] as Row[] });
    await expect(
      upsertManagerBudget(db as never, { managerUserId: MANAGER, propertyId: "p2", fiscalYear: 2026, categoryCode: "maintenance" }),
    ).rejects.toThrow(/outside your active workspace/);
  });

  it("allows a budget for a property inside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = fakeSupabaseClient({ manager_budgets: [] as Row[] });
    const budget = await upsertManagerBudget(db as never, {
      managerUserId: MANAGER,
      propertyId: "p1",
      fiscalYear: 2026,
      categoryCode: "maintenance",
    });
    expect(budget.propertyId).toBe("p1");
  });

  it("a portfolio-level budget (no property) is never refused by the workspace guard", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    const db = fakeSupabaseClient({ manager_budgets: [] as Row[] });
    const budget = await upsertManagerBudget(db as never, {
      managerUserId: MANAGER,
      fiscalYear: 2026,
      categoryCode: "insurance",
    });
    expect(budget.propertyId).toBeNull();
  });
});
