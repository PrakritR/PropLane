/**
 * Unit coverage for `handlePendingActionDecision` scoring: confirm/deny must
 * score `action-approved` on the SERVER-STORED proposal trace, never trust a
 * client-supplied id, and skip scoring when no proposal trace exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  denyPendingAction,
  peekPendingActionPortal,
  runConfirmedPendingActionForPortal,
  scoreActionApproval,
  traceAgentAction,
  track,
  appendAgentMessages,
} = vi.hoisted(() => ({
  denyPendingAction: vi.fn(),
  peekPendingActionPortal: vi.fn(),
  runConfirmedPendingActionForPortal: vi.fn(),
  scoreActionApproval: vi.fn(),
  traceAgentAction: vi.fn(),
  track: vi.fn(),
  appendAgentMessages: vi.fn(),
}));

vi.mock("@/lib/tools/pending-actions", () => ({
  denyPendingAction,
  peekPendingActionPortal,
}));
vi.mock("@/lib/tools/confirm-gate.server", () => ({
  runConfirmedPendingActionForPortal,
}));
vi.mock("@/lib/observability/langfuse", () => ({
  scoreActionApproval,
  traceAgentAction,
}));
vi.mock("@/lib/analytics/posthog", () => ({ track }));
vi.mock("@/lib/agent/sessions", () => ({ appendAgentMessages }));

import { agentChatRateLimitResponse, decidePendingAction, handlePendingActionDecision } from "@/lib/agent/pending-action-decision";

const ctx = { userId: "user_a", landlordId: "user_a", db: {} as never };
const registry = { get: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  peekPendingActionPortal.mockResolvedValue({
    state: "found",
    portal: "manager",
    toolName: "send_message",
  });
  scoreActionApproval.mockResolvedValue(true);
  traceAgentAction.mockImplementation(async (_actor, _info, run) => run());
});

describe("handlePendingActionDecision scoring", () => {
  it("scores action-approved=0 on deny when a proposal trace is stored", async () => {
    denyPendingAction.mockResolvedValue({
      toolName: "send_message",
      input: {},
      portal: "manager",
      sessionId: null,
      proposalTraceId: "lf-proposal-1",
    });

    const res = await handlePendingActionDecision({
      body: { denyActionId: "act-1" },
      ctx,
      registry,
      portal: "manager",
    });
    expect(res?.status).toBe(200);
    expect(scoreActionApproval).toHaveBeenCalledWith({
      traceId: "lf-proposal-1",
      approved: false,
      actionId: "act-1",
      toolName: "send_message",
    });
    expect(traceAgentAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ decision: "cancel", actionId: "act-1", proposalTraceId: "lf-proposal-1" }),
      expect.any(Function),
    );
  });

  it("does not score when deny has no proposal trace (tour proposals)", async () => {
    denyPendingAction.mockResolvedValue({
      toolName: "confirm_tour_inquiry",
      input: {},
      portal: "manager",
      sessionId: null,
      proposalTraceId: null,
    });
    await handlePendingActionDecision({
      body: { denyActionId: "act-tour" },
      ctx,
      registry,
      portal: "manager",
    });
    expect(scoreActionApproval).not.toHaveBeenCalled();
  });

  it("scores action-approved=1 on confirm using the claim's proposalTraceId", async () => {
    runConfirmedPendingActionForPortal.mockResolvedValue({
      ok: true,
      reply: "Done.",
      toolName: "send_message",
      sessionId: "sess-1",
      proposalTraceId: "lf-proposal-2",
    });

    const res = await handlePendingActionDecision({
      body: { confirmActionId: "act-2" },
      ctx,
      registry,
      portal: "manager",
    });
    expect(res?.status).toBe(200);
    expect(scoreActionApproval).toHaveBeenCalledWith({
      traceId: "lf-proposal-2",
      approved: true,
      actionId: "act-2",
      toolName: "send_message",
    });
  });

  it("uses the same scored decision service for an SMS resident denial", async () => {
    peekPendingActionPortal.mockResolvedValue({
      state: "found",
      portal: "resident",
      toolName: "report_maintenance_issue",
    });
    denyPendingAction.mockResolvedValue({
      toolName: "report_maintenance_issue",
      input: {},
      portal: "resident",
      sessionId: "resident-sms-session",
      proposalTraceId: "lf-resident-sms-proposal",
    });

    const result = await decidePendingAction({
      action: { kind: "deny", actionId: "resident-action-1" },
      ctx,
      registry,
      portal: "resident",
      traceMetadata: {
        landlordId: "user_a",
        role: "resident",
        channel: "sms",
        sessionId: "resident-sms-session",
      },
    });

    expect(result).toEqual(expect.objectContaining({ kind: "denied", known: true }));
    expect(traceAgentAction).toHaveBeenCalledWith(
      {
        userId: "user_a",
        metadata: {
          landlordId: "user_a",
          role: "resident",
          channel: "sms",
          sessionId: "resident-sms-session",
        },
      },
      expect.objectContaining({
        decision: "cancel",
        actionId: "resident-action-1",
        proposalTraceId: "lf-resident-sms-proposal",
      }),
      expect.any(Function),
    );
    expect(scoreActionApproval).toHaveBeenCalledWith({
      traceId: "lf-resident-sms-proposal",
      approved: false,
      actionId: "resident-action-1",
      toolName: "report_maintenance_issue",
    });
  });

  it("does not discard a proposal owned by another portal", async () => {
    peekPendingActionPortal.mockResolvedValue({
      state: "found",
      portal: "resident",
      toolName: "report_maintenance_issue",
    });

    const result = await decidePendingAction({
      action: { kind: "deny", actionId: "resident-action-from-manager" },
      ctx,
      registry,
      portal: "manager",
    });

    expect(result).toEqual(expect.objectContaining({ kind: "denied", known: false }));
    expect(denyPendingAction).not.toHaveBeenCalled();
    expect(scoreActionApproval).not.toHaveBeenCalled();
  });

  it("returns null for ordinary chat bodies", async () => {
    const res = await handlePendingActionDecision({
      body: { messages: [] },
      ctx,
      registry,
      portal: "manager",
    });
    expect(res).toBeNull();
  });
});


describe("chat quota and pending-action cancellation", () => {
  it.each(["manager", "resident", "vendor"] as const)("allows %s denial after chat quota is exhausted while confirmations remain limited", async (portal) => {
    const actor = { ...ctx, userId: `quota-${portal}` };
    for (let index = 0; index < 20; index += 1) {
      expect((await agentChatRateLimitResponse({ messages: [{ role: "user", content: "Hi" }] }, actor.userId, portal))).toBeNull();
    }
    expect((await agentChatRateLimitResponse({ messages: [] }, actor.userId, portal)?.status).toBe(429);
    expect((await agentChatRateLimitResponse({ confirmActionId: "action" }, actor.userId, portal)?.status).toBe(429);
    expect((await agentChatRateLimitResponse({ denyActionId: "action", confirmActionId: "action" }, actor.userId, portal)?.status).toBe(429);
    expect((await agentChatRateLimitResponse({ denyActionId: "action", messages: [] }, actor.userId, portal)?.status).toBe(429);
    expect((await agentChatRateLimitResponse({ denyActionId: " " }, actor.userId, portal)?.status).toBe(429);

    peekPendingActionPortal.mockResolvedValue({ state: "found", portal, toolName: "send_message" });
    denyPendingAction.mockResolvedValue({ toolName: "send_message", portal, proposalTraceId: null });
    const body = { denyActionId: "action" };
    expect((await agentChatRateLimitResponse(body, actor.userId, portal))).toBeNull();
    const response = await handlePendingActionDecision({ body, ctx: actor, registry, portal });
    expect(response?.status).toBe(200);
    expect(denyPendingAction).toHaveBeenCalledWith(actor, "action");
    expect(runConfirmedPendingActionForPortal).not.toHaveBeenCalled();
  });

  it("bounds cancellation independently without consuming chat capacity", async () => {
    const userId = "denial-capacity";
    for (let index = 0; index < 60; index += 1) {
      expect((await agentChatRateLimitResponse({ denyActionId: "action" }, userId, "manager"))).toBeNull();
    }
    expect((await agentChatRateLimitResponse({ denyActionId: "action" }, userId, "manager")?.status).toBe(429);
    expect((await agentChatRateLimitResponse({ confirmActionId: "action" }, userId, "manager"))).toBeNull();
  });
});
