import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd, selectPortalAgentRoute } from "@/lib/agent/model";

const messages = (text: string): Anthropic.MessageParam[] => [{ role: "user", content: text }];
const route = (turns: Anthropic.MessageParam[]) => selectPortalAgentRoute({ messages: turns, actorKey: "actor-1", availableTools: ["list_charges", "create_charge"] });

afterEach(() => vi.unstubAllEnvs());

describe("Luna portal routing", () => {
  it("uses Luna by default when configured and keeps explicit rollback and malformed settings fail-closed", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", undefined);
    vi.stubEnv("AXIS_AGENT_LUNA_ROLLOUT_PERCENT", undefined);
    expect(route(messages("What is my balance?"))).toMatchObject({ provider: "openai", reasoningEffort: "low" });
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", "false");
    expect(route(messages("What is my balance?")).provider).toBe("anthropic");
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", "invalid");
    expect(route(messages("What is my balance?")).provider).toBe("anthropic");
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_LUNA_ROLLOUT_PERCENT", "invalid");
    expect(route(messages("What is my balance?")).provider).toBe("anthropic");
  });
  it("keeps established routing when disabled or missing a key", () => {
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_LUNA_ROLLOUT_PERCENT", "100");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(route(messages("List my charges")).provider).toBe("anthropic");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", "false");
    expect(route(messages("List my charges")).provider).toBe("anthropic");
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_MODEL", "claude-sonnet-4-6");
    expect(route(messages("List my charges")).provider).toBe("anthropic");
  });

  it("exposes the full surface catalog and uses low by default", () => {
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_LUNA_ROLLOUT_PERCENT", "100");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    expect(route(messages("Create a charge for the key replacement"))).toMatchObject({ provider: "openai", route: "luna_primary", reasoningEffort: "low", model: "gpt-6-luna" });
    expect(route(messages("Create a charge for the key replacement")).toolNames).toBeUndefined();
    expect(selectPortalAgentRoute({ messages: messages("Describe this image"), actorKey: "actor-1", availableTools: [], hasAttachments: true }).provider).toBe("anthropic");
    expect(route(messages("Show your support across the portfolio"))).toMatchObject({ reasoningEffort: "high" });
    expect(route(messages("The projector is broken"))).toMatchObject({ reasoningEffort: "low" });
  });

  it("raises high effort for analysis and deep histories", () => {
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_LUNA_ROLLOUT_PERCENT", "100");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    expect(route(messages("Compare rent trends across these properties")).reasoningEffort).toBe("high");
    expect(route([...Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "Earlier turn" } as Anthropic.MessageParam)), { role: "user", content: "And that one?" }]).reasoningEffort).toBe("high");
  });

  it("keeps zero-percent rollout on the established route", () => {
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_LUNA_ROLLOUT_PERCENT", "0");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    expect(route(messages("What is my balance?")).provider).toBe("anthropic");
  });

  it("charges cached input once and includes reasoning in output once", () => {
    expect(estimateCostUsd("gpt-6-luna", { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 1_000_000, reasoningOutputTokens: 400_000 } as never)).toBeCloseTo(0.555);
  });

  it("prices dated provider identifiers against their exact known model family", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd("claude-haiku-4-5-20251001", usage)).toBe(estimateCostUsd("claude-haiku-4-5", usage));
    expect(estimateCostUsd("claude-sonnet-4-6-20260217", usage)).toBe(estimateCostUsd("claude-sonnet-4-6", usage));
    expect(estimateCostUsd("gpt-6-luna-2026-09-25", usage)).toBe(estimateCostUsd("gpt-6-luna", usage));
  });
});
