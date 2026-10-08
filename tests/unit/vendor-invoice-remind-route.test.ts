import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeServiceDb, type FakeRow } from "../helpers/fake-service-db";

/**
 * `POST /api/vendor/invoices/[id]/remind` (Incoming payments > Send reminder).
 * Only your own invoice (another vendor's id is a 404), only while it is approved or scheduled
 * (409 otherwise), at most once per 24 hours (429, stored on the invoice and claimed before the
 * send), and delivered through the same follow-up path as the work-order payment reminder.
 */

const VENDOR = "vendor-1";
const OTHER = "vendor-2";
const HOUR = 60 * 60 * 1000;

const state = vi.hoisted(() => ({
  userId: null as string | null,
  rows: [] as unknown[],
  deliver: vi.fn(),
}));

vi.mock("@/lib/auth/vendor-api-access", () => ({
  resolveVendorPortalUserId: async () =>
    state.userId ? { ok: true, userId: state.userId } : { ok: false, status: 401 },
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: state.userId, email: "v@example.com" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeFakeServiceDb(state.rows as FakeRow[]),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/vendor-work-order-payment-notify.server", () => ({
  deliverVendorPaymentFollowUp: (...args: unknown[]) => state.deliver(...args),
}));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = () => new Request("http://localhost/x", { method: "POST" });

function seed(over: FakeRow = {}) {
  state.userId = VENDOR;
  state.deliver.mockReset();
  state.deliver.mockResolvedValue({ ok: true, recipientCount: 2 });
  state.rows = [
    { __table: "profiles", id: VENDOR, email: "v@example.com", full_name: "Alex Plumbing" },
    {
      __table: "vendor_invoices",
      id: "inv-1",
      vendor_user_id: VENDOR,
      manager_user_id: "mgr-1",
      status: "approved",
      work_order_id: null,
      invoice_number: "INV-1",
      total_cents: 20500,
      currency: "usd",
      last_reminder_at: null,
      ...over,
    },
    { __table: "vendor_invoices", id: "inv-theirs", vendor_user_id: OTHER, manager_user_id: "mgr-9", status: "approved", total_cents: 100, currency: "usd", last_reminder_at: null },
  ];
}

const invoice = (id = "inv-1") => (state.rows as FakeRow[]).find((r) => r.id === id)!;

beforeEach(() => {
  vi.resetModules();
  seed();
});

describe("POST /api/vendor/invoices/[id]/remind", () => {
  it("requires a vendor session", async () => {
    state.userId = null;
    const { POST } = await import("@/app/api/vendor/invoices/[id]/remind/route");
    expect((await POST(post(), ctx("inv-1"))).status).toBe(401);
  });

  it("another vendor's invoice id is a 404 and sends nothing", async () => {
    const { POST } = await import("@/app/api/vendor/invoices/[id]/remind/route");
    expect((await POST(post(), ctx("inv-theirs"))).status).toBe(404);
    expect(state.deliver).not.toHaveBeenCalled();
    expect(invoice("inv-theirs").last_reminder_at).toBeNull();
  });

  it.each(["submitted", "paid", "rejected"])("refuses a %s invoice with 409", async (status) => {
    seed({ status });
    const { POST } = await import("@/app/api/vendor/invoices/[id]/remind/route");
    expect((await POST(post(), ctx("inv-1"))).status).toBe(409);
    expect(state.deliver).not.toHaveBeenCalled();
  });

  it.each(["approved", "scheduled"])("sends for a %s invoice and stamps the throttle", async (status) => {
    seed({ status });
    const { POST } = await import("@/app/api/vendor/invoices/[id]/remind/route");
    const res = await POST(post(), ctx("inv-1"));
    expect(res.status).toBe(200);
    expect(state.deliver).toHaveBeenCalledTimes(1);
    const input = state.deliver.mock.calls[0]![1] as { ownerManagerUserId: string; vendorUserId: string; subject: string; text: string };
    expect(input.ownerManagerUserId).toBe("mgr-1");
    expect(input.vendorUserId).toBe(VENDOR);
    expect(input.subject).toContain("Payment reminder");
    expect(input.text).toContain("$205.00");
    expect(typeof invoice().last_reminder_at).toBe("string");
  });

  it("refuses a second reminder inside 24 hours (429) and allows one after", async () => {
    const { POST } = await import("@/app/api/vendor/invoices/[id]/remind/route");
    expect((await POST(post(), ctx("inv-1"))).status).toBe(200);
    expect((await POST(post(), ctx("inv-1"))).status).toBe(429);
    expect(state.deliver).toHaveBeenCalledTimes(1);

    invoice().last_reminder_at = new Date(Date.now() - 25 * HOUR).toISOString();
    expect((await POST(post(), ctx("inv-1"))).status).toBe(200);
    expect(state.deliver).toHaveBeenCalledTimes(2);
  });

  it("a recent reminder stored on the invoice blocks a new one even from a fresh session", async () => {
    seed({ last_reminder_at: new Date(Date.now() - 2 * HOUR).toISOString() });
    const { POST } = await import("@/app/api/vendor/invoices/[id]/remind/route");
    const res = await POST(post(), ctx("inv-1"));
    expect(res.status).toBe(429);
    expect(state.deliver).not.toHaveBeenCalled();
  });

  it("gives the throttle slot back when delivery fails, so the vendor can try again", async () => {
    state.deliver.mockResolvedValue({ ok: false, error: "No manager recipients found." });
    const { POST } = await import("@/app/api/vendor/invoices/[id]/remind/route");
    const res = await POST(post(), ctx("inv-1"));
    expect(res.status).toBe(400);
    expect(invoice().last_reminder_at).toBeNull();
  });
});
