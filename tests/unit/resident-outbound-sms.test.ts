import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const sendTwilio = vi.fn();
const sendClaw = vi.fn();
const registerRoute = vi.fn();
const optedOut = vi.fn();

vi.mock("@/lib/claw-messenger.server", () => ({
  isClawMessengerConfigured: () =>
    process.env.CLAW_MESSENGER_ENABLED === "1" && Boolean(process.env.CLAW_MESSENGER_API_KEY?.trim()),
  normalizeE164Us: (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  },
  registerClawMessengerRoute: (...args: unknown[]) => registerRoute(...args),
  sendClawMessengerText: (...args: unknown[]) => sendClaw(...args),
}));

vi.mock("@/lib/twilio", () => ({
  normalizeE164: (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  },
  sendSms: (...args: unknown[]) => sendTwilio(...args),
}));

vi.mock("@/lib/sms-consent", () => ({
  isPhoneOptedOut: (...args: unknown[]) => optedOut(...args),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));

describe("sendResidentOutboundSms", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Noon Pacific: transport assertions must not depend on the wall clock or
    // accidentally exercise the automated quiet-hours policy.
    vi.setSystemTime(new Date("2026-08-25T19:00:00.000Z"));
    sendClaw.mockReset();
    registerRoute.mockReset();
    sendTwilio.mockReset();
    optedOut.mockResolvedValue(false);
    delete process.env.CLAW_MESSENGER_API_KEY;
    delete process.env.CLAW_MESSENGER_ENABLED;
    vi.stubEnv("SMS_RUNTIME_ENABLED", "0");
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAW_MESSENGER_API_KEY;
    delete process.env.CLAW_MESSENGER_ENABLED;
    vi.unstubAllEnvs();
  });

  it("does not let a caller-provided From number bypass the managed Twilio dispatcher", async () => {
    vi.stubEnv("SMS_RUNTIME_ENABLED", "1");
    sendTwilio.mockResolvedValue({ sent: true, sid: "SM1" });
    const { sendResidentOutboundSms } = await import("@/lib/resident-outbound-sms.server");
    const result = await sendResidentOutboundSms({
      to: "5103098345",
      text: "Lease ready to sign",
      fromNumber: "+14258909021",
    });
    expect(result).toEqual({
      sent: false,
      channel: undefined,
      error: "managed_sender_scope_required",
      sid: undefined,
    });
    expect(sendTwilio).not.toHaveBeenCalled();
    expect(sendClaw).not.toHaveBeenCalled();
  });

  it("prefers Claw when enabled even if a Twilio from is provided", async () => {
    process.env.CLAW_MESSENGER_API_KEY = "cm_test";
    process.env.CLAW_MESSENGER_ENABLED = "1";
    sendTwilio.mockResolvedValue({ sent: true, sid: "SM2" });
    sendClaw.mockResolvedValue({ ok: true, messageId: "m1" });
    const { sendResidentOutboundSms } = await import("@/lib/resident-outbound-sms.server");
    const result = await sendResidentOutboundSms({
      to: "+15103098345",
      text: "Payment reminder: rent is due.",
      fromNumber: "+14258909021",
    });
    expect(result).toEqual({ sent: true, channel: "claw", sid: "m1", error: undefined });
    expect(sendClaw).toHaveBeenCalled();
    expect(sendTwilio).not.toHaveBeenCalled();
  });

  it("sends via Claw when enabled and no from number is provided", async () => {
    process.env.CLAW_MESSENGER_API_KEY = "cm_test";
    process.env.CLAW_MESSENGER_ENABLED = "1";
    sendClaw.mockResolvedValue({ ok: true, messageId: "m1" });
    const { sendResidentOutboundSms } = await import("@/lib/resident-outbound-sms.server");
    const result = await sendResidentOutboundSms({
      to: "+15103098345",
      text: "Payment reminder: rent is due.",
    });
    expect(result.sent).toBe(true);
    expect(result.channel).toBe("claw");
    expect(sendClaw).toHaveBeenCalled();
  });
});
