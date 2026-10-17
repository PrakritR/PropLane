import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({
  cookies: {} as Record<string, string>,
  requireManagerRouteUser: vi.fn(),
  billing: vi.fn(),
}));

vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: mocks.requireManagerRouteUser,
}));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPortalNavSubscriptionTier: vi.fn().mockResolvedValue("paid"),
}));
vi.mock("@/lib/sms/manager-sms-entitlement.server", () => ({
  getEffectiveManagerSmsEntitlement: vi.fn().mockResolvedValue({ eligible: true, tier: "pro", source: "stripe" }),
  reconcileManagerSmsEntitlement: vi.fn(),
}));
vi.mock("@/lib/sms/work-numbers.server", () => ({
  provisionNumberForWorkspace: vi.fn(),
  listWorkspaceNumbers: vi.fn().mockResolvedValue([]),
  assignNumberToWorkspace: vi.fn(),
  unassignNumber: vi.fn(),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({
  evaluateManagerCommsBillingGate: mocks.billing,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (mocks.cookies[name] ? { value: mocks.cookies[name] } : undefined),
  }),
}));

import { GET } from "@/app/api/manager/messaging-number/route";

const MANAGER = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000099";
const MY_WS = "ws-manager";
const SHARED_WS = "ws-owner";

const envKeys = [
  "SMS_RUNTIME_ENABLED",
  "SMS_OUTBOX_SCHEDULER_READY",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_CAMPAIGN_SID",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function teammateDb(
  ownerLine: { provision_state: string; registration_state?: string; workspace_id?: string | null } | null,
  runtime: { mode: string; pilot_manager_user_ids: string[] } = {
    mode: "automatic",
    pilot_manager_user_ids: [],
  },
) {
  const db = createMemoryDb({
    sms_runtime_config: [{ singleton: true, ...runtime }],
    manager_sms_numbers: ownerLine
      ? [
          {
            id: "num-1",
            manager_user_id: OWNER,
            workspace_id: SHARED_WS,
            phone_number: "+12065550199",
            phone_number_sid: "PN123",
            messaging_service_sid: "MG123",
            campaign_sid: "CM123",
            registration_state: "approved",
            attachment_state: "attached",
            number_registration_state: "registered",
            ...ownerLine,
          },
        ]
      : [],
    sms_manager_entitlements: [],
    profiles: [
      { id: MANAGER, email: "manager@example.com" },
      { id: OWNER, full_name: "Owner", email: "owner@example.com" },
    ],
    portal_workspaces: [
      { id: MY_WS, owner_user_id: MANAGER, name: "Mine", is_default: true, created_at: "2026-01-02" },
      { id: SHARED_WS, owner_user_id: OWNER, name: "Owner's", is_default: true, created_at: "2026-01-01" },
    ],
    manager_property_records: [{ id: "house-1", manager_user_id: OWNER, workspace_id: SHARED_WS, row_data: {} }],
    account_link_invites: [
      {
        id: "link-1",
        invitee_user_id: MANAGER,
        inviter_user_id: OWNER,
        status: "accepted",
        assigned_property_ids: ["house-1"],
        property_co_manager_permissions: { "house-1": { inbox: true } },
      },
    ],
  });
  return db;
}

