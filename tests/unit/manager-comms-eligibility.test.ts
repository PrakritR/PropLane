// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { managerCommsEntitlementCanBeReconciled, managerCommsEntitlementIsUnreadable, managerCommsRequestIsOfferable, managerCommsUseIsAllowed } from "@/lib/comms-billing/manager-comms-eligibility.server";
const FREE = { eligible: false, reason: "free" } as const;
const TRIALING = { eligible: false, reason: "trialing" } as const;
const UNREADABLE = { eligible: false, reason: "plan_unreadable" } as const;
afterEach(() => vi.unstubAllEnvs());

it("keeps verified Free email usable when paid credit purchases are enabled", () => {
  vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "1");
  const entitlement = { eligible: true, tier: "free", source: "free" } as const;
  expect(managerCommsRequestIsOfferable({ entitlement })).toBe(true);
  expect(managerCommsUseIsAllowed({ entitlement })).toBe(true);
});

describe("what may still be offered versus what may be used", () => {
  it("keeps offering setup on an unsettled plan, but never lets it send", () => {
    expect(managerCommsEntitlementCanBeReconciled(UNREADABLE)).toBe(true);
    expect(managerCommsRequestIsOfferable({ entitlement: UNREADABLE })).toBe(true);
    expect(managerCommsUseIsAllowed({ entitlement: UNREADABLE })).toBe(false);
  });

  it("offers an unenrolled trial only while trial onboarding is open", () => {
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "");
    expect(managerCommsEntitlementCanBeReconciled(TRIALING)).toBe(false);
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "1");
    expect(managerCommsEntitlementCanBeReconciled(TRIALING)).toBe(true);
  });

  it("settles a genuinely free plan without offering anything", () => {
    expect(managerCommsEntitlementCanBeReconciled(FREE)).toBe(false);
  });

  it("separates an unreadable plan from a settled refusal", () => {
    expect(managerCommsEntitlementIsUnreadable(UNREADABLE)).toBe(true);
    expect(managerCommsEntitlementIsUnreadable({ eligible: false, reason: "legacy_unknown" })).toBe(true);
    expect(managerCommsEntitlementIsUnreadable(FREE)).toBe(false);
    expect(managerCommsEntitlementIsUnreadable(TRIALING)).toBe(false);
  });
});
