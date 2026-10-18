import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendSms: vi.fn(), config: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/twilio", () => ({ sendSms: mocks.sendSms }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: mocks.config }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.service }));

import { sendPhoneAuthCode } from "@/lib/auth/phone-otp-delivery.server";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_DEFAULT_FROM", "+12065550100");
  mocks.service.mockReturnValue({});
  mocks.config.mockResolvedValue({ mode: "per_workspace", sharedNumber: null });
  mocks.sendSms.mockResolvedValue({ sent: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("phone auth transport", () => {
  it("uses the platform verification path, never a workspace sender", async () => {
    expect(await sendPhoneAuthCode("2065550142", "123456", "actor")).toBe(true);
    expect(mocks.sendSms).toHaveBeenCalledExactlyOnceWith(
      "+12065550142", "Your PropLane code is 123456. It expires in 10 minutes. Do not share this code.", "+12065550100",
      { purpose: "phone_verification", skipOptOutCheck: true, actorUserId: "actor" },
    );
  });

  it("uses the configured shared sender only in shared mode", async () => {
    mocks.config.mockResolvedValue({ mode: "shared", sharedNumber: "+12065550199", messagingServiceSid: "MGshared" });
    expect(await sendPhoneAuthCode("+12065550142", "123456")).toBe(true);
    expect(mocks.sendSms.mock.calls[0][2]).toBe("+12065550199");
    expect(mocks.sendSms.mock.calls[0][3]).toMatchObject({ messagingServiceSid: "MGshared" });
  });

  it("shadow mode preserves the existing platform sender", async () => {
    mocks.config.mockResolvedValue({ mode: "shadow", sharedNumber: "+12065550199" });
    expect(await sendPhoneAuthCode("+12065550142", "123456")).toBe(true);
    expect(mocks.sendSms.mock.calls[0][2]).toBe("+12065550100");
  });

  it.each([["bad", "123456"], ["+12065550142", "12345"], ["+12065550142", "1234567"]])(
    "rejects an invalid destination or code before reading config",
    async (phone, code) => {
      expect(await sendPhoneAuthCode(phone, code)).toBe(false);
      expect(mocks.service).not.toHaveBeenCalled();
      expect(mocks.sendSms).not.toHaveBeenCalled();
    },
  );

  it("does not silently fall back when shared config has no sender", async () => {
    mocks.config.mockResolvedValue({ mode: "shared", sharedNumber: null });
    expect(await sendPhoneAuthCode("+12065550142", "123456")).toBe(false);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("fails closed without a platform sender", async () => {
    vi.stubEnv("TWILIO_DEFAULT_FROM", "");
    expect(await sendPhoneAuthCode("+12065550142", "123456")).toBe(false);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("returns false for a provider refusal or unexpected transport exception", async () => {
    mocks.sendSms.mockResolvedValueOnce({ sent: false }).mockRejectedValueOnce(new Error("provider"));
    expect(await sendPhoneAuthCode("+12065550142", "123456")).toBe(false);
    expect(await sendPhoneAuthCode("+12065550142", "123456")).toBe(false);
  });
});
