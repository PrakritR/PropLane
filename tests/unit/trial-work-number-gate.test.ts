/**
 * A trial workspace cannot buy a work number — it is a paid feature (see
 * docs/agents/comms-billing.md). This pins both halves of the gate: the
 * server refuses the purchase route with a plain, non-transient reason, and
 * the client card shows "Start Pro" instead of ever reaching the number
 * picker. A paid tier reaches both the route and the picker normally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({
  requireManagerRouteUser: vi.fn(),
  reconcileManagerSmsEntitlement: vi.fn(),
  getEffectiveManagerSmsEntitlement: vi.fn(),
  getManagerPortalNavSubscriptionTier: vi.fn(),
  provisionNumberForWorkspace: vi.fn(),
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
  // The route's GET/status-building path (`buildStatus`, called at the end of
  // POST too, to shape its response) reads this separately from the
  // POST-only `reconcileManagerSmsEntitlement` gate under test.
  getEffectiveManagerSmsEntitlement: mocks.getEffectiveManagerSmsEntitlement,
  reconcileManagerSmsEntitlement: mocks.reconcileManagerSmsEntitlement,
}));
// The route buys through the per-workspace path (`work-numbers.server`); the
// rest of that module (listing / assigning numbers for `buildStatus`) stays real.
vi.mock("@/lib/sms/work-numbers.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/work-numbers.server")>();
  return { ...actual, provisionNumberForWorkspace: mocks.provisionNumberForWorkspace };
});
vi.mock("@/lib/analytics/posthog", () => ({ track: mocks.track }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const MY_WS = "ws-manager";

// The route resolves the active workspace through this helper; stubbing it
// directly keeps this test focused on the entitlement gate rather than
// reproducing the workspace-resolution table shape.
vi.mock("@/lib/workspaces/active.server", () => ({
  resolveActiveWorkspaceFromRequest: vi.fn(async () => ({
    id: MY_WS,
    name: "Main",
    owned: true,
    isDefault: true,
  })),
}));

import { POST } from "@/app/api/manager/messaging-number/route";

const MANAGER = "00000000-0000-4000-8000-000000000001";

function dbFor() {
  return createMemoryDb({
    sms_runtime_config: [{ singleton: true, mode: "automatic", pilot_manager_user_ids: [] }],
    manager_sms_numbers: [],
    profiles: [{ id: MANAGER, phone: null, phone_verified_at: null, sms_forward_inbound: null }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireManagerRouteUser.mockResolvedValue({ db: dbFor(), userId: MANAGER });
  mocks.getManagerPortalNavSubscriptionTier.mockResolvedValue("pro");
  mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "plan_unreadable" });
  process.env.SMS_PROVISIONING_ENABLED = "1";
});

afterEach(() => {
  delete process.env.SMS_PROVISIONING_ENABLED;
});

describe("server: trial cannot buy a work number", () => {
  it("refuses a trial with a plain 403, not the generic try-again 503", async () => {
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({ eligible: false, reason: "trialing" });
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.toLowerCase()).toContain("trial");
    expect(body.code).toBe("trial_cannot_buy_number");
    expect(mocks.provisionNumberForWorkspace).not.toHaveBeenCalled();
  });

  it("lets a paid (non-trial) tier through to provisioning", async () => {
    mocks.reconcileManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "pro", source: "stripe" });
    mocks.provisionNumberForWorkspace.mockResolvedValue({
      ok: true,
      number: "+12065550123",
      state: "provisioning",
      alreadyProvisioned: false,
    });
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/messaging-number", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(200);
    expect(mocks.provisionNumberForWorkspace).toHaveBeenCalledWith(expect.anything(), MANAGER, { workspaceId: MY_WS });
  });
});

describe("client: the work-number card never reaches the picker on a trial", () => {
  const panelSrc = readFileSync(
    join(process.cwd(), "src/components/portal/pro-messaging-settings-panel.tsx"),
    "utf8",
  );

  it("shows a plain, single 'Start Pro' action for a trial", () => {
    expect(panelSrc).toContain("Available on Pro. Start Pro to set up a work number.");
    expect(panelSrc).toContain('"Start Pro"');
  });

  it("never renders the area-code picker while a plan message locks the number", () => {
    // Inside the Add-a-work-number sheet the picker is the ELSE branch of the
    // plan-lock ternary, so a trial's non-null planMessage renders the
    // "Start Pro" lock card in its place every time — and the submit stays
    // disabled for good measure.
    const lockIdx = panelSrc.indexOf('data-attr="messaging-work-number-plan-lock"');
    const pickerIdx = panelSrc.indexOf('id="messaging-number-area-code"');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(pickerIdx).toBeGreaterThan(lockIdx);
    const ternaryIdx = panelSrc.lastIndexOf("{planMessage ? (", lockIdx);
    expect(ternaryIdx).toBeGreaterThan(-1);
    expect(panelSrc.slice(ternaryIdx, pickerIdx)).toContain(") : (");
    expect(panelSrc).toContain("(Boolean(planMessage) && !unverifiedEntitlement) ||");
  });
});