async function statusFor(db: ReturnType<typeof teammateDb>) {
  mocks.requireManagerRouteUser.mockResolvedValue({ db, userId: MANAGER });
  mocks.cookies["proplane-workspace"] = SHARED_WS;
  return (await GET(new Request("http://localhost"))).json();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies = {};
  for (const k of envKeys) savedEnv[k] = process.env[k];
  process.env.SMS_RUNTIME_ENABLED = "1";
  process.env.SMS_OUTBOX_SCHEDULER_READY = "1";
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MG123";
  process.env.TWILIO_CAMPAIGN_SID = "CM123";
  mocks.billing.mockResolvedValue({ allowed: true, billingOwnerId: OWNER });
});

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("messaging-number status: a teammate's canSend is the workspace line's", () => {
  it("is true when the owner's line is live and the owner's wallet has credit", async () => {
    const body = await statusFor(teammateDb({ provision_state: "active" }));
    expect(body.workspaceRole).toBe("co_manager");
    expect(body.workspaceNumber.phoneNumber).toBe("+12065550199");
    expect(body.canSend).toBe(true);
    // Billed to the owner's workspace wallet, never the viewer's.
    expect(mocks.billing).toHaveBeenCalledWith(expect.anything(), OWNER, 3, SHARED_WS);
    expect(mocks.billing).not.toHaveBeenCalledWith(expect.anything(), MANAGER, expect.anything(), expect.anything());
  });

  it("is false while the owner's line is still pending", async () => {
    const body = await statusFor(
      teammateDb({ provision_state: "pending_registration", registration_state: "pending" }),
    );
    expect(body.canSend).toBe(false);
  });

  it("is false when the workspace has no line at all", async () => {
    const body = await statusFor(teammateDb(null));
    expect(body.canSend).toBe(false);
  });

  it("is false when the owner's billing gate refuses (out of credit)", async () => {
    mocks.billing.mockResolvedValue({ allowed: false, reason: "allowance_exhausted" });
    const body = await statusFor(teammateDb({ provision_state: "active" }));
    expect(body.canSend).toBe(false);
  });

  it("is false when the deployment cannot send", async () => {
    process.env.SMS_RUNTIME_ENABLED = "0";
    const body = await statusFor(teammateDb({ provision_state: "active" }));
    expect(body.canSend).toBe(false);
  });

  it("fails closed when the readiness check throws", async () => {
    mocks.billing.mockRejectedValue(new Error("boom"));
    const body = await statusFor(teammateDb({ provision_state: "active" }));
    expect(body.canSend).toBe(false);
  });

  it("skips the readiness chain entirely when the deployment's texting runtime is off", async () => {
    process.env.SMS_OUTBOX_SCHEDULER_READY = "0";
    const body = await statusFor(teammateDb({ provision_state: "active" }));
    expect(body.canSend).toBe(false);
    expect(mocks.billing).not.toHaveBeenCalled();
  });
});

describe("messaging-number status: a teammate's sendingAvailable follows the OWNER's access", () => {
  const allowlisted = { mode: "allowlisted_self_service", pilot_manager_user_ids: [OWNER] };

  it("is true when the owner holds the allowlist seat and the teammate does not", async () => {
    const body = await statusFor(teammateDb({ provision_state: "active" }, allowlisted));
    expect(body.sendingAvailable).toBe(true);
    expect(body.canSend).toBe(true);
  });

  it("is false when the owner has no seat either", async () => {
    const body = await statusFor(
      teammateDb({ provision_state: "active" }, { mode: "allowlisted_self_service", pilot_manager_user_ids: [] }),
    );
    expect(body.sendingAvailable).toBe(false);
    expect(body.canSend).toBe(false);
  });

  it("never lets a teammate's own seat open provisioning they cannot do", async () => {
    const body = await statusFor(
      teammateDb({ provision_state: "active" }, { mode: "allowlisted_self_service", pilot_manager_user_ids: [MANAGER] }),
    );
    expect(body.canRequest).toBe(false);
  });
});

describe("messaging-number status: the teammate's workspaceNumber is the line a send resolves", () => {
  it("reports the owner's legacy unplaced line as the workspace's number", async () => {
    // Migrated before numbers were workspace-owned: no `workspace_id`, so the
    // per-workspace read finds nothing while a send still leaves on it.
    const body = await statusFor(teammateDb({ provision_state: "active", workspace_id: null }));
    expect(body.workspaceNumber.phoneNumber).toBe("+12065550199");
    expect(body.canSend).toBe(true);
  });

  it("stays null when the workspace genuinely has no line", async () => {
    const body = await statusFor(teammateDb(null));
    expect(body.workspaceNumber.phoneNumber).toBeNull();
  });
});
