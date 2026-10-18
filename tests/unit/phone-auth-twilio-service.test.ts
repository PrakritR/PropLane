import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/twilio-client.server", () => ({
  createTwilioRestClient: () => ({ messages: { create: mocks.create } }),
}));
vi.mock("@/lib/sms/sms-test-transport.server", () => ({ captureSmsTestDelivery: () => false }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: async () => ({ captured: false }),
}));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));

import { sendSms } from "@/lib/twilio";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MGlegacy");
  mocks.create.mockResolvedValue({ sid: "SMtest" });
});
afterEach(() => vi.unstubAllEnvs());

describe("phone auth Twilio messaging service", () => {
  it.each([
    [undefined, "MGlegacy"],
    ["MGshared", "MGshared"],
    [null, undefined],
  ])("selects the trusted service override %s while retaining legacy default", async (override, expected) => {
    const result = await sendSms("+12065550142", "Verification code: 123456", "+12065550100", {
      purpose: "phone_verification", skipOptOutCheck: true, messagingServiceSid: override,
    });
    expect(result.sent).toBe(true);
    expect(mocks.create.mock.calls[0][0].messagingServiceSid).toBe(expected);
    expect(mocks.create.mock.calls[0][0].from).toBe("+12065550100");
  });
});
