import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the two-way Communication → SMS replica (addendum-2):
 * the manager portal thread must show BOTH sides of a resident/prospect
 * conversation, not just the agent's outbound replies. The known-resident hub
 * path (payment/lease/move-in/general topics) previously never persisted the
 * resident's raw inbound text anywhere the portal reads from — only the
 * leasing-prospect path did. This exercises that specific gap.
 */

const sendFromManager = vi.fn(async () => ({ ok: true, channel: "claw" as const, sid: "SM1" }));
const logManagerSmsMessage = vi.fn(async (): Promise<boolean> => true);
const findResidentProfileByPhone = vi.fn();
const findThreadByResidentPhone = vi.fn();
const openClawResidentThread = vi.fn();
const runResidentSmsAction = vi.fn(async () => ({
  classification: {
    intent: "balance",
    domain: "payment",
    wantsLabel: "see balance",
    managerPath: "/portal/payments",
    skipManagerBrief: false,
  },
  residentReply: "You're all caught up — nothing due right now.",
  autoFiledNote: null,
  threadTopic: "payment",
  forwardSaid: "what do I owe this month?",
  residentName: "Jane Resident",
  propertyLabel: "4709A 8th Ave NE",
}));

vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendPropLaneSms: vi.fn(async () => ({ ok: true })),
  sendFromManagerWorkNumber: (...args: unknown[]) => sendFromManager(...(args as [unknown])),
}));

vi.mock("@/lib/manager-sms-messages.server", () => ({
  logManagerSmsMessage: (...args: unknown[]) => logManagerSmsMessage(...(args as [unknown, unknown])),
  // Real implementation is pure; used by persistClawInboundSms for the
  // inbound_sms_log identity columns.
  inboundLogIdentityFields: (args: {
    managerUserId: string | null;
    counterpartyRole?: string;
    counterpartyUserId?: string | null;
    fromPhone: string;
  }) => ({
    counterparty_role: args.counterpartyRole ?? "unknown",
    conversation_key: `${args.managerUserId ?? ""}:${args.counterpartyRole ?? "unknown"}:${
      args.counterpartyUserId ?? args.fromPhone
    }`,
  }),
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
  findResidentProfileByPhone: (...args: unknown[]) => findResidentProfileByPhone(...args),
  findThreadByResidentPhone: (...args: unknown[]) => findThreadByResidentPhone(...args),
  forwardResidentMessageToManagers: vi.fn(async () => ({ forwardedTo: [] })),
  mirrorResidentTextToManagerInbox: vi.fn(async () => undefined),
  openClawResidentThread: (...args: unknown[]) => openClawResidentThread(...args),
}));

vi.mock("@/lib/claw-resident-actions.server", () => ({
  runResidentSmsAction: (...args: unknown[]) => runResidentSmsAction(...(args as [unknown])),
  buildManagerResidentBrief: vi.fn(() => "brief text"),
}));

vi.mock("@/lib/public-listings.server", () => ({
  getPublicListings: vi.fn(async () => []),
}));

vi.mock("@/lib/supabase/service", () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    const self = () => c;
    c.select = self;
    c.eq = self;
    c.in = self;
    c.order = self;
    c.limit = self;
    c.maybeSingle = async () => ({ data: null });
    c.insert = async () => ({ error: null });
    return c;
  };
  return { createSupabaseServiceRoleClient: () => ({ from: () => chain() }) };
});

