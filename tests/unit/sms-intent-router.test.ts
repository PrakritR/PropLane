/**
 * The intent-router seam: the stub's contract, and the transport call site in
 * /api/twilio/inbound — the router is consulted after self-reply detection,
 * a handled result skips default (leasing-bot) handling but still runs the
 * manager fan-out, and an unhandled result falls through unchanged.
 *
 * The router BODY is owned by the axis-sms-text-to-entry lane; these tests pin
 * the transport's side of the contract, not the intents.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  routeMock,
  leasingMock,
  notifyMock,
  forwardCellMock,
  logSmsMock,
  relayMock,
  selfReplyMock,
  residentProfileMock,
  priorRowsMock,
  sendWorkNumberMock,
} = vi.hoisted(() => ({
  routeMock: vi.fn(),
  leasingMock: vi.fn(async () => ({ ok: true, intent: "question", replied: true })),
  notifyMock: vi.fn(async () => ({ inboxNoticeWritten: true, emailSent: true })),
  forwardCellMock: vi.fn(async () => true),
  logSmsMock: vi.fn(async () => true),
  relayMock: vi.fn(async () => ({ handled: false })),
  selfReplyMock: vi.fn(async () => null),
  residentProfileMock: vi.fn(async () => null),
  priorRowsMock: vi.fn(() => [] as Array<{ id: string }>),
  sendWorkNumberMock: vi.fn(async () => ({ ok: true, sid: "SM-reply" })),
}));

vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendFromManagerWorkNumber: sendWorkNumberMock,
}));

vi.mock("@/lib/sms-intent-router", () => ({
  routeInboundSms: routeMock,
}));

vi.mock("@/lib/claw-leasing-bot.server", () => ({
  handleClawLeasingInbound: leasingMock,
}));

vi.mock("@/lib/sms-inbox-notice.server", () => ({
  notifyManagerOfInboundSms: notifyMock,
  upsertManagerInboxNotice: vi.fn(async () => undefined),
  sendManagerNoticeEmail: vi.fn(async () => ({ sent: false })),
}));

vi.mock("@/lib/sms/manager-relay.server", () => ({
  detectManagerSelfReply: selfReplyMock,
  handleManagerReplyInbound: vi.fn(async () => ({ ok: true, residentPhone: "+1" })),
  forwardResidentInboundToManagerCell: forwardCellMock,
}));

vi.mock("@/lib/sms-relay.server", () => ({
  relayInboundSms: relayMock,
}));

vi.mock("@/lib/claw-resident-messaging.server", () => ({
  findResidentProfileByPhone: residentProfileMock,
}));

vi.mock("@/lib/manager-sms-messages.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/manager-sms-messages.server")>();
  return {
    inboundLogIdentityFields: original.inboundLogIdentityFields,
    logManagerSmsMessage: logSmsMock,
  };
});

vi.mock("@/lib/sms-media.server", () => ({
  twilioMediaUrls: () => [],
}));

vi.mock("@/lib/sms-consent", () => ({
  recordOptIn: vi.fn(async () => undefined),
  recordOptOut: vi.fn(async () => undefined),
}));

vi.mock("@/lib/claw-leasing-links", () => ({
  isClawSharedLineBridgeEnabled: () => false,
}));

vi.mock("@/lib/supabase/service", () => {
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    let eqColumn = "";
    c.select = () => c;
    c.eq = (column: string) => {
      eqColumn = column;
      return c;
    };
    c.in = () => c;
    c.order = () => c;
    c.limit = async () => ({
      data:
        table === "profiles"
          ? [{ id: "mgr-1" }]
          : // inbound_sms_log serves two queries: the MessageSid dedupe (always
            // unseen here) and the conversation-prior check (test-controlled).
            table === "inbound_sms_log" && eqColumn === "conversation_key"
            ? priorRowsMock()
            : [],
    });
    c.insert = async () => ({ error: null });
    c.maybeSingle = async () => ({ data: { id: "mgr-1", email: "m@test.com" } });
    return c;
  };
  return {
    createSupabaseServiceRoleClient: () => ({ from: (table: string) => chain(table) }),
  };
});

const WEBHOOK = "http://localhost/api/twilio/inbound";

function inboundRequest(params: Record<string, string>): Request {
  return new Request(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

async function postInbound(params?: Record<string, string>): Promise<Response> {
  const { POST } = await import("@/app/api/twilio/inbound/route");
  return POST(
    inboundRequest({
      From: "+14255550123",
      To: "+12065550100",
      Body: "TOUR",
      MessageSid: `SM-${Math.random().toString(36).slice(2)}`,
      ...params,
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  routeMock.mockReset();
  leasingMock.mockClear();
  notifyMock.mockClear();
  forwardCellMock.mockClear();
  logSmsMock.mockClear();
  relayMock.mockClear();
  selfReplyMock.mockClear();
  residentProfileMock.mockReset();
  residentProfileMock.mockResolvedValue(null);
  priorRowsMock.mockReset();
  priorRowsMock.mockReturnValue([]);
  sendWorkNumberMock.mockReset();
  sendWorkNumberMock.mockResolvedValue({ ok: true, sid: "SM-reply" });
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  delete process.env.VERCEL;
});

describe("sms-intent-router stub", () => {
  it("returns handled:false — the axis-sms-text-to-entry lane owns the body", async () => {
    const { routeInboundSms } = await vi.importActual<typeof import("@/lib/sms-intent-router")>(
      "@/lib/sms-intent-router",
    );
    const result = await routeInboundSms({
      fromPhone: "+14255550123",
      toPhone: "+12065550100",
      body: "TOUR",
      managerId: "mgr-1",
      conversationId: "mgr-1:prospect:+14255550123",
      isFirstMessageInConversation: true,
    });
    expect(result).toEqual({ handled: false });
  });
});

describe("/api/twilio/inbound intent-router call site", () => {
  it("consults the router with the resolved conversation context", async () => {
    routeMock.mockResolvedValue({ handled: false });
    await postInbound();
    expect(routeMock).toHaveBeenCalledTimes(1);
    const ctx = routeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(ctx).toMatchObject({
      fromPhone: "+14255550123",
      toPhone: "+12065550100",
      body: "TOUR",
      managerId: "mgr-1",
      isFirstMessageInConversation: true,
    });
    expect(String(ctx.conversationId)).toContain("mgr-1");
    // Unhandled → default handling runs.
    expect(leasingMock).toHaveBeenCalledTimes(1);
  });

  it("reports a continuing conversation when prior inbound rows exist", async () => {
    routeMock.mockResolvedValue({ handled: false });
    priorRowsMock.mockReturnValue([{ id: "prior" }]);
    await postInbound();
    const ctx = routeMock.mock.calls[0]![0] as { isFirstMessageInConversation: boolean };
    expect(ctx.isFirstMessageInConversation).toBe(false);
  });

  it("handled:true sends the auto-reply through the transport gate, not TwiML", async () => {
    routeMock.mockResolvedValue({ handled: true, autoReplyBody: "Tour booked! See you Saturday." });
    const res = await postInbound();
    const xml = await res.text();
    // The reply is NOT embedded in TwiML — that path skips opt-out / quiet
    // hours / suspension and produces no sid to stamp delivery against.
    expect(xml).not.toContain("<Message>");
    expect(sendWorkNumberMock).toHaveBeenCalledTimes(1);
    expect(sendWorkNumberMock.mock.calls[0]![0]).toMatchObject({
      managerUserId: "mgr-1",
      to: "+14255550123",
      text: "Tour booked! See you Saturday.",
      fromNumber: "+12065550100",
    });
    expect(leasingMock).not.toHaveBeenCalled();
    // The transport still owns the manager fan-out on the handled branch:
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![1]).toMatchObject({
      managerUserId: "mgr-1",
      fromPhone: "+14255550123",
      autoReply: "Tour booked! See you Saturday.",
    });
    expect(forwardCellMock).toHaveBeenCalledTimes(1);
    // The transport logs the outbound itself — no second conversation row here.
    expect(logSmsMock).not.toHaveBeenCalled();
  });

  it("a suppressed auto-reply is never reported to the manager as sent", async () => {
    routeMock.mockResolvedValue({ handled: true, autoReplyBody: "Tour booked!" });
    sendWorkNumberMock.mockResolvedValue({ ok: false, error: "recipient_opted_out" });
    const res = await postInbound();
    expect(await res.text()).not.toContain("<Message>");
    expect(notifyMock.mock.calls[0]![1]).toMatchObject({ autoReply: null });
  });

  it("handled:true with no reply body acks quietly but still fans out", async () => {
    routeMock.mockResolvedValue({ handled: true });
    const res = await postInbound();
    const xml = await res.text();
    expect(xml).not.toContain("<Message>");
    expect(leasingMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(sendWorkNumberMock).not.toHaveBeenCalled();
    expect(logSmsMock).not.toHaveBeenCalled();
  });

  it("a router crash falls back to default handling (never drops the message)", async () => {
    routeMock.mockRejectedValue(new Error("router exploded"));
    await postInbound();
    expect(leasingMock).toHaveBeenCalledTimes(1);
  });
});
