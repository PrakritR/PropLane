import { describe, expect, it, vi } from "vitest";

import {
  completeSmsTestBurst,
  recordAndClaimSmsTestBurst,
} from "@/lib/sms/sms-test-burst.server";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const BURST = "33333333-3333-4333-8333-333333333333";

describe("authenticated SMS test burst", () => {
  it("records authenticated ingress then claims the exact durable revision", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: [{ burst_id: BURST, revision: 7, inserted: true }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ claimed: true, source_ids: ["source-a", "source-b"] }],
        error: null,
      });

    const result = await recordAndClaimSmsTestBurst({ rpc } as never, {
      managerUserId: MANAGER,
      actorUserId: ACTOR,
      sessionId: "session-1",
      body: "Can I tour tomorrow?",
    });

    expect(result).toMatchObject({
      burstId: BURST,
      revision: 7,
      sourceIds: ["source-a", "source-b"],
    });
    expect(result?.sourceMessageId).toMatch(/^sms-test:/);
    expect(result?.workerId).toMatch(/^sms-test-/);
    expect(rpc).toHaveBeenNthCalledWith(1, "record_authenticated_sms_test_ingress", {
      p_source_message_id: result?.sourceMessageId,
      p_manager_user_id: MANAGER,
      p_test_actor_user_id: ACTOR,
      p_test_session_id: "session-1",
      p_body: "Can I tour tomorrow?",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "claim_authenticated_sms_test_burst", {
      p_burst_id: BURST,
      p_revision: 7,
      p_worker_id: result?.workerId,
      p_lease_seconds: 120,
      p_test_actor_user_id: ACTOR,
      p_test_session_id: "session-1",
    });
  });

  it("does not invent a turn when the durable revision is invalid or the claim loses", async () => {
    const invalidRevision = vi.fn().mockResolvedValue({
      data: [{ burst_id: BURST, revision: 0 }],
      error: null,
    });
    await expect(recordAndClaimSmsTestBurst({ rpc: invalidRevision } as never, {
      managerUserId: MANAGER,
      actorUserId: ACTOR,
      sessionId: "session-1",
      body: "hello",
    })).resolves.toBeNull();
    expect(invalidRevision).toHaveBeenCalledTimes(1);

    const lostClaim = vi.fn()
      .mockResolvedValueOnce({ data: [{ burst_id: BURST, revision: 2 }], error: null })
      .mockResolvedValueOnce({ data: [{ claimed: false }], error: null });
    await expect(recordAndClaimSmsTestBurst({ rpc: lostClaim } as never, {
      managerUserId: MANAGER,
      actorUserId: ACTOR,
      sessionId: "session-1",
      body: "hello again",
    })).resolves.toBeNull();
  });

  it("fails closed on ingress and claim persistence errors", async () => {
    const ingressFailure = vi.fn().mockResolvedValue({ data: null, error: { message: "offline" } });
    await expect(recordAndClaimSmsTestBurst({ rpc: ingressFailure } as never, {
      managerUserId: MANAGER,
      actorUserId: ACTOR,
      sessionId: "session-1",
      body: "hello",
    })).rejects.toThrow("Could not record the SMS test message");

    const claimFailure = vi.fn()
      .mockResolvedValueOnce({ data: [{ burst_id: BURST, revision: 2 }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "offline" } });
    await expect(recordAndClaimSmsTestBurst({ rpc: claimFailure } as never, {
      managerUserId: MANAGER,
      actorUserId: ACTOR,
      sessionId: "session-1",
      body: "hello",
    })).rejects.toThrow("Could not claim the SMS test turn");
  });

  it("completes only through the actor, revision, and worker bound RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    await expect(completeSmsTestBurst({ rpc } as never, {
      burstId: BURST,
      revision: 9,
      workerId: "sms-test-worker",
      sourceIds: ["source-a"],
      sourceMessageId: "source-a",
      actorUserId: ACTOR,
      reply: "The 2 PM slot is available.",
      candidateContext: [{ tool: "list_open_tour_slots" }],
    })).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("complete_authenticated_sms_test_burst", {
      p_burst_id: BURST,
      p_revision: 9,
      p_worker_id: "sms-test-worker",
      p_test_actor_user_id: ACTOR,
      p_candidate_body: "The 2 PM slot is available.",
      p_candidate_context: [{ tool: "list_open_tour_slots" }],
    });

    rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(completeSmsTestBurst({ rpc } as never, {
      burstId: BURST,
      revision: 9,
      workerId: "stale-worker",
      sourceIds: ["source-a"],
      sourceMessageId: "source-a",
      actorUserId: ACTOR,
      reply: "stale",
    })).resolves.toBe(false);
  });
});
