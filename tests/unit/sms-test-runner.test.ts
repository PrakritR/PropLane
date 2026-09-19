import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertEnvironment: vi.fn(),
  serviceDb: vi.fn(),
  runManager: vi.fn(),
  runResident: vi.fn(),
  runLeasing: vi.fn(),
  findLeasingSession: vi.fn(),
  recordAndClaim: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("@/lib/agent/sms-test-context.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/sms-test-context.server")>()),
  assertSmsTestEnvironment: mocks.assertEnvironment,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: mocks.serviceDb,
}));
vi.mock("@/lib/agent/manager-sms-agent.server", () => ({
  runManagerSmsAgentTurn: mocks.runManager,
}));
vi.mock("@/lib/agent/resident-sms-agent.server", () => ({
  runResidentSmsAgentTurn: mocks.runResident,
}));
vi.mock("@/lib/agent/leasing-sms-agent.server", () => ({
  runLeasingSmsAgentTurn: mocks.runLeasing,
  findOrCreateLeasingSmsTestSession: mocks.findLeasingSession,
}));
vi.mock("@/lib/sms/sms-test-burst.server", () => ({
  recordAndClaimSmsTestBurst: mocks.recordAndClaim,
  completeSmsTestBurst: mocks.complete,
}));

import { runSmsTestTurn } from "@/lib/agent/sms-test-runner.server";
import { captureSmsTestDelivery } from "@/lib/sms/sms-test-transport.server";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";

function prospectContext() {
  return {
    capability: {
      enabled: true as const,
      portal: "resident" as const,
      actorUserId: ACTOR,
      actorName: "Alex",
      targets: [],
    },
    mode: "prospect" as const,
    stage: "prospect" as const,
    managerUserId: MANAGER,
    sessionKind: `leasing_sms_test:${MANAGER}:listing-1`,
    target: {
      listingId: "listing-1",
      managerUserId: MANAGER,
      title: "Oak Home",
      address: "1 Oak St",
    },
    actorEmail: "alex@example.com",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.serviceDb.mockReturnValue({ db: true });
  mocks.recordAndClaim.mockResolvedValue({
    burstId: "burst-1",
    revision: 6,
    workerId: "sms-test-worker",
    sourceIds: ["source-1"],
    sourceMessageId: "sms-test:source-1",
  });
  mocks.complete.mockResolvedValue(true);
  mocks.findLeasingSession.mockResolvedValue({
    id: "session-1",
    landlord_id: MANAGER,
    kind: `leasing_sms_test:${MANAGER}:listing-1`,
    vendor_phone_e164: null,
    status: "active",
  });
  mocks.runLeasing.mockImplementation(async () => {
    captureSmsTestDelivery({
      kind: "reminder",
      summary: "Delayed tour follow-up captured.",
      status: "captured",
      metadata: { delayed: true },
    });
    return {
      reply: "Which time works for you?",
      sessionId: "session-1",
      traceId: "trace-1",
      toolTrace: [{ tool: "list_open_tour_slots", ok: true }],
      candidateContext: [{ tool: "list_open_tour_slots" }],
    };
  });
});

describe("runSmsTestTurn prospect lane", () => {
  it("uses the durable claimed revision, authenticated actor, autonomous registry path, and captured effects", async () => {
    const context = prospectContext();
    const result = await runSmsTestTurn({ context, message: " Can I tour tomorrow? " });

    expect(mocks.assertEnvironment).toHaveBeenCalledOnce();
    expect(mocks.recordAndClaim).toHaveBeenCalledWith({ db: true }, {
      managerUserId: MANAGER,
      actorUserId: ACTOR,
      sessionId: "session-1",
      body: "Can I tour tomorrow?",
    });
    expect(mocks.runLeasing).toHaveBeenCalledWith({ db: true }, expect.objectContaining({
      landlordId: MANAGER,
      inboundText: "Can I tour tomorrow?",
      inboundMessageSid: "sms-test:source-1",
      crossCatalog: false,
      prospectBurst: {
        burstId: "burst-1",
        revision: 6,
        workerId: "sms-test-worker",
        claimedSourceIds: ["source-1"],
        testSessionId: "session-1",
      },
      testActor: {
        userId: ACTOR,
        email: "alex@example.com",
        targetListingId: "listing-1",
        sessionKind: `leasing_sms_test:${MANAGER}:listing-1`,
        sessionId: "session-1",
      },
      testTarget: { listingId: "listing-1", title: "Oak Home" },
    }));
    expect(mocks.complete).toHaveBeenCalledWith({ db: true }, expect.objectContaining({
      burstId: "burst-1",
      revision: 6,
      workerId: "sms-test-worker",
      actorUserId: ACTOR,
      reply: "Which time works for you?",
      candidateContext: [{ tool: "list_open_tour_slots" }],
    }));
    expect(result).toMatchObject({
      reply: "Which time works for you?",
      sessionId: "session-1",
      traceId: "trace-1",
      mode: "prospect",
      stage: "prospect",
      effects: [{ kind: "reminder", status: "captured" }],
    });
  });

  it("fails closed when the revision cannot be claimed or committed", async () => {
    mocks.recordAndClaim.mockResolvedValueOnce(null);
    await expect(runSmsTestTurn({
      context: prospectContext(),
      message: "tour",
    })).rejects.toThrow("could not be claimed");
    expect(mocks.runLeasing).not.toHaveBeenCalled();

    mocks.recordAndClaim.mockResolvedValueOnce({
      burstId: "burst-2",
      revision: 2,
      workerId: "worker-2",
      sourceIds: ["source-2"],
      sourceMessageId: "sms-test:source-2",
    });
    mocks.complete.mockResolvedValueOnce(false);
    await expect(runSmsTestTurn({
      context: prospectContext(),
      message: "tour",
    })).rejects.toThrow("could not be committed");
  });

  it("requires the server-resolved target and a non-empty message", async () => {
    await expect(runSmsTestTurn({
      context: { ...prospectContext(), target: null },
      message: "tour",
    })).rejects.toThrow("session is invalid");
    await expect(runSmsTestTurn({
      context: prospectContext(),
      message: "   ",
    })).rejects.toThrow("message is required");
    expect(mocks.recordAndClaim).not.toHaveBeenCalled();
  });
});
