import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeServiceDb, type FakeRow, type FakeStorageCall } from "../helpers/fake-service-db";

/**
 * `/api/vendor/expenses` (Outgoing payments): the vendor's private expense log.
 * Clients are SELECT-only on `vendor_expense_entries`, so these handlers are the only write path
 * and must re-derive ownership on every call: another vendor's id reads as 404, a body
 * `vendor_user_id` is ignored, and a service may be linked only if it is this vendor's own.
 */

const VENDOR = "vendor-1";
const OTHER = "vendor-2";

const state = vi.hoisted(() => ({
  userId: null as string | null,
  rows: [] as FakeRow[],
  storage: [] as FakeStorageCall[],
}));

vi.mock("@/lib/auth/vendor-api-access", () => ({
  resolveVendorPortalUserId: async () =>
    state.userId ? { ok: true, userId: state.userId } : { ok: false, status: 401 },
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeFakeServiceDb(state.rows, state.storage),
}));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (method: string, body?: unknown) =>
  new Request("http://localhost/api/vendor/expenses", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const VALID = { expenseDate: "2026-10-06", amountCents: 3840, category: "materials", memo: "Drywall + mud" };

function seed() {
  state.userId = VENDOR;
  state.storage = [];
  state.rows = [
    { __table: "portal_work_order_records", id: "wo-mine", vendor_user_id: VENDOR, manager_user_id: "mgr-1", row_data: { title: "Patch drywall", propertyName: "Alder House", unit: "4B" } },
    { __table: "portal_work_order_records", id: "wo-theirs", vendor_user_id: OTHER, manager_user_id: "mgr-2", row_data: { title: "Not yours" } },
    { __table: "vendor_expense_entries", id: "exp-mine", vendor_user_id: VENDOR, expense_date: "2026-10-02", amount_cents: 6499, category: "tools", memo: "Pipe wrench", work_order_id: null, receipt_path: `vendor-documents/${VENDOR}/expense-receipt-exp-mine-1.pdf`, created_at: "2026-10-02T00:00:00Z" },
    { __table: "vendor_expense_entries", id: "exp-theirs", vendor_user_id: OTHER, expense_date: "2026-10-03", amount_cents: 1000, category: "other", memo: "Secret", work_order_id: null, receipt_path: `vendor-documents/${OTHER}/expense-receipt-exp-theirs-1.pdf`, created_at: "2026-10-03T00:00:00Z" },
  ];
}

beforeEach(() => {
  vi.resetModules();
  seed();
});

describe("GET /api/vendor/expenses", () => {
  it("requires a vendor session", async () => {
    state.userId = null;
    const { GET } = await import("@/app/api/vendor/expenses/route");
    expect((await GET()).status).toBe(401);
  });

  it("lists only the signed-in vendor's own expenses and never leaks the receipt path", async () => {
    const { GET } = await import("@/app/api/vendor/expenses/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { expenses: Array<Record<string, unknown>> };
    expect(body.expenses.map((e) => e.id)).toEqual(["exp-mine"]);
    expect(body.expenses[0]).toMatchObject({ hasReceipt: true, amountCents: 6499, category: "tools" });
    expect(JSON.stringify(body)).not.toContain("vendor-documents/");
  });
});

describe("POST /api/vendor/expenses", () => {
  it("creates the expense for the session user and ignores a body vendor_user_id", async () => {
    const { POST } = await import("@/app/api/vendor/expenses/route");
    const res = await POST(json("POST", { ...VALID, vendor_user_id: OTHER, vendorUserId: OTHER }));
    expect(res.status).toBe(201);
    const created = state.rows.find((r) => r.__table === "vendor_expense_entries" && r.memo === "Drywall + mud");
    expect(created?.vendor_user_id).toBe(VENDOR);
  });

  it("links a service only when it is assigned to this vendor", async () => {
    const { POST } = await import("@/app/api/vendor/expenses/route");
    const ok = await POST(json("POST", { ...VALID, workOrderId: "wo-mine" }));
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { expense: Record<string, unknown> }).expense).toMatchObject({
      workOrderId: "wo-mine",
      workOrderTitle: "Patch drywall",
      propertyLabel: "Alder House · 4B",
    });
    const rejected = await POST(json("POST", { ...VALID, memo: "x", workOrderId: "wo-theirs" }));
    expect(rejected.status).toBe(400);
    expect(state.rows.some((r) => r.memo === "x")).toBe(false);
  });

  it.each([
    ["zero amount", { ...VALID, amountCents: 0 }],
    ["fractional cents", { ...VALID, amountCents: 10.5 }],
    ["a string amount", { ...VALID, amountCents: "38.40" }],
    ["a bad category", { ...VALID, category: "yacht" }],
    ["an impossible date", { ...VALID, expenseDate: "2026-02-31" }],
    ["a missing date", { ...VALID, expenseDate: undefined }],
  ])("rejects %s", async (_name, body) => {
    const { POST } = await import("@/app/api/vendor/expenses/route");
    expect((await POST(json("POST", body))).status).toBe(400);
  });
});

