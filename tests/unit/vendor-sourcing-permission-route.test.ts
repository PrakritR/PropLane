import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireVendorApiAccess: vi.fn(),
  createSupabaseServiceRoleClient: vi.fn(),
  resolveAuthenticatedBusinessAccess: vi.fn(),
  coordinationWorkOrderAccess: vi.fn(),
  readScopedSmsConsentState: vi.fn(),
  readSmsSuppressionState: vi.fn(),
  recordScopedSmsConsent: vi.fn(),
  sweepVendorSourcing: vi.fn(),
  afterCallbacks: [] as Array<() => Promise<unknown>>,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (callback: () => Promise<unknown>) => { mocks.afterCallbacks.push(callback); },
  };
});
vi.mock("@/lib/auth/vendor-api-access", () => ({ requireVendorApiAccess: mocks.requireVendorApiAccess }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.createSupabaseServiceRoleClient }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: mocks.resolveAuthenticatedBusinessAccess }));
vi.mock("@/lib/vendor-coordination.server", () => ({ coordinationWorkOrderAccess: mocks.coordinationWorkOrderAccess }));
vi.mock("@/lib/sms-consent", () => ({
  readScopedSmsConsentState: mocks.readScopedSmsConsentState,
  readSmsSuppressionState: mocks.readSmsSuppressionState,
  recordScopedSmsConsent: mocks.recordScopedSmsConsent,
}));
vi.mock("@/lib/vendor-sourcing.server", () => ({
  VENDOR_QUOTE_SMS_PURPOSE: "vendor_quote_request",
  sweepVendorSourcing: mocks.sweepVendorSourcing,
}));

import { GET, POST } from "@/app/api/portal/vendor-sourcing-permission/route";

function mockDb(options?: { activeOffer?: boolean; verified?: boolean; directoryPhone?: string }) {
  const rows: Record<string, unknown[]> = {
    manager_vendor_records: [{
      id: "directory-1",
      vendor_user_id: "vendor-1",
      row_data: { active: true, phone: options?.directoryPhone ?? "+12065550123" },
    }],
    work_order_vendor_offers: options?.activeOffer === false ? [] : [{
      vendor_directory_id: "directory-1",
      vendor_user_id: "vendor-1",
      status: "sent",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }],
  };
  const db = {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        maybeSingle: async () => ({ data: table === "profiles" ? {
          id: "vendor-1",
          phone: "+12065550123",
          phone_verified_at: options?.verified === false ? null : "2026-10-15T12:00:00.000Z",
        } : (rows[table]?.[0] ?? null), error: null }),
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve, reject),
      };
      return query;
    },
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.afterCallbacks.length = 0;
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG11111111111111111111111111111111");
  mocks.requireVendorApiAccess.mockResolvedValue({ ok: true, actor: { userId: "vendor-1", email: "vendor@example.test" } });
  mocks.resolveAuthenticatedBusinessAccess.mockResolvedValue({ kind: "allowed" });
  mocks.coordinationWorkOrderAccess.mockResolvedValue({ id: "service-1", manager_user_id: "manager-1", row_data: {} });
  mocks.readScopedSmsConsentState.mockResolvedValue({ ok: true, state: "none" });
  mocks.readSmsSuppressionState.mockResolvedValue({ ok: true, optedOut: false });
  mocks.recordScopedSmsConsent.mockResolvedValue({ ok: true });
  mocks.sweepVendorSourcing.mockResolvedValue(1);
  mocks.createSupabaseServiceRoleClient.mockReturnValue(mockDb());
});

describe("vendor quote SMS permission route", () => {
  it("rejects vendors denied by authenticated business access", async () => {
    mocks.resolveAuthenticatedBusinessAccess.mockResolvedValue({ kind: "denied" });
    const response = await POST(new Request("https://proplane.test/api/portal/vendor-sourcing-permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workOrderId: "service-1", enabled: true }),
    }));
    expect(response.status).toBe(403);
    expect(mocks.coordinationWorkOrderAccess).not.toHaveBeenCalled();
    expect(mocks.recordScopedSmsConsent).not.toHaveBeenCalled();
  });

  it("records the exact vendor quote scope after explicit opt-in and wakes the scoped service", async () => {
    const response = await POST(new Request("https://proplane.test/api/portal/vendor-sourcing-permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workOrderId: "service-1", enabled: true }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.coordinationWorkOrderAccess).toHaveBeenCalledWith(expect.anything(), {
      role: "vendor", userId: "vendor-1", email: "vendor@example.test",
    }, "service-1");
    expect(mocks.recordScopedSmsConsent).toHaveBeenCalledWith(expect.anything(), "+12065550123", expect.objectContaining({
      managerUserId: "manager-1",
      purpose: "vendor_quote_request",
      sendClass: "automated",
      conversationKey: "manager-1:vendor:vendor-1",
      messagingServiceSid: "MG11111111111111111111111111111111",
      eventType: "granted",
      source: "vendor_portal_explicit_quote_opt_in",
    }));
    expect(mocks.afterCallbacks).toHaveLength(1);
    await mocks.afterCallbacks[0]!();
    expect(mocks.sweepVendorSourcing).toHaveBeenCalledWith(expect.anything(), "service-1");
  });

  it("rejects an implicit or non-positive permission request", async () => {
    const response = await POST(new Request("https://proplane.test/api/portal/vendor-sourcing-permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workOrderId: "service-1", enabled: false }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.recordScopedSmsConsent).not.toHaveBeenCalled();
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it("requires a finite active offer and a verified phone matching the vendor directory", async () => {
    mocks.createSupabaseServiceRoleClient.mockReturnValue(mockDb({ activeOffer: false }));
    const expired = await POST(new Request("https://proplane.test/api/portal/vendor-sourcing-permission", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workOrderId: "service-1", enabled: true }),
    }));
    expect(expired.status).toBe(409);
    expect(mocks.recordScopedSmsConsent).not.toHaveBeenCalled();

    mocks.createSupabaseServiceRoleClient.mockReturnValue(mockDb({ verified: false }));
    const unverified = await POST(new Request("https://proplane.test/api/portal/vendor-sourcing-permission", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workOrderId: "service-1", enabled: true }),
    }));
    expect(unverified.status).toBe(409);
    expect(mocks.recordScopedSmsConsent).not.toHaveBeenCalled();

    mocks.createSupabaseServiceRoleClient.mockReturnValue(mockDb({ directoryPhone: "+12065550999" }));
    const mismatched = await POST(new Request("https://proplane.test/api/portal/vendor-sourcing-permission", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workOrderId: "service-1", enabled: true }),
    }));
    expect(mismatched.status).toBe(409);
    expect(mocks.recordScopedSmsConsent).not.toHaveBeenCalled();
  });

  it("reports existing grant state only after validating the current active offer", async () => {
    mocks.readScopedSmsConsentState.mockResolvedValue({ ok: true, state: "granted" });
    const response = await GET(new Request("https://proplane.test/api/portal/vendor-sourcing-permission?workOrderId=service-1"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ permissionGranted: true, suppressed: false });
  });
});
