// A prospect locked to a free manager's home on the PropLane line gets ONE conversation in the owner's Communication:
// the stored notice carries the LOCKED home (subject, house stamp, recipients) and the original-text marker that folds it
// into the projection's thread, instead of naming the manager's most recently edited listing and standing as a second row.
import { beforeEach, describe, expect, it, vi } from "vitest";

const notices: Record<string, unknown>[] = [];
const workLineArgs: Record<string, unknown>[] = [];
const recipientArgs: Record<string, unknown>[] = [];
const tagArgs: Record<string, unknown>[] = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendPropLaneSms: vi.fn(async () => ({ ok: true, channel: "twilio", sid: "SM9" })),
  sendFromManagerWorkNumber: vi.fn(async () => ({ ok: true, channel: "twilio", sid: "SM9" })),
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
  upsertManagerInboxNotice: vi.fn(async (_db: unknown, args: Record<string, unknown>) => { notices.push(args); return { threadId: "t", messageId: "m" }; }),
  recordAutoReplyOnSmsNoticeFresh: vi.fn(async () => true),
}));
vi.mock("@/lib/agent/leasing-sms-agent.server", () => ({
  runLeasingSmsAgentTurn: vi.fn(async () => null),
  deliverLeasingSmsReply: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyScopedManagerRecipientIds: vi.fn(async (_db: unknown, args: Record<string, unknown>) => { recipientArgs.push(args); return ["owner-1"]; }),
}));
vi.mock("@/lib/sms/conversation-houses.server", () => ({
  tagConversationHouse: vi.fn(async (_db: unknown, args: Record<string, unknown>) => { tagArgs.push(args); return true; }),
}));
vi.mock("@/lib/one-number/locked-home-context.server", () => ({
  loadLockedHomeContext: vi.fn(async () => ({ propertyId: "prop-pine", label: "Pine Street House" })),
  lockedHomePromptNote: () => "",
}));
vi.mock("@/lib/sms/sms-projection.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/sms-projection.server")>()),
  resolveSmsProjectionWorkLine: vi.fn(async (_db: unknown, args: Record<string, unknown>) => {
    workLineArgs.push(args);
    return args.workspaceId ? { workLineId: String(args.workspaceId), phoneNumber: String(args.phoneNumber), workspaceId: String(args.workspaceId) } : null;
  }),
}));
vi.mock("@/lib/supabase/service", () => {
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    const self = () => c;
    c.select = self; c.eq = self; c.in = self; c.order = self;
    // The manager's most recently edited live listing: a DIFFERENT home from the one the phone is locked to.
    c.limit = async () => ({ data: table === "manager_property_records" ? [{ id: "prop-sixty-fifth", property_data: { title: "Sixty-Fifth Street House" } }] : [] });
    c.insert = async () => ({ error: null });
    c.maybeSingle = async () => ({ data: { id: "owner-1", email: "o@test.com", full_name: "Lena" } });
    return c;
  };
  return { createSupabaseServiceRoleClient: () => ({ from: (t: string) => chain(t) }) };
});

describe("a locked prospect on the PropLane line reads as one conversation about the locked home", () => {
  beforeEach(() => {
    notices.length = 0; workLineArgs.length = 0; recipientArgs.length = 0; tagArgs.length = 0;
    vi.resetModules();
  });

  const run = async () => {
    const { handleClawLeasingInbound, __resetClawInboundSeenForTests } = await import("@/lib/claw-leasing-bot.server");
    __resetClawInboundSeenForTests();
    await handleClawLeasingInbound({
      from: "+12535550190", text: "is parking included?", messageId: "SM-locked-1", receivedAt: "2026-10-26T18:00:00.000Z",
      managerUserId: "owner-1", workspaceId: "ws-lena", workNumber: "+12065550100", durablyClaimed: true,
    });
  };

  it("names the LOCKED home in the notice subject, never the manager's other listing", async () => {
    await run();
    expect(notices).toHaveLength(1);
    expect(String(notices[0]!.subject)).toContain("Pine Street House");
    expect(String(notices[0]!.subject)).not.toContain("Sixty-Fifth");
  });

  it("stamps the locked house on the thread and scopes the recipients to it", async () => {
    await run();
    expect(tagArgs.at(-1)).toMatchObject({ managerUserId: "owner-1", propertyId: "prop-pine" });
    expect(recipientArgs.at(-1)).toMatchObject({ propertyId: "prop-pine" });
  });

  it("resolves the shared line's work line through the routed workspace so the notice carries the original-text marker", async () => {
    await run();
    expect(workLineArgs.at(-1)).toMatchObject({ workspaceId: "ws-lena" });
    expect(notices[0]!.originalSmsEvent).toMatchObject({ sourceEventId: "SM-locked-1", workLineId: "ws-lena" });
  });
});

describe("the Looking for line is a card, not a sent text", () => {
  it("recognises the summary turn by its sid and strips its label", async () => {
    const { isLookingForTurnSid, lookingForCardText } = await import("@/lib/manager-sms-messages");
    expect(isLookingForTurnSid("lookingfor:lead-1:prop-pine")).toBe(true);
    expect(isLookingForTurnSid("SM123")).toBe(false);
    expect(lookingForCardText("Looking for: private room near UW · under $1200")).toBe("private room near UW · under $1200");
  });
});
