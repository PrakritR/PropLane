import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import type { AgentContext } from "@/lib/tools/context";

// The loop talks to the Anthropic SDK; canned responses keep it off the network.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { runAgentTurn, AgentTurnBudgetExceededError } from "@/lib/agent/loop";
import { buildRegistry, defineTool } from "@/lib/tools/registry";

const reads = vi.fn(async () => ({ rooms: ["Room 1"] }));
const listRooms = defineTool({
  name: "list_rooms",
  description: "List rooms.",
  kind: "read",
  inputSchema: z.object({ house: z.string().optional(), limit: z.number().optional() }),
  handler: reads,
});
const registry = buildRegistry([listRooms]);
const ctx = { landlordId: "m", userId: "m", email: "m@axis.test", roles: ["manager"], isAdmin: false, db: {} } as unknown as AgentContext;
const toolUse = (id: string, input: unknown) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "list_rooms", input }], usage: { input_tokens: 1, output_tokens: 1 } });
const done = { stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 1 } };
const legacy = { model: "claude-sonnet-4-6", tier: "standard" as const, provider: "anthropic" as const, route: "anthropic" as const };

describe("agent loop: repeated reads and the turn budget", () => {
  beforeEach(() => {
    create.mockReset();
    reads.mockClear();
  });

  it("answers an identical repeated lookup from the first result, keyed regardless of key order", async () => {
    create
      .mockResolvedValueOnce(toolUse("tu_1", { house: "Brooklyn", limit: 2 }))
      .mockResolvedValueOnce(toolUse("tu_2", { limit: 2, house: "Brooklyn" }))
      .mockResolvedValueOnce(done);
    const result = await runAgentTurn({ ctx, registry, messages: [{ role: "user", content: "vacancies?" }], model: legacy });
    expect(result.reply).toBe("done");
    expect(reads).toHaveBeenCalledTimes(1);
    const secondCall = create.mock.calls[2]![0] as { messages: Array<{ role: string; content: unknown }> };
    const lastToolResult = secondCall.messages.at(-1)!.content as Array<{ tool_use_id: string; content: string }>;
    expect(lastToolResult[0]).toMatchObject({ tool_use_id: "tu_2", content: JSON.stringify({ rooms: ["Room 1"] }) });
  });

  it("still runs a lookup with different input", async () => {
    create
      .mockResolvedValueOnce(toolUse("tu_1", { house: "Brooklyn" }))
      .mockResolvedValueOnce(toolUse("tu_2", { house: "8th Ave" }))
      .mockResolvedValueOnce(done);
    await runAgentTurn({ ctx, registry, messages: [{ role: "user", content: "vacancies?" }], model: legacy });
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("stops before another model call once a non-Luna turn budget is spent", async () => {
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    create.mockImplementationOnce(async () => {
      clock += 46_000;
      return toolUse("tu_1", {});
    });
    await expect(
      runAgentTurn({ ctx, registry, messages: [{ role: "user", content: "vacancies?" }], model: { ...legacy, timeoutMs: 30_000, turnBudgetMs: 45_000 } }),
    ).rejects.toBeInstanceOf(AgentTurnBudgetExceededError);
    expect(create).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });
});
