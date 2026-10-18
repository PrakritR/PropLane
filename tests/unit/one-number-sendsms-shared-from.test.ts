import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  shared: "+12065550100" as string | null,
  numbers: [] as Array<{ phone_number: string; manager_user_id: string }>,
  hold: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: () => ({ messages: { create: mocks.create } }) }));
vi.mock("@/lib/sms/sms-test-transport.server", () => ({ captureSmsTestDelivery: () => false }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: async () => ({ captured: false }) }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));
vi.mock("@/lib/one-number/shared-line-number.server", () => ({
  isConfiguredSharedNumber: async (_db: unknown, phone: string) => mocks.shared !== null && phone === mocks.shared,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      let phone = "";
      const q: Record<string, unknown> = {
        select: () => q, neq: () => q,
        eq: (column: string, value: string) => { if (column === "phone_number") phone = value; return q; },
        maybeSingle: async () => table === "manager_sms_numbers"
          ? { data: mocks.numbers.find((n) => n.phone_number === phone) ?? null, error: null }
          : { data: mocks.hold, error: null },
      };
      return q;
    },
  }),
}));

import { sendSms } from "@/lib/twilio";

const hold = (manager: string) => ({ manager_user_id: manager, meter: "sms_outbound_segment", quantity: 1, credit_state: "reserved" });

describe("sendSms from numbers", () => {
  beforeEach(() => {
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MGENV";
    mocks.create.mockReset().mockResolvedValue({ sid: "SM1" });
    mocks.shared = "+12065550100";
    mocks.numbers = [{ phone_number: "+12065550999", manager_user_id: "m1" }];
    mocks.hold = hold("m1");
  });

  it("a manager work number still needs the hold to belong to that number's owner", async () => {
    await expect(sendSms("+12065550142", "hi", "+12065550999", { creditReservationKey: "k" })).resolves.toMatchObject({ sent: true });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ from: "+12065550999", messagingServiceSid: "MGENV" }));
    mocks.hold = hold("someone-else");
    await expect(sendSms("+12065550142", "hi", "+12065550999", { creditReservationKey: "k" })).resolves.toMatchObject({ sent: false, providerAttempted: false });
  });

  it("the configured shared number is a valid from, on the provided Messaging Service, with a reserved hold", async () => {
    await expect(sendSms("+12065550142", "hi", "+12065550100", { creditReservationKey: "k", messagingServiceSid: "MGSHARED" })).resolves.toMatchObject({ sent: true, sid: "SM1" });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ from: "+12065550100", messagingServiceSid: "MGSHARED" }));
  });

  it("a number that is neither a work number nor the shared number is refused", async () => {
    await expect(sendSms("+12065550142", "hi", "+12065550777", { creditReservationKey: "k" })).resolves.toMatchObject({ sent: false, providerAttempted: false });
    mocks.shared = null; // no shared number configured: the shared 'from' is not special
    await expect(sendSms("+12065550142", "hi", "+12065550100", { creditReservationKey: "k" })).resolves.toMatchObject({ sent: false, providerAttempted: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("the shared number still needs a reserved, matching credit hold", async () => {
    mocks.hold = { ...hold("m1"), credit_state: "released" };
    await expect(sendSms("+12065550142", "hi", "+12065550100", { creditReservationKey: "k" })).resolves.toMatchObject({ sent: false });
    mocks.hold = null;
    await expect(sendSms("+12065550142", "hi", "+12065550100", { creditReservationKey: "k" })).resolves.toMatchObject({ sent: false });
    await expect(sendSms("+12065550142", "hi", "+12065550100", {})).resolves.toMatchObject({ sent: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
