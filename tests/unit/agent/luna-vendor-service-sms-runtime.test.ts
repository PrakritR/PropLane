import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "../support/memory-supabase";

const mocks = vi.hoisted(() => ({ reserve: vi.fn(), complete: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  resolveWorkspaceIdForWorkOrder: vi.fn(async () => "workspace-a"), reserveCommsCredit: mocks.reserve,
}));
vi.mock("@/lib/comms-billing/turn-result.server", () => ({
  completeCommsTurn: mocks.complete, readCommsTurnResult: vi.fn(), INTERRUPTED_COMMS_REPLY: "Interrupted",
}));
vi.mock("@/lib/comms-billing/rates", () => ({ isCommsCreditPoolEnabled: () => false }));
vi.mock("@/lib/observability/langfuse", () => ({
  traceAgentTurn: async (_actor: unknown, _messages: unknown, run: (observer: object) => unknown) => run({}),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { runVendorAgentSessionTurn, type VendorAgentSessionRow } from "@/lib/agent/vendor-agent.server";

const session: VendorAgentSessionRow = {
  id: "session-vendor", landlord_id: "manager-a", kind: "vendor_work_order", vendor_user_id: "vendor-a",
  vendor_directory_id: "directory-a", work_order_id: "service-a", vendor_phone_e164: null,
  status: "active", inbox_thread_id: null,
};

function fixture() {
  const db = createMemoryDb({ agent_messages: [], agent_sessions: [session] });
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const query = from(table);
    if (table === "agent_messages") {
      (query as unknown as { gte: () => Promise<{ count: number; data: null; error: null }> }).gte =
        async () => ({ count: 0, data: null, error: null });
    }
    return query;
  }) as typeof db.from;
  return db;
}

describe("vendor service SMS Luna runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    mocks.reserve.mockResolvedValue({ allowed: true, duplicate: false, state: "reserved" });
    mocks.complete.mockImplementation(async (_db: unknown, _owner: string, _key: string, reply: string) => reply);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("reserves credit, sends the scoped SMS turn to Luna, and completes the ledger", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "resp-vendor", model: "gpt-6-luna", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "The service is scheduled." }] }],
      usage: { input_tokens: 50, output_tokens: 12 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runVendorAgentSessionTurn(fixture() as never, session, "What is the service status?", "sms", { inboundMessageSid: "SM-vendor" });
    expect(result).toBe("The service is scheduled.");
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({ model: "gpt-6-luna", max_output_tokens: 8000 });
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it("uses a precomputed reply without provider work", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const reply = await runVendorAgentSessionTurn(fixture() as never, session, "WO-404?", "sms", { precomputedReply: "We can't find that service." });
    expect(reply).toBe("We can't find that service.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
});
