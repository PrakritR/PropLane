import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWritableCtx } from "./tools/fake-agent-ctx";

const mocks = vi.hoisted(() => ({
  runAgentTurn: vi.fn(),
  decidePendingAction: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/agent/loop", () => ({ runAgentTurn: mocks.runAgentTurn }));
vi.mock("@/lib/agent/pending-action-decision", () => ({
  decidePendingAction: mocks.decidePendingAction,
}));
vi.mock("@/lib/observability/langfuse", () => ({
  traceAgentTurn: async (_actor: unknown, _messages: unknown, run: (observer: object) => unknown, options: { onTraceId?: (id: string) => void }) => {
    options.onTraceId?.("trace-manager-sms");
    return run({});
  },
}));
vi.mock("@/lib/agent/user-preferences", () => ({
  loadAgentCustomInstructions: vi.fn(async () => null),
  withAgentCustomInstructions: (prompt: string) => prompt,
}));
vi.mock("@/lib/comms-billing/agent-usage.server", () => ({
  recordCommsAgentTurnUsage: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: mocks.track }));

import { runManagerSmsAgentTurn } from "@/lib/agent/manager-sms-agent.server";

const originalApiKey = process.env.ANTHROPIC_API_KEY;
const managerId = "11111111-1111-4111-8111-111111111111";
const conversationKey = `${managerId}:prospect:+12065550123`;

describe("manager SMS prospect proposal lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "unit-test-key";
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("stores the exact existing-thread reply proposal and executes it only after YES", async () => {
    const { ctx, store } = makeWritableCtx({
      agent_sessions: [],
      agent_messages: [],
      agent_pending_actions: [],
    }, { landlordId: managerId, userId: managerId });
    const input = {
      conversationKey,
      body: "The minimum lease is six months.",
      toPhone: "+12065550123",
    };
    mocks.runAgentTurn.mockResolvedValueOnce({
      reply: "I found the existing prospect thread.",
      toolTrace: [{ tool: "list_sms_conversations", ok: true }],
      pendingAction: {
        toolName: "reply_to_sms_conversation",
        input,
        preview: {
          kind: "reply_to_sms_conversation",
          title: "Send text reply",
          summary: "Text Potential tenant from the conversation owner's work number.",
          fields: [
            { label: "To", value: "+12065550123" },
            { label: "Message", value: input.body },
          ],
          confirmLabel: "Send text",
        },
      },
    });
    mocks.decidePendingAction.mockResolvedValue({
      kind: "confirmed",
      result: { ok: true, status: 200, reply: "Text submitted to +12065550123." },
    });

    const proposed = await runManagerSmsAgentTurn(ctx.db as never, {
      ctx,
      managerPhoneE164: "+12065550999",
      inboundText: "Message the Room 3 prospect that the minimum lease is six months.",
      inboundMessageSid: "SM-propose",
    });

    expect(proposed).toMatchObject({ awaitingConfirmation: true });
    expect(proposed?.reply).toContain("Reply YES to confirm or NO to cancel.");
    expect(mocks.decidePendingAction).not.toHaveBeenCalled();
    expect(store.agent_pending_actions).toHaveLength(1);
    expect(store.agent_pending_actions?.[0]).toMatchObject({
      user_id: managerId,
      portal: "manager",
      session_id: proposed?.sessionId,
      tool_name: "reply_to_sms_conversation",
      input,
      status: "proposed",
    });

    const confirmed = await runManagerSmsAgentTurn(ctx.db as never, {
      ctx,
      managerPhoneE164: "+12065550999",
      inboundText: "YES",
      inboundMessageSid: "SM-confirm",
    });

    expect(confirmed?.reply).toBe("Text submitted to +12065550123.");
    expect(mocks.runAgentTurn).toHaveBeenCalledTimes(1);
    expect(mocks.decidePendingAction).toHaveBeenCalledWith(expect.objectContaining({
      action: { kind: "confirm", actionId: proposed?.pendingActionId },
      ctx,
      portal: "manager",
    }));
  });
});
