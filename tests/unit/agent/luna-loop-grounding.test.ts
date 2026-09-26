import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentContext } from "@/lib/tools/context";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@/lib/agent/provider", () => ({ completeAgentModel: complete }));

import { runAgentTurn } from "@/lib/agent/loop";
import { buildRegistry, defineTool, defineWriteTool } from "@/lib/tools/registry";

const ctx = { landlordId: "manager_a", userId: "manager_a", db: {} } as unknown as AgentContext;
const model = { model: "gpt-6-luna", tier: "standard" as const, provider: "openai" as const, route: "luna_primary" as const, reasoningEffort: "low" as const };
const call = (content: Anthropic.ContentBlock[], stopReason: string) => ({
  content, stopReason, provider: "openai", latencyMs: 5, usage: { inputTokens: 20, outputTokens: 5 },
});
const toolCall = call([{ type: "tool_use", id: "call_1", name: "get_links", input: {} } as Anthropic.ToolUseBlock], "tool_use");
const final = (reply: string) => call([{ type: "text", text: reply } as Anthropic.TextBlock], "end_turn");

beforeEach(() => complete.mockReset());

describe("Luna loop grounding boundary", () => {
  it("blocks a URL invented after a successful empty result", async () => {
    const registry = buildRegistry([defineTool({ name: "get_links", description: "Links", kind: "read", inputSchema: z.object({}), handler: async () => ({ links: {} }) })]);
    complete.mockResolvedValueOnce(toolCall).mockResolvedValueOnce(final("Open [Inspections](/resident/inspections)."));
    const result = await runAgentTurn({ ctx, registry, model, messages: [{ role: "user", content: "Where is my checklist?" }] });
    expect(result.reply).toMatch(/can't verify that link/);
    expect(result.reply).not.toContain("/resident/inspections");
  });

  it("allows the exact URL returned by a successful tool and rejects absence after failure", async () => {
    const goodRegistry = buildRegistry([defineTool({ name: "get_links", description: "Links", kind: "read", inputSchema: z.object({}), handler: async () => ({ links: { services: "/resident/services" } }) })]);
    complete.mockResolvedValueOnce(toolCall).mockResolvedValueOnce(final("Open [Services](/resident/services)."));
    expect((await runAgentTurn({ ctx, registry: goodRegistry, model, messages: [{ role: "user", content: "Open services" }] })).reply).toBe("Open [Services](/resident/services).");

    const failedRegistry = buildRegistry([defineTool({ name: "get_links", description: "Links", kind: "read", inputSchema: z.object({}), handler: async () => { throw new Error("unavailable"); } })]);
    complete.mockResolvedValueOnce(toolCall).mockResolvedValueOnce(final("No service record is available."));
    expect((await runAgentTurn({ ctx, registry: failedRegistry, model, messages: [{ role: "user", content: "Any services?" }] })).reply).toMatch(/couldn't verify/);
  });

  it("does not use an unrelated successful link to excuse a failed data read", async () => {
    const registry = buildRegistry([
      defineTool({ name: "get_links", description: "Links", kind: "read", inputSchema: z.object({}), handler: async () => ({ links: { payments: "/resident/payments" } }) }),
      defineTool({ name: "get_balance", description: "Balance", kind: "read", inputSchema: z.object({}), handler: async () => { throw new Error("unavailable"); } }),
    ]);
    complete.mockResolvedValueOnce(call([
      { type: "tool_use", id: "call_1", name: "get_links", input: {} } as Anthropic.ToolUseBlock,
      { type: "tool_use", id: "call_2", name: "get_balance", input: {} } as Anthropic.ToolUseBlock,
    ], "tool_use")).mockResolvedValueOnce(final("Your balance is paid. Open [Payments](/resident/payments)."));
    const result = await runAgentTurn({ ctx, registry, model, messages: [{ role: "user", content: "What is my balance?" }] });
    expect(result.reply).toMatch(/couldn't verify/);
    expect(result.reply).not.toContain("paid");
  });

  it("treats a business-error read result as unverified", async () => {
    const registry = buildRegistry([defineTool({ name: "get_links", description: "Links", kind: "read", inputSchema: z.object({}), handler: async () => ({ ok: false, error: "unavailable" }) })]);
    complete.mockResolvedValueOnce(toolCall).mockResolvedValueOnce(final("Your service request was not found."));
    const result = await runAgentTurn({ ctx, registry, model, messages: [{ role: "user", content: "Find my service" }] });
    expect(result.reply).toMatch(/couldn't verify/);
  });

  it("keeps a pending card while neutralizing prose after a failed read", async () => {
    const registry = buildRegistry([
      defineTool({ name: "get_links", description: "Links", kind: "read", inputSchema: z.object({}), handler: async () => { throw new Error("unavailable"); } }),
      defineWriteTool({
        name: "create_request", description: "Request", inputSchema: z.object({}),
        preview: async () => ({ kind: "create_request", title: "Create request", confirmLabel: "Create", fields: [] }),
        handler: async () => ({ reply: "created" }),
      }),
    ]);
    complete.mockResolvedValueOnce(toolCall).mockResolvedValueOnce(call([
      { type: "text", text: "Your payment is paid. I can create a request." } as Anthropic.TextBlock,
      { type: "tool_use", id: "call_2", name: "create_request", input: {} } as Anthropic.ToolUseBlock,
    ], "tool_use"));
    const result = await runAgentTurn({ ctx, registry, model, messages: [{ role: "user", content: "Create a service request" }] });
    expect(result.pendingAction?.toolName).toBe("create_request");
    expect(result.reply).toMatch(/couldn't verify/);
    expect(result.reply).not.toContain("paid");
  });
});
