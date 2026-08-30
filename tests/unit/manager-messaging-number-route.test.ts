import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({
  requireManagerRouteUser: vi.fn(),
  getStoredManagerSmsEntitlement: vi.fn(),
  reconcileManagerSmsEntitlement: vi.fn(),
  getEffectiveManagerSkuTier: vi.fn(),
  provisionManagerNumber: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: mocks.requireManagerRouteUser,
}));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: mocks.getEffectiveManagerSkuTier,
}));
vi.mock("@/lib/sms/manager-sms-entitlement.server", () => ({
  getStoredManagerSmsEntitlement: mocks.getStoredManagerSmsEntitlement,
  reconcileManagerSmsEntitlement: mocks.reconcileManagerSmsEntitlement,
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  provisionManagerNumber: mocks.provisionManagerNumber,
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: mocks.track }));

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
      ? [{ id: "link-1", invitee_user_id: MANAGER, status: "accepted" }]
      : [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SMS_PROVISIONING_ENABLED;
  const db = dbFor();
  mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
  mocks.getStoredManagerSmsEntitlement.mockResolvedValue({
    eligible: true,
    tier: "pro",
    source: "stripe",
  });
  mocks.reconcileManagerSmsEntitlement.mockResolvedValue({
    eligible: true,
    tier: "pro",
    source: "stripe",
  });
  mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "pro" });
});

afterEach(() => {
  if (originalProvisioning === undefined)
    delete process.env.SMS_PROVISIONING_ENABLED;
  else process.env.SMS_PROVISIONING_ENABLED = originalProvisioning;
});

describe("manager messaging-number route", () => {
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
    expect(mocks.getStoredManagerSmsEntitlement).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("maps the authoritative plan class into planTier (free / unknown)", async () => {
    mocks.getEffectiveManagerSkuTier.mockResolvedValueOnce({
      ok: true,
      tier: "free",
    });
    expect((await (await GET()).json()).planTier).toBe("free");

    // A null tier backed by a live subscription is paid, not free.
    mocks.getEffectiveManagerSkuTier.mockResolvedValueOnce({
      ok: true,
      tier: null,
    });
    expect((await (await GET()).json()).planTier).toBe("paid");

    // An unreadable plan fails closed to "unknown" (never the free upsell).
    mocks.getEffectiveManagerSkuTier.mockResolvedValueOnce({
      ok: false,
      error: "boom",
    });
    expect((await (await GET()).json()).planTier).toBe("unknown");
  });

  it("exposes co-manager workspace context on read-only status", async () => {
    const db = dbFor({ coManager: true });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workspaceRole: "co_manager",
      canRequest: false,
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

  it("refuses a numberless check once a plan snapshot exists", async () => {
    // `plan_unreadable` is sticky, so a reason-keyed gate would never close and
    // every press would re-hit billing. A stored snapshot closes it for good.
    const db = dbFor({ entitlementRow: true });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    mocks.getStoredManagerSmsEntitlement.mockResolvedValue({
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

    expect(response.status).toBe(409);
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
  });

  it("refreshes an unresolved plan even before a number exists", async () => {
    // The new-account shape: no entitlement row yet, so the stored read is
    // `plan_unreadable` and this is the only action that can settle it.
    mocks.getStoredManagerSmsEntitlement.mockResolvedValue({
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

  it("does not refresh or provision when no number exists", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refresh_eligibility" }),
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("refuses a pure co-manager before billing reconciliation or provisioning", async () => {
    const db = dbFor({ mode: "automatic", coManager: true });
    mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
    process.env.SMS_PROVISIONING_ENABLED = "1";

    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", {
        method: "POST",
        body: JSON.stringify({ action: "request_number" }),
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/primary property manager/i);
    expect(mocks.reconcileManagerSmsEntitlement).not.toHaveBeenCalled();
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
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
});
