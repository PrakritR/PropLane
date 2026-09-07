import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({
  requireManagerRouteUser: vi.fn(),
  getEffectiveManagerSmsEntitlement: vi.fn(),
  reconcileManagerSmsEntitlement: vi.fn(),
  getManagerPortalNavSubscriptionTier: vi.fn(),
  provisionManagerNumber: vi.fn(),
  track: vi.fn(),
  rateLimit: vi.fn<typeof import("@/lib/rate-limit").rateLimit>(),
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
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  provisionManagerNumber: mocks.provisionManagerNumber,
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: mocks.track }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));

import { GET, POST } from "@/app/api/manager/messaging-number/route";

const MANAGER = "00000000-0000-4000-8000-000000000001";
const originalProvisioning = process.env.SMS_PROVISIONING_ENABLED;

function dbFor(input?: {
  mode?: string;
  allowlisted?: boolean;
  coManager?: boolean;
  entitlementRow?: boolean;
}) {
  return createMemoryDb({
    sms_runtime_config: [
      {
        singleton: true,
        mode: input?.mode ?? "paused",
        pilot_manager_user_ids: input?.allowlisted ? [MANAGER] : [],
      },
    ],
    manager_sms_numbers: [],
    sms_manager_entitlements: input?.entitlementRow
      ? [{ manager_user_id: MANAGER, tier: "free", eligible: false }]
      : [],
    profiles: [
      {
        id: MANAGER,
        phone: "+15105550123",
        phone_verified_at: "2026-08-25T12:00:00.000Z",
        sms_forward_inbound: true,
      },
    ],
    manager_property_records: [],
    account_link_invites: input?.coManager
      ? [
          {
            id: "link-1",
            invitee_user_id: MANAGER,
            inviter_user_id: "00000000-0000-4000-8000-000000000099",
            status: "accepted",
          },
        ]
      : [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({ ok: true });
  delete process.env.SMS_PROVISIONING_ENABLED;
  const db = dbFor();
  mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
  mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({
    eligible: true,
    tier: "pro",
    source: "stripe",
  });
  mocks.reconcileManagerSmsEntitlement.mockResolvedValue({
    eligible: true,
    tier: "pro",
    source: "stripe",
  });
  mocks.getManagerPortalNavSubscriptionTier.mockResolvedValue("paid");
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalProvisioning === undefined)
    delete process.env.SMS_PROVISIONING_ENABLED;
  else process.env.SMS_PROVISIONING_ENABLED = originalProvisioning;
});

describe("manager messaging-number route", () => {
  it("offers explicit setup for an old trial snapshot only during the onboarding rollout", async () => {
    const db = dbFor({ mode: "automatic" });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "trialing" });
    process.env.SMS_PROVISIONING_ENABLED = "1";
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "1");
    expect((await (await GET()).json()).canRequest).toBe(true);
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "0");
    expect((await (await GET()).json()).canRequest).toBe(false);
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated eligibility refresh before billing work", async () => {
    mocks.requireManagerRouteUser.mockResolvedValue(null);
    const response = await POST(new Request("https://prop-lane.test/api/manager/messaging-number", {
      method: "POST", body: JSON.stringify({ action: "refresh_eligibility" }),
    }));
    expect(response.status).toBe(401);
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("bounds explicit refresh without purchasing or reading billing when throttled", async () => {
    mocks.rateLimit.mockResolvedValue({ ok: false });
    const response = await POST(new Request("https://prop-lane.test/api/manager/messaging-number", {
      method: "POST", body: JSON.stringify({ action: "refresh_eligibility" }),
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mocks.rateLimit).toHaveBeenCalledWith(`messaging-eligibility-refresh:${MANAGER}`, 3, 60_000);
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("returns a recoverable service failure when the limiter is unavailable", async () => {
    mocks.rateLimit.mockResolvedValue({ ok: false, unavailable: true });
    const response = await POST(new Request("https://prop-lane.test/api/manager/messaging-number", {
      method: "POST", body: JSON.stringify({ action: "refresh_eligibility" }),
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).error).toContain("temporarily unavailable");
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it.each(["pro", "business"])("lets an active %s subscriber request a number", async (tier) => {
    const db = dbFor({ mode: "automatic" });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier, source: "stripe" });
    mocks.provisionManagerNumber.mockResolvedValue({ ok: true, number: "+12065550123", state: "provisioning", alreadyProvisioned: false });
    process.env.SMS_PROVISIONING_ENABLED = "1";
    const response = await POST(new Request("https://prop-lane.test/api/manager/messaging-number", { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    expect(mocks.provisionManagerNumber).toHaveBeenCalledWith(db, MANAGER, undefined);
    expect(mocks.track).toHaveBeenCalledWith("messaging_number_requested", MANAGER, { state: "provisioning" });
  });

  it.each([
    ["trialing", 403, "trial converts"],
    ["plan_unreadable", 503, "could not verify"],
    ["legacy_unknown", 503, "could not verify"],
  ])("explains %s eligibility without a misleading upgrade prompt", async (reason, status, message) => {
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason });
    const response = await POST(new Request("https://prop-lane.test/api/manager/messaging-number", { method: "POST", body: "{}" }));
    expect(response.status).toBe(status);
    expect((await response.json()).error).toContain(message);
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("keeps GET strictly read-only and reports the effective paused mode", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      mode: "paused",
      workspaceRole: "primary",
      provisioningAvailable: false,
      planTier: "paid",
      canRequest: false,
      canSend: false,
      number: null,
      personalPhone: { phone: "+15105550123", forwardInbound: true },
    });
    expect(mocks.getEffectiveManagerSmsEntitlement).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("maps the nav subscription tier into planTier (free / unknown)", async () => {
    mocks.getManagerPortalNavSubscriptionTier.mockResolvedValueOnce("free");
    expect((await (await GET()).json()).planTier).toBe("free");

    mocks.getManagerPortalNavSubscriptionTier.mockResolvedValueOnce("paid");
    expect((await (await GET()).json()).planTier).toBe("paid");

    mocks.getManagerPortalNavSubscriptionTier.mockResolvedValueOnce(null);
    expect((await (await GET()).json()).planTier).toBe("unknown");
  });

  it("exposes co-manager workspace role while allowing number setup when eligible", async () => {
    const db = dbFor({ mode: "automatic", coManager: true });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    process.env.SMS_PROVISIONING_ENABLED = "1";

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workspaceRole: "co_manager",
      canRequest: true,
    });
  });

  it("removes unexpected persisted last_error details from read-only status", async () => {
    const db = dbFor();
    db.__tables.manager_sms_numbers.push({
      manager_user_id: MANAGER,
      provision_state: "failed",
      registration_state: "approved",
      attachment_state: "failed",
      number_registration_state: "not_submitted",
      last_error: "database host and provider account details",
    });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });

    const body = await (await GET()).json();

    expect(body.number.lastError).toBeNull();
    expect(JSON.stringify(body)).not.toContain("database host");
  });

  it("derives stuck carrier-registration attention from provider progress instead of updated_at", async () => {
    const db = dbFor();
    db.__tables.manager_sms_numbers.push({
      manager_user_id: MANAGER,
      phone_number: "+12065550123",
      provision_state: "provisioning",
      registration_state: "approved",
      attachment_state: "attached",
      number_registration_state: "pending",
      registration_submitted_at: new Date(
        Date.now() - 31 * 60_000,
      ).toISOString(),
      last_provider_event_at: null,
      quarantined_at: null,
      updated_at: new Date().toISOString(),
    });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      number: { setupNeedsAttention: true },
    });
  });

  it("treats a recent provider event as carrier-registration progress without relying on updated_at", async () => {
    const db = dbFor();
    db.__tables.manager_sms_numbers.push({
      manager_user_id: MANAGER,
      phone_number: "+12065550123",
      provision_state: "provisioning",
      registration_state: "approved",
      attachment_state: "attached",
      number_registration_state: "pending",
      registration_submitted_at: new Date(
        Date.now() - 2 * 60 * 60_000,
      ).toISOString(),
      last_provider_event_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      quarantined_at: null,
      updated_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      number: { setupNeedsAttention: false },
    });
  });

  it("rejects a JSON null body without reconciling or provisioning", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/JSON object/i);
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("refreshes stored eligibility for an existing number without entering provisioning", async () => {
    const db = dbFor({ mode: "paused" });
    db.__tables.manager_sms_numbers.push({
      manager_user_id: MANAGER,
      phone_number: "+12065550123",
      provision_state: "active",
      registration_state: "approved",
      attachment_state: "attached",
      number_registration_state: "registered",
    });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refresh_eligibility" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalledWith(
      db,
      MANAGER,
    );
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("recovers a numberless account even when an old plan snapshot exists", async () => {
    // An old snapshot must never permanently block recovery after an upgrade.
    const db = dbFor({ entitlementRow: true });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({
      eligible: false,
      reason: "plan_unreadable",
    });

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refresh_eligibility" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalledTimes(1);
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("refreshes an unresolved plan even before a number exists", async () => {
    // The new-account shape: no entitlement row yet, so the stored read is
    // `plan_unreadable` and this is the only action that can settle it.
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({
      eligible: false,
      reason: "plan_unreadable",
    });
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({
      eligible: false,
      reason: "free",
    });

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refresh_eligibility" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalledTimes(1);
    // Still strictly a billing re-read - it may never buy a number.
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("refreshes an eligible account without purchasing a number", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refresh_eligibility" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalledTimes(1);
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("provisions a co-manager work number after entitlement reconciliation", async () => {
    const db = dbFor({ mode: "automatic", coManager: true });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    mocks.provisionManagerNumber.mockResolvedValue({
      ok: true,
      number: "+12065550123",
      state: "active",
      alreadyProvisioned: false,
    });
    process.env.SMS_PROVISIONING_ENABLED = "1";

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        body: JSON.stringify({ action: "request_number" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalledWith(
      db,
      MANAGER,
    );
    expect(mocks.provisionManagerNumber).toHaveBeenCalledWith(db, MANAGER, undefined);
  });

  it("keeps the environment kill switch ahead of provider provisioning", async () => {
    const db = dbFor({ mode: "automatic" });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalledTimes(1);
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("provisions only after entitlement, runtime, allowlist, and env gates pass", async () => {
    const db = dbFor({ mode: "allowlisted_self_service", allowlisted: true });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    mocks.provisionManagerNumber.mockResolvedValue({
      ok: true,
      number: "+12065550123",
      state: "active",
      alreadyProvisioned: false,
    });
    process.env.SMS_PROVISIONING_ENABLED = "1";

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ areaCode: "206" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileManagerSmsEntitlement).toHaveBeenCalledWith(
      db,
      MANAGER,
    );
    expect(mocks.provisionManagerNumber).toHaveBeenCalledWith(db, MANAGER, {
      areaCode: "206",
    });
    expect(mocks.track).toHaveBeenCalledWith(
      "messaging_number_requested",
      MANAGER,
      { state: "active" },
    );
  });

  it("returns the precise provisioning diagnostic instead of replacing it with generic copy", async () => {
    const db = dbFor({ mode: "automatic" });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    mocks.provisionManagerNumber.mockResolvedValue({
      ok: false,
      error:
        "Twilio Messaging Service sender-pool attachment failed (code 20403, HTTP 403). The purchased number was released.",
      state: "failed",
    });
    process.env.SMS_PROVISIONING_ENABLED = "1";

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("code 20403, HTTP 403");
  });
  it("does not expose an unexpected internal provisioning error", async () => {
    const db = dbFor({ mode: "automatic" });
    db.__tables.manager_sms_numbers.push({
      manager_user_id: MANAGER,
      provision_state: "failed",
      registration_state: "approved",
      attachment_state: "failed",
      number_registration_state: "not_submitted",
      last_error: "database host and provider account details",
    });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    mocks.provisionManagerNumber.mockResolvedValue({
      ok: false,
      error: "database host and provider account details",
      state: "failed",
    });
    process.env.SMS_PROVISIONING_ENABLED = "1";

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        body: "{}",
      }),
    );

    const body = await response.json();
    expect(body).toMatchObject({
      error: "We could not set up your messaging number. Try again later.",
      number: { lastError: null },
    });
    expect(JSON.stringify(body)).not.toContain("database host");
  });

  it.each([
    "No SMS-capable numbers are available in area code 999 right now.",
    "No SMS-capable numbers are available right now — try again shortly.",
    "Twilio work-number purchase failed (code 20500, HTTP 500). Provider ownership is unconfirmed; do not retry until PropLane reviews it.",
    "Twilio Messaging Service sender-pool attachment failed (code ETIMEDOUT). The purchased number was released.",
    "Twilio Messaging Service sender-pool attachment failed (HTTP 500). The purchased number was released.",
    "Messaging Service attachment is not configured. The purchased number release could not be confirmed; do not retry until PropLane reviews it.",
    "Provider setup is awaiting reconciliation.",
    "Provider cleanup requires review.",
  ])("preserves the curated actionable provisioning error %s", async (error) => {
    const db = dbFor({ mode: "automatic" });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    mocks.provisionManagerNumber.mockResolvedValue({
      ok: false,
      error,
      state: "failed",
    });
    process.env.SMS_PROVISIONING_ENABLED = "1";

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe(error);
  });
});
