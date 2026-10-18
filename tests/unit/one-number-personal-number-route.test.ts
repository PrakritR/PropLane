import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({
  requireManagerRouteUser: vi.fn(),
  getEffectiveManagerSmsEntitlement: vi.fn(),
  reconcileManagerSmsEntitlement: vi.fn(),
  getManagerPortalNavSubscriptionTier: vi.fn(),
  provision: vi.fn(),
  rateLimit: vi.fn(),
  personal: vi.fn(),
  availability: vi.fn(),
}));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({ managerPersonalNumberEntitlement: mocks.personal }));
vi.mock("@/lib/number-subscription/availability.server", () => ({ getNumberAvailability: mocks.availability }));
vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: mocks.requireManagerRouteUser }));
vi.mock("@/lib/manager-access-server", () => ({ getManagerPortalNavSubscriptionTier: mocks.getManagerPortalNavSubscriptionTier }));
vi.mock("@/lib/sms/manager-sms-entitlement.server", () => ({
  getEffectiveManagerSmsEntitlement: mocks.getEffectiveManagerSmsEntitlement,
  reconcileManagerSmsEntitlement: mocks.reconcileManagerSmsEntitlement,
}));
vi.mock("@/lib/sms/work-numbers.server", () => ({
  provisionNumberForWorkspace: mocks.provision,
  listWorkspaceNumbers: vi.fn(async () => []),
  assignNumberToWorkspace: vi.fn(),
  unassignNumber: vi.fn(),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { GET, POST } from "@/app/api/manager/messaging-number/route";

const MANAGER = "00000000-0000-4000-8000-000000000001";
const SHARED = "+12065550100";
const originalOwner = process.env.PROPLANE_SERVICE_OWNER_USER_ID;
const originalProvisioning = process.env.SMS_PROVISIONING_ENABLED;

function dbFor(lineMode: "shared" | "per_workspace", extra: Record<string, Record<string, unknown>[]> = {}) {
  return createMemoryDb({
    sms_runtime_config: [{
      singleton: true, mode: "automatic", pilot_manager_user_ids: [],
      line_mode: lineMode, shared_number_e164: SHARED, shared_messaging_service_sid: "MG1", shared_pilot_workspace_ids: [],
    }],
    manager_sms_numbers: [],
    workspace_work_numbers: [],
    sms_manager_entitlements: [],
    profiles: [{ id: MANAGER, email: "m@example.com", phone: "+15105550123", phone_verified_at: "2026-08-25T12:00:00.000Z", sms_forward_inbound: true }],
    portal_workspaces: [{ id: "ws-1", owner_user_id: MANAGER, name: "My workspace", is_default: true, created_at: "2026-01-02" }],
    manager_property_records: [],
    account_link_invites: [],
    ...extra,
  });
}

const post = () => POST(new Request("https://prop-lane.test/api/manager/messaging-number", { method: "POST", body: JSON.stringify({ action: "request_number" }) }));

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PROPLANE_SERVICE_OWNER_USER_ID;
  process.env.SMS_PROVISIONING_ENABLED = "1";
  mocks.rateLimit.mockResolvedValue({ ok: true });
  mocks.getManagerPortalNavSubscriptionTier.mockResolvedValue("pro");
  mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "pro", source: "stripe" });
  mocks.reconcileManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "pro", source: "stripe" });
  mocks.personal.mockResolvedValue({ ok: true, entitled: true, via: "plan", tier: "pro" });
  mocks.availability.mockResolvedValue({ available: true });
  mocks.provision.mockResolvedValue({ ok: true, number: "+12065550001", state: "provisioning", alreadyProvisioned: false });
  mocks.requireManagerRouteUser.mockResolvedValue({ db: dbFor("shared"), userId: MANAGER });
});
afterEach(() => {
  if (originalOwner === undefined) delete process.env.PROPLANE_SERVICE_OWNER_USER_ID;
  else process.env.PROPLANE_SERVICE_OWNER_USER_ID = originalOwner;
  if (originalProvisioning === undefined) delete process.env.SMS_PROVISIONING_ENABLED;
  else process.env.SMS_PROVISIONING_ENABLED = originalProvisioning;
});

