import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Send-time gate for the tours-contact SMS opt-in (A2P 10DLC / CTIA).
 *
 * A tour text requires either explicit form opt-in or exact, trusted inbound
 * conversation evidence. A phone on the inquiry alone is never authorization.
 */

const sendResidentOutboundSms = vi.fn(async () => ({ sent: true }));
const recordScopedSmsConsent = vi.fn(async () => ({ ok: true }));
const eligibleResult = {
  eligible: true as const,
  phoneE164: "+12065550100",
  conversationKey: "00000000-0000-4000-8000-000000000001:prospect:+12065550100",
  provenance: "tour_inquiry_opt_in" as const,
};
const resolveTourSmsEligibility = vi.fn(async (_db: unknown, input: { explicitOptIn?: boolean }) =>
  input.explicitOptIn === true ? eligibleResult : { eligible: false as const, reason: "tour_sms_consent_missing" },
);
const recordTourRescheduleSmsProposal = vi.fn(async () => true);
vi.mock("@/lib/resident-outbound-sms.server", () => ({
  sendResidentOutboundSms: (...args: unknown[]) => sendResidentOutboundSms(...(args as [])),
}));

const sendPropLaneSms = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendPropLaneSms: (...args: unknown[]) => sendPropLaneSms(...(args as [])),
}));
vi.mock("@/lib/sms-consent", () => ({
  recordScopedSmsConsent: (...args: unknown[]) => recordScopedSmsConsent(...(args as [])),
}));
vi.mock("@/lib/sms/tour-sms-eligibility.server", () => ({
  resolveTourSmsEligibility: (...args: unknown[]) => resolveTourSmsEligibility(...(args as [])),
}));
vi.mock("@/lib/tour-reschedule-sms-reply.server", () => ({
  recordTourRescheduleSmsProposal: (...args: unknown[]) => recordTourRescheduleSmsProposal(...(args as [])),
}));

import {
  notifyTenantTourConfirmed,
  notifyTenantTourRequestReceived,
  notifyTenantTourRescheduled,
} from "@/lib/tour-notification-delivery.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  buildTourNotificationContext,
  buildTourRescheduledTenantBody,
} from "@/lib/tour-notifications";

