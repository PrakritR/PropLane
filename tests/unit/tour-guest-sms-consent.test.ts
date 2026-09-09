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
const recordTourRescheduleSmsProposal = vi.fn(async () => true);
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
vi.mock("@/lib/tour-reschedule-sms-reply.server", () => ({
  recordTourRescheduleSmsProposal: (...args: unknown[]) => recordTourRescheduleSmsProposal(...(args as [])),
}));

import {
  notifyTenantTourConfirmed,
  notifyTenantTourRequestReceived,
  notifyTenantTourRescheduled,
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
    sendResidentOutboundSms.mockResolvedValue({ sent: true });
    recordTourRescheduleSmsProposal.mockClear();
    recordTourRescheduleSmsProposal.mockResolvedValue(true);
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
        undefined,
        undefined,
        { viaEmail: false, viaSms: true },
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
        undefined,
        undefined,
        { viaEmail: false },
      );
      expect(res.ok).toBe(false);
      expect(sendResidentOutboundSms).not.toHaveBeenCalled();
    });

    it("honors the selected channels and reports the SMS outcome", async () => {
      const res = await notifyTenantTourConfirmed(
        makeDb(),
        req,
        { ...baseInquiry, smsConsent: true },
        confirmWindow,
        undefined,
        undefined,
        { viaEmail: false, viaSms: true },
      );
      expect(res).toMatchObject({
        ok: true,
        email: { requested: false, sent: false },
        sms: { requested: true, sent: true },
      });
    });

    it("does not attempt SMS when the manager did not select it", async () => {
      const res = await notifyTenantTourConfirmed(
        makeDb(), req, { ...baseInquiry, smsConsent: true }, confirmWindow,
        undefined, undefined, { viaEmail: false, viaSms: false },
      );
      expect(res.sms).toMatchObject({ requested: false, sent: false, skipped: true });
      expect(sendResidentOutboundSms).not.toHaveBeenCalled();
    });

    it("reports a selected SMS provider failure instead of claiming success", async () => {
      sendResidentOutboundSms.mockResolvedValueOnce({ sent: false, error: "provider_rejected" });
      const res = await notifyTenantTourConfirmed(
        makeDb(), req, { ...baseInquiry, smsConsent: true }, confirmWindow,
        undefined, undefined, { viaEmail: false, viaSms: true },
      );
      expect(res).toMatchObject({
        ok: false,
        error: "provider_rejected",
        sms: { requested: true, sent: false, skipped: false, error: "provider_rejected" },
      });
    });

    it("keeps a durable queued outcome distinct from sent", async () => {
      sendResidentOutboundSms.mockResolvedValueOnce({ sent: false, accepted: true });
      const res = await notifyTenantTourConfirmed(
        makeDb(), req, { ...baseInquiry, smsConsent: true }, confirmWindow,
        undefined, undefined, { viaEmail: false, viaSms: true },
      );
      expect(res).toMatchObject({ ok: true, sms: { requested: true, sent: false, accepted: true } });
    });
  });

  it("asks a rescheduled prospect to confirm by replying YES or propose another time", async () => {
    const res = await notifyTenantTourRescheduled(
      makeDb(),
      req,
      { ...baseInquiry, smsConsent: true },
      {
        window: confirmWindow,
        previousWindow: {
          start: "2026-07-21T18:00:00.000Z",
          end: "2026-07-21T18:30:00.000Z",
        },
        channels: { viaEmail: false, viaSms: true },
      },
    );
    expect(res.sms.sent).toBe(true);
    const { text, dedupeKey } = sendResidentOutboundSms.mock.calls[0]![0] as { text: string; dedupeKey: string };
    expect(text).toContain("Reply YES to confirm");
    expect(text).toContain("reply with another time that works");
    expect(dedupeKey).toContain(confirmWindow.start);
    expect(recordTourRescheduleSmsProposal).toHaveBeenCalledTimes(1);
  });

  it("attempts SMS independently when selected email has no recipient", async () => {
    const result = await notifyTenantTourRescheduled(makeDb(), req, {
      ...baseInquiry, email: "", smsConsent: true,
    }, {
      window: confirmWindow,
      previousWindow: { start: "2026-07-21T18:00:00.000Z", end: "2026-07-21T18:30:00.000Z" },
      channels: { viaEmail: true, viaSms: true },
    });
    expect(sendResidentOutboundSms).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, email: { requested: true }, sms: { sent: true } });
  });

  it("does not create an actionable reply state when reschedule SMS is rejected", async () => {
    sendResidentOutboundSms.mockResolvedValueOnce({ sent: false, error: "provider_rejected" });
    await notifyTenantTourRescheduled(makeDb(), req, { ...baseInquiry, smsConsent: true }, {
      window: confirmWindow,
      previousWindow: { start: "2026-07-21T18:00:00.000Z", end: "2026-07-21T18:30:00.000Z" },
      channels: { viaEmail: false, viaSms: true },
    });
    expect(recordTourRescheduleSmsProposal).not.toHaveBeenCalled();
  });

  it("reports accepted SMS as incomplete when its reply state cannot be saved", async () => {
    sendResidentOutboundSms.mockResolvedValueOnce({ sent: false, accepted: true });
    recordTourRescheduleSmsProposal.mockResolvedValueOnce(false);
    const result = await notifyTenantTourRescheduled(makeDb(), req, { ...baseInquiry, smsConsent: true }, {
      window: confirmWindow,
      previousWindow: { start: "2026-07-21T18:00:00.000Z", end: "2026-07-21T18:30:00.000Z" },
      channels: { viaEmail: false, viaSms: true },
    });
    expect(result).toMatchObject({
      ok: false,
      sms: { accepted: true, error: "SMS was accepted, but its tour confirmation state was not saved." },
    });
  });

  it("uses a new dedupe key when the proposed reschedule window changes", async () => {
    const inquiry = { ...baseInquiry, smsConsent: true };
    await notifyTenantTourRescheduled(makeDb(), req, inquiry, {
      window: confirmWindow,
      previousWindow: { start: "2026-07-21T18:00:00.000Z", end: "2026-07-21T18:30:00.000Z" },
      channels: { viaEmail: false, viaSms: true },
    });
    await notifyTenantTourRescheduled(makeDb(), req, inquiry, {
      window: { ...confirmWindow, start: "2026-07-23T18:00:00.000Z", end: "2026-07-23T18:30:00.000Z" },
      previousWindow: confirmWindow,
      channels: { viaEmail: false, viaSms: true },
    });
    const keys = sendResidentOutboundSms.mock.calls.map((call) => (call[0] as { dedupeKey: string }).dedupeKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("does not suppress a later A → B → A reschedule cycle", async () => {
    const inquiry = { ...baseInquiry, smsConsent: true };
    const priorA = { start: "2026-07-21T18:00:00.000Z", end: "2026-07-21T18:30:00.000Z" };
    const windowB = { ...confirmWindow, start: "2026-07-23T18:00:00.000Z", end: "2026-07-23T18:30:00.000Z" };
    await notifyTenantTourRescheduled(makeDb(), req, inquiry, {
      window: confirmWindow, previousWindow: priorA, rescheduleGeneration: "generation-1", channels: { viaEmail: false, viaSms: true },
    });
    await notifyTenantTourRescheduled(makeDb(), req, inquiry, {
      window: windowB, previousWindow: confirmWindow, rescheduleGeneration: "generation-2", channels: { viaEmail: false, viaSms: true },
    });
    await notifyTenantTourRescheduled(makeDb(), req, inquiry, {
      window: confirmWindow, previousWindow: windowB, rescheduleGeneration: "generation-3", channels: { viaEmail: false, viaSms: true },
    });
    await notifyTenantTourRescheduled(makeDb(), req, inquiry, {
      window: windowB, previousWindow: confirmWindow, rescheduleGeneration: "generation-4", channels: { viaEmail: false, viaSms: true },
    });
    const keys = sendResidentOutboundSms.mock.calls.map((call) => (call[0] as { dedupeKey: string }).dedupeKey);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
  });
});
