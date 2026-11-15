import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

const sendResidentOutboundSms = vi.fn(async (_args: { to: string; text: string; purpose?: string; dedupeKey?: string }) => ({ sent: true, outboxStatus: "queued" }));
vi.mock("@/lib/resident-outbound-sms.server", () => ({
  sendResidentOutboundSms: (args: Parameters<typeof sendResidentOutboundSms>[0]) => sendResidentOutboundSms(args),
}));
vi.mock("@/lib/sms/tour-sms-eligibility.server", () => ({
  resolveTourSmsEligibility: async (_db: unknown, input: { explicitOptIn?: boolean }) =>
    input.explicitOptIn === true
      ? { eligible: true, phoneE164: "+12065550142", conversationKey: "m:prospect:+12065550142", provenance: "tour_inquiry_opt_in" }
      : { eligible: false, reason: "tour_sms_consent_missing" },
}));
vi.mock("@/lib/marketing/public-texting.server", () => ({
  getPublicTextingConfig: async () => ({ phone: "+12065550100", smsHref: null }),
}));
vi.mock("@/lib/manager-outbound-identity.server", () => ({
  managerOutboundFromHeader: async () => "PropLane <notices@example.test>",
}));
const resendCalls: Array<{ to: string[]; subject: string; text: string }> = [];
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: async (args: { payload: { to: string[]; subject: string; text: string } }) => {
    resendCalls.push(args.payload);
    return new Response(JSON.stringify({ id: "r1" }), { status: 200 });
  },
}));

import { notifyGuestTourConfirmed } from "@/lib/guest-notices.server";
import { buildGuestTourConfirmedEmail, buildGuestTourConfirmedSms, renderHoldPlaced } from "@/lib/guest-notices";
import { roomsMissingDoorCode } from "@/lib/manager-listing-submission";

const MANAGER = "00000000-0000-4000-8000-000000000001";
function makeDb() {
  return {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        or: () => chain,
        order: () => chain,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({
          data: table === "profiles" ? { id: MANAGER, email: "manager@example.test", full_name: "Jordan Lee" } : null,
          error: null,
        }),
        insert: async () => ({ data: null, error: null }),
        upsert: async () => ({ data: null, error: null }),
      };
      return chain;
    },
  } as unknown as Parameters<typeof notifyGuestTourConfirmed>[0];
}

const window = { start: "2026-12-02T18:00:00.000Z", end: "2026-12-02T18:30:00.000Z", managerUserId: MANAGER, adminLabel: "Jordan Lee" };

describe("guest tour confirmation", () => {
  beforeEach(() => {
    sendResidentOutboundSms.mockClear();
    resendCalls.length = 0;
    process.env.RESEND_API_KEY = "re_test_key";
  });

  it("a guest tour (no account) sends the confirmation email and the text, with no resident-portal link", async () => {
    const result = await notifyGuestTourConfirmed(
      makeDb(),
      { id: "00000000-0000-4000-8000-000000000010", managerUserId: MANAGER, name: "Sam Guest", email: "sam@example.test", phone: "+12065550142", smsConsent: true, propertyId: "maple-house", propertyTitle: "Maple House" } as never,
      window,
    );
    expect(result.email.sent).toBe(true);
    expect(result.sms.sent).toBe(true);
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0]!.to).toEqual(["sam@example.test"]);
    expect(resendCalls[0]!.subject).toBe("Your tour is confirmed");
    expect(sendResidentOutboundSms).toHaveBeenCalledTimes(1);
    const sms = sendResidentOutboundSms.mock.calls[0]![0];
    expect(sms.to).toBe("+12065550142");
    expect(sms.purpose).toBe("tour_confirmed");
    for (const text of [resendCalls[0]!.text, sms.text]) {
      expect(text).not.toMatch(/\/resident|resident portal|create a free/i);
      expect(text).toContain("Maple House");
      expect(text).toContain("(206) 555-0100");
    }
  });

  it("no phone consent: the email still goes and no text is sent", async () => {
    const result = await notifyGuestTourConfirmed(
      makeDb(),
      { id: "00000000-0000-4000-8000-000000000011", managerUserId: MANAGER, name: "Sam Guest", email: "sam@example.test", phone: "+12065550142", smsConsent: false, propertyId: "maple-house", propertyTitle: "Maple House" } as never,
      window,
    );
    expect(result.email.sent).toBe(true);
    expect(sendResidentOutboundSms).not.toHaveBeenCalled();
  });
});

describe("guest copy builders", () => {
  const facts = { propertyTitle: "Maple House", propertyAddress: "12 Maple St, Seattle", startIso: window.start, endIso: window.end, propLaneLine: "(206) 555-0100", listingUrl: "https://example.test/rent/listings/maple-house" };
  it("tour email and text carry time, address and how to reschedule", () => {
    const email = buildGuestTourConfirmedEmail(facts);
    expect(email.text).toContain("12 Maple St, Seattle");
    expect(email.text).toContain("reply to this message or text us at (206) 555-0100");
    expect(buildGuestTourConfirmedSms({ ...facts, propLaneLine: null })).toContain("reply here");
  });

  it("the hold text names the amount, room and expiry, and the deposit credit", () => {
    const r = renderHoldPlaced({ amountLabel: "$100", roomLabel: "Room 3", expiresLabel: "Nov 20" });
    expect(r.smsText).toBe("$100 hold placed for Room 3, expires Nov 20; credited to your deposit if you sign by then.");
  });
});

describe("rooms missing a door code", () => {
  it("lists only rooms with a blank or absent code, in listing order, and never a code", () => {
    const list = roomsMissingDoorCode({
      rooms: [
        { id: "a", name: "Room 1", doorCode: "4471#" },
        { id: "b", name: "Room 2", doorCode: "  " },
        { id: "c", name: "", doorCode: undefined },
      ],
    });
    expect(list).toEqual([{ id: "b", label: "Room 2" }, { id: "c", label: "Room 3" }]);
    expect(JSON.stringify(list)).not.toContain("4471");
  });
});
