import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * `/api/expenses` merged every workspace's manual expenses into one list and
 * let a create/update/delete touch any expense the manager owned, regardless
 * of which workspace was active. These fail against that pre-fix route.ts
 * (`.eq("manager_user_id", …)` alone, no workspace check on any verb).
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined) })),
}));

const mocks = vi.hoisted(() => ({ loadWorkspaces: vi.fn() }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));

const authState = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(async () => ({ userId: "mgr-1", email: "mgr@example.com", db: authState.db })),
  assertManagerFinancialsAccess: vi.fn(async () => ({ ok: true })),
}));

import { DELETE, GET, PATCH, POST } from "@/app/api/expenses/route";

const MANAGER = "mgr-1";
const WS_A = { id: "ws-a", name: "A", ownerUserId: MANAGER, owned: true, isDefault: true, propertyIds: ["p1"] };
const WS_B = { id: "ws-b", name: "B", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: ["p2"] };
const WS_EMPTY = { id: "ws-empty", name: "Empty", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: [] };

function expenseRow(id: string, propertyId: string | null) {
  return {
    id,
    manager_user_id: MANAGER,
    property_id: propertyId,
    category_code: "maintenance",
    amount_cents: 5000,
    expense_date: "2026-01-15",
    memo: null,
    vendor_id: null,
    tax_deductible: true,
  };
}

function setup(rows: { manager_expense_entries?: Row[]; manager_property_records?: Row[] } = {}) {
  const db = fakeSupabaseClient({
    manager_expense_entries: rows.manager_expense_entries ?? [],
    manager_property_records: rows.manager_property_records ?? [{ id: "p1", manager_user_id: MANAGER }, { id: "p2", manager_user_id: MANAGER }],
  });
  authState.db = db;
  return db;
}

beforeEach(() => {
  state.cookieValue = undefined;
  mocks.loadWorkspaces.mockReset();
});

async function getJson(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

describe("GET /api/expenses — active-workspace scoping", () => {
  it("a manager with two workspaces sees only workspace A's expenses while A is active", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    setup({ manager_expense_entries: [expenseRow("e-a", "p1"), expenseRow("e-b", "p2")] });
    const body = await getJson(await GET());
    expect((body.expenses as Array<{ id: string }>).map((e) => e.id)).toEqual(["e-a"]);
  });

  it("switching to workspace B shows only B's expenses", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    setup({ manager_expense_entries: [expenseRow("e-a", "p1"), expenseRow("e-b", "p2")] });
    const body = await getJson(await GET());
    expect((body.expenses as Array<{ id: string }>).map((e) => e.id)).toEqual(["e-b"]);
  });

  it("an empty active workspace yields no property-tied expenses", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_EMPTY]);
    state.cookieValue = WS_EMPTY.id;
    setup({ manager_expense_entries: [expenseRow("e-a", "p1")] });
    const body = await getJson(await GET());
    expect(body.expenses).toEqual([]);
  });

  it("a single-workspace manager is unaffected", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A]);
    setup({ manager_expense_entries: [expenseRow("e-a", "p1")] });
    const body = await getJson(await GET());
    expect((body.expenses as Array<{ id: string }>).map((e) => e.id)).toEqual(["e-a"]);
  });

  it("an account-level expense (no property) follows the default-workspace rule", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);

    state.cookieValue = WS_A.id;
    setup({ manager_expense_entries: [expenseRow("e-portfolio", null)] });
    expect(((await getJson(await GET())).expenses as Array<{ id: string }>).map((e) => e.id)).toEqual(["e-portfolio"]);

    state.cookieValue = WS_B.id;
    setup({ manager_expense_entries: [expenseRow("e-portfolio", null)] });
    expect((await getJson(await GET())).expenses).toEqual([]);
  });
});

describe("POST /api/expenses — active-workspace guard", () => {
  function request(body: unknown) {
    return new Request("http://localhost/api/expenses", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("refuses to create an expense for a property outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    setup();
    const res = await POST(request({ propertyId: "p2", categoryCode: "maintenance", amountCents: 1000, expenseDate: "2026-01-15" }));
    expect(res.status).toBe(400);
    const body = await getJson(res);
    expect(String(body.error)).toMatch(/outside your active workspace/);
  });

  it("allows creating an expense for a property inside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    setup();
    const res = await POST(request({ propertyId: "p1", categoryCode: "maintenance", amountCents: 1000, expenseDate: "2026-01-15" }));
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/expenses — active-workspace guard", () => {
  function request(body: unknown) {
    return new Request("http://localhost/api/expenses", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("refuses to update an expense that already sits outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    setup({ manager_expense_entries: [expenseRow("e-b", "p2")] });
    const res = await PATCH(request({ id: "e-b", amountCents: 2000 }));
    expect(res.status).toBe(404);
  });

  it("refuses to move an in-workspace expense to a property outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    setup({ manager_expense_entries: [expenseRow("e-a", "p1")] });
    const res = await PATCH(request({ id: "e-a", propertyId: "p2" }));
    expect(res.status).toBe(400);
  });

  it("allows updating an expense inside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    setup({ manager_expense_entries: [expenseRow("e-a", "p1")] });
    const res = await PATCH(request({ id: "e-a", amountCents: 2500 }));
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/expenses — active-workspace guard", () => {
  function url(id: string) {
    return new Request(`http://localhost/api/expenses?id=${id}`, { method: "DELETE" });
  }

  it("refuses to delete an expense outside the active workspace, and leaves it in place", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = setup({ manager_expense_entries: [expenseRow("e-b", "p2")] });
    const res = await DELETE(url("e-b"));
    expect(res.status).toBe(404);
    const raw = await db.from("manager_expense_entries").select();
    expect((raw.data ?? []).map((r: Row) => r.id)).toContain("e-b");
  });

  it("deletes an expense inside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = setup({ manager_expense_entries: [expenseRow("e-a", "p1")] });
    const res = await DELETE(url("e-a"));
    expect(res.status).toBe(200);
    const raw = await db.from("manager_expense_entries").select();
    expect((raw.data ?? []).map((r: Row) => r.id)).not.toContain("e-a");
  });
});
