import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(async (_db, args) => ({ reply: args.precomputedReply ?? "model", sessionId: "session" })),
  fast: vi.fn(),
  resolve: vi.fn(),
  send: vi.fn(),
  schedule: [] as (() => Promise<void>)[],
}));

vi.mock("@/lib/tools", () => ({ buildManagerSmsRegistry: vi.fn(() => new Map()), MANAGER_INLINE_WRITE_TOOLS: [] }));
vi.mock("@/lib/tools/resident-index", () => ({ buildResidentRegistry: vi.fn(() => new Map()) }));
vi.mock("@/lib/agent/sms-agent-turn.server", () => ({ runSmsAgentTurn: mocks.runTurn }));
vi.mock("@/lib/tools/work-order-reference-resolution", () => ({
  resolveManagerWorkOrderReference: vi.fn(),
  resolveResidentWorkOrderReference: mocks.resolve,
  workOrderReferencePromptContext: () => null,
}));
vi.mock("@/lib/one-number/resident-fast-path.server", () => ({ tryResidentFastPath: mocks.fast }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: mocks.send }));
vi.mock("@/lib/one-number/redact-reply.server", () => ({ redactedInboundReplyOverride: async () => null }));
vi.mock("next/server", () => ({ after: (task: () => Promise<void>) => { mocks.schedule.push(task); } }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

import { runResidentSmsAgentTurn, deliverResidentSmsReply } from "@/lib/agent/resident-sms-agent.server";
import { deliverManagerSmsReply } from "@/lib/agent/manager-sms-agent.server";

const ctx = { userId: "resident", landlordId: "resident", activeManagerId: "manager" } as never;
const LONG =
  "Yes, Room 3 is open and rent is $950 a month. Tours run weekdays after 4 pm and weekends from 10 am. " +
  "Tell me which day works and I will book it. You can also apply any time from the link I send after the tour.";

describe("resident turn: fast path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue(null);
    mocks.fast.mockResolvedValue(null);
  });

  it("hands a stored-fact answer to the turn runner as a no-model, no-credit reply", async () => {
    mocks.fast.mockResolvedValue({ reply: "Wi-Fi: 4709A, password sunny42.", topics: ["wifi"] });
    await runResidentSmsAgentTurn({} as never, { ctx, ownerManagerUserId: "manager", inboundText: "wifi password?", fastPath: true });
    expect(mocks.runTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      precomputedReply: "Wi-Fi: 4709A, password sunny42.",
      precomputedLane: "fast_path",
    }));
  });

  it("falls through to the agent on a miss", async () => {
    await runResidentSmsAgentTurn({} as never, { ctx, ownerManagerUserId: "manager", inboundText: "wifi password?", fastPath: true });
    expect(mocks.fast).toHaveBeenCalledTimes(1);
    expect(mocks.runTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ precomputedReply: null, precomputedLane: "scripted" }));
  });

  it("is off unless the setting is on, and never in an authenticated test turn", async () => {
    await runResidentSmsAgentTurn({} as never, { ctx, ownerManagerUserId: "manager", inboundText: "wifi password?" });
    await runResidentSmsAgentTurn({} as never, {
      ctx, ownerManagerUserId: "manager", inboundText: "wifi password?", fastPath: true,
      testActor: { userId: "r", managerUserId: "manager", sessionKind: "k", targetListingId: "l" },
    });
    expect(mocks.fast).not.toHaveBeenCalled();
  });

  it("passes the slow-work ack through to the runner", async () => {
    const onSlowWork = vi.fn();
    await runResidentSmsAgentTurn({} as never, { ctx, ownerManagerUserId: "manager", inboundText: "hi", onSlowWork });
    expect(mocks.runTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ onSlowWork }));
  });
});

describe("deliverers: bubbles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.schedule.length = 0;
    mocks.send.mockResolvedValue({ ok: true });
  });

  const resident = (extra: Record<string, unknown> = {}) =>
    deliverResidentSmsReply({ ownerManagerUserId: "m", residentUserId: "r", toPhone: "+12065550101", text: LONG, inboundMessageSid: "SM1", ...extra });

  it("sends one message exactly as before when no bubble setting is given", async () => {
    await resident();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![0]).toMatchObject({ text: LONG, dedupeKey: "inbound_reply_SM1" });
  });

  it("splits into ordered bubbles with their own idempotency keys when bubbles are on", async () => {
    await resident({ bubbles: true, workspaceId: "ws" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![0].dedupeKey).toBe("inbound_reply_SM1");
    expect(mocks.send.mock.calls[0]![0].text).toMatch(/^Yes, Room 3 is open/);
    expect(mocks.schedule).toHaveLength(1);
    await mocks.schedule[0]!();
    const keys = mocks.send.mock.calls.map((c) => c[0].dedupeKey);
    expect(keys).toEqual(["inbound_reply_SM1", "inbound_reply_SM1_b2", ...(keys.length > 2 ? ["inbound_reply_SM1_b3"] : [])]);
    expect(mocks.send.mock.calls.map((c) => c[0].text).join(" ")).toBe(LONG);
  }, 10_000);

  it("the work ack has its own key so it never collides with the reply", async () => {
    await resident({ text: "On it, I'll text you when it's done.", dedupeSuffix: "_ack" });
    expect(mocks.send.mock.calls[0]![0].dedupeKey).toBe("inbound_reply_SM1_ack");
  });

  it("manager replies bubble too, without logging into Communication", async () => {
    await deliverManagerSmsReply({ managerUserId: "m", toPhone: "+12065550101", text: LONG, inboundMessageSid: "SM2", bubbles: true });
    expect(mocks.send.mock.calls[0]![0]).toMatchObject({ skipLog: true, dedupeKey: "inbound_reply_SM2" });
    expect(mocks.schedule).toHaveLength(1);
  });
});
