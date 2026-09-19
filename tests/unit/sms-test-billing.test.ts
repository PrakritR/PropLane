import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordUsage: vi.fn(),
  resolveOpen: vi.fn(),
  denyOpen: vi.fn(),
  decidePending: vi.fn(),
}));

vi.mock("@/lib/comms-billing/agent-usage.server", () => ({
  recordCommsAgentTurnUsage: mocks.recordUsage,
}));
vi.mock("@/lib/sms/agent-confirmation.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/agent-confirmation.server")>()),
  resolveOpenSmsProposal: mocks.resolveOpen,
  denyOpenSmsProposal: mocks.denyOpen,
}));
vi.mock("@/lib/agent/pending-action-decision", () => ({
  decidePendingAction: mocks.decidePending,
}));

import { runSmsAgentTurn, type SmsAgentSurface } from "@/lib/agent/sms-agent-turn.server";
import { createMemoryDb } from "./support/memory-supabase";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";

const surface: SmsAgentSurface = {
  sessionKind: "resident_sms",
  portal: "resident",
  basePrompt: "test",
  promptId: "resident-sms-agent",
  traceName: "resident-sms-agent-turn",
  analytics: {
    messageIn: "resident_sms_message_in",
    messageOut: "resident_sms_message_out",
    actionProposed: "resident_sms_action_proposed",
  },
};

const ctx = {
  userId: ACTOR,
  landlordId: ACTOR,
  email: "resident@example.com",
  db: null,
};

function dbWithTables() {
  const db = createMemoryDb({
    agent_sessions: [],
    agent_messages: [],
    agent_pending_actions: [],
    portal_scheduled_inbox_message_records: [],
  });
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const query = from(table);
    if (table === "agent_messages") {
      (query as unknown as { gte: () => Promise<{ count: number; data: null; error: null }> }).gte =
        async () => ({ count: 0, data: null, error: null });
      const insert = query.insert.bind(query);
      query.insert = ((rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const withIds = (Array.isArray(rows) ? rows : [rows]).map((row, index) => ({
          id: String(row.id ?? `message-${db.__tables.agent_messages.length + index + 1}`),
          ...row,
        }));
        return insert(Array.isArray(rows) ? withIds : withIds[0]);
      }) as typeof query.insert;
    }
    return query;
  }) as typeof db.from;
  return db;
}

function testArgs(inboundText: string) {
  return {
    ctx: ctx as never,
    surface,
    registry: new Map() as never,
    sessionLandlordId: MANAGER,
    phoneE164: null,
    inboundText,
    traceActor: { userId: ACTOR, metadata: {} },
    traceMetadata: {},
    testActor: {
      userId: ACTOR,
      managerUserId: MANAGER,
      mode: "resident" as const,
      sessionKind: `resident_sms_test:${MANAGER}:listing-a`,
      targetListingId: "listing-a",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.resolveOpen.mockResolvedValue({ status: "none" });
  mocks.denyOpen.mockResolvedValue({ denied: true, toolName: "schedule_message" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SMS test turn communication usage", () => {
  it("does not bill a deterministic test reply", async () => {
    const db = dbWithTables();
    const result = await runSmsAgentTurn(db as never, {
      ...testArgs("What is my application status?"),
      precomputedReply: "Your application is submitted.",
    });

    expect(result?.reply).toBe("Your application is submitted.");
    expect(result?.assistantMessageId).toBeTruthy();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["YES", { kind: "confirmed", result: { ok: true, reply: "Done." } }, "Done."],
    ["NO", { kind: "denied", known: true }, "No problem, I have cancelled that. Anything else?"],
  ])("does not bill the %s confirmation path", async (text, decision, expectedReply) => {
    const db = dbWithTables();
    mocks.resolveOpen.mockResolvedValue({
      status: "one",
      actionId: "action-1",
      toolName: "send_message_to_manager",
    });
    mocks.decidePending.mockResolvedValue(decision);

    const result = await runSmsAgentTurn(db as never, testArgs(text));

    expect(result?.reply).toBe(expectedReply);
    expect(result?.pendingActionId).toBe("action-1");
    expect(mocks.decidePending).toHaveBeenCalledTimes(1);
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("continues billing an ordinary live SMS turn", async () => {
    const db = dbWithTables();
    const result = await runSmsAgentTurn(db as never, {
      ...testArgs("status"),
      testActor: undefined,
      phoneE164: "+12065550123",
      precomputedReply: "Live reply.",
    });

    expect(result?.reply).toBe("Live reply.");
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledWith(db, expect.objectContaining({
      channel: "sms",
      managerUserId: ACTOR,
    }));
  });

});
