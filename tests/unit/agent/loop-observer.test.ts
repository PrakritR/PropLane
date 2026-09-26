import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import type { AgentContext } from "@/lib/tools/context";

// Mock the Anthropic SDK so the loop never makes a network call; `create`
// returns canned responses and we assert the events the loop emits.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { runAgentTurn, type AgentObserver, type LlmCallEvent, type ToolCallEvent } from "@/lib/agent/loop";
import { buildRegistry, defineTool } from "@/lib/tools/registry";

const listThings = defineTool({
  name: "list_things",
  description: "List things.",
  kind: "read",
  inputSchema: z.object({ limit: z.number().optional() }),
  handler: async () => ({ things: ["a", "b"] }),
});
const registry = buildRegistry([listThings]);

const ctx = {
  landlordId: "manager_a",
  userId: "manager_a",
  email: "m@axis.test",
  roles: ["manager"],
  isAdmin: false,
  db: {},
} as unknown as AgentContext;

function collector() {
  const starts: { toolsAvailable: string[]; system: string }[] = [];
  const llm: LlmCallEvent[] = [];
  const tool: ToolCallEvent[] = [];
  const observer: AgentObserver = {
    onStart: (i) => starts.push({ toolsAvailable: i.toolsAvailable, system: i.system }),
    onLlmCall: (e) => llm.push(e),
    onToolCall: (e) => tool.push(e),
  };
  return { observer, starts, llm, tool };
}

describe("runAgentTurn observer", () => {
  beforeEach(() => create.mockReset());

  it("emits start, per-call LLM events, and a tool event with full args/result", async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_1", name: "list_things", input: { limit: 2 } }],
        usage: { input_tokens: 30, output_tokens: 12 },
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 40, output_tokens: 8 },
      });

    const { observer, starts, llm, tool } = collector();
    const result = await runAgentTurn({
      ctx,
      registry,
      messages: [{ role: "user", content: "list my things" }],
      observer,
    });

    // onStart once, advertising the available tool and a non-empty system prompt.
    expect(starts).toHaveLength(1);
    expect(starts[0]!.toolsAvailable).toContain("list_things");
    expect(starts[0]!.system.length).toBeGreaterThan(0);

    // One generation per LLM call, each with THIS call's tokens (not the accumulator).
    expect(llm).toHaveLength(2);
    expect(llm[0]!.usage).toMatchObject({ inputTokens: 30, outputTokens: 12, raw: { input_tokens: 30, output_tokens: 12 } });
    expect(llm[0]!.toolsChosen).toEqual(["list_things"]);
    expect(llm[1]!.usage).toMatchObject({ inputTokens: 40, outputTokens: 8, raw: { input_tokens: 40, output_tokens: 8 } });
    expect(llm[1]!.toolsChosen).toEqual([]);

    // Tool span carries the raw model args and the tool's actual result.
    expect(tool).toHaveLength(1);
    expect(tool[0]!.name).toBe("list_things");
    expect(tool[0]!.input).toEqual({ limit: 2 });
    expect(tool[0]!.ok).toBe(true);
    expect(tool[0]!.output).toEqual({ things: ["a", "b"] });

    // The wire result is unchanged: accumulated usage still reported.
    expect(result.usage).toMatchObject({ inputTokens: 70, outputTokens: 20 });
  });

  it("reports a failed tool call with its error as the output", async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_1", name: "missing_tool", input: {} }],
        usage: { input_tokens: 5, output_tokens: 2 },
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "sorry" }],
        usage: { input_tokens: 6, output_tokens: 1 },
      });

    const { observer, tool } = collector();
    await runAgentTurn({
      ctx,
      registry,
      messages: [{ role: "user", content: "do a thing" }],
      observer,
    });

    expect(tool).toHaveLength(1);
    expect(tool[0]!.ok).toBe(false);
    expect(typeof tool[0]!.output).toBe("string");
  });

  it("a throwing observer never breaks the turn", async () => {
    create.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hi!" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const boom: AgentObserver = {
      onStart: () => {
        throw new Error("boom");
      },
      onLlmCall: () => {
        throw new Error("boom");
      },
    };
    const result = await runAgentTurn({
      ctx,
      registry,
      messages: [{ role: "user", content: "hi" }],
      observer: boom,
    });
    expect(result.reply).toBe("hi!");
  });
});
