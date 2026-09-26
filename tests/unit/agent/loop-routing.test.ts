import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";

// Mock the Anthropic SDK so the loop never makes a network call; `create`
// returns a canned no-tool response and we assert how the loop drives it.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { runAgentTurn } from "@/lib/agent/loop";
import { buildRegistry } from "@/lib/tools/registry";

const registry = buildRegistry([]);
const ctx = {
  landlordId: "manager_a",
  userId: "manager_a",
  email: "m@axis.test",
  roles: ["manager"],
  isAdmin: false,
  db: {},
} as unknown as AgentContext;

function finalResponse(text: string, usage: { input_tokens: number; output_tokens: number }) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }], usage };
}

describe("runAgentTurn model routing", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("routes a trivial turn to the simple-tier model", async () => {
    create.mockResolvedValue(finalResponse("hi!", { input_tokens: 10, output_tokens: 4 }));

    const result = await runAgentTurn({
      ctx,
      registry,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].model).toBe("claude-haiku-4-5");
    expect(result.tier).toBe("simple");
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.reply).toBe("hi!");
  });

  it("routes an analytical turn to the complex-tier model", async () => {
    create.mockResolvedValue(finalResponse("...", { input_tokens: 100, output_tokens: 50 }));

    const result = await runAgentTurn({
      ctx,
      registry,
      messages: [{ role: "user", content: "Compare delinquency across all my properties" }],
    });

    expect(create.mock.calls[0]![0].model).toBe("claude-opus-4-8");
    expect(result.tier).toBe("complex");
  });

  it("accumulates token usage across loop iterations and reports it", async () => {
    const toolUseResponse = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "missing_tool", input: {} }],
      usage: { input_tokens: 30, output_tokens: 12 },
    };
    create
      .mockResolvedValueOnce(toolUseResponse)
      .mockResolvedValueOnce(finalResponse("done", { input_tokens: 40, output_tokens: 8 }));

    const result = await runAgentTurn({
      ctx,
      registry,
      messages: [{ role: "user", content: "list my leases" }],
    });

    expect(create).toHaveBeenCalledTimes(2);
    // A turn always uses one model for all of its iterations.
    expect(create.mock.calls[0]![0].model).toBe(create.mock.calls[1]![0].model);
    expect(result.usage).toMatchObject({ inputTokens: 70, outputTokens: 20 });
  });
});
