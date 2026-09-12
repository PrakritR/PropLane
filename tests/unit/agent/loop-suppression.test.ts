import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentContext } from "@/lib/tools/context";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { runAgentTurn } from "@/lib/agent/loop";
import { buildRegistry, defineTool, defineWriteTool } from "@/lib/tools/registry";

const suppress = defineTool({
  name: "suppress_reply",
  description: "Suppress a delivered repeat.",
  inputSchema: z.object({ reference: z.literal("out-1") }).strict(),
  handler: async (_ctx: AgentContext, input: { reference: "out-1" }) => ({
    suppress: true,
    referenceMessageId: input.reference,
    reason: "acknowledgment",
  }),
});

const ctx = {
  landlordId: "manager-a",
  userId: "manager-a",
  email: "",
  roles: ["leasing_sms_agent"],
  isAdmin: false,
  db: {},
} as unknown as AgentContext;

describe("agent loop explicit suppression", () => {
  beforeEach(() => create.mockReset());

  it("returns typed silence without a fallback or second model call", async () => {
    create.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tool-1", name: "suppress_reply", input: { reference: "out-1" } }],
      usage: { input_tokens: 9, output_tokens: 3 },
    });

    const result = await runAgentTurn({
      ctx,
      registry: buildRegistry([suppress]),
      messages: [{ role: "user", content: "Thanks" }],
      suppressionTools: ["suppress_reply"],
    });

    expect(result).toMatchObject({
      reply: "",
      terminationReason: "suppressed",
      suppression: {
        toolName: "suppress_reply",
        referenceMessageId: "out-1",
        reason: "acknowledgment",
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not suppress when the typed reference fails validation", async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tool-1", name: "suppress_reply", input: { reference: "invented" } }],
        usage: { input_tokens: 9, output_tokens: 3 },
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Here is the answer." }],
        usage: { input_tokens: 11, output_tokens: 4 },
      });

    const result = await runAgentTurn({
      ctx,
      registry: buildRegistry([suppress]),
      messages: [{ role: "user", content: "Please repeat that" }],
      suppressionTools: ["suppress_reply"],
    });

    expect(result.reply).toBe("Here is the answer.");
    expect(result.suppression).toBeUndefined();
  });

  it("validates inline write input before consuming its revision claim", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const authorize = vi.fn(async () => true);
    const write = defineWriteTool({
      name: "request_tour",
      description: "Request a tour.",
      inputSchema: z.object({ propertyId: z.string().min(1) }).strict(),
      preview: async () => ({ kind: "request_tour", title: "Tour", confirmLabel: "Request", fields: [] }),
      handler,
    });
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "bad", name: "request_tour", input: {} }],
        usage: { input_tokens: 4, output_tokens: 2 },
      })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "good", name: "request_tour", input: { propertyId: "jain-home" } }],
        usage: { input_tokens: 5, output_tokens: 2 },
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Requested." }],
        usage: { input_tokens: 5, output_tokens: 2 },
      });

    const result = await runAgentTurn({
      ctx,
      registry: buildRegistry([write]),
      messages: [{ role: "user", content: "Tour please" }],
      readOnly: true,
      allowWriteTools: ["request_tour"],
      authorizeInlineWrite: authorize,
    });

    expect(result.reply).toBe("Requested.");
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ id: "good", input: { propertyId: "jain-home" } }));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
