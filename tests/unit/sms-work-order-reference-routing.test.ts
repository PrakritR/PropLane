import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  managerResolve: vi.fn(),
  residentResolve: vi.fn(),
  runTurn: vi.fn(async (_db, args) => ({ reply: args.precomputedReply ?? "model", sessionId: "session" })),
}));

vi.mock("@/lib/tools", () => ({
  buildManagerSmsRegistry: vi.fn(() => new Map()),
  MANAGER_INLINE_WRITE_TOOLS: [],
}));
vi.mock("@/lib/tools/resident-index", () => ({ buildResidentRegistry: vi.fn(() => new Map()) }));
vi.mock("@/lib/agent/sms-agent-turn.server", () => ({ runSmsAgentTurn: mocks.runTurn }));
vi.mock("@/lib/tools/work-order-reference-resolution", () => ({
  resolveManagerWorkOrderReference: mocks.managerResolve,
  resolveResidentWorkOrderReference: mocks.residentResolve,
  workOrderReferencePromptContext: (resolution: { kind: string; candidates: Array<{ id: string; reference: string }> }) =>
    resolution.kind === "resolved"
      ? `Resolved ${resolution.candidates[0]!.reference} to ${resolution.candidates[0]!.id}`
      : null,
}));

import { runManagerSmsAgentTurn } from "@/lib/agent/manager-sms-agent.server";
import { runResidentSmsAgentTurn } from "@/lib/agent/resident-sms-agent.server";

const resolved = {
  kind: "resolved" as const,
  candidates: [{
    id: "opaque-id",
    reference: "WO-1042",
    title: "Kitchen sink",
    propertyName: "Cascade",
    unit: "2A",
    status: "Open",
  }] as const,
  message: null,
};

describe("SMS work-order reference narrowing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds a manager-scoped match before the model handles intent", async () => {
    mocks.managerResolve.mockResolvedValue(resolved);
    await runManagerSmsAgentTurn({} as never, {
      ctx: { landlordId: "manager", userId: "manager" } as never,
      managerPhoneE164: "+12065550100",
      inboundText: "status WO-1042",
    });
    expect(mocks.managerResolve).toHaveBeenCalledWith(expect.objectContaining({ landlordId: "manager" }), "status WO-1042");
    expect(mocks.runTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        additionalSystemContext: "Resolved WO-1042 to opaque-id",
        precomputedReply: null,
        traceMetadata: expect.objectContaining({ workOrderReference: "WO-1042" }),
      }),
    );
  });

  it("returns the generic resident miss without handing the claim to the model", async () => {
    mocks.residentResolve.mockResolvedValue({
      kind: "not_found",
      candidates: [],
      message: "We can't find that work order.",
    });
    const ctx = { userId: "resident", landlordId: "resident", activeManagerId: "manager" } as never;
    await runResidentSmsAgentTurn({} as never, {
      ctx,
      ownerManagerUserId: "manager",
      residentPhoneE164: "+12065550200",
      inboundText: "WO-1042",
    });
    expect(mocks.residentResolve).toHaveBeenCalledWith(ctx, "WO-1042");
    expect(mocks.runTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        precomputedReply: "We can't find that work order.",
        additionalSystemContext: null,
      }),
    );
  });

  it("does not pay the lookup cost for ordinary SMS messages", async () => {
    await runManagerSmsAgentTurn({} as never, {
      ctx: { landlordId: "manager", userId: "manager" } as never,
      managerPhoneE164: "+12065550100",
      inboundText: "What needs my attention?",
    });
    expect(mocks.managerResolve).not.toHaveBeenCalled();
    expect(mocks.runTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ additionalSystemContext: null, precomputedReply: null }),
    );
  });
});
