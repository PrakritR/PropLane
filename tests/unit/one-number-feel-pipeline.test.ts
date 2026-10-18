import { beforeEach, describe, expect, it, vi } from "vitest";

// The delivery-feel wiring in the inbound pipeline, resident path: debounce, fast path, bubbles,
// work ack and the per-turn log. Off the shared line nothing changes.

const m = vi.hoisted(() => ({
  residentCtx: vi.fn(),
  residentTurn: vi.fn(),
  deliver: vi.fn(),
  debounce: vi.fn(),
  gate: vi.fn(),
  metrics: vi.fn(),
  finish: vi.fn(async (..._a: unknown[]) => true),
  forward: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
  settle: vi.fn(async () => undefined),
}));

vi.mock("@/lib/tools/resident-sms-context", () => ({ resolveResidentSmsAgentContext: m.residentCtx }));
vi.mock("@/lib/agent/resident-sms-agent.server", () => ({ runResidentSmsAgentTurn: m.residentTurn, deliverResidentSmsReply: m.deliver }));
vi.mock("@/lib/one-number/debounce.server", () => ({ debounceInbound: m.debounce }));
vi.mock("@/lib/one-number/knowledge/reply-modes.server", () => ({ gateAiReply: m.gate }));
vi.mock("@/lib/one-number/turn-metrics.server", async (orig) => ({ ...(await orig<typeof import("@/lib/one-number/turn-metrics.server")>()), recordSmsTurnMetrics: m.metrics }));
vi.mock("@/lib/vendor-dispatch/inbound.server", () => ({
  handleManagerDispatchReply: vi.fn(async () => ({ handled: false })),
  handleResidentDispatchReply: vi.fn(async () => ({ handled: false })),
  handleVendorDispatchReply: vi.fn(async () => ({ handled: false })),
}));
vi.mock("@/lib/inspections/attachment-intake.server", () => ({ intakeResidentSmsPhotos: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/session.server", () => ({ loadThreadPause: vi.fn(async () => null) }));
vi.mock("@/lib/claw-leasing-bot.server", () => ({ handleClawLeasingInbound: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/agent/vendor-agent.server", () => ({ resolveVendorAgentSessionForInbound: vi.fn(async () => ({ kind: "unknown_phone" })), runVendorAgentSessionTurn: vi.fn() }));
vi.mock("@/lib/sms/manager-sms-access.server", () => ({ resolveManagerSmsInboundIdentity: vi.fn(async () => null) }));
vi.mock("@/lib/sms/project-manager-sms-event.server", () => ({ projectManagerSmsEvent: vi.fn(async () => true) }));
vi.mock("@/lib/sms/inbound-replay.server", () => ({
  attachInboundOutbox: vi.fn(async () => true),
  finishInboundClaim: m.finish,
  loadInboundReplay: vi.fn(async () => ({ ok: true, receipt: null })),
  prepareInboundReply: vi.fn(async () => true),
}));
vi.mock("@/lib/comms-billing/record-usage.server", () => ({ recordManagerCommsUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({ upsertManagerSmsContact: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/sms/manager-relay.server", () => ({ forwardResidentInboundToManagerCell: m.forward }));
vi.mock("@/lib/sms/inbound-forward-team.server", () => ({ forwardInboundToTeammates: vi.fn(async () => undefined), resolveResidentForwardHouseId: vi.fn(async () => null) }));
vi.mock("@/lib/workspace-team-fanout.server", () => ({ fanOutWorkspaceNotice: vi.fn(async () => ({ notified: 0 })), repliedNoticeText: (t: string) => t }));
vi.mock("@/lib/claw-leasing-links", () => ({ isClawSharedLineBridgeEnabled: () => false }));

import { resetFeelSettingsCacheForTests } from "@/lib/one-number/feel-settings.server";
import { runClaimedInbound, type ClaimedInbound } from "@/lib/sms/inbound-pipeline.server";

const PAYLOAD = { fromPhone: "+12065550142", toPhone: "+12065550100", body: "wifi password?", workspaceId: "ws-a", media: {}, runtime: "development" };

function fakeDb(payload: Record<string, unknown>) {
  const envelope = { manager_user_id: "owner-a", first_received_at: "2026-10-18T12:00:00.000Z", inbound_payload: payload };
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      const chain: Record<string, unknown> = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
          if (prop === "maybeSingle") return async () => ({ data: table === "sms_inbound_receipts" ? envelope : null, error: null });
          return () => chain;
        },
      });
      return chain;
    },
  } as never;
}

const claim = (over: Partial<ClaimedInbound> = {}): ClaimedInbound => ({
  ...PAYLOAD, messageSid: "SM1", managerId: "owner-a", inboundWorkerId: "w1", mark: () => undefined, ...over,
});

const proceed = (body: string, mergedCount = 1) => ({ proceed: true, body, mergedCount, waitedMs: 1500, settle: m.settle });

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockClear();
  resetFeelSettingsCacheForTests();
  m.residentCtx.mockResolvedValue({ ok: true, ctx: { userId: "res-1", email: "r@x.co" } });
  m.deliver.mockResolvedValue({ ok: true });
  m.gate.mockResolvedValue({ held: false });
  m.debounce.mockImplementation(async (_db: unknown, a: { body: string }) => proceed(a.body));
  m.residentTurn.mockResolvedValue({ reply: "Wi-Fi: 4709A, password sunny42.", sessionId: "s1", traceId: "tr1", lane: "fast_path", model: null });
});

describe("resident text on the shared line", () => {
  it("debounces, takes the fast path, bubbles the reply, settles and logs the turn", async () => {
    const res = await runClaimedInbound(fakeDb({ ...PAYLOAD, sharedLine: true }), claim({ sharedLine: true }));
    expect(res.status).toBe(200);
    expect(m.debounce).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "resident", ownerUserId: "owner-a", waitMs: 1500, messageSid: "SM1", immediate: false }));
    expect(m.residentTurn.mock.calls[0]![1]).toMatchObject({ fastPath: true, inboundText: "wifi password?" });
    expect(m.deliver.mock.calls[0]![0]).toMatchObject({ workspaceId: "ws-a", bubbles: true, inboundText: "wifi password?", text: "Wi-Fi: 4709A, password sunny42." });
    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(m.metrics).toHaveBeenCalledTimes(1);
    expect(m.metrics.mock.calls[0]![1]).toMatchObject({
      ownerUserId: "owner-a", messageSid: "SM1", role: "resident", traceId: "tr1",
      metrics: { intent: "faq", lane: "fast_path", modelUsed: null, replyStatus: "sent", bubbleCount: 1 },
    });
    const logged = m.metrics.mock.calls[0]![1].metrics;
    expect(logged.firstBubbleMs === null || logged.firstBubbleMs >= 0).toBe(true);
  });

  it("answers the merged burst, oldest first", async () => {
    m.debounce.mockResolvedValue(proceed("hey\nis the wifi down", 2));
    m.residentTurn.mockResolvedValue({ reply: "Checking.", sessionId: "s1", traceId: "tr1", lane: "agent", model: "claude-sonnet-4-6" });
    await runClaimedInbound(fakeDb({ ...PAYLOAD, sharedLine: true }), claim({ sharedLine: true }));
    expect(m.residentTurn.mock.calls[0]![1].inboundText).toBe("hey\nis the wifi down");
    expect(m.metrics.mock.calls[0]![1].metrics).toMatchObject({ lane: "agent", modelUsed: "claude-sonnet-4-6", intent: "maintenance" });
  });

  it("an older text of a burst yields: no agent turn, no reply, claim completed, forwards still run", async () => {
    m.debounce.mockResolvedValue({ proceed: false });
    const res = await runClaimedInbound(fakeDb({ ...PAYLOAD, sharedLine: true }), claim({ sharedLine: true }));
    expect(res.status).toBe(200);
    expect(m.residentTurn).not.toHaveBeenCalled();
    expect(m.deliver).not.toHaveBeenCalled();
    expect(m.metrics).not.toHaveBeenCalled();
    expect(m.forward).toHaveBeenCalledTimes(1);
    expect(m.finish).toHaveBeenCalledWith(expect.anything(), "SM1", "w1", "completed");
  });

  it("a text with a photo answers at once", async () => {
    await runClaimedInbound(
      fakeDb({ ...PAYLOAD, media: { NumMedia: "1" }, sharedLine: true }),
      claim({ sharedLine: true, media: { NumMedia: "1" } }),
    );
    expect(m.debounce.mock.calls[0]![1]).toMatchObject({ immediate: true });
  });

  it("a reply held as a draft is logged as a draft, not sent, and nothing is delivered", async () => {
    m.gate.mockResolvedValue({ held: true });
    await runClaimedInbound(fakeDb({ ...PAYLOAD, sharedLine: true }), claim({ sharedLine: true }));
    expect(m.deliver).not.toHaveBeenCalled();
    expect(m.metrics.mock.calls[0]![1].metrics).toMatchObject({ replyStatus: "draft", firstBubbleMs: null });
  });

  it("the slow-work ack goes out on its own key", async () => {
    await runClaimedInbound(fakeDb({ ...PAYLOAD, sharedLine: true }), claim({ sharedLine: true }));
    const onSlowWork = m.residentTurn.mock.calls[0]![1].onSlowWork as () => Promise<void>;
    expect(typeof onSlowWork).toBe("function");
    await onSlowWork();
    expect(m.deliver.mock.calls.at(-1)![0]).toMatchObject({ text: "On it, I'll text you when it's done.", dedupeSuffix: "_ack", inboundMessageSid: "SM1" });
  });
});

describe("resident text on a work number", () => {
  it("behaves as before: no fast path, no bubbles, no wait, no ack", async () => {
    const res = await runClaimedInbound(fakeDb(PAYLOAD), claim());
    expect(res.status).toBe(200);
    expect(m.debounce.mock.calls[0]![1]).toMatchObject({ waitMs: 0 });
    expect(m.residentTurn.mock.calls[0]![1]).toMatchObject({ fastPath: false, onSlowWork: undefined });
    expect(m.deliver.mock.calls[0]![0]).toMatchObject({ bubbles: false });
  });
});