function makeDb() {
  return { from: (table: string) => {
    let id = "";
    const chain = {
      select: () => chain,
      eq: (column: string, value: string) => { if (column === "id") id = value; return chain; },
      or: () => chain,
      order: () => chain,
      limit: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({
        data: table === "profiles" && id === confirmWindow.managerUserId
          ? { id, email: "manager@example.com", full_name: "Jordan Lee" }
          : null,
        error: null,
      }),
      insert: async () => ({ data: null, error: null }),
      upsert: async () => ({ data: null, error: null }),
    };
    return chain;
  } } as unknown as Parameters<typeof notifyTenantTourRequestReceived>[0];
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    sendResidentOutboundSms.mockClear();
    sendResidentOutboundSms.mockResolvedValue({ sent: true });
    recordScopedSmsConsent.mockClear();
    recordScopedSmsConsent.mockResolvedValue({ ok: true });
    resolveTourSmsEligibility.mockClear();
    resolveTourSmsEligibility.mockImplementation(async (_db, input) =>
      input.explicitOptIn === true ? eligibleResult : { eligible: false, reason: "tour_sms_consent_missing" });
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
      expect((sendResidentOutboundSms.mock.calls[0]![0] as { openThread: { conversationKey?: string } }).openThread.conversationKey)
        .toBe("00000000-0000-4000-8000-000000000001:prospect:+12065550100");
      expect(resolveTourSmsEligibility).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          managerUserId: baseInquiry.managerUserId,
          purpose: "tour_request_received",
          guestPhone: baseInquiry.phone,
          explicitOptIn: true,
        }),
      );
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

    it("texts a legacy false row when the exact scoped recipient-initiated grant is valid", async () => {
      resolveTourSmsEligibility.mockResolvedValueOnce({
        eligible: true,
        phoneE164: "+12065550100",
        conversationKey: "00000000-0000-4000-8000-000000000001:prospect:+12065550100",
        provenance: "recipient_initiated_inbound",
      });
      const res = await notifyTenantTourRequestReceived(makeDb(), req, {
        ...baseInquiry,
        smsConsent: false,
      });
      expect(res.ok).toBe(true);
      expect(sendResidentOutboundSms).toHaveBeenCalledTimes(1);
    });

    it("fails closed when the scoped consent ledger cannot be read", async () => {
      resolveTourSmsEligibility.mockResolvedValueOnce({ eligible: false, reason: "conversation_consent_unreadable" });
      const res = await notifyTenantTourRequestReceived(makeDb(), req, {
        ...baseInquiry,
        smsConsent: false,
      });
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

    it("reports an all-skipped selection as skipped, not sent", async () => {
      const res = await notifyTenantTourConfirmed(
        makeDb(), req, { ...baseInquiry, smsConsent: false }, confirmWindow,
        undefined, undefined, { viaEmail: false, viaSms: true },
      );
      expect(res).toMatchObject({
        ok: false,
        error: expect.any(String),
        sms: { requested: true, sent: false, skipped: true },
      });
      expect(sendResidentOutboundSms).not.toHaveBeenCalled();
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

  it("keeps the conservative client preview aligned while attaching a configured signed Reply-To", async () => {
    const prior = {
      apiKey: process.env.RESEND_API_KEY,
      domain: process.env.RESEND_REPLY_DOMAIN,
      secret: process.env.RESEND_INBOUND_WEBHOOK_SECRET,
    };
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_REPLY_DOMAIN = "reply.example.com";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = `whsec_${Buffer.from("test-secret-that-is-long-enough").toString("base64")}`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const previousWindow = { start: "2026-07-21T18:00:00.000Z", end: "2026-07-21T18:30:00.000Z" };
      const clientDefault = buildTourRescheduledTenantBody(buildTourNotificationContext({
        origin: resolveEmailLinkBaseUrl(),
        guestName: baseInquiry.name,
        guestEmail: baseInquiry.email,
        guestPhone: baseInquiry.phone,
        propertyId: baseInquiry.propertyId,
        propertyTitle: baseInquiry.propertyTitle,
        tourStartIso: confirmWindow.start,
        tourEndIso: confirmWindow.end,
        tourInquiryId: baseInquiry.id,
        replyOptions: {
          smsSelected: false,
          smsAvailable: true,
          emailSelected: true,
          emailReplyAvailable: false,
        },
      }), { startIso: previousWindow.start, endIso: previousWindow.end });
      const result = await notifyTenantTourRescheduled(makeDb(), req, {
        ...baseInquiry,
        smsConsent: false,
        smsOrigin: "non_sms",
      }, {
        window: confirmWindow,
        previousWindow,
        body: clientDefault,
        channels: { viaEmail: true, viaSms: false },
      });
      expect(result.email.sent).toBe(true);
      const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        text: string;
        reply_to?: string;
      };
      expect(payload.reply_to).toMatch(/^reply\+/);
      expect(payload.reply_to).toContain("@reply.example.com");
      expect(payload.text).toBe(clientDefault);
      expect(payload.text).toContain("Create or sign in to a PropLane account");
      expect(payload.text).not.toMatch(/reply\s+YES\s+by\s+SMS/i);
    } finally {
      if (prior.apiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prior.apiKey;
      if (prior.domain === undefined) delete process.env.RESEND_REPLY_DOMAIN;
      else process.env.RESEND_REPLY_DOMAIN = prior.domain;
      if (prior.secret === undefined) delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
      else process.env.RESEND_INBOUND_WEBHOOK_SECRET = prior.secret;
    }
  });

  it("uses configured signed email reply instructions when no client preview body is supplied", async () => {
    const prior = {
      apiKey: process.env.RESEND_API_KEY,
      domain: process.env.RESEND_REPLY_DOMAIN,
      secret: process.env.RESEND_INBOUND_WEBHOOK_SECRET,
    };
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_REPLY_DOMAIN = "reply.example.com";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = `whsec_${Buffer.from("test-secret-that-is-long-enough").toString("base64")}`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-server-default" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await notifyTenantTourRescheduled(makeDb(), req, {
        ...baseInquiry,
        smsConsent: false,
        smsOrigin: "non_sms",
      }, {
        window: confirmWindow,
        previousWindow: { start: "2026-07-21T18:00:00.000Z", end: "2026-07-21T18:30:00.000Z" },
        channels: { viaEmail: true, viaSms: false },
      });
      const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        text: string;
        reply_to?: string;
      };
      expect(payload.reply_to).toContain("@reply.example.com");
      expect(payload.text).toContain("Reply to this email to confirm");
      expect(payload.text).not.toMatch(/reply\s+YES\s+by\s+SMS/i);
    } finally {
      if (prior.apiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prior.apiKey;
      if (prior.domain === undefined) delete process.env.RESEND_REPLY_DOMAIN;
      else process.env.RESEND_REPLY_DOMAIN = prior.domain;
      if (prior.secret === undefined) delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
      else process.env.RESEND_INBOUND_WEBHOOK_SECRET = prior.secret;
    }
  });

  it("preserves manager-customized prose while attaching the valid Reply-To", async () => {
    const prior = {
      apiKey: process.env.RESEND_API_KEY,
      domain: process.env.RESEND_REPLY_DOMAIN,
      secret: process.env.RESEND_INBOUND_WEBHOOK_SECRET,
    };
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_REPLY_DOMAIN = "reply.example.com";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = `whsec_${Buffer.from("test-secret-that-is-long-enough").toString("base64")}`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-custom" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await notifyTenantTourRescheduled(makeDb(), req, baseInquiry, {
        window: confirmWindow,
        previousWindow: { start: "2026-07-21T18:00:00.000Z", end: "2026-07-21T18:30:00.000Z" },
        body: "I will meet you by the blue gate. Call the front desk if you are delayed.",
        channels: { viaEmail: true, viaSms: false },
      });
      const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        text: string;
        reply_to?: string;
      };
      expect(payload.text).toBe("I will meet you by the blue gate. Call the front desk if you are delayed.");
      expect(payload.reply_to).toContain("@reply.example.com");
    } finally {
      if (prior.apiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prior.apiKey;
      if (prior.domain === undefined) delete process.env.RESEND_REPLY_DOMAIN;
      else process.env.RESEND_REPLY_DOMAIN = prior.domain;
      if (prior.secret === undefined) delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
      else process.env.RESEND_INBOUND_WEBHOOK_SECRET = prior.secret;
    }
  });

  it("gives an account-creation path when email cannot carry a signed reply", async () => {
    const prior = {
      apiKey: process.env.RESEND_API_KEY,
      domain: process.env.RESEND_REPLY_DOMAIN,
      secret: process.env.RESEND_INBOUND_WEBHOOK_SECRET,
    };
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.RESEND_REPLY_DOMAIN;
    delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await notifyTenantTourRescheduled(makeDb(), req, {
        ...baseInquiry,
        smsConsent: false,
        smsOrigin: "non_sms",
      }, {
        window: confirmWindow,
        previousWindow: { start: "2026-07-21T18:00:00.000Z", end: "2026-07-21T18:30:00.000Z" },
        proposalRecordId: "axis_admin_partner_inquiries_v1",
        channels: { viaEmail: true, viaSms: false },
      });
      const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        text: string;
        reply_to?: string;
      };
      expect(payload).not.toHaveProperty("reply_to");
      expect(payload.text).toContain("Create or sign in to a PropLane account");
      expect(payload.text).toContain("tour_inquiry=");
      expect(payload.text).not.toMatch(/reply\s+YES\s+by\s+SMS/i);
      expect(payload.text).not.toContain("Reply to this email");
    } finally {
      if (prior.apiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prior.apiKey;
      if (prior.domain === undefined) delete process.env.RESEND_REPLY_DOMAIN;
      else process.env.RESEND_REPLY_DOMAIN = prior.domain;
      if (prior.secret === undefined) delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
      else process.env.RESEND_INBOUND_WEBHOOK_SECRET = prior.secret;
    }
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
