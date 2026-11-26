// Whichever context a multi-role sender answers as OWNS the turn: "resident: when is my rent due" from a phone that is
// also a manager and an admin is recorded in the resident conversation with that house's manager, the reply is
// delivered as that same conversation, and the raw inbound copy is kept until the answer is out. The same holds when
// the sender answers as another workspace's manager (last describe) - the number they texted owns neither.
import { beforeEach, describe, expect, it, vi } from "vitest";

const LINE_OWNER = "owner-line";
const HOUSE_MANAGER = "owner-res";
const SENDER = "person-1";

const m = vi.hoisted(() => ({
  managerIdentity: vi.fn(),
  sender: vi.fn(),
  residentCtx: vi.fn(),
  residentTurn: vi.fn(),
  deliverResident: vi.fn(),
  deliverManager: vi.fn(),
  project: vi.fn(),
  finish: vi.fn(async () => true),
  prepare: vi.fn(async () => true),
  replay: vi.fn(async () => ({ ok: true, receipt: null })),
  managerTurn: vi.fn(),
  buildServiceCtx: vi.fn(),
}));

vi.mock("@/lib/sms/manager-sms-access.server", () => ({ resolveManagerSmsInboundIdentity: m.managerIdentity }));
vi.mock("@/lib/sms/sender-context.server", () => ({ resolveSenderContext: m.sender }));
vi.mock("@/lib/tools/resident-sms-context", () => ({ resolveResidentSmsAgentContext: m.residentCtx }));
vi.mock("@/lib/agent/resident-sms-agent.server", () => ({
  runResidentSmsAgentTurn: m.residentTurn,
  deliverResidentSmsReply: m.deliverResident,
}));
vi.mock("@/lib/agent/manager-sms-agent.server", () => ({
  deliverManagerSmsReply: m.deliverManager,
  runManagerSmsAgentTurn: m.managerTurn,
}));
vi.mock("@/lib/sms/project-manager-sms-event.server", () => ({ projectManagerSmsEvent: m.project }));
vi.mock("@/lib/sms/inbound-replay.server", () => ({
  attachInboundOutbox: vi.fn(async () => true),
  finishInboundClaim: m.finish,
  loadInboundReplay: m.replay,
  prepareInboundReply: m.prepare,
}));
vi.mock("@/lib/sms/service-manager-inbound.server", () => ({
  recognizeServiceManagerInbound: vi.fn(async () => null),
  listServiceWorkspaceRefs: vi.fn(async () => []),
  listServiceWorkspacesFor: vi.fn(async () => []),
  pickServiceWorkspaceForText: vi.fn(async () => ({ kind: "none" })),
  buildServiceManagerAgentContext: m.buildServiceCtx,
}));
vi.mock("@/lib/sms/manager-conversation-consent.server", () => ({ ensureManagerInboundReplyConsent: vi.fn(async () => "allowed") }));
vi.mock("@/lib/manager-sms-commands/index.server", () => ({ handleManagerSmsCommand: vi.fn(async () => ({ handled: false })) }));
vi.mock("@/lib/vendor-dispatch/inbound.server", () => ({
  handleManagerDispatchReply: vi.fn(async () => ({ handled: false })),
  handleResidentDispatchReply: vi.fn(async () => ({ handled: false })),
  handleVendorDispatchReply: vi.fn(async () => ({ handled: false })),
  handleVendorDispatchMedia: vi.fn(async () => ({ handled: false })),
  hasLiveVendorDispatchAnswer: vi.fn(async () => false),
}));
vi.mock("@/lib/service/service-catalog.server", () => ({ isPropLaneServiceLine: vi.fn(async () => false) }));
vi.mock("@/lib/service/service-alert-targets.server", () => ({
  isManagedWorkspaceId: vi.fn(async () => false),
  isManagedWorkspaceOwnerActor: vi.fn(async () => false),
}));
vi.mock("@/lib/comms-billing/record-usage.server", () => ({ recordManagerCommsUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/one-number/session.server", () => ({ loadThreadPause: vi.fn(async () => null) }));
vi.mock("@/lib/sms/manager-assistant-thread-mirror.server", () => ({ appendSmsTurnToManagerAssistantThread: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/claw-leasing-links", () => ({ isClawSharedLineBridgeEnabled: () => false, isClawTransportEnabled: () => false }));

import { resetFeelSettingsCacheForTests } from "@/lib/one-number/feel-settings.server";
import { runClaimedInbound, type ClaimedInbound } from "@/lib/sms/inbound-pipeline.server";

const PAYLOAD = {
  fromPhone: "+12065550142",
  toPhone: "+12065550100",
  body: "resident: when is my rent due",
  workspaceId: "ws-line",
  media: {},
  runtime: "development",
};

function fakeDb(ops: string[]) {
  const envelope = {
    manager_user_id: LINE_OWNER,
    first_received_at: "2026-11-23T12:00:00.000Z",
    inbound_payload: PAYLOAD,
  };
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            // A query is awaited, and a few writes attach their own handlers (`.then(undefined, onError)`).
            if (prop === "then") {
              return (onFulfilled?: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onFulfilled);
            }
            if (prop === "maybeSingle") {
              return async () => ({ data: table === "sms_inbound_receipts" ? envelope : null, error: null });
            }
            return () => {
              ops.push(`${table}.${prop}`);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  } as never;
}

const claim = (): ClaimedInbound => ({
  ...PAYLOAD,
  messageSid: "SM1",
  managerId: LINE_OWNER,
  inboundWorkerId: "w1",
  mark: () => undefined,
});

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockClear();
  resetFeelSettingsCacheForTests();
  m.finish.mockResolvedValue(true);
  m.prepare.mockResolvedValue(true);
  m.project.mockResolvedValue(true);
  m.replay.mockResolvedValue({ ok: true, receipt: null });
  m.managerIdentity.mockResolvedValue({
    workNumberOwnerId: LINE_OWNER,
    actorUserId: SENDER,
    workNumber: PAYLOAD.toPhone,
    actorPhone: PAYLOAD.fromPhone,
    access: { mode: "owner", workspacePropertyIds: ["prop-line"] },
  });
  m.sender.mockResolvedValue({
    kind: "run",
    body: "when is my rent due",
    tag: "Resident · 88 Pine St:",
    source: "switch",
    resolved: {
      context: {
        kind: "resident",
        key: "resident:ws-res",
        workspaceId: "ws-res",
        ownerUserId: HOUSE_MANAGER,
        propertyId: "p9",
        label: "88 Pine St",
      },
      workspace: null,
    },
  });
  m.residentCtx.mockResolvedValue({ ok: true, ctx: { userId: SENDER, email: "person@x.co", landlordId: HOUSE_MANAGER } });
  m.residentTurn.mockResolvedValue({ reply: "Rent is due on the 1st.", sessionId: "s1", traceId: "tr1" });
  m.deliverResident.mockResolvedValue({ ok: true });
  m.deliverManager.mockResolvedValue({ ok: true });
  m.buildServiceCtx.mockResolvedValue({ ok: false, reason: "no_houses" });
  m.managerTurn.mockResolvedValue(null);
});

describe("a multi-role sender texting as a resident", () => {
  it("records the text in the resident conversation with that house's manager, not the line owner's Assistant", async () => {
    const ops: string[] = [];
    const res = await runClaimedInbound(fakeDb(ops), claim());
    expect(res.status).toBe(200);
    const projections = m.project.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(projections).toEqual([
      expect.objectContaining({
        ownerManagerUserId: HOUSE_MANAGER,
        counterpartyRole: "resident",
        counterpartyUserId: SENDER,
        direction: "inbound",
        body: PAYLOAD.body,
        workspaceId: "ws-res",
      }),
    ]);
  });

  it("delivers the answer as that resident conversation, never through the manager Assistant of the number's owner", async () => {
    const res = await runClaimedInbound(fakeDb([]), claim());
    expect(res.status).toBe(200);
    expect(m.deliverManager).not.toHaveBeenCalled();
    expect(m.deliverResident).toHaveBeenCalledTimes(1);
    expect(m.deliverResident.mock.calls[0]![0]).toMatchObject({
      ownerManagerUserId: HOUSE_MANAGER,
      residentUserId: SENDER,
      toPhone: PAYLOAD.fromPhone,
      workspaceId: "ws-res",
      text: "Resident · 88 Pine St: Rent is due on the 1st.",
    });
  });

  it("keeps the raw inbound row when the turn produces no reply, and asks for a retry", async () => {
    m.residentTurn.mockResolvedValue(null);
    const ops: string[] = [];
    const res = await runClaimedInbound(fakeDb(ops), claim());
    expect(res.status).toBe(503);
    expect(ops).not.toContain("inbound_sms_log.delete");
    expect(m.finish).toHaveBeenCalledWith(expect.anything(), "SM1", "w1", "retryable");
  });

  it("drops the raw inbound row once the outbox owns delivery, even before the provider reports it sent", async () => {
    m.deliverResident.mockResolvedValue({ ok: false, durablyAccepted: true, outboxId: "ob-1", error: "queued" });
    const ops: string[] = [];
    const res = await runClaimedInbound(fakeDb(ops), claim());
    // The claim completes on a durable outbox, so nothing will retry: leaving the row would strand the text in the
    // line owner's legacy SMS list forever.
    expect(res.status).toBe(200);
    expect(ops).toContain("inbound_sms_log.delete");
  });

  it("keeps the raw inbound row when the send is retryable", async () => {
    m.deliverResident.mockResolvedValue({ ok: false, error: "enqueue_failed" });
    const ops: string[] = [];
    const res = await runClaimedInbound(fakeDb(ops), claim());
    expect(res.status).toBe(503);
    expect(ops).not.toContain("inbound_sms_log.delete");
  });
});

describe("a retry of that text (the prepared reply is replayed)", () => {
  const receipt = {
    status: "processing" as const,
    routeKind: "resident_agent" as const,
    counterpartyUserId: SENDER,
    agentSessionId: "s1",
    inboundAgentMessageId: null,
    assistantAgentMessageId: null,
    pendingActionId: null,
    turnTraceId: "tr1",
    replyBody: "Resident · 88 Pine St: Rent is due on the 1st.",
    replyOwnerUserId: HOUSE_MANAGER,
    replyWorkspaceId: "ws-res",
    outboxId: null,
  };

  it("re-sends it to the conversation it was prepared for, not the owner of the number it arrived on", async () => {
    m.replay.mockResolvedValue({ ok: true, receipt });
    const res = await runClaimedInbound(fakeDb([]), claim());
    expect(res.status).toBe(200);
    // Never rerun the turn, and never under the line owner: that would write (and bill) the resident conversation
    // in workspace A while the house is run by B.
    expect(m.residentTurn).not.toHaveBeenCalled();
    expect(m.deliverResident).toHaveBeenCalledTimes(1);
    expect(m.deliverResident.mock.calls[0]![0]).toMatchObject({
      ownerManagerUserId: HOUSE_MANAGER,
      residentUserId: SENDER,
      workspaceId: "ws-res",
      text: receipt.replyBody,
    });
  });

  it("falls back to the work number's owner only for a receipt stored before the conversation was recorded", async () => {
    m.replay.mockResolvedValue({ ok: true, receipt: { ...receipt, replyOwnerUserId: null, replyWorkspaceId: null } });
    const res = await runClaimedInbound(fakeDb([]), claim());
    expect(res.status).toBe(200);
    expect(m.deliverResident.mock.calls[0]![0]).toMatchObject({ ownerManagerUserId: LINE_OWNER, workspaceId: "ws-line" });
  });
});

describe("a multi-role sender texting as another workspace's manager", () => {
  const OWNER_B = "owner-b";
  const senderRunsWorkspaceB = {
    kind: "run",
    body: "what is the balance on 123 Main",
    tag: "Manager · Bee Homes:",
    source: "switch",
    resolved: {
      context: {
        kind: "manager",
        key: "manager:ws-b",
        workspaceId: "ws-b",
        ownerUserId: OWNER_B,
        name: "Bee Homes",
        isDefault: false,
        isService: false,
        basis: "seat",
        viewerSeat: false,
      },
      workspace: null,
    },
  };

  beforeEach(() => {
    m.sender.mockResolvedValue(senderRunsWorkspaceB);
    m.buildServiceCtx.mockResolvedValue({
      ok: true,
      ctx: { userId: SENDER, landlordId: OWNER_B, workspace: { id: "ws-b", propertyIds: ["prop-b1"] }, managerSmsAccess: { mode: "owner", workspacePropertyIds: ["prop-b1"] } },
    });
    m.managerTurn.mockResolvedValue({ reply: "123 Main is $400 behind.", sessionId: "s2", traceId: "tr2" });
  });

  // AGENTS.md § SMS / phone: "Outbound from the work number of the workspace the message is about, never another
  // workspace's". The answer is B's rent roll, so A's Communication must not hold it and A's wallet must not pay.
  it("records and delivers under the workspace that answered, not the owner of the number texted", async () => {
    const res = await runClaimedInbound(fakeDb([]), claim());
    expect(res.status).toBe(200);
    expect(m.project.mock.calls.map((call) => call[1] as Record<string, unknown>)).toEqual([
      expect.objectContaining({
        ownerManagerUserId: OWNER_B,
        counterpartyRole: "manager",
        counterpartyUserId: SENDER,
        direction: "inbound",
        workspaceId: "ws-b",
      }),
    ]);
    expect(m.deliverManager).toHaveBeenCalledTimes(1);
    expect(m.deliverManager.mock.calls[0]![0]).toMatchObject({
      managerUserId: OWNER_B,
      actorUserId: SENDER,
      workspaceId: "ws-b",
      text: "Manager · Bee Homes: 123 Main is $400 behind.",
    });
    expect(m.prepare.mock.calls[0]![1]).toMatchObject({
      routeKind: "manager_agent",
      replyOwnerUserId: OWNER_B,
      replyWorkspaceId: "ws-b",
    });
  });

  it("replays the prepared reply to that same workspace, never under the line's owner", async () => {
    m.replay.mockResolvedValue({
      ok: true,
      receipt: {
        status: "processing",
        routeKind: "manager_agent",
        counterpartyUserId: SENDER,
        agentSessionId: "s2",
        inboundAgentMessageId: null,
        assistantAgentMessageId: null,
        pendingActionId: null,
        turnTraceId: "tr2",
        replyBody: "Manager · Bee Homes: 123 Main is $400 behind.",
        replyOwnerUserId: OWNER_B,
        replyWorkspaceId: "ws-b",
        outboxId: null,
      },
    });
    const res = await runClaimedInbound(fakeDb([]), claim());
    expect(res.status).toBe(200);
    expect(m.managerTurn).not.toHaveBeenCalled();
    expect(m.deliverManager.mock.calls[0]![0]).toMatchObject({ managerUserId: OWNER_B, workspaceId: "ws-b" });
  });
});
