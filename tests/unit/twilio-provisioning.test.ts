import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const available = vi.fn();
  const purchase = vi.fn();
  const attach = vi.fn();
  const remove = vi.fn();
  const createClient = vi.fn(() => ({
    availablePhoneNumbers: () => ({ local: { list: available } }),
    incomingPhoneNumbers: Object.assign(() => ({ remove }), {
      create: purchase,
    }),
    messaging: {
      v1: { services: () => ({ phoneNumbers: { create: attach } }) },
    },
  }));
  return { available, purchase, attach, remove, createClient };
});

vi.mock("@/lib/twilio-client.server", () => ({
  createTwilioRestClient: mocks.createClient,
  twilioErrorFields: (error: unknown) => {
    const value = error as Record<string, unknown>;
    return {
      status: value.status,
      code: value.code == null ? undefined : String(value.code),
      message: value.message,
      moreInfo: value.moreInfo,
    };
  },
}));

import { purchaseManagerTwilioNumber } from "@/lib/twilio-provisioning";

describe("purchaseManagerTwilioNumber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG111");
    mocks.available.mockResolvedValue([{ phoneNumber: "+12065550123" }]);
    mocks.purchase.mockResolvedValue({
      phoneNumber: "+12065550123",
      sid: "PN111",
    });
    mocks.remove.mockResolvedValue(true);
  });

  it("preserves Twilio attachment diagnostics and confirms cleanup", async () => {
    mocks.attach.mockRejectedValue(
      Object.assign(new Error("Permission denied"), {
        code: 20403,
        status: 403,
        moreInfo: "https://www.twilio.com/docs/errors/20403",
      }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await purchaseManagerTwilioNumber({ requestId: "req-1" });

    expect(result).toEqual({
      ok: false,
      cleanupConfirmed: true,
      purchasedNumber: { number: "+12065550123", sid: "PN111" },
      error:
        "Twilio Messaging Service sender-pool attachment failed (code 20403, HTTP 403). The purchased number was released.",
    });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "Twilio Messaging Service sender-pool attachment failed",
      expect.objectContaining({
        phoneNumberSid: "PN111",
        messagingServiceSid: "MG111",
        code: "20403",
        status: 403,
      }),
    );
    expect(JSON.stringify(result)).not.toContain("Permission denied");
    expect(JSON.stringify(result)).not.toContain("twilio.com/docs");
  });

  it("does not tell callers to retry when provider cleanup cannot be confirmed", async () => {
    mocks.attach.mockRejectedValue(
      Object.assign(new Error("Permission denied"), {
        code: 20403,
        status: 403,
      }),
    );
    mocks.remove.mockResolvedValue(false);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await purchaseManagerTwilioNumber();

    expect(result).toMatchObject({ ok: false, cleanupConfirmed: false });
    if (result.ok) throw new Error("Expected attachment failure");
    expect(result.error).toContain("code 20403, HTTP 403");
    expect(result.error).toContain("do not retry until PropLane reviews it");
  });
  it("reports unconfirmed cleanup when attachment configuration is missing", async () => {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "");
    mocks.remove.mockResolvedValue(false);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await purchaseManagerTwilioNumber();

    expect(result).toMatchObject({
      ok: false,
      cleanupConfirmed: false,
      purchasedNumber: { number: "+12065550123", sid: "PN111" },
    });
    if (result.ok) throw new Error("Expected configuration failure");
    expect(result.error).toContain("do not retry until PropLane reviews it");
  });

  it("quarantines an ambiguous purchase response instead of permitting a duplicate", async () => {
    mocks.purchase.mockRejectedValue(
      Object.assign(new Error("socket timed out after request write"), {
        code: "ETIMEDOUT",
      }),
    );

    const result = await purchaseManagerTwilioNumber({
      requestId: "req-timeout",
    });

    expect(result).toEqual({
      ok: false,
      cleanupConfirmed: false,
      error:
        "Twilio work-number purchase failed (code ETIMEDOUT). Provider ownership is unconfirmed; do not retry until PropLane reviews it.",
    });
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("socket timed out");
  });

  it("leaves a definitive 4xx rejection retryable instead of quarantining it", async () => {
    mocks.purchase.mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), {
        code: 20429,
        status: 429,
      }),
    );

    const result = await purchaseManagerTwilioNumber({ requestId: "req-429" });

    expect(result).toEqual({
      ok: false,
      error: "Twilio work-number provisioning failed (code 20429, HTTP 429).",
    });
    expect(result).not.toHaveProperty("cleanupConfirmed");
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("do not retry");
  });
});
