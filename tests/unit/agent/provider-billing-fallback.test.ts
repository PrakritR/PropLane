import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { completeAgentModel } from "@/lib/agent/provider";

const anthropicSelection = {
  model: "claude-sonnet-4-6",
  tier: "standard" as const,
  provider: "anthropic" as const,
  route: "anthropic" as const,
};

const CREDIT_ERROR = new Error(
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
);

describe("Anthropic billing fallback", () => {
  afterEach(() => {
    create.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("retries through OpenRouter when Anthropic refuses the account", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    create.mockRejectedValue(CREDIT_ERROR);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "Hi from OpenRouter" } }],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeAgentModel({
      selection: anthropicSelection,
      system: "system",
      tools: [],
      messages: [{ role: "user", content: "hello" }] as Anthropic.MessageParam[],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.provider).toBe("openrouter");
    expect(result.fallbackReason).toMatch(/credit balance/i);
    expect(result.content).toMatchObject([{ type: "text", text: "Hi from OpenRouter" }]);
  });

  it("does not call OpenRouter for a non-billing Anthropic error", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    create.mockRejectedValue(new Error("overloaded_error"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeAgentModel({
        selection: anthropicSelection,
        system: "system",
        tools: [],
        messages: [{ role: "user", content: "hello" }] as Anthropic.MessageParam[],
      }),
    ).rejects.toThrow(/overloaded/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
