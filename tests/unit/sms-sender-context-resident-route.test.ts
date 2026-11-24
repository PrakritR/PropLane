// A multi-role sender ("resident: when is my rent due" from a phone that is also a manager and an admin) is answered
// as a RESIDENT of that house: the text is recorded in the resident conversation with that house's manager, the reply
// is delivered as that same resident conversation, and the raw inbound copy is kept until the answer is out.
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
  runManagerSmsAgentTurn: vi.fn(),
}));
vi.mock("@/lib/sms/project-manager-sms-event.server", () => ({ projectManagerSmsEvent: m.project }));
vi.mock("@/lib/sms/inbound-replay.server", () => ({
  attachInboundOutbox: vi.fn(async () => true),
  finishInboundClaim: m.finish,
  loadInboundReplay: vi.fn(async () => ({ ok: true, receipt: null })),
  prepareInboundReply: m.prepare,
}));
vi.mock("@/lib/sms/service-manager-inbound.server", () => ({
  recognizeServiceManagerInbound: vi.fn(async () => null),
  listServiceWorkspaceRefs: vi.fn(async () => []),
  listServiceWorkspacesFor: vi.fn(async () => []),
  pickServiceWorkspaceForText: vi.fn(async () => ({ kind: "none" })),
  buildServiceManagerAgentContext: vi.fn(async () => ({ ok: false, reason: "no_houses" })),
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
            if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
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

  it("drops the raw inbound row only once the answer is delivered", async () => {
    const ops: string[] = [];
    const res = await runClaimedInbound(fakeDb(ops), claim());
    expect(res.status).toBe(200);
    expect(ops).toContain("inbound_sms_log.delete");
  });
});
