import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeTaskModel, smsTaskModel } from "@/lib/agent/runtime-model";
import { visionPinnedModel } from "@/lib/agent/assistant-vision-turn";
import { hasAgentModelCredential, selectPortalAgentRoute } from "@/lib/agent/model";

afterEach(() => vi.unstubAllEnvs());

describe("all-surface Luna policy at runtime boundaries", () => {
  it.each(["manager", "resident-workspace", "prospect", "vendor-service", "resident-personal", "vendor-number"])("routes %s SMS only through Luna when master enabled", (actor) => {
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_SMS_AGENT_LUNA_ENABLED", "false");
    vi.stubEnv("AXIS_SMS_AGENT_LUNA_ROLLOUT_PERCENT", "0");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const model = smsTaskModel(actor);
    expect(model).toMatchObject({ model: "gpt-6-luna", provider: "openai", maxOutputTokens: 8000, timeoutMs: 40000 });
    expect(hasAgentModelCredential(model)).toBe(true);
  });
  it("keeps voice inside its shorter model deadline", () => {
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", "true");
    expect(smsTaskModel("manager", "voice").timeoutMs).toBe(15000);
  });
  it.each(["false", ""])("preserves the caller's legacy complexity tier when master is %s", (master) => {
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", master);
    const legacy = { model: "claude-opus-4-8", tier: "complex" as const, provider: "anthropic" as const, route: "anthropic" as const };
    expect(runtimeTaskModel({}, legacy)).toEqual(legacy);
    expect(smsTaskModel("manager", "sms", legacy)).toEqual(legacy);
  });

  it("forces legacy rollback even when old rollout is fully enabled", () => {
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", "false");
    vi.stubEnv("AXIS_SMS_AGENT_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_SMS_AGENT_LUNA_ROLLOUT_PERCENT", "100");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    expect(smsTaskModel("manager").provider).toBe("anthropic");
    expect(runtimeTaskModel().provider).toBe("anthropic");
    expect(visionPinnedModel().provider).toBe("anthropic");
  });
  it("never substitutes an Anthropic credential for missing selected OpenAI credentials", () => {
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "legacy-test");
    expect(hasAgentModelCredential(runtimeTaskModel())).toBe(false);
  });
  it("unpins images and documents from a stale Claude vision override", () => {
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_MODEL_VISION", "claude-stale");
    expect(visionPinnedModel()).toMatchObject({ model: "gpt-6-luna", provider: "openai" });
  });
  it.each(["tru", ""])("does not activate portal Luna for an explicit malformed master %s", (master) => {
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", master);
    vi.stubEnv("AXIS_AGENT_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_LUNA_ROLLOUT_PERCENT", "100");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    expect(selectPortalAgentRoute({ messages: [{ role: "user", content: "Hello" }], actorKey: "manager", availableTools: [] }).provider).toBe("anthropic");
  });

  it("keeps malformed flags closed to opt-in", () => {
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", "tru");
    vi.stubEnv("AXIS_SMS_AGENT_LUNA_ENABLED", "true");
    vi.stubEnv("AXIS_SMS_AGENT_LUNA_ROLLOUT_PERCENT", "100");
    expect(smsTaskModel("actor").provider).toBe("anthropic");
  });
});
