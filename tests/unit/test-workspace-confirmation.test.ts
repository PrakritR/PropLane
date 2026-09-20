import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  peek: vi.fn(),
  claim: vi.fn(),
  markFailed: vi.fn(),
  currentProvenance: vi.fn(),
  classify: vi.fn(),
  feature: vi.fn(),
}));

vi.mock("@/lib/tools/pending-actions", () => ({
  peekPendingActionPortal: mocks.peek,
  claimPendingAction: mocks.claim,
  markPendingActionFailed: mocks.markFailed,
}));
vi.mock("@/lib/sms/sms-test-provenance.server", () => ({ currentSmsTestProvenance: mocks.currentProvenance }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: mocks.classify,
  isTestWorkspaceFeatureEnabled: mocks.feature,
}));
vi.mock("@/lib/observability/langfuse", () => ({ traceAgentAction: vi.fn((_actor, _action, run) => run()) }));

import { runConfirmedPendingActionForPortal } from "@/lib/tools/confirm-gate.server";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.peek.mockResolvedValue({ state: "found", portal: "resident", toolName: "update_profile", smsTestProvenance: { actorUserId: ACTOR, managerUserId: "manager-a", sessionId: "session-a", workspaceId: WORKSPACE_A } });
  mocks.currentProvenance.mockReturnValue({ actorUserId: ACTOR, managerUserId: "manager-a", sessionId: "session-a", workspaceId: WORKSPACE_A });
  mocks.feature.mockReturnValue(true);
});

describe("SMS test pending confirmation workspace boundary", () => {
  it.each([
    [{ kind: "classified", workspaceId: WORKSPACE_A, role: "resident", state: "suspended" }],
    [{ kind: "classified", workspaceId: WORKSPACE_A, role: "resident", state: "expired" }],
    [{ kind: "classified", workspaceId: "foreign-workspace", role: "resident", state: "active" }],
    [{ kind: "normal" }],
  ])("rejects a proposal after revocation or workspace mismatch: %j", async (classification) => {
    mocks.classify.mockResolvedValue(classification);
    const result = await runConfirmedPendingActionForPortal(
      { userId: ACTOR, db: {} } as never,
      new Map() as never,
      "resident",
      "action-a",
    );

    expect(result).toEqual({ ok: false, status: 410, error: "This action is no longer available. Ask the assistant again." });
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
