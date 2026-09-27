/**
 * W002 (High): `POST /api/manager-bills` checked the co-manager module grant
 * (correct) but then called `createManagerBill({ managerUserId: auth.userId })`
 * — the CALLER's id, not the property's real owner. A co-manager with a
 * financials grant could bill an owner's property, but the bill was stamped
 * under the co-manager's own id, so the real owner never saw it (GET had no
 * owned+linked merge at all) while it polluted the co-manager's own Bills
 * view with someone else's payable — the same bug class PRP-199 closed for
 * household charges.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

const mocks = vi.hoisted(() => ({
  getReportsAuthContext: vi.fn(),
  assertManagerFinancialsAccess: vi.fn(),
  assertManagerFinancialsCoManagerAccess: vi.fn(),
  resolvePropertyPayoutOwner: vi.fn(),
  createManagerBill: vi.fn(),
  linkedPropertyIdsForModule: vi.fn(),
  fetchRowsForManagerWithLinked: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: mocks.getReportsAuthContext,
  assertManagerFinancialsAccess: mocks.assertManagerFinancialsAccess,
}));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertManagerFinancialsCoManagerAccess: mocks.assertManagerFinancialsCoManagerAccess,
}));
vi.mock("@/lib/payments/property-payout-owner.server", () => ({
  resolvePropertyPayoutOwner: mocks.resolvePropertyPayoutOwner,
}));
vi.mock("@/lib/manager-bills.server", () => ({ createManagerBill: mocks.createManagerBill }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedPropertyIdsForModule: mocks.linkedPropertyIdsForModule,
  fetchRowsForManagerWithLinked: mocks.fetchRowsForManagerWithLinked,
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: mocks.track }));

const OWNER = "owner-1";
const CO_MANAGER = "co-manager-1";
const PROPERTY = "house-owned-by-owner";

function jsonRequest(body: unknown) {
  return new Request("https://x.test/api/manager-bills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function billRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "bill-1",
    manager_user_id: OWNER,
    vendor_id: null,
    work_order_id: null,
    property_id: PROPERTY,
    vendor_invoice_id: null,
    bill_number: null,
    description: "Roof repair",
    amount_cents: 5000,
    due_date: null,
    status: "pending_approval",
    category_code: "maintenance",
    paid_expense_entry_id: null,
    approved_at: null,
    paid_at: null,
    created_at: new Date().toISOString(),
    sms_test_session_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertManagerFinancialsAccess.mockResolvedValue({ ok: true });
  mocks.linkedPropertyIdsForModule.mockResolvedValue(new Set<string>());
  mocks.fetchRowsForManagerWithLinked.mockResolvedValue([]);
});

describe("POST /api/manager-bills — stamps the property's real owner, never the caller", () => {
  it("attributes a new bill to the property owner when a co-manager files it", async () => {
    mocks.getReportsAuthContext.mockResolvedValue({ role: "manager", userId: CO_MANAGER, email: "cm@example.com", db: {} });
    mocks.resolvePropertyPayoutOwner.mockResolvedValue({ ok: true, ownerUserId: OWNER });
    mocks.assertManagerFinancialsCoManagerAccess.mockResolvedValue({ ok: true });
    mocks.createManagerBill.mockResolvedValue({ id: "bill-1", propertyId: PROPERTY, amountCents: 5000 });

    const { POST } = await import("@/app/api/manager-bills/route");
    const res = await POST(jsonRequest({ description: "Roof repair", amountCents: 5000, propertyId: PROPERTY }));
    expect(res.status).toBe(200);

    expect(mocks.createManagerBill).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ managerUserId: OWNER, viewerUserId: CO_MANAGER }),
    );
    // The gate is checked against the REAL owner (paired with the grant that
    // issued it) — passing the caller here would be a no-op.
    expect(mocks.assertManagerFinancialsCoManagerAccess).toHaveBeenCalledWith(
      expect.anything(),
      CO_MANAGER,
      PROPERTY,
      OWNER,
      "edit",
    );
  });

  it("keeps the caller as owner when they own the property themselves", async () => {
    mocks.getReportsAuthContext.mockResolvedValue({ role: "manager", userId: OWNER, email: "o@example.com", db: {} });
    mocks.resolvePropertyPayoutOwner.mockResolvedValue({ ok: true, ownerUserId: OWNER });
    mocks.assertManagerFinancialsCoManagerAccess.mockResolvedValue({ ok: true });
    mocks.createManagerBill.mockResolvedValue({ id: "bill-1", propertyId: PROPERTY, amountCents: 5000 });

    const { POST } = await import("@/app/api/manager-bills/route");
    await POST(jsonRequest({ description: "Roof repair", amountCents: 5000, propertyId: PROPERTY }));

    expect(mocks.createManagerBill).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ managerUserId: OWNER, viewerUserId: OWNER }),
    );
    // undefined ownerId when caller === resolved owner (pairing would be a no-op).
    expect(mocks.assertManagerFinancialsCoManagerAccess).toHaveBeenCalledWith(
      expect.anything(),
      OWNER,
      PROPERTY,
      undefined,
      "edit",
    );
  });

  it("refuses (503) rather than guess a payee when the property lookup fails", async () => {
    mocks.getReportsAuthContext.mockResolvedValue({ role: "manager", userId: CO_MANAGER, email: "cm@example.com", db: {} });
    mocks.resolvePropertyPayoutOwner.mockResolvedValue({ ok: false, reason: "lookup_failed" });

    const { POST } = await import("@/app/api/manager-bills/route");
    const res = await POST(jsonRequest({ description: "Roof repair", amountCents: 5000, propertyId: PROPERTY }));
    expect(res.status).toBe(503);
    expect(mocks.createManagerBill).not.toHaveBeenCalled();
  });
});

describe("GET /api/manager-bills — merges a linked owner's bills, narrowed to the active workspace", () => {
  it("a co-manager sees an owner's bill on a property they hold financials on", async () => {
    mocks.getReportsAuthContext.mockResolvedValue({
      role: "manager",
      userId: CO_MANAGER,
      email: "cm@example.com",
      db: fakeSupabaseClient({ manager_bills: [] }), // the co-manager owns nothing directly
    });
    mocks.linkedPropertyIdsForModule.mockResolvedValue(new Set([PROPERTY]));
    mocks.fetchRowsForManagerWithLinked.mockResolvedValue([billRow()]);

    const { GET } = await import("@/app/api/manager-bills/route");
    const res = await GET(new Request("https://x.test/api/manager-bills"));
    const body = (await res.json()) as { bills: { id: string; propertyId: string }[] };
    expect(body.bills.map((b) => b.id)).toEqual(["bill-1"]);
    expect(body.bills[0]!.propertyId).toBe(PROPERTY);
  });

  it("an owner with no co-manager grants sees only their own bills", async () => {
    mocks.getReportsAuthContext.mockResolvedValue({
      role: "manager",
      userId: OWNER,
      email: "o@example.com",
      db: fakeSupabaseClient({ manager_bills: [billRow()] }),
    });
    mocks.linkedPropertyIdsForModule.mockResolvedValue(new Set<string>());

    const { GET } = await import("@/app/api/manager-bills/route");
    const res = await GET(new Request("https://x.test/api/manager-bills"));
    const body = (await res.json()) as { bills: { id: string }[] };
    expect(body.bills.map((b) => b.id)).toEqual(["bill-1"]);
    expect(mocks.fetchRowsForManagerWithLinked).not.toHaveBeenCalled();
  });
});
