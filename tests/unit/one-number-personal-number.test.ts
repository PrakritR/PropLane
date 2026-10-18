/**
 * Number model (Oct 18): a personalized number is for Pro and Business; PropLane's managed service
 * (the platform service owner) is always allowed; Free stays on the PropLane line.
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

import {
  isPlatformServiceOwner,
  PERSONAL_NUMBER_FREE_REFUSAL,
  planMayHavePersonalNumber,
  platformServiceOwnerIds,
} from "@/lib/one-number/personal-number";
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
  delete process.env.PROPLANE_SERVICE_OWNER_USER_ID;
  mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "pro" });
  mocks.loadManagerPlanAddonQuantities.mockResolvedValue({ ok: true, quantities: { extra_work_number: 0 } });
  mocks.provisionManagerNumber.mockResolvedValue({ ok: true, number: "+12065550001", state: "provisioning", alreadyProvisioned: false });
});
afterEach(() => {
  if (original === undefined) delete process.env.PROPLANE_SERVICE_OWNER_USER_ID;
  else process.env.PROPLANE_SERVICE_OWNER_USER_ID = original;
});

describe("the service owner and the plan rule", () => {
  it("reads the service owner ids from the environment, comma separated", () => {
    expect(platformServiceOwnerIds({ PROPLANE_SERVICE_OWNER_USER_ID: " a , b ," })).toEqual(["a", "b"]);
    expect(platformServiceOwnerIds({})).toEqual([]);
    expect(isPlatformServiceOwner("b", { PROPLANE_SERVICE_OWNER_USER_ID: "a,b" })).toBe(true);
    expect(isPlatformServiceOwner("c", { PROPLANE_SERVICE_OWNER_USER_ID: "a,b" })).toBe(false);
    expect(isPlatformServiceOwner("", { PROPLANE_SERVICE_OWNER_USER_ID: "" })).toBe(false);
    expect(isPlatformServiceOwner(null, {})).toBe(false);
  });

  it("only Pro and Business may hold a personalized number", () => {
    expect(planMayHavePersonalNumber("pro")).toBe(true);
    expect(planMayHavePersonalNumber("business")).toBe(true);
    expect(planMayHavePersonalNumber("free")).toBe(false);
    expect(planMayHavePersonalNumber(null)).toBe(false);
  });

  it("the Free refusal is neutral: no plan names, no price", () => {
    expect(PERSONAL_NUMBER_FREE_REFUSAL.error).toBe("This workspace texts from the PropLane line.");
    expect(PERSONAL_NUMBER_FREE_REFUSAL.error).not.toMatch(/\b(pro|business|upgrade)\b|\$/i);
  });
});

describe("provisionNumberForWorkspace by plan", () => {
  it("refuses a Free account with a neutral reason and never reaches the provider", async () => {
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "free" });
    const result = await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS });
    expect(result).toMatchObject({ ok: false, code: "not_entitled", error: "This workspace texts from the PropLane line." });
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("a Free account with an extra-number add-on still stays on the PropLane line", async () => {
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "free" });
    mocks.loadManagerPlanAddonQuantities.mockResolvedValue({ ok: true, quantities: { extra_work_number: 2 } });
    const result = await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS });
    expect(result).toMatchObject({ ok: false, code: "not_entitled" });
  });

  it("Pro and Business provision inside their budget", async () => {
    for (const tier of ["pro", "business"]) {
      mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier });
      expect(await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS })).toMatchObject({ ok: true });
    }
  });

  it("the platform service owner is always allowed, on any plan, without reading the plan", async () => {
    process.env.PROPLANE_SERVICE_OWNER_USER_ID = OWNER;
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "free" });
    const result = await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS });
    expect(result).toMatchObject({ ok: true });
    expect(mocks.getEffectiveManagerSkuTier).not.toHaveBeenCalled();
    expect(mocks.provisionManagerNumber).toHaveBeenCalledWith(expect.anything(), OWNER, { workspaceId: WS });
  });

  it("an unreadable plan fails closed", async () => {
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: false, error: "x" });
    expect(await provisionNumberForWorkspace(seed() as never, OWNER, { workspaceId: WS })).toMatchObject({ ok: false });
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });
});
