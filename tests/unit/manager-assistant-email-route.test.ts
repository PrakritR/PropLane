// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const MANAGER = "mgr-assistant-email";

const mocks = vi.hoisted(() => ({
  requireManagerRouteUser: vi.fn(),
  getManagerPortalNavSubscriptionTier: vi.fn(),
  getEffectiveManagerSmsEntitlement: vi.fn(),
  reconcileManagerSmsEntitlement: vi.fn(),
  loadManagerAssistantEmail: vi.fn(),
  ensureManagerAssistantEmail: vi.fn(),
  isAssistantEmailProvisioningEnabled: vi.fn(),
  isPureCoManagerWorkspace: vi.fn(),
  probeAssistantEmailStorageReady: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: mocks.requireManagerRouteUser,
}));

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPortalNavSubscriptionTier: mocks.getManagerPortalNavSubscriptionTier,
}));

vi.mock("@/lib/sms/manager-sms-entitlement.server", () => ({
  getEffectiveManagerSmsEntitlement: mocks.getEffectiveManagerSmsEntitlement,
  reconcileManagerSmsEntitlement: mocks.reconcileManagerSmsEntitlement,
}));

vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  loadManagerAssistantEmail: mocks.loadManagerAssistantEmail,
  ensureManagerAssistantEmail: mocks.ensureManagerAssistantEmail,
  isAssistantEmailProvisioningEnabled: mocks.isAssistantEmailProvisioningEnabled,
  isAssistantEmailStorageError: (error: { code?: string; message?: string }) =>
    error.code === "PGRST205" || /manager_assistant_emails/i.test(error.message ?? ""),
  probeAssistantEmailStorageReady: mocks.probeAssistantEmailStorageReady,
}));

vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  isPureCoManagerWorkspace: mocks.isPureCoManagerWorkspace,
}));

vi.mock("@/lib/analytics/posthog", () => ({
  track: mocks.track,
}));

import { GET, POST } from "@/app/api/manager/assistant-email/route";

function dbFor(options: { entitlementRow?: boolean } = {}) {
  const tables = {
    sms_manager_entitlements: options.entitlementRow
      ? [{ manager_user_id: MANAGER }]
      : [],
  };
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: (_col: string, value: string) => ({
          maybeSingle: async () => {
            if (table === "sms_manager_entitlements") {
              const row = tables.sms_manager_entitlements.find(
                (entry) => entry.manager_user_id === value,
              );
              return { data: row ?? null, error: null };
            }
            return { data: null, error: null };
          },
        }),
      };
      return chain;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireManagerRouteUser.mockResolvedValue({ db: dbFor(), userId: MANAGER });
  mocks.getManagerPortalNavSubscriptionTier.mockResolvedValue("paid");
  mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({
    eligible: false,
    reason: "plan_unreadable",
  });
  mocks.reconcileManagerSmsEntitlement.mockResolvedValue({
    eligible: true,
    tier: "pro",
    source: "stripe",
  });
  mocks.loadManagerAssistantEmail.mockResolvedValue(null);
  mocks.ensureManagerAssistantEmail.mockResolvedValue({
    managerUserId: MANAGER,
    inboxToken: "tok123456789",
    address: "assistant+tok123456789@prop-lane.space",
    provisionState: "active",
  });
  mocks.isAssistantEmailProvisioningEnabled.mockReturnValue(true);
  mocks.probeAssistantEmailStorageReady.mockResolvedValue(true);
  mocks.isPureCoManagerWorkspace.mockResolvedValue(false);
});

describe("GET /api/manager/assistant-email", () => {
  it("returns status for an authenticated manager", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      canRequest: true,
      planTier: "paid",
      address: null,
    });
  });
});

describe("POST /api/manager/assistant-email", () => {
  it("provisions an address after entitlement reconciliation", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/assistant-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request_address" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalled();
    expect(mocks.ensureManagerAssistantEmail).toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledWith("assistant_email_requested", MANAGER, {});
  });

  it("returns a readable error when the plan is still free after reconciliation", async () => {
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({
      eligible: false,
      reason: "free",
    });
    mocks.getManagerPortalNavSubscriptionTier.mockResolvedValue("free");

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/assistant-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request_address" }),
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("paid Pro or Business plan");
    expect(mocks.ensureManagerAssistantEmail).not.toHaveBeenCalled();
  });

  it("refreshes eligibility before an address exists", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/assistant-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refresh_eligibility" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalled();
    expect(mocks.ensureManagerAssistantEmail).not.toHaveBeenCalled();
  });
});