describe("handleClawLeasingInbound — known resident thread", () => {
  // 30s, not the 10s default: this hook's first `await import(...)` is what pays
  // the transform cost for claw-leasing-bot.server and its dependency tree. Run
  // alone that is milliseconds, but under the full suite (990+ files competing
  // for workers) it has exceeded 10s and timed out the hook — a load-dependent
  // flake, not a real failure. The import itself is cached after the first test.
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetClawInboundSeenForTests } = await import("@/lib/claw-leasing-bot.server");
    __resetClawInboundSeenForTests();
    sendFromManager.mockResolvedValue({ ok: true, channel: "claw", sid: "SM1" });
    logManagerSmsMessage.mockResolvedValue(true);
    findResidentProfileByPhone.mockResolvedValue({
      userId: "res-1",
      email: "res@example.com",
      managerUserId: "mgr-1",
    });
    findThreadByResidentPhone.mockResolvedValue({
      id: "thread-1",
      managerUserId: "mgr-1",
      managerPhone: "+15105551111",
      residentPhone: "+15105794001",
      residentUserId: "res-1",
      residentEmail: "res@example.com",
      topic: "general",
      lastMessageAt: new Date(0).toISOString(),
    });
    openClawResidentThread.mockResolvedValue(null);
  }, 30000);

  it("persists the resident's raw inbound text (direction=inbound) for the two-way portal thread", async () => {
    const { handleClawLeasingInbound } = await import("@/lib/claw-leasing-bot.server");
    const result = await handleClawLeasingInbound({
      from: "+15105794001",
      text: "what do I owe this month?",
      messageId: "inbound-log-test-1",
      workNumber: "+12053690702",
    });

    expect(result.ok).toBe(true);
    expect(result.replied).toBe(true);

    expect(logManagerSmsMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        managerUserId: "mgr-1",
        residentUserId: "res-1",
        residentPhone: "+15105794001",
        direction: "inbound",
        body: "what do I owe this month?",
      }),
    );

    // The reply (outbound) is sent separately via sendFromManagerWorkNumber,
    // which the app's own transport layer logs as direction=outbound —
    // together the thread has both sides.
    expect(sendFromManager).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15105794001",
        managerUserId: "mgr-1",
        text: "You're all caught up — nothing due right now.",
      }),
    );
  });

  it("replaces a shared-line thread owned by a different manager before logging inbound", async () => {
    findThreadByResidentPhone.mockResolvedValue({
      id: "stale-thread",
      managerUserId: "mgr-2",
      managerPhone: "+15105552222",
      residentPhone: "+15105794001",
      residentUserId: "res-1",
      residentEmail: "res@example.com",
      topic: "general",
      lastMessageAt: new Date().toISOString(),
    });
    openClawResidentThread.mockResolvedValue({
      id: "correct-thread",
      managerUserId: "mgr-1",
      managerPhone: "+15105551111",
      residentPhone: "+15105794001",
      residentUserId: "res-1",
      residentEmail: "res@example.com",
      topic: "general",
      lastMessageAt: new Date().toISOString(),
    });

    const { handleClawLeasingInbound } = await import("@/lib/claw-leasing-bot.server");
    const result = await handleClawLeasingInbound({
      from: "+15105794001",
      text: "route this to my manager",
      messageId: "inbound-manager-scope-test",
      workNumber: "+12053690702",
    });

    expect(result.ok).toBe(true);
    expect(openClawResidentThread).toHaveBeenCalledWith(
      expect.objectContaining({ managerUserId: "mgr-1" }),
    );
    expect(logManagerSmsMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ managerUserId: "mgr-1" }),
    );
    expect(sendFromManager).toHaveBeenCalledWith(
      expect.objectContaining({ managerUserId: "mgr-1" }),
    );
  });

  it("does not fall through to another landlord when the correct thread cannot open", async () => {
    findThreadByResidentPhone.mockResolvedValue({
      id: "stale-thread",
      managerUserId: "mgr-2",
      managerPhone: "+15105552222",
      residentPhone: "+15105794001",
      residentUserId: "res-1",
      residentEmail: "res@example.com",
      topic: "general",
      lastMessageAt: new Date().toISOString(),
    });

    const { handleClawLeasingInbound } = await import("@/lib/claw-leasing-bot.server");
    const result = await handleClawLeasingInbound({
      from: "+15105794001",
      text: "do not misroute this",
      messageId: "inbound-manager-scope-failure-test",
      workNumber: "+12053690702",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Resident SMS thread resolution failed.",
    });
    expect(logManagerSmsMessage).not.toHaveBeenCalled();
    expect(sendFromManager).not.toHaveBeenCalled();
  });

  it("answers a work-number text instead of stranding it when the resident thread cannot open", async () => {
    // Regression: `openClawResidentThread` refuses for ordinary reasons — the
    // texter's own number is a registered manager/admin cell, or the owning
    // manager has no personal phone on file. That refusal used to return
    // ok:false, which made /api/twilio/inbound answer 503 forever: Twilio
    // retried three times, gave up, and the sender never got a reply while the
    // manager saw nothing in Communication. Scoped to one work number the
    // leasing responder is pinned to that same manager, so answering is safe.
    findThreadByResidentPhone.mockResolvedValue(null);
    openClawResidentThread.mockResolvedValue(null);

    const { handleClawLeasingInbound } = await import("@/lib/claw-leasing-bot.server");
    const result = await handleClawLeasingInbound({
      from: "+15105794001",
      text: "Hi",
      messageId: "inbound-thread-refused-scoped-test",
      workNumber: "+12053690702",
      managerUserId: "mgr-1",
    });

    expect(result.ok).toBe(true);
    expect(result.replied).toBe(true);
    expect(sendFromManager).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15105794001", managerUserId: "mgr-1" }),
    );
  });

  it("preserves the authoritative manager thread topic when a newer thread belongs to another manager", async () => {
    findThreadByResidentPhone
      .mockResolvedValueOnce({
        id: "stale-thread",
        managerUserId: "mgr-2",
        managerPhone: "+15105552222",
        residentPhone: "+15105794001",
        residentUserId: "res-1",
        residentEmail: "res@example.com",
        topic: "general",
        lastMessageAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        id: "payment-thread",
        managerUserId: "mgr-1",
        managerPhone: "+15105551111",
        residentPhone: "+15105794001",
        residentUserId: "res-1",
        residentEmail: "res@example.com",
        topic: "payment",
        lastMessageAt: new Date(0).toISOString(),
      });

    const { handleClawLeasingInbound } = await import("@/lib/claw-leasing-bot.server");
    const result = await handleClawLeasingInbound({
      from: "+15105794001",
      text: "what do I owe?",
      messageId: "inbound-topic-preservation-test",
      workNumber: "+12053690702",
      managerUserId: "mgr-1",
    });

    expect(result.ok).toBe(true);
    expect(findThreadByResidentPhone).toHaveBeenNthCalledWith(2, "+15105794001", "mgr-1");
    expect(openClawResidentThread).not.toHaveBeenCalled();
    expect(runResidentSmsAction).toHaveBeenCalledWith(
      expect.objectContaining({ managerUserId: "mgr-1", threadTopic: "payment" }),
    );
  });

  it("uses the scoped manager thread when the resident profile is not yet assigned", async () => {
    findResidentProfileByPhone.mockResolvedValue({
      userId: "res-1",
      email: "res@example.com",
      managerUserId: null,
    });
    findThreadByResidentPhone
      .mockResolvedValueOnce({
        id: "other-manager-thread",
        managerUserId: "mgr-2",
        managerPhone: "+15105552222",
        residentPhone: "+15105794001",
        residentUserId: "res-1",
        residentEmail: "res@example.com",
        topic: "general",
        lastMessageAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        id: "scoped-payment-thread",
        managerUserId: "mgr-1",
        managerPhone: "+15105551111",
        residentPhone: "+15105794001",
        residentUserId: "res-1",
        residentEmail: "res@example.com",
        topic: "payment",
        lastMessageAt: new Date(0).toISOString(),
      });

    const { handleClawLeasingInbound } = await import("@/lib/claw-leasing-bot.server");
    const result = await handleClawLeasingInbound({
      from: "+15105794001",
      text: "what do I owe?",
      messageId: "inbound-unassigned-profile-topic-test",
      workNumber: "+12053690702",
      managerUserId: "mgr-1",
    });

    expect(result.ok).toBe(true);
    expect(findThreadByResidentPhone).toHaveBeenNthCalledWith(2, "+15105794001", "mgr-1");
    expect(openClawResidentThread).not.toHaveBeenCalled();
    expect(runResidentSmsAction).toHaveBeenCalledWith(
      expect.objectContaining({ managerUserId: "mgr-1", threadTopic: "payment" }),
    );
  });

  it("dedupes every constituent ID from a merged debounce frame", async () => {
    const { handleClawLeasingInbound } = await import("@/lib/claw-leasing-bot.server");
    const merged = await handleClawLeasingInbound({
      from: "+15105794001",
      text: "first\nsecond",
      messageId: "merged-log-test-2",
      mergedMessageIds: ["merged-log-test-1", "merged-log-test-2"],
      workNumber: "+12053690702",
    });
    const replayedConstituent = await handleClawLeasingInbound({
      from: "+15105794001",
      text: "first",
      messageId: "merged-log-test-1",
      workNumber: "+12053690702",
    });

    expect(merged.replied).toBe(true);
    expect(replayedConstituent.replied).toBe(false);
    expect(sendFromManager).toHaveBeenCalledTimes(1);
  });

  it("withholds the reply and releases the warm-process claim when durable inbound persistence fails", async () => {
    const { handleClawLeasingInbound } = await import("@/lib/claw-leasing-bot.server");
    logManagerSmsMessage.mockResolvedValueOnce(false);

    const result = await handleClawLeasingInbound({
      from: "+15105794001",
      text: "what do I owe this month?",
      messageId: "inbound-log-best-effort-test",
      workNumber: "+12053690702",
    });
    expect(result.ok).toBe(false);
    expect(result.replied).toBe(false);
    expect(sendFromManager).not.toHaveBeenCalled();

    logManagerSmsMessage.mockResolvedValueOnce(true);
    const redelivered = await handleClawLeasingInbound({
      from: "+15105794001",
      text: "what do I owe this month?",
      messageId: "inbound-log-best-effort-test",
      workNumber: "+12053690702",
    });
    expect(redelivered.replied).toBe(true);
    expect(sendFromManager).toHaveBeenCalledTimes(1);
    expect(sendFromManager).toHaveBeenCalledTimes(1);
  });
});