describe("request_number by plan", () => {
  it("refuses a Free workspace with a neutral 403 and never provisions", async () => {
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "free" });
    mocks.personal.mockResolvedValue({ ok: true, entitled: false, tier: "free" });
    const response = await post();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "personal_number_needs_paid_plan", error: "This workspace texts from the PropLane line." });
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("lets a Pro or Business workspace request its own number", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(mocks.provision).toHaveBeenCalledWith(expect.anything(), MANAGER, expect.objectContaining({ workspaceId: "ws-1" }));
  });

  it("lets a Free manager request a number once the standalone PropLane Number subscription is active", async () => {
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "free" });
    mocks.personal.mockResolvedValue({ ok: true, entitled: true, via: "add_on", tier: "free" });
    const response = await post();
    expect(response.status).toBe(200);
    expect(mocks.provision).toHaveBeenCalledTimes(1);
  });

  it("a lapsed add-on is Free again: neutral 403", async () => {
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "free" });
    mocks.personal.mockResolvedValue({ ok: true, entitled: false, tier: "free" });
    expect((await post()).status).toBe(403);
  });

  it("has no exemption for PropLane's managed-service account: Free stays on the PropLane line", async () => {
    process.env.PROPLANE_SERVICE_OWNER_USER_ID = MANAGER;
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "free" });
    mocks.personal.mockResolvedValue({ ok: true, entitled: false, tier: "free" });
    const response = await post();
    expect(response.status).toBe(403);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("a provisioning-level refusal for a plan is a 403, not a gateway error", async () => {
    mocks.provision.mockResolvedValue({ ok: false, error: "This workspace texts from the PropLane line.", state: "failed", code: "not_entitled" });
    const response = await post();
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("This workspace texts from the PropLane line.");
  });
});

describe("status: the PropLane line", () => {
  it("reports the shared line and that this workspace is on it", async () => {
    const body = await (await GET(new Request("http://localhost"))).json();
    expect(body.sharedLine).toEqual({ number: SHARED, onSharedLine: true, addOn: { available: false, active: false } });
  });

  it("a workspace that holds its own number is not on the shared line", async () => {
    mocks.requireManagerRouteUser.mockResolvedValue({
      userId: MANAGER,
      db: dbFor("shared", {
        manager_sms_numbers: [{ id: "n1", manager_user_id: MANAGER, workspace_id: "ws-1", phone_number: "+12065550001", provision_state: "active", registration_state: "approved", released_at: null }],
        workspace_work_numbers: [{ workspace_id: "ws-1", number_id: "n1", is_primary: true }],
      }),
    });
    const body = await (await GET(new Request("http://localhost"))).json();
    expect(body.sharedLine).toEqual({ number: SHARED, onSharedLine: false });
  });

  it("per_workspace reports no shared line at all", async () => {
    mocks.requireManagerRouteUser.mockResolvedValue({ db: dbFor("per_workspace"), userId: MANAGER });
    const body = await (await GET(new Request("http://localhost"))).json();
    expect(body.sharedLine).toBeNull();
  });

  it("a Free account cannot request", async () => {
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "free" });
    mocks.personal.mockResolvedValue({ ok: true, entitled: false, tier: "free" });
    const body = await (await GET(new Request("http://localhost"))).json();
    expect(body.canRequest).toBe(false);
  });

  it("a Free account is offered the standalone PropLane Number only when checkout is on and a number can be delivered", async () => {
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "free" });
    mocks.personal.mockResolvedValue({ ok: true, entitled: false, tier: "free" });
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    try {
      let body = await (await GET(new Request("http://localhost"))).json();
      expect(body.sharedLine.addOn).toEqual({ available: true, active: false });
      mocks.availability.mockResolvedValue({ available: false, reason: "capacity" });
      body = await (await GET(new Request("http://localhost"))).json();
      expect(body.sharedLine.addOn).toEqual({ available: false, active: false });
    } finally {
      vi.unstubAllEnvs();
    }
    mocks.availability.mockResolvedValue({ available: true });
    const off = await (await GET(new Request("http://localhost"))).json();
    expect(off.sharedLine.addOn).toEqual({ available: false, active: false });
  });

  it("a Free account with an active add-on can request its number", async () => {
    mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "free" });
    mocks.personal.mockResolvedValue({ ok: true, entitled: true, via: "add_on", tier: "free" });
    const body = await (await GET(new Request("http://localhost"))).json();
    expect(body.sharedLine.addOn).toEqual({ available: false, active: true });
    expect(body.canRequest).toBe(true);
  });

  it("a Pro account never sees the add-on offer: the plan includes the number", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    try {
      const body = await (await GET(new Request("http://localhost"))).json();
      expect(body.sharedLine.addOn).toEqual({ available: false, active: false });
      expect(body.canRequest).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("status: a workspace on the PropLane line can text", () => {
  it("reads the line as ready from the send path's own shared-line decision", async () => {
    vi.stubEnv("SMS_RUNTIME_ENABLED", "1");
    vi.stubEnv("SMS_OUTBOX_SCHEDULER_READY", "1");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MGdefault");
    try {
      const body = await (await GET(new Request("http://localhost"))).json();
      expect(body.sharedLine).toEqual({ number: SHARED, onSharedLine: true, addOn: { available: false, active: false } });
      expect(body.number).toBeNull();
      expect(body.lineReady).toBe(true);
      expect(body.canSend).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is not ready when the deployment's send switch is off, with the deployment as the reason", async () => {
    const body = await (await GET(new Request("http://localhost"))).json();
    expect(body.lineReady).toBe(false);
    expect(body.lineBlocked).toBe("deployment");
  });
});
