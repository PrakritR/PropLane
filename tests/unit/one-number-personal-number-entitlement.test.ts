import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tier: vi.fn(),
  addOn: vi.fn(),
}));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: mocks.tier }));
vi.mock("@/lib/number-subscription/subscription.server", () => ({ numberServiceEntitled: mocks.addOn }));

import { managerPersonalNumberEntitlement } from "@/lib/one-number/personal-number-entitlement.server";

const db = {} as never;

beforeEach(() => {
  mocks.tier.mockReset();
  mocks.addOn.mockReset();
  mocks.addOn.mockResolvedValue(false);
});

describe("managerPersonalNumberEntitlement", () => {
  it("Pro and Business include a personalized number", async () => {
    for (const tier of ["pro", "business"]) {
      mocks.tier.mockResolvedValue({ ok: true, tier });
      expect(await managerPersonalNumberEntitlement(db, "u1")).toMatchObject({ ok: true, entitled: true, via: "plan" });
    }
    expect(mocks.addOn).not.toHaveBeenCalled();
  });

  it("Free is not entitled with no subscription", async () => {
    mocks.tier.mockResolvedValue({ ok: true, tier: "free" });
    expect(await managerPersonalNumberEntitlement(db, "u1")).toEqual({ ok: true, entitled: false, tier: "free" });
  });

  it("Free with an active or past_due PropLane Number subscription is entitled through the add-on", async () => {
    mocks.tier.mockResolvedValue({ ok: true, tier: "free" });
    mocks.addOn.mockResolvedValue(true);
    expect(await managerPersonalNumberEntitlement(db, "u1")).toMatchObject({ ok: true, entitled: true, via: "add_on" });
  });

  it("a live signup trial is not paid; only an add-on counts", async () => {
    mocks.tier.mockResolvedValue({ ok: true, tier: "pro", liveSignupTrial: true });
    expect(await managerPersonalNumberEntitlement(db, "u1")).toMatchObject({ ok: true, entitled: false });
    mocks.addOn.mockResolvedValue(true);
    expect(await managerPersonalNumberEntitlement(db, "u1")).toMatchObject({ ok: true, entitled: true, via: "add_on" });
  });

  it("an unreadable plan or subscription fails closed", async () => {
    mocks.tier.mockResolvedValue({ ok: false, error: "x" });
    expect(await managerPersonalNumberEntitlement(db, "u1")).toEqual({ ok: false });
    mocks.tier.mockResolvedValue({ ok: true, tier: "free" });
    mocks.addOn.mockRejectedValue(new Error("boom"));
    expect(await managerPersonalNumberEntitlement(db, "u1")).toEqual({ ok: false });
    mocks.tier.mockRejectedValue(new Error("boom"));
    expect(await managerPersonalNumberEntitlement(db, "u1")).toEqual({ ok: false });
  });

  it("no user is never entitled", async () => {
    expect(await managerPersonalNumberEntitlement(db, " ")).toEqual({ ok: true, entitled: false, tier: null });
  });
});
