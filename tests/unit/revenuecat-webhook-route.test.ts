import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/manager-apple-subscription-sync", () => ({
  applyRevenueCatWebhookEvent: vi.fn(),
}));
vi.mock("@/lib/analytics/posthog", () => ({
  track: vi.fn(),
}));
vi.mock("@/lib/sms/manager-sms-entitlement.server", () => ({
  reconcileManagerSmsEntitlement: vi.fn(async () => ({
    eligible: true,
    tier: "pro",
    source: "apple",
  })),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(() => ({})),
}));

import { POST } from "@/app/api/revenuecat/webhook/route";
import { applyRevenueCatWebhookEvent } from "@/lib/manager-apple-subscription-sync";
import { track } from "@/lib/analytics/posthog";

const AUTH = "rc_secret_header_value";
const URL = "https://www.prop-lane.space/api/revenuecat/webhook";

function post(body: unknown, authHeader?: string): Request {
  return new Request(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.REVENUECAT_WEBHOOK_AUTH_HEADER = AUTH;
});
afterEach(() => {
  delete process.env.REVENUECAT_WEBHOOK_AUTH_HEADER;
});

describe("POST /api/revenuecat/webhook", () => {
  it("500s when the auth secret is not configured", async () => {
    delete process.env.REVENUECAT_WEBHOOK_AUTH_HEADER;
    const res = await POST(post({ event: {} }, AUTH));
    expect(res.status).toBe(500);
    expect(applyRevenueCatWebhookEvent).not.toHaveBeenCalled();
  });

  it("401s on a missing or wrong Authorization header", async () => {
    expect((await POST(post({ event: {} }))).status).toBe(401);
    expect((await POST(post({ event: {} }, "wrong"))).status).toBe(401);
    expect(applyRevenueCatWebhookEvent).not.toHaveBeenCalled();
  });

  it("acknowledges a malformed payload without touching entitlements", async () => {
    const res = await POST(post({ notAnEvent: true }, AUTH));
    expect(res.status).toBe(200);
    expect(applyRevenueCatWebhookEvent).not.toHaveBeenCalled();
  });

  it("applies a valid event and fires the conversion metric on initial purchase", async () => {
    vi.mocked(applyRevenueCatWebhookEvent).mockResolvedValue({
      decision: { action: "grant", appUserId: "u1", tier: "pro", billing: "monthly", originalTransactionId: "otx", environment: "PRODUCTION" },
    });

    const res = await POST(post({ event: { type: "INITIAL_PURCHASE", app_user_id: "u1" } }, AUTH));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, action: "grant" });
    expect(applyRevenueCatWebhookEvent).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith("manager_subscription_purchased", "u1", {
      tier: "pro",
      billing: "apple",
      platform: "ios",
    });
  });

  it("does not fire the conversion metric on a renewal", async () => {
    vi.mocked(applyRevenueCatWebhookEvent).mockResolvedValue({
      decision: { action: "grant", appUserId: "u1", tier: "pro", billing: "monthly", originalTransactionId: "otx", environment: null },
    });
    await POST(post({ event: { type: "RENEWAL", app_user_id: "u1" } }, AUTH));
    expect(track).not.toHaveBeenCalled();
  });

  it("500s (so RevenueCat retries) when the handler throws", async () => {
    vi.mocked(applyRevenueCatWebhookEvent).mockRejectedValue(new Error("db down"));
    const res = await POST(post({ event: { type: "EXPIRATION", app_user_id: "u1" } }, AUTH));
    expect(res.status).toBe(500);
  });

  it("500s without firing the conversion metric when a grant write fails", async () => {
    vi.mocked(applyRevenueCatWebhookEvent).mockRejectedValue(
      new Error("Apple grant not recorded: db down"),
    );
    const res = await POST(post({ event: { type: "INITIAL_PURCHASE", app_user_id: "u1" } }, AUTH));
    expect(res.status).toBe(500);
    expect(track).not.toHaveBeenCalled();
  });
});
