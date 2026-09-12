import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgentTurn: vi.fn(),
  reserveCredit: vi.fn(),
  completeTurn: vi.fn(),
  readTurn: vi.fn(),
  traceResult: null as { reply: string } | null,
  traceObserver: undefined as { onToolCall?: (event: unknown) => void } | undefined,
  agentMessageInserts: [] as Record<string, unknown>[],
  track: vi.fn(),
}));

vi.mock("@/lib/agent/loop", () => ({ runAgentTurn: mocks.runAgentTurn }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({ reserveCommsCredit: mocks.reserveCredit }));
vi.mock("@/lib/comms-billing/turn-result.server", () => ({
  INTERRUPTED_COMMS_REPLY: "interrupted",
  readCommsTurnResult: mocks.readTurn,
  completeCommsTurn: mocks.completeTurn,
}));
vi.mock("@/lib/agent/leasing-sms-custom-instructions", () => ({
  leasingSmsSystemPromptForWorkNumberOwner: vi.fn(async () => "sealed test prompt"),
}));
vi.mock("@/lib/observability/langfuse", () => ({
  traceAgentTurn: async (_actor: unknown, _history: unknown, run: (observer?: unknown) => Promise<{ reply: string }>) => {
    // Langfuse is normally absent in tests. The runtime must still observe the
    // typed tool payload when this callback receives no observer.
    const result = await run(mocks.traceObserver);
    mocks.traceResult = result;
    return result;
  },
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: mocks.track }));

function makeDb() {
  return {
    from(table: string) {
      let inserting = false;
      let selected = "";
      const builder: Record<string, unknown> = {
        select(columns?: string) {
          selected = columns ?? "";
          return builder;
        },
        eq: () => builder,
        gte: async () => ({ count: 0 }),
        order: () => builder,
        limit: async () => ({ data: [] }),
        insert(values: Record<string, unknown>) {
          inserting = true;
          if (table === "agent_messages") mocks.agentMessageInserts.push(values);
          return builder;
        },
        update: () => builder,
        maybeSingle: async () => {
          if (table === "agent_sessions") {
            return { data: { id: "session-1", landlord_id: "manager-1", kind: "leasing_sms", vendor_phone_e164: "+12065550123", status: "active" }, error: null };
          }
          if (table === "agent_messages" && inserting) return { data: { id: "inbound-1" }, error: null };
          return { data: null, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          if (table === "agent_messages" && selected.includes("role, content")) return Promise.resolve({ data: [] }).then(resolve);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.traceResult = null;
  mocks.traceObserver = undefined;
  mocks.agentMessageInserts = [];
  vi.stubEnv("ANTHROPIC_API_KEY", "sealed-test-key");
  mocks.reserveCredit.mockResolvedValue({ allowed: true, duplicate: false });
  mocks.completeTurn.mockImplementation(async (_db: unknown, _owner: string, _key: string, result: unknown) => result);
  mocks.readTurn.mockReset();
  mocks.runAgentTurn.mockImplementation(async (args: { observer?: { onToolCall?: (event: unknown) => void } }) => {
    args.observer?.onToolCall?.({
      iteration: 0,
      name: "escalate_to_manager",
      input: { summary: "Needs manager approval.", handoff: "quiet" },
      ok: true,
      output: { ok: true, quietHandoff: true },
    });
    return {
      reply: "The manager has been notified and will follow up.",
      toolTrace: [{ tool: "escalate_to_manager", ok: true }],
      model: "sealed-model",
      tier: "standard",
      provider: "anthropic",
      route: "anthropic",
      latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      iterationCount: 1,
      terminationReason: "end_turn",
      finalStopReason: "end_turn",
    };
  });
});

describe("leasing SMS quiet handoff runtime", () => {
  it("returns the quiet disposition without a fictional outbound message when tracing is disabled", async () => {
    const { runLeasingSmsAgentTurn } = await import("@/lib/agent/leasing-sms-agent.server");

    const turn = await runLeasingSmsAgentTurn(makeDb() as never, {
      landlordId: "manager-1",
      prospectPhoneE164: "+12065550123",
      inboundText: "I can reserve today if the manager approves this exception.",
      inboundMessageSid: "SM-quiet-runtime",
    });

    expect(turn).toMatchObject({ reply: "", disposition: "quiet_handoff", assistantMessageId: null });
    expect(mocks.traceResult).toMatchObject({ reply: "" });
    expect(mocks.agentMessageInserts).toHaveLength(1);
    expect(mocks.agentMessageInserts[0]).toMatchObject({ role: "user" });
    expect(mocks.track).not.toHaveBeenCalledWith("leasing_sms_message_out", expect.anything(), expect.anything());
  });

  it("keeps the ordinary reply when a successful tool transport contains a failed payload", async () => {
    mocks.runAgentTurn.mockImplementationOnce(async (args: { observer?: { onToolCall?: (event: unknown) => void } }) => {
      args.observer?.onToolCall?.({
        iteration: 0,
        name: "escalate_to_manager",
        input: { summary: "Needs manager approval.", handoff: "quiet" },
        ok: true,
        output: { ok: false, quietHandoff: true },
      });
      return {
        reply: "The manager has been notified and will follow up.",
        toolTrace: [{ tool: "escalate_to_manager", ok: true }],
        model: "sealed-model", tier: "standard", provider: "anthropic", route: "anthropic", latencyMs: 1,
        usage: { inputTokens: 1, outputTokens: 1 }, iterationCount: 1, terminationReason: "end_turn", finalStopReason: "end_turn",
      };
    });
    const { runLeasingSmsAgentTurn } = await import("@/lib/agent/leasing-sms-agent.server");

    const turn = await runLeasingSmsAgentTurn(makeDb() as never, {
      landlordId: "manager-1", prospectPhoneE164: "+12065550123", inboundText: "Can you make an exception?", inboundMessageSid: "SM-failed-payload",
    });

    expect(turn).toMatchObject({ reply: "The manager has been notified and will follow up." });
    expect(turn).not.toHaveProperty("disposition");
    expect(mocks.traceResult).toMatchObject({ reply: "The manager has been notified and will follow up." });
    expect(mocks.agentMessageInserts).toHaveLength(2);
  });

  it("keeps a delivered quiet handoff when the model fails after the tool call", async () => {
    mocks.runAgentTurn.mockImplementationOnce(async (args: { observer?: { onToolCall?: (event: unknown) => void } }) => {
      args.observer?.onToolCall?.({
        iteration: 0,
        name: "escalate_to_manager",
        input: { summary: "Needs manager approval.", handoff: "quiet" },
        ok: true,
        output: { ok: true, quietHandoff: true },
      });
      throw new Error("final provider call failed");
    });
    const { runLeasingSmsAgentTurn } = await import("@/lib/agent/leasing-sms-agent.server");

    const turn = await runLeasingSmsAgentTurn(makeDb() as never, {
      landlordId: "manager-1", prospectPhoneE164: "+12065550123", inboundText: "Please reserve this now.",
      inboundMessageSid: "SM-post-handoff-provider-failure",
    });

    expect(turn).toMatchObject({ reply: "", disposition: "quiet_handoff", assistantMessageId: null });
    expect(mocks.agentMessageInserts).toHaveLength(1);
  });

  it("detects quiet delivery even when the optional trace observer throws", async () => {
    mocks.traceObserver = { onToolCall: () => { throw new Error("trace unavailable"); } };
    const { runLeasingSmsAgentTurn } = await import("@/lib/agent/leasing-sms-agent.server");

    const turn = await runLeasingSmsAgentTurn(makeDb() as never, {
      landlordId: "manager-1", prospectPhoneE164: "+12065550123", inboundText: "Please reserve this now.",
      inboundMessageSid: "SM-throwing-observer",
    });

    expect(turn).toMatchObject({ reply: "", disposition: "quiet_handoff" });
  });

  it("keeps voice replies audible even if the tool requests a quiet handoff", async () => {
    const { runLeasingSmsAgentTurn } = await import("@/lib/agent/leasing-sms-agent.server");

    const turn = await runLeasingSmsAgentTurn(makeDb() as never, {
      landlordId: "manager-1", prospectPhoneE164: "+12065550123", inboundText: "Please reserve this now.",
      inboundMessageSid: "CA-quiet-voice", channel: "voice",
    });

    expect(turn).toMatchObject({ reply: "The manager has been notified and will follow up." });
    expect(turn).not.toHaveProperty("disposition");
    expect(mocks.agentMessageInserts).toHaveLength(2);
  });

  it("replays a stored quiet disposition without rerunning the model or tool", async () => {
    mocks.reserveCredit.mockResolvedValue({ allowed: true, duplicate: true });
    mocks.readTurn.mockResolvedValue({
      reply: "", disposition: "quiet_handoff", sessionId: "session-1", inboundMessageId: "inbound-1", assistantMessageId: null, traceId: "trace-quiet",
    });
    const { runLeasingSmsAgentTurn } = await import("@/lib/agent/leasing-sms-agent.server");

    const turn = await runLeasingSmsAgentTurn(makeDb() as never, {
      landlordId: "manager-1", prospectPhoneE164: "+12065550123", inboundText: "Please reserve this now.", inboundMessageSid: "SM-quiet-replay",
    });

    expect(turn).toMatchObject({ reply: "", disposition: "quiet_handoff" });
    expect(mocks.runAgentTurn).not.toHaveBeenCalled();
    expect(mocks.agentMessageInserts).toHaveLength(1);
  });
});
