/**
 * Number model (Oct 18): a personalized number is for Pro and Business only. PropLane's managed
 * service has no exemption; Free stays on the PropLane line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceMemoryDb } from "./support/workspace-memory-db";

const mocks = vi.hoisted(() => ({
  getEffectiveManagerSkuTier: vi.fn(),
  loadManagerPlanAddonQuantities: vi.fn(),
  provisionManagerNumber: vi.fn(),
}));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: mocks.getEffectiveManagerSkuTier }));
vi.mock("@/lib/plan-addons.server", () => ({ loadManagerPlanAddonQuantities: mocks.loadManagerPlanAddonQuantities }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ provisionManagerNumber: mocks.provisionManagerNumber }));
const addOn = vi.hoisted(() => ({ entitled: false }));
vi.mock("@/lib/number-subscription/subscription.server", () => ({ numberServiceEntitled: vi.fn(async () => addOn.entitled) }));

import { PERSONAL_NUMBER_FREE_REFUSAL, planMayHavePersonalNumber } from "@/lib/one-number/personal-number";
import { provisionNumberForWorkspace } from "@/lib/sms/work-numbers.server";

const OWNER = "owner-1";
const WS = "ws-1";
const original = process.env.PROPLANE_SERVICE_OWNER_USER_ID;

function seed() {
  return createWorkspaceMemoryDb({
    portal_workspaces: [{ id: WS, owner_user_id: OWNER, name: "My workspace", is_default: true, created_at: "2026-02-01" }],
    manager_sms_numbers: [],
    workspace_work_numbers: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  addOn.entitled = false;
  delete process.env.PROPLANE_SERVICE_OWNER_USER_ID;
  mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "pro", billablePlan: true });
  mocks.loadManagerPlanAddonQuantities.mockResolvedValue({ ok: true, quantities: { extra_work_number: 0 } });
  mocks.provisionManagerNumber.mockResolvedValue({ ok: true, number: "+12065550001", state: "provisioning", alreadyProvisioned: false });
});
afterEach(() => {
  if (original === undefined) delete process.env.PROPLANE_SERVICE_OWNER_USER_ID;
  else process.env.PROPLANE_SERVICE_OWNER_USER_ID = original;
});

describe("the plan rule", () => {
  it("only Pro and Business may hold a personalized number", () => {
    expect(planMayHavePersonalNumber("pro")).toBe(true);
    expect(planMayHavePersonalNumber("business")).toBe(true);
    expect(planMayHavePersonalNumber("free")).toBe(false);
    expect(planMayHavePersonalNumber(null)).toBe(false);
  });

  it("the refusal is the one message the number-request error slot shows", () => {
    expect(PERSONAL_NUMBER_FREE_REFUSAL.error).toBe(
      "Your plan uses the PropLane line. A number of your own needs a paid plan or the $5 PropLane Number.",
    );
  });
});

describe("provisionNumberForWorkspace by plan", () => {
  it("refuses a Free account with a neutral reason and never reaches the provider", async () => {
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "free" });
    const result = await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS });
    expect(result).toMatchObject({ ok: false, code: "not_entitled", error: PERSONAL_NUMBER_FREE_REFUSAL.error });
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("a Free account with the standalone PropLane Number subscription may hold exactly one number", async () => {
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "free" });
    addOn.entitled = true;
    expect(await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS })).toMatchObject({ ok: true });
    expect(mocks.provisionManagerNumber).toHaveBeenCalledTimes(1);
    // A second number on the same account is over the add-on's one-number budget.
    const held = createWorkspaceMemoryDb({
      portal_workspaces: [
        { id: WS, owner_user_id: OWNER, name: "My workspace", is_default: true, created_at: "2026-02-01" },
        { id: "ws-2", owner_user_id: OWNER, name: "Second", is_default: false, created_at: "2026-02-02" },
      ],
      manager_sms_numbers: [{ id: "n-1", manager_user_id: OWNER, workspace_id: "ws-2", phone_number: "+12065550009", provision_state: "active", released_at: null }],
      workspace_work_numbers: [],
    });
    expect(await provisionNumberForWorkspace(held as never, OWNER, { workspaceId: WS })).toMatchObject({ ok: false, code: "budget_exceeded" });
  });

  it("a lapsed add-on (not entitled) is refused like Free", async () => {
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "free" });
    addOn.entitled = false;
    expect(await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS })).toMatchObject({ ok: false, code: "not_entitled" });
  });

  it("a Free account with an extra-number add-on still stays on the PropLane line", async () => {
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "free" });
    mocks.loadManagerPlanAddonQuantities.mockResolvedValue({ ok: true, quantities: { extra_work_number: 2 } });
    const result = await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS });
    expect(result).toMatchObject({ ok: false, code: "not_entitled" });
  });

  it("Pro and Business provision inside their budget", async () => {
    for (const tier of ["pro", "business"]) {
      mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier, billablePlan: true });
      expect(await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS })).toMatchObject({ ok: true });
    }
  });

  it("PropLane's own managed service has no exemption: a Free service account stays on the PropLane line", async () => {
    process.env.PROPLANE_SERVICE_OWNER_USER_ID = OWNER;
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "free" });
    const result = await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS });
    expect(result).toMatchObject({ ok: false, code: "not_entitled" });
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("an unreadable plan fails closed", async () => {
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: false, error: "x" });
    expect(await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS })).toMatchObject({ ok: false });
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });
});
