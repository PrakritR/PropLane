import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildRegistry, defineWriteTool } from "@/lib/tools/registry";
import { createMemoryDb } from "../support/memory-supabase";

const mocks = vi.hoisted(() => ({ resolveOpen: vi.fn(), decide: vi.fn(), recordUsage: vi.fn() }));
vi.mock("@/lib/sms/agent-confirmation.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/agent-confirmation.server")>()),
  resolveOpenSmsProposal: mocks.resolveOpen,
}));
vi.mock("@/lib/agent/pending-action-decision", () => ({ decidePendingAction: mocks.decide }));
vi.mock("@/lib/comms-billing/agent-usage.server", () => ({ recordCommsAgentTurnUsage: mocks.recordUsage }));
vi.mock("@/lib/observability/langfuse", () => ({
  traceAgentTurn: async (_actor: unknown, _messages: unknown, run: (observer: object) => unknown, options: { onTraceId?: (id: string) => void }) => {
    options.onTraceId?.("trace-sms");
    return run({});
  },
}));
vi.mock("@/lib/agent/user-preferences", () => ({
  loadAgentCustomInstructions: vi.fn(async () => null),
  withAgentCustomInstructions: (prompt: string) => prompt,
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { runSmsAgentTurn, type SmsAgentSurface } from "@/lib/agent/sms-agent-turn.server";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";

function fixture(portal: "manager" | "resident") {
  const db = createMemoryDb({ agent_sessions: [], agent_messages: [], agent_pending_actions: [] });
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const query = from(table);
    if (table === "agent_messages") {
      (query as unknown as { gte: () => Promise<{ count: number; data: null; error: null }> }).gte =
        async () => ({ count: 0, data: null, error: null });
    }
    if (table === "agent_messages" || table === "agent_pending_actions") {
      if (table === "agent_pending_actions") {
        (query as unknown as { single: typeof query.maybeSingle }).single = query.maybeSingle.bind(query);
      }
      const insert = query.insert.bind(query);
      query.insert = ((rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const tableRows = db.__tables[table] as Record<string, unknown>[];
        const withIds = (Array.isArray(rows) ? rows : [rows]).map((row, index) => ({ id: `id-${table}-${tableRows.length + index + 1}`, ...row }));
        return insert(Array.isArray(rows) ? withIds : withIds[0]);
      }) as typeof query.insert;
    }
    return query;
  }) as typeof db.from;
  const surface: SmsAgentSurface = {
    sessionKind: `${portal}_sms`, portal, basePrompt: "Answer from tools only.",
    promptId: portal === "manager" ? "manager-sms-agent" : "resident-sms-agent",
    traceName: `${portal}-sms-agent-turn`,
    analytics: { messageIn: "sms_in", messageOut: "sms_out", actionProposed: "sms_proposed" },
  };
  const ctx = { userId: ACTOR, landlordId: portal === "manager" ? ACTOR : OWNER, db };
  const args = {
    ctx: ctx as never, surface, registry: buildRegistry([]), sessionLandlordId: OWNER,
    phoneE164: null, inboundText: "What is my status?",
    traceActor: { userId: ACTOR, metadata: {} }, traceMetadata: {},
    testActor: { userId: ACTOR, managerUserId: OWNER, mode: portal,
      sessionKind: `${portal}_sms_test:${OWNER}${portal === "resident" ? ":listing-a" : ""}`,
      ...(portal === "resident" ? { targetListingId: "listing-a" } : {}),
    },
  } as const;
  return { db, args };
}

function completed(text: string) {
  return new Response(JSON.stringify({ id: "resp-sms", model: "gpt-6-luna", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 30, output_tokens: 12 } }), { status: 200 });
}

describe("manager and resident workspace SMS Luna runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    mocks.resolveOpen.mockResolvedValue({ status: "none" });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.each(["manager", "resident"] as const)("runs %s through exact Luna with only the OpenAI key", async (portal) => {
    const fetchMock = vi.fn().mockResolvedValue(completed("Grounded answer."));
    vi.stubGlobal("fetch", fetchMock);
    const { db, args } = fixture(portal);
    const result = await runSmsAgentTurn(db as never, args);
    expect(result?.reply).toBe("Grounded answer.");
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(request).toMatchObject({ model: "gpt-6-luna", max_output_tokens: 8000,
      prompt_cache_options: { mode: "implicit", ttl: "30m" } });
    expect(request.input[0].role).toBe("developer");
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it.each(["manager", "resident"] as const)("skips %s model work for a precomputed reply and confirmation", async (portal) => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db, args } = fixture(portal);
    const precomputed = await runSmsAgentTurn(db as never, { ...args, precomputedReply: "Known answer." });
    expect(precomputed?.reply).toBe("Known answer.");
    mocks.resolveOpen.mockResolvedValue({ status: "one", actionId: "action-1", toolName: "send_message" });
    mocks.decide.mockResolvedValue({ kind: "denied", known: true });
    const confirmation = await runSmsAgentTurn(db as never, { ...args, inboundText: "NO" });
    expect(confirmation?.pendingActionId).toBe("action-1");
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ portal }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a proposed write behind confirmation even when Luna calls it", async () => {
    const handler = vi.fn(async () => ({ reply: "sent" }));
    const preview = vi.fn(async () => ({ kind: "send_message", title: "Send", confirmLabel: "Send",
      fields: [{ label: "To", value: "Resident" }] }));
    const registry = buildRegistry([defineWriteTool({ name: "send_message", description: "Send a message",
      inputSchema: z.object({ body: z.string() }), preview, handler })]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "resp-write", model: "gpt-6-luna", status: "completed",
      output: [{ type: "function_call", call_id: "call-1", name: "send_message", arguments: '{"body":"Hi"}' }],
      usage: { input_tokens: 45, output_tokens: 10 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { db, args } = fixture("manager");
    const result = await runSmsAgentTurn(db as never, { ...args, registry });
    expect(result).toMatchObject({ awaitingConfirmation: true });
    expect(preview).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect((db.__tables.agent_pending_actions as Record<string, unknown>[])[0]).toMatchObject({ portal: "manager", tool_name: "send_message" });
  });
});
