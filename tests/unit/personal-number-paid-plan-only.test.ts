/**
 * Captain, Oct 28: "free trials don't get phone number, only paid accounts." A personalized number needs a
 * BILLABLE plan (Stripe subscription or Apple grant) or the $5 PropLane Number. A signup trial, a payment-waiver
 * (FREE100) grant and an admin comp keep the shared PropLane line. A number provisioned before 2026-10-29 is
 * grandfathered, so nothing that already exists is paused or released.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { createWorkspaceMemoryDb } from "./support/workspace-memory-db";

const mocks = vi.hoisted(() => ({
  tier: vi.fn(),
  addOn: vi.fn(),
  loadAddons: vi.fn(),
  provision: vi.fn(),
}));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: mocks.tier }));
vi.mock("@/lib/number-subscription/subscription.server", () => ({ numberServiceEntitled: mocks.addOn }));
vi.mock("@/lib/plan-addons.server", () => ({ loadManagerPlanAddonQuantities: mocks.loadAddons }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ provisionManagerNumber: mocks.provision }));

import {
  isGrandfatheredNumberRow,
  PERSONAL_NUMBER_FREE_REFUSAL,
  PERSONAL_NUMBER_GRANDFATHER_BEFORE_MS,
} from "@/lib/one-number/personal-number";
import { managerPersonalNumberEntitlement } from "@/lib/one-number/personal-number-entitlement.server";
import { provisionNumberForWorkspace } from "@/lib/sms/work-numbers.server";

const OWNER = "owner-1";
const BEFORE = "2026-10-20T10:00:00Z";
const AFTER = "2026-10-29T08:00:00Z";

const liveNumber = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  manager_user_id: OWNER,
  workspace_id: "ws-1",
  phone_number: "+12065550111",
  provision_state: "active",
  released_at: null,
  requested_at: BEFORE,
  provisioned_at: BEFORE,
  ...over,
});

const comp = { ok: true, tier: "pro", billablePlan: false };
const paid = { ok: true, tier: "pro", billablePlan: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.addOn.mockResolvedValue(false);
  mocks.loadAddons.mockResolvedValue({ ok: true, quantities: { extra_work_number: 0 } });
  mocks.provision.mockResolvedValue({ ok: true, number: "+12065550001", state: "provisioning", alreadyProvisioned: false });
});

describe("who is entitled to a personalized number", () => {
  it("a paid plan (Stripe or Apple behind it) is entitled by plan", async () => {
    mocks.tier.mockResolvedValue(paid);
    const db = createMemoryDb({ manager_sms_numbers: [] });
    expect(await managerPersonalNumberEntitlement(db as never, OWNER)).toMatchObject({ ok: true, entitled: true, via: "plan" });
  });

  it("a live signup trial is not entitled, even holding an old number", async () => {
    mocks.tier.mockResolvedValue({ ok: true, tier: "pro", liveSignupTrial: true, billablePlan: false });
    const db = createMemoryDb({ manager_sms_numbers: [liveNumber()] });
    expect(await managerPersonalNumberEntitlement(db as never, OWNER)).toMatchObject({ ok: true, entitled: false });
  });

  it("a FREE100 waiver or admin comp with no number is NOT entitled to a new one", async () => {
    mocks.tier.mockResolvedValue(comp);
    const db = createMemoryDb({ manager_sms_numbers: [] });
    expect(await managerPersonalNumberEntitlement(db as never, OWNER)).toMatchObject({ ok: true, entitled: false, tier: "pro" });
  });

  it("a waiver or comp holding a number provisioned before Oct 29 stays entitled (grandfathered)", async () => {
    mocks.tier.mockResolvedValue(comp);
    const db = createMemoryDb({ manager_sms_numbers: [liveNumber()] });
    expect(await managerPersonalNumberEntitlement(db as never, OWNER)).toMatchObject({ ok: true, entitled: true, via: "grandfathered" });
  });

  it("a number provisioned on or after the cutoff is not grandfathered", async () => {
    mocks.tier.mockResolvedValue(comp);
    const db = createMemoryDb({ manager_sms_numbers: [liveNumber({ provisioned_at: AFTER, requested_at: AFTER })] });
    expect(await managerPersonalNumberEntitlement(db as never, OWNER)).toMatchObject({ ok: true, entitled: false });
  });

  it("a released number, or the signup placeholder row with no number, is not grandfathered", async () => {
    mocks.tier.mockResolvedValue(comp);
    const released = createMemoryDb({ manager_sms_numbers: [liveNumber({ released_at: BEFORE, provision_state: "released" })] });
    expect(await managerPersonalNumberEntitlement(released as never, OWNER)).toMatchObject({ ok: true, entitled: false });
    const placeholder = createMemoryDb({ manager_sms_numbers: [liveNumber({ phone_number: null, provisioned_at: null })] });
    expect(await managerPersonalNumberEntitlement(placeholder as never, OWNER)).toMatchObject({ ok: true, entitled: false });
  });

  it("another owner's old number grandfathers nobody else", async () => {
    mocks.tier.mockResolvedValue(comp);
    const db = createMemoryDb({ manager_sms_numbers: [liveNumber({ manager_user_id: "someone-else" })] });
    expect(await managerPersonalNumberEntitlement(db as never, OWNER)).toMatchObject({ ok: true, entitled: false });
  });

  it("the $5 PropLane Number still entitles a waiver or trial account with no number", async () => {
    mocks.tier.mockResolvedValue(comp);
    mocks.addOn.mockResolvedValue(true);
    const db = createMemoryDb({ manager_sms_numbers: [] });
    expect(await managerPersonalNumberEntitlement(db as never, OWNER)).toMatchObject({ ok: true, entitled: true, via: "add_on" });
  });

  it("an unreadable plan or number table fails closed, never entitled and never a release", async () => {
    mocks.tier.mockResolvedValue({ ok: false, error: "x" });
    expect(await managerPersonalNumberEntitlement(createMemoryDb({}) as never, OWNER)).toEqual({ ok: false });
    mocks.tier.mockResolvedValue(comp);
    const broken = { from: () => ({ select: () => ({ eq: () => ({ is: async () => ({ data: null, error: { message: "boom" } }) }) }) }) };
    expect(await managerPersonalNumberEntitlement(broken as never, OWNER)).toEqual({ ok: false });
  });
});

describe("the grandfather cutoff", () => {
  it("is Oct 29 2026 midnight Pacific", () => {
    expect(PERSONAL_NUMBER_GRANDFATHER_BEFORE_MS).toBe(Date.parse("2026-10-29T07:00:00Z"));
    const row = { phone_number: "+12065550111", provision_state: "active", released_at: null };
    expect(isGrandfatheredNumberRow({ ...row, provisioned_at: "2026-10-28T23:59:59-07:00" })).toBe(true);
    expect(isGrandfatheredNumberRow({ ...row, provisioned_at: "2026-10-29T00:00:00-07:00" })).toBe(false);
    expect(isGrandfatheredNumberRow({ ...row, provisioned_at: null, requested_at: BEFORE })).toBe(true);
    expect(isGrandfatheredNumberRow({ ...row, provisioned_at: null, requested_at: null })).toBe(false);
  });
});

describe("requesting a number", () => {
  function seed(numbers: Record<string, unknown>[]) {
    return createWorkspaceMemoryDb({
      portal_workspaces: [
        { id: "ws-1", owner_user_id: OWNER, name: "One", is_default: true, created_at: "2026-02-01" },
        { id: "ws-2", owner_user_id: OWNER, name: "Two", is_default: false, created_at: "2026-02-02" },
      ],
      manager_sms_numbers: numbers,
      workspace_work_numbers: [],
    });
  }

  it("a waiver or comp account is refused with the single paid-plan message and never reaches the provider", async () => {
    mocks.tier.mockResolvedValue(comp);
    const result = await provisionNumberForWorkspace(seed([]) as never, OWNER, { workspaceId: "ws-1" });
    expect(result).toMatchObject({ ok: false, code: "not_entitled", error: PERSONAL_NUMBER_FREE_REFUSAL.error });
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("a grandfathered number does not buy another, even for a second workspace", async () => {
    mocks.tier.mockResolvedValue(comp);
    const result = await provisionNumberForWorkspace(seed([liveNumber()]) as never, OWNER, { workspaceId: "ws-2" });
    expect(result).toMatchObject({ ok: false, code: "not_entitled", error: PERSONAL_NUMBER_FREE_REFUSAL.error });
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("a paid plan still provisions", async () => {
    mocks.tier.mockResolvedValue(paid);
    const result = await provisionNumberForWorkspace(seed([]) as never, OWNER, { workspaceId: "ws-1" });
    expect(result).toMatchObject({ ok: true });
    expect(mocks.provision).toHaveBeenCalledTimes(1);
  });
});
