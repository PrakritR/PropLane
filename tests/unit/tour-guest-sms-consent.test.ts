import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Send-time gate for the tours-contact SMS opt-in (A2P 10DLC / CTIA).
 *
 * A prospect who did NOT check the consent box on the tours-contact form must
 * never receive an outbound tour text — even though the phone is on the inquiry
 * and the opt-out ledger fails open. The load-bearing gate is the positive
 * `smsConsent` flag persisted with the inquiry, read by textTourGuest.
 */

const sendResidentOutboundSms = vi.fn(async () => ({ sent: true }));
vi.mock("@/lib/resident-outbound-sms.server", () => ({
  sendResidentOutboundSms: (...args: unknown[]) => sendResidentOutboundSms(...(args as [])),
}));

const sendPropLaneSms = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendPropLaneSms: (...args: unknown[]) => sendPropLaneSms(...(args as [])),
}));
vi.mock("@/lib/sms-consent", () => ({
  recordScopedSmsConsent: vi.fn(async () => ({ ok: true })),
}));

import {
  notifyTenantTourConfirmed,
  notifyTenantTourRequestReceived,
} from "@/lib/tour-notification-delivery.server";

function makeDb() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    or: () => chain,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    upsert: async () => ({ data: null, error: null }),
  };
  return { from: () => chain } as unknown as Parameters<typeof notifyTenantTourRequestReceived>[0];
}

const req = new Request("http://localhost:3100/api/public/partner-inquiries");

const baseInquiry = {
  id: "00000000-0000-4000-8000-000000000010",
  managerUserId: "00000000-0000-4000-8000-000000000001",
  name: "Jordan Guest",
  email: "guest@example.com",
  phone: "+12065550100",
  propertyId: "maple-house",
  propertyTitle: "Maple House",
  proposedStart: "2026-07-22T18:00:00.000Z",
  proposedEnd: "2026-07-22T18:30:00.000Z",
};

const confirmWindow = {
  start: "2026-07-22T18:00:00.000Z",
  end: "2026-07-22T18:30:00.000Z",
  managerUserId: "00000000-0000-4000-8000-000000000001",
  adminLabel: "Jordan Lee",
};

describe("tour guest SMS consent gate", () => {
  beforeEach(() => {
    sendResidentOutboundSms.mockClear();
  });

  describe("notifyTenantTourRequestReceived", () => {
    it("texts the prospect when smsConsent is true", async () => {
      const res = await notifyTenantTourRequestReceived(makeDb(), req, {
        ...baseInquiry,
        smsConsent: true,
      });
      expect(res.ok).toBe(true);
      expect(sendResidentOutboundSms).toHaveBeenCalledTimes(1);
      const { to, text } = sendResidentOutboundSms.mock.calls[0]![0] as { to: string; text: string };
      expect(to).toBe("+12065550100");
      expect(text).toContain("STOP to opt out");
    });

    it("never emits the legacy Axis host in a tour link", async () => {
      const previousCanonical = process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
      const previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;
      process.env.NEXT_PUBLIC_CANONICAL_APP_URL = "https://axis-seattle-housing.com";
      process.env.NEXT_PUBLIC_APP_URL = "https://www.axis-seattle-housing.com";
      try {
        await notifyTenantTourRequestReceived(
          makeDb(),
          new Request("https://axis-seattle-housing.com/api/public/partner-inquiries"),
          { ...baseInquiry, smsConsent: true },
        );
        const { text } = sendResidentOutboundSms.mock.calls[0]![0] as { text: string };
        expect(text).toContain("https://prop-lane.space/rent/listings/maple-house");
        expect(text).not.toContain("axis-seattle-housing.com");
      } finally {
        if (previousCanonical === undefined) delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
        else process.env.NEXT_PUBLIC_CANONICAL_APP_URL = previousCanonical;
        if (previousAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
        else process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
      }
    });

    it("does NOT text the prospect when smsConsent is false", async () => {
      const res = await notifyTenantTourRequestReceived(makeDb(), req, {
        ...baseInquiry,
        smsConsent: false,
      });
      expect(res.ok).toBe(true);
      expect(sendResidentOutboundSms).not.toHaveBeenCalled();
    });

    it("does NOT text the prospect when smsConsent is absent (legacy / unchecked)", async () => {
      const res = await notifyTenantTourRequestReceived(makeDb(), req, baseInquiry);
      expect(res.ok).toBe(true);
      expect(sendResidentOutboundSms).not.toHaveBeenCalled();
    });

    it("does NOT text a truthy-but-non-boolean consent value", async () => {
      const res = await notifyTenantTourRequestReceived(makeDb(), req, {
        ...baseInquiry,
        smsConsent: "yes" as unknown as boolean,
      });
      expect(res.ok).toBe(true);
      expect(sendResidentOutboundSms).not.toHaveBeenCalled();
    });
  });

  describe("notifyTenantTourConfirmed", () => {
    it("texts the prospect when smsConsent is true", async () => {
      const res = await notifyTenantTourConfirmed(
        makeDb(),
        req,
        { ...baseInquiry, smsConsent: true },
        confirmWindow,
      );
      expect(res.ok).toBe(true);
      expect(sendResidentOutboundSms).toHaveBeenCalledTimes(1);
    });

    it("does NOT text the prospect when smsConsent is false", async () => {
      const res = await notifyTenantTourConfirmed(
        makeDb(),
        req,
        { ...baseInquiry, smsConsent: false },
        confirmWindow,
      );
      expect(res.ok).toBe(true);
      expect(sendResidentOutboundSms).not.toHaveBeenCalled();
    });
  });
});