describe("PATCH / DELETE /api/vendor/expenses/[id]", () => {
  it("edits the vendor's own expense", async () => {
    const { PATCH } = await import("@/app/api/vendor/expenses/[id]/route");
    const res = await PATCH(json("PATCH", { amountCents: 7000, vendor_user_id: OTHER }), ctx("exp-mine"));
    expect(res.status).toBe(200);
    const row = state.rows.find((r) => r.id === "exp-mine");
    expect(row?.amount_cents).toBe(7000);
    expect(row?.vendor_user_id).toBe(VENDOR);
  });

  it("another vendor's expense id is a 404 for edit and delete, and nothing changes", async () => {
    const { PATCH, DELETE } = await import("@/app/api/vendor/expenses/[id]/route");
    expect((await PATCH(json("PATCH", { amountCents: 1 }), ctx("exp-theirs"))).status).toBe(404);
    expect((await DELETE(json("DELETE"), ctx("exp-theirs"))).status).toBe(404);
    const theirs = state.rows.find((r) => r.id === "exp-theirs");
    expect(theirs?.amount_cents).toBe(1000);
  });

  it("a patch cannot link another vendor's service", async () => {
    const { PATCH } = await import("@/app/api/vendor/expenses/[id]/route");
    expect((await PATCH(json("PATCH", { workOrderId: "wo-theirs" }), ctx("exp-mine"))).status).toBe(400);
  });

  it("deleting removes the row and its receipt file from the vendor's own prefix", async () => {
    const { DELETE } = await import("@/app/api/vendor/expenses/[id]/route");
    expect((await DELETE(json("DELETE"), ctx("exp-mine"))).status).toBe(200);
    expect(state.rows.some((r) => r.id === "exp-mine")).toBe(false);
    expect(state.storage).toEqual([
      { op: "remove", bucket: "vendor-documents", path: `vendor-documents/${VENDOR}/expense-receipt-exp-mine-1.pdf` },
    ]);
  });
});

describe("/api/vendor/expenses/[id]/receipt", () => {
  const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 test").toString("base64")}`;

  it("mints a short-lived signed URL for the vendor's own receipt only", async () => {
    const { GET } = await import("@/app/api/vendor/expenses/[id]/receipt/route");
    const own = await GET(json("GET"), ctx("exp-mine"));
    expect(own.status).toBe(200);
    expect(state.storage[0]).toMatchObject({ op: "sign", bucket: "vendor-documents", ttl: 300 });
    state.storage.length = 0;
    const theirs = await GET(json("GET"), ctx("exp-theirs"));
    expect(theirs.status).toBe(404);
    expect(state.storage).toEqual([]);
  });

  it("uploads under the vendor's own prefix, built server-side, and replaces the old file", async () => {
    const { POST } = await import("@/app/api/vendor/expenses/[id]/receipt/route");
    const res = await POST(json("POST", { dataUrl: pdf, storagePath: "vendor-documents/vendor-2/evil.pdf" }), ctx("exp-mine"));
    expect(res.status).toBe(200);
    const upload = state.storage.find((c) => c.op === "upload");
    expect(upload?.path.startsWith(`vendor-documents/${VENDOR}/`)).toBe(true);
    expect(upload?.path).not.toContain("evil");
    expect(state.storage.some((c) => c.op === "remove" && c.path.endsWith("exp-mine-1.pdf"))).toBe(true);
    expect(state.rows.find((r) => r.id === "exp-mine")?.receipt_path).toBe(upload?.path);
  });

  it("refuses another vendor's expense, a non-file body and a disallowed type", async () => {
    const { POST } = await import("@/app/api/vendor/expenses/[id]/receipt/route");
    expect((await POST(json("POST", { dataUrl: pdf }), ctx("exp-theirs"))).status).toBe(404);
    expect((await POST(json("POST", { dataUrl: "nope" }), ctx("exp-mine"))).status).toBe(400);
    const exe = `data:application/x-msdownload;base64,${Buffer.from("MZ").toString("base64")}`;
    expect((await POST(json("POST", { dataUrl: exe }), ctx("exp-mine"))).status).toBe(400);
    expect(state.storage.some((c) => c.op === "upload")).toBe(false);
  });
});
