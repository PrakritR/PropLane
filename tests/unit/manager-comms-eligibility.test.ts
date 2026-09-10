// @vitest-environment node
/**
 * One gate, two channels.
 *
 * The work number and the work email had drifted into contradicting each other:
 * the number honoured pay-as-you-go (a card qualifies a manager on any plan,
 * Free included) and an enrolled trial; the email ignored pay-as-you-go and
 * demoted every trial. These pin the shared decision so they cannot drift again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  evaluateManagerCommsBillingGate: vi.fn(),
}));

vi.mock("@/lib/comms-billing/eligibility.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/comms-billing/eligibility.server")>();
  return { ...actual, evaluateManagerCommsBillingGate: mocks.evaluateManagerCommsBillingGate };
});

import { commsBillingBlockMessage } from "@/lib/comms-billing/eligibility.server";
import {
  decideManagerCommsRequest,
  loadManagerCommsPaygGate,
  managerCommsEntitlementCanBeReconciled,
  managerCommsEntitlementIsUnreadable,
  managerCommsRequestIsOfferable,
  managerCommsUseIsAllowed,
} from "@/lib/comms-billing/manager-comms-eligibility.server";

const DB = {} as never;
const PAID = { eligible: true, tier: "pro", source: "stripe" } as const;
const TRIAL = { eligible: true, tier: "pro", source: "stripe", trial: true } as const;
const FREE = { eligible: false, reason: "free" } as const;
const TRIALING = { eligible: false, reason: "trialing" } as const;
const UNREADABLE = { eligible: false, reason: "plan_unreadable" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.evaluateManagerCommsBillingGate.mockResolvedValue({ allowed: true, billingOwnerId: "m1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("pay-as-you-go is the authority when it is on", () => {
  it("qualifies a FREE manager who has a card, on either channel", async () => {
    vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "1");
    expect(await decideManagerCommsRequest(DB, "m1", FREE)).toEqual({ allowed: true });
    const gate = await loadManagerCommsPaygGate(DB, "m1");
    expect(managerCommsRequestIsOfferable({ entitlement: FREE, paygGate: gate })).toBe(true);
    expect(managerCommsUseIsAllowed({ entitlement: FREE, paygGate: gate })).toBe(true);
  });

  it("refuses a PAID manager with no card, and says why", async () => {
    vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "1");
    mocks.evaluateManagerCommsBillingGate.mockResolvedValue({
      allowed: false,
      reason: "no_payment_method",
    });
    const decision = await decideManagerCommsRequest(DB, "m1", PAID);
    expect(decision).toEqual({ allowed: false, kind: "payg", reason: "no_payment_method" });

    // Same refusal, worded for whichever channel was asked for.
    expect(commsBillingBlockMessage("no_payment_method", "work_number")).toContain("work number");
    expect(commsBillingBlockMessage("no_payment_method", "work_email")).toContain("work email");
    // Default stays the number so every pre-existing caller keeps its copy.
    expect(commsBillingBlockMessage("no_payment_method")).toBe(
      commsBillingBlockMessage("no_payment_method", "work_number"),
    );
  });
});

describe("plan entitlement stands in when pay-as-you-go is off", () => {
  it("never consults the billing gate", async () => {
    vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "");
    await decideManagerCommsRequest(DB, "m1", PAID);
    expect(mocks.evaluateManagerCommsBillingGate).not.toHaveBeenCalled();
    expect(await loadManagerCommsPaygGate(DB, "m1")).toBeNull();
  });

  it("allows an eligible plan and refuses an ineligible one", async () => {
    vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "");
    expect(await decideManagerCommsRequest(DB, "m1", PAID)).toEqual({ allowed: true });
    expect(await decideManagerCommsRequest(DB, "m1", FREE)).toEqual({
      allowed: false,
      kind: "entitlement",
      entitlement: FREE,
    });
  });

  it("treats an enrolled trial as eligible — a trial is not a refusal", async () => {
    vi.stubEnv("COMMS_PAYG_BILLING_ENABLED", "");
    expect(await decideManagerCommsRequest(DB, "m1", TRIAL)).toEqual({ allowed: true });
  });
});

describe("what may still be offered versus what may be used", () => {
  it("keeps offering setup on an unsettled plan, but never lets it send", () => {
    expect(managerCommsEntitlementCanBeReconciled(UNREADABLE)).toBe(true);
    expect(managerCommsRequestIsOfferable({ entitlement: UNREADABLE, paygGate: null })).toBe(true);
    expect(managerCommsUseIsAllowed({ entitlement: UNREADABLE, paygGate: null })).toBe(false);
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
