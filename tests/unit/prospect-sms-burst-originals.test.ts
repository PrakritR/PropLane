import { beforeEach, describe, expect, it, vi } from "vitest";

const loggedMessages = vi.fn(async (_db: unknown, row: Record<string, unknown>) => {
  loggedMessages.rows.push(row);
  return true;
}) as ReturnType<typeof vi.fn> & { rows: Record<string, unknown>[] };
loggedMessages.rows = [];
const agentTurn = vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
  agentTurn.inputs.push(input);
  return { disposition: "quiet_handoff" as const };
}) as ReturnType<typeof vi.fn> & { inputs: Record<string, unknown>[] };
agentTurn.inputs = [];
const inboundRows: Record<string, unknown>[] = [];

vi.mock("@/lib/manager-sms-messages.server", () => ({
  logManagerSmsMessage: (...args: unknown[]) => loggedMessages(...(args as [unknown, Record<string, unknown>])),
  inboundLogIdentityFields: (args: { managerUserId: string; counterpartyRole?: string; fromPhone: string }) => ({
    manager_user_id: args.managerUserId,
    counterparty_role: args.counterpartyRole ?? "unknown",
    conversation_key: `${args.managerUserId}:${args.counterpartyRole}:${args.fromPhone}`,
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "order", "limit"]) query[method] = () => query;
      query.maybeSingle = async () => ({
        data: table === "profiles" ? { id: "manager-1", email: "manager@example.test" } : null,
        error: null,
      });
      query.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
      query.insert = async (row: Record<string, unknown>) => {
        if (table === "inbound_sms_log") inboundRows.push(row);
        return { error: null };
      };
      return query;
    },
  }),
}));

vi.mock("@/lib/agent/leasing-sms-agent.server", () => ({
  runLeasingSmsAgentTurn: (...args: unknown[]) => agentTurn(...(args as [unknown, Record<string, unknown>])),
  deliverLeasingSmsReply: vi.fn(),
}));
vi.mock("@/lib/prospect-tour-booking-recovery.server", () => ({
  loadConfirmedProspectTourBooking: vi.fn(async () => null),
}));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyScopedManagerRecipientIds: vi.fn(async () => []),
}));
vi.mock("@/lib/sms-inbox-notice.server", () => ({ upsertManagerInboxNotice: vi.fn() }));
vi.mock("@/lib/claw-resident-messaging.server", () => ({
  clawMappedManagerEmails: () => [],
  findResidentProfileByPhone: vi.fn(async () => null),
  findThreadByResidentPhone: vi.fn(async () => null),
  resolveMappedManagerContacts: vi.fn(async () => []),
  resolveRegisteredClawManagers: vi.fn(async () => []),
}));
vi.mock("@/lib/claw-relay.server", () => ({
  isMappedManagerPhone: vi.fn(async () => false),
  forwardClawInboundToManagers: vi.fn(async () => ({ forwardedTo: [] })),
  tryRelayManagerReplyViaClaw: vi.fn(async () => ({ relayed: false })),
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendPropLaneSms: vi.fn(),
  sendFromManagerWorkNumber: vi.fn(),
}));
vi.mock("@/lib/sms/prospect-sms-burst.server", () => ({
  durableProspectSmsEnabled: () => true,
  enqueueProspectSmsBurst: vi.fn(),
}));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: vi.fn(async () => []) }));

describe("prospect SMS burst transport history", () => {
  beforeEach(() => {
    loggedMessages.rows = [];
    agentTurn.inputs = [];
    inboundRows.length = 0;
    vi.clearAllMocks();
  });

  it("keeps each original SID, body, and receive time while giving the agent joined context", async () => {
    const { handleClawLeasingInbound, __resetClawInboundSeenForTests } = await import("@/lib/claw-leasing-bot.server");
    __resetClawInboundSeenForTests();
    const originals = [
      { messageId: "SM-first", body: "Can I tour?", receivedAt: "2026-09-25T12:00:00.000Z" },
      { messageId: "SM-second", body: "Tomorrow afternoon", receivedAt: "2026-09-25T12:00:04.000Z" },
    ];

    const result = await handleClawLeasingInbound({
      from: "+15105794001",
      text: originals.map((event) => event.body).join("\n"),
      messageId: "SM-second",
      mergedMessageIds: originals.map((event) => event.messageId),
      originalMessages: originals,
      managerUserId: "manager-1",
      workNumber: "+12053690702",
      durableBurstWorker: true,
      durablyClaimed: true,
      prospectBurst: { burstId: "burst-1", revision: 1, workerId: "worker-1", claimedSourceIds: originals.map((event) => event.messageId) },
    });

    expect(result).toMatchObject({ ok: true, completedWithoutReply: "quiet_handoff" });
    expect(agentTurn.inputs[0]?.inboundText).toBe("Can I tour?\nTomorrow afternoon");
    expect(loggedMessages.rows.map(({ messageSid, body, createdAt }) => [messageSid, body, createdAt])).toEqual([
      ["SM-first", "Can I tour?", originals[0]!.receivedAt],
      ["SM-second", "Tomorrow afternoon", originals[1]!.receivedAt],
    ]);
    expect(inboundRows.map(({ message_sid, body, created_at }) => [message_sid, body, created_at])).toEqual([
      ["SM-first", "Can I tour?", originals[0]!.receivedAt],
      ["SM-second", "Tomorrow afternoon", originals[1]!.receivedAt],
    ]);
  });
});
