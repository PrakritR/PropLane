import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * A manager with more than one workspace must not create or act on a bill
 * outside the active one. These fail against pre-fix `manager-bills.server.ts`
 * (no workspace check existed at all — any manager id + bill id combination
 * worked regardless of which workspace was active).
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined) })),
}));

const mocks = vi.hoisted(() => ({ loadWorkspaces: vi.fn(), postGlBillApproved: vi.fn(), postGlBillPaid: vi.fn() }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));
vi.mock("@/lib/reports/gl-posting", () => ({
  postGlBillApproved: mocks.postGlBillApproved,
  postGlBillPaid: mocks.postGlBillPaid,
}));
vi.mock("@/lib/sms/sms-test-provenance.server", () => ({ smsTestProvenanceColumns: () => ({}) }));

import { approveManagerBill, createManagerBill, payManagerBill } from "@/lib/manager-bills.server";

const MANAGER = "mgr-1";
const WS_A = { id: "ws-a", name: "A", ownerUserId: MANAGER, owned: true, isDefault: true, propertyIds: ["p1"] };
const WS_B = { id: "ws-b", name: "B", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: ["p2"] };
const WS_EMPTY = { id: "ws-empty", name: "Empty", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: [] };

function setup(rows: { manager_bills?: Row[]; manager_expense_entries?: Row[] } = {}) {
  mocks.postGlBillApproved.mockResolvedValue(undefined);
  mocks.postGlBillPaid.mockResolvedValue(undefined);
  return fakeSupabaseClient({ manager_bills: rows.manager_bills ?? [], manager_expense_entries: rows.manager_expense_entries ?? [] });
}

beforeEach(() => {
  state.cookieValue = undefined;
  mocks.loadWorkspaces.mockReset();
  mocks.postGlBillApproved.mockReset();
  mocks.postGlBillPaid.mockReset();
});

describe("createManagerBill — active-workspace guard", () => {
  it("refuses a bill for a property outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = setup();
    await expect(
      createManagerBill(db as never, { managerUserId: MANAGER, description: "Roof repair", amountCents: 1000, propertyId: "p2" }),
    ).rejects.toThrow(/outside your active workspace/);
  });

  it("allows a bill for a property inside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = setup();
    const bill = await createManagerBill(db as never, {
      managerUserId: MANAGER,
      description: "Roof repair",
      amountCents: 1000,
      propertyId: "p1",
    });
    expect(bill.propertyId).toBe("p1");
  });

  it("switching the active workspace to B allows p2 and now refuses p1", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    const db = setup();
    const bill = await createManagerBill(db as never, {
      managerUserId: MANAGER,
      description: "Landscaping",
      amountCents: 500,
      propertyId: "p2",
    });
    expect(bill.propertyId).toBe("p2");
    await expect(
      createManagerBill(db as never, { managerUserId: MANAGER, description: "x", amountCents: 100, propertyId: "p1" }),
    ).rejects.toThrow(/outside your active workspace/);
  });

  it("an account-level bill (no property) is never refused by the workspace guard", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    const db = setup();
    const bill = await createManagerBill(db as never, { managerUserId: MANAGER, description: "Software", amountCents: 2000 });
    expect(bill.propertyId).toBeNull();
  });

  it("a single-workspace manager is unaffected (workspace load resolves but narrows to their own houses only)", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A]);
    const db = setup();
    const bill = await createManagerBill(db as never, {
      managerUserId: MANAGER,
      description: "Roof repair",
      amountCents: 1000,
      propertyId: "p1",
    });
    expect(bill.propertyId).toBe("p1");
  });
});

describe("approveManagerBill / payManagerBill — active-workspace guard", () => {
  function billRow(id: string, propertyId: string | null, status = "pending_approval") {
    return {
      id,
      manager_user_id: MANAGER,
      property_id: propertyId,
      description: "x",
      amount_cents: 1000,
      status,
      category_code: "maintenance",
      created_at: new Date().toISOString(),
    };
  }

  it("refuses to approve a bill whose property is outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id; // active = p1 only
    const db = setup({ manager_bills: [billRow("b1", "p2")] }); // bill is on p2
    await expect(approveManagerBill(db as never, MANAGER, "b1", MANAGER)).rejects.toThrow(/Bill not found/);
  });

  it("approves a bill whose property IS inside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = setup({ manager_bills: [billRow("b1", "p1")] });
    const bill = await approveManagerBill(db as never, MANAGER, "b1", MANAGER);
    expect(bill.status).toBe("approved");
  });

  it("an empty active workspace refuses every property-tied bill", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_EMPTY]);
    state.cookieValue = WS_EMPTY.id;
    const db = setup({ manager_bills: [billRow("b1", "p1")] });
    await expect(approveManagerBill(db as never, MANAGER, "b1", MANAGER)).rejects.toThrow(/Bill not found/);
  });

  it("an account-level bill (no property) is only actionable in the manager's own default workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id; // B is not default
    const db1 = setup({ manager_bills: [billRow("b1", null, "approved")] });
    await expect(payManagerBill(db1 as never, MANAGER, "b1")).rejects.toThrow(/Bill not found/);

    state.cookieValue = WS_A.id; // A is default
    const db2 = setup({ manager_bills: [billRow("b1", null, "approved")] });
    const bill = await payManagerBill(db2 as never, MANAGER, "b1");
    expect(bill.status).toBe("paid");
  });
});
