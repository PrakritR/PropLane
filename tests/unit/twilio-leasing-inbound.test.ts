import { beforeEach, describe, expect, it, vi } from "vitest";

const sendSms = vi.fn();
const sendFromManager = vi.fn();

vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendPropLaneSms: (...args: unknown[]) => sendSms(...args),
  sendFromManagerWorkNumber: (...args: unknown[]) => sendFromManager(...args),
  isClawTransportEnabled: () => false,
  scheduleManagerMessagingReady: () => undefined,
}));

vi.mock("@/lib/claw-relay.server", () => ({
  forwardClawInboundToManagers: vi.fn(async () => ({ forwardedTo: [] })),
  isMappedManagerPhone: vi.fn(async () => false),
  tryRelayManagerReplyViaClaw: vi.fn(async () => ({ relayed: false })),
}));

vi.mock("@/lib/claw-resident-messaging.server", () => ({
  clawMappedManagerEmails: () => [],
  resolveMappedManagerContacts: vi.fn(async () => []),
  resolveRegisteredClawManagers: vi.fn(async () => []),
  findResidentProfileByPhone: vi.fn(async () => null),
  findThreadByResidentPhone: vi.fn(async () => null),
  forwardResidentMessageToManagers: vi.fn(async () => ({ forwardedTo: [] })),
  mirrorResidentTextToManagerInbox: vi.fn(async () => undefined),
  openClawResidentThread: vi.fn(async () => null),
}));

vi.mock("@/lib/sms-inbox-notice.server", () => ({
  upsertManagerInboxNotice: vi.fn(async () => undefined),
  notifyManagerOfInboundSms: vi.fn(async () => ({ inboxNoticeWritten: true, emailSent: false })),
  sendManagerNoticeEmail: vi.fn(async () => ({ sent: false })),
}));

vi.mock("@/lib/agent/leasing-sms-agent.server", () => ({
  runLeasingSmsAgentTurn: vi.fn(async () => null),
  deliverLeasingSmsReply: vi.fn(async () => ({ ok: false })),
}));

vi.mock("@/lib/supabase/service", () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    const self = () => c;
    c.select = self;
    c.eq = self;
    c.in = self;
    c.order = self;
    c.limit = async () => ({ data: [] });
    c.insert = async () => ({ error: null });
    c.maybeSingle = async () => ({
      data: { id: "mgr-1", email: "m@test.com", full_name: "M" },
    });
    return c;
  };
  return {
    createSupabaseServiceRoleClient: () => ({
      from: () => chain(),
    }),
  };
});

describe("handleClawLeasingInbound via Twilio work number", () => {
  beforeEach(() => {
    sendSms.mockReset();
    sendFromManager.mockReset();
    sendFromManager.mockResolvedValue({ ok: true, channel: "twilio", sid: "SM1" });
    sendSms.mockResolvedValue({ ok: true, channel: "twilio", sid: "SM1" });
    vi.resetModules();
  });

  it("auto-replies to a cold prospect without any phone allowlist", async () => {
    const { handleClawLeasingInbound } = await import("@/lib/claw-leasing-bot.server");
    const result = await handleClawLeasingInbound({
      from: "+15551234567",
      text: "Hi — I'd like to schedule a tour for Magnolia House.",
      messageId: `test-${Date.now()}`,
      managerUserId: "mgr-1",
      workNumber: "+14258909021",
    });
    expect(result.ok).toBe(true);
    expect(result.replied).toBe(true);
    expect(result.intent).toBe("tour");
    expect(sendFromManager).toHaveBeenCalled();
    const call = sendFromManager.mock.calls[0]?.[0] as {
      to: string;
      fromNumber?: string;
      text: string;
    };
    expect(call.to).toBe("+15551234567");
    expect(call.fromNumber).toBe("+14258909021");
    expect(call.text).toMatch(/tour/i);
  });
});
