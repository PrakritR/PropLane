import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const availableList = vi.fn(async () => [{ phoneNumber: "+12065550123" }]);
  const purchase = vi.fn(async () => ({ phoneNumber: "+12065550123", sid: "PN111" }));
  const attach = vi.fn(async () => ({ sid: "PN111" }));
  return {
    availableList,
    purchase,
    attach,
    createClient: vi.fn(() => ({
      availablePhoneNumbers: () => ({ local: { list: availableList } }),
      incomingPhoneNumbers: Object.assign(() => ({ remove: vi.fn() }), { create: purchase }),
      messaging: { v1: { services: () => ({ phoneNumbers: { create: attach } }) } },
    })),
  };
});

vi.mock("@/lib/twilio-client.server", () => ({
  createTwilioRestClient: mocks.createClient,
}));

import { buyAndEnrollRelayNumber } from "@/lib/sms-relay.server";

describe("relay-number Twilio credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG111");
  });

  it("uses the restricted REST-client boundary for purchase and attachment", async () => {
    const db = {
      from: (table: string) => ({
        insert: vi.fn(async () => ({ error: table === "sms_relay_numbers" ? null : { message: "unexpected" } })),
      }),
    };

    await expect(buyAndEnrollRelayNumber(db as never)).resolves.toEqual({
      ok: true,
      phone: "+12065550123",
    });
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(mocks.purchase).toHaveBeenCalledWith({
      phoneNumber: "+12065550123",
      friendlyName: "proplane-relay-pool",
    });
    expect(mocks.attach).toHaveBeenCalledWith({ phoneNumberSid: "PN111" });
  });
});
