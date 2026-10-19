import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendSms: vi.fn(), config: vi.fn(), service: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/twilio", () => ({ sendSms: mocks.sendSms }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: mocks.config }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.service }));

import { claimPhoneAuthHookDelivery, sendPhoneAuthCode } from "@/lib/auth/phone-otp-delivery.server";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_DEFAULT_FROM", "+12065550100");
  mocks.service.mockReturnValue({ rpc: mocks.rpc });
  mocks.config.mockResolvedValue({ mode: "per_workspace", sharedNumber: null });
  mocks.sendSms.mockResolvedValue({ sent: true });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("phone auth transport", () => {
  it("fails closed for the hook outside shared mode: no reservation lookup, no send", async () => {
    expect(await claimPhoneAuthHookDelivery("+12065550142")).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it.each(["0", "false", "yes", ""])("hook flag value %j does not enable the hook off the shared line", async (flag) => {
    vi.stubEnv("SUPABASE_PHONE_AUTH_HOOK_ENABLED", flag);
    expect(await claimPhoneAuthHookDelivery("+12065550142")).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("with the hook flag on, an off-shared-line hook still needs the atomic reservation", async () => {
    vi.stubEnv("SUPABASE_PHONE_AUTH_HOOK_ENABLED", "1");
    expect(await claimPhoneAuthHookDelivery("+12065550142")).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("phone_auth_claim_hook_delivery", { p_phone: "+12065550142" });
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect(await claimPhoneAuthHookDelivery("+12065550142")).toBe(false);
  });

  it("requires an atomic pending challenge claim for shared-mode hook delivery", async () => {
    mocks.config.mockResolvedValue({ mode: "shared", sharedNumber: "+12065550199" });
    expect(await claimPhoneAuthHookDelivery("+12065550142")).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("phone_auth_claim_hook_delivery", { p_phone: "+12065550142" });
  });

  it.each([
    { data: false, error: null },
    { data: null, error: { code: "42P01" } },
    { data: null, error: { code: "42703" } },
    { data: null, error: { code: "PGRST205" } },
  ])("fails closed when shared delivery has no reservation or schema %#", async (result) => {
    mocks.config.mockResolvedValue({ mode: "shared", sharedNumber: "+12065550199" });
    mocks.rpc.mockResolvedValue(result);
    expect(await claimPhoneAuthHookDelivery("+12065550142")).toBe(false);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

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
