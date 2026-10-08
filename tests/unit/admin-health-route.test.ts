/**
 * GET /api/admin/health: failed deliveries and stuck work, grouped by kind.
 *
 * Every row names the account it belongs to; no payload, URL or message body leaves the server.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminFakeDb, type AdminFakeDb, type Row } from "../helpers/admin-fake-db";

const isAdminUser = vi.fn();
const getUser = vi.fn();
const serviceRoleFactory = vi.fn();

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceRoleFactory() }));

const { GET } = await import("@/app/api/admin/health/route");
const { isStuckApplication } = await import("@/lib/admin/admin-health.server");

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const seed = (): Record<string, Row[]> => ({
  sms_delivery_log: [
    { id: "l1", to_phone: "+12065550142", status: "failed", error_code: "30003", manager_user_id: "m1", created_at: daysAgo(1) },
    { id: "l2", to_phone: "+12065550143", status: "delivered", manager_user_id: "m1", created_at: daysAgo(1) },
    { id: "l3", to_phone: "+12065550144", status: "undelivered", error_code: "30005", manager_user_id: "m2", created_at: daysAgo(20) },
  ],
  sms_delivery_attempts: [
    { id: "a1", outbox_id: "o1", state: "provider_rejected", provider_error_code: "21610", started_at: daysAgo(2) },
  ],
  sms_outbox: [{ id: "o1", manager_user_id: "m3", recipient_phone: "+12065550199", purpose: "rent_reminder" }],
  webhook_deliveries: [
    { id: "w1", subscription_id: "s1", event_type: "charge.paid", status: "exhausted", response_status: 500, attempt: 6, payload: { secret: "do-not-leak" }, created_at: daysAgo(1) },
    { id: "w2", subscription_id: "s1", event_type: "charge.paid", status: "delivered", created_at: daysAgo(1) },
  ],
  webhook_subscriptions: [{ id: "s1", manager_user_id: "m4", url: "https://hooks.example.com/private" }],
  stripe_disputes: [
    { id: "d1", manager_user_id: "m1", amount_cents: 7500, status: "needs_response", reason: "fraudulent", created_at: daysAgo(3) },
    { id: "d2", manager_user_id: "m1", amount_cents: 100, status: "won", created_at: daysAgo(3) },
  ],
  manager_application_records: [
    { id: "app1", manager_user_id: "m1", created_at: daysAgo(10), bucket: "pending", stage: "Under review", row_data: { bucket: "pending", stage: "Under review" }, test_workspace_id: null },
    { id: "app2", manager_user_id: "m1", created_at: daysAgo(2), bucket: "pending", stage: "Under review", row_data: { bucket: "pending", stage: "Under review" }, test_workspace_id: null },
    { id: "app3", manager_user_id: "m1", created_at: daysAgo(12), bucket: "pending", stage: "In progress", row_data: { bucket: "pending", stage: "In progress" }, test_workspace_id: null },
    { id: "app4", manager_user_id: "m1", created_at: daysAgo(12), bucket: "approved", stage: "Approved", row_data: { bucket: "approved", stage: "Approved" }, test_workspace_id: null },
    { id: "app5", manager_user_id: "m1", created_at: daysAgo(12), bucket: "pending", stage: "Under review", row_data: { bucket: "pending", stage: "Under review" }, test_workspace_id: "tw1" },
  ],
});

let db: AdminFakeDb;
const asAdmin = () => {
  getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  isAdminUser.mockResolvedValue(true);
};

beforeEach(() => {
  isAdminUser.mockReset();
  getUser.mockReset();
  serviceRoleFactory.mockReset();
  db = createAdminFakeDb(seed());
  serviceRoleFactory.mockImplementation(() => db);
});

describe("GET /api/admin/health", () => {
  it("is 401 signed out and 403 for a non-admin", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await GET()).status).toBe(401);
    getUser.mockResolvedValue({ data: { user: { id: "x" } } });
    isAdminUser.mockResolvedValue(false);
    expect((await GET()).status).toBe(403);
    expect(serviceRoleFactory).not.toHaveBeenCalled();
  });

  it("groups failed texts, webhooks, disputes and stuck applications", async () => {
    asAdmin();
    const body = await (await GET()).json();
    const ids = (group: string) =>
      body.groups.find((g: { id: string }) => g.id === group).rows.map((r: { id: string }) => r.id).sort();

    // The delivered text and the failure older than a week are not listed; the rejected attempt is.
    expect(ids("sms")).toEqual(["attempt-a1", "log-l1"]);
    expect(ids("webhooks")).toEqual(["webhook-w1"]);
    expect(ids("disputes")).toEqual(["dispute-d1"]);
    // Pending more than 7 days, submitted (not "In progress"), real (not a test workspace).
    expect(ids("applications")).toEqual(["application-app1"]);
  });

  it("names the account each row belongs to", async () => {
    asAdmin();
    const body = await (await GET()).json();
    const rows = Object.fromEntries(
      body.groups.flatMap((g: { rows: { id: string; accountId: string }[] }) => g.rows.map((r) => [r.id, r.accountId])),
    );
    expect(rows["log-l1"]).toBe("m1");
    expect(rows["attempt-a1"]).toBe("m3");
    expect(rows["webhook-w1"]).toBe("m4");
    expect(rows["dispute-d1"]).toBe("m1");
  });

  it("never leaks a phone number, a webhook URL or a payload", async () => {
    asAdmin();
    const text = JSON.stringify(await (await GET()).json());
    expect(text).not.toContain("2065550142");
    expect(text).not.toContain("hooks.example.com");
    expect(text).not.toContain("do-not-leak");
    expect(text).toContain("•••• 0142");
  });

  it("does not list email failures, which no table records", async () => {
    asAdmin();
    const body = await (await GET()).json();
    expect(body.groups.map((g: { id: string }) => g.id)).toEqual(["sms", "webhooks", "disputes", "applications"]);
    expect(db.touched.has("portal_outbound_mail_records")).toBe(false);
  });
});

describe("isStuckApplication", () => {
  it("excludes drafts, decided and approved rows", () => {
    expect(isStuckApplication({ bucket: "pending", stage: "Under review" })).toBe(true);
    expect(isStuckApplication({ bucket: "pending", stage: "In progress" })).toBe(false);
    expect(isStuckApplication({ bucket: "pending", stage: "Rejected" })).toBe(false);
    expect(isStuckApplication({ bucket: "pending", stage: "Withdrawn" })).toBe(false);
    expect(isStuckApplication({ bucket: "approved", stage: "Approved" })).toBe(false);
  });
});
