import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { selectAgentRoute } from "@/lib/agent/model";

const message = (content: string): Anthropic.MessageParam[] => [{ role: "user", content }];

function route(content: string, tools: string[] = []) {
  return selectAgentRoute({ messages: message(content), actorKey: "manager_1", availableTools: tools });
}

describe("fast agent routing", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off until both key and rollout controls are configured", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "key");
    vi.stubEnv("AXIS_AGENT_FAST_ENABLED", "false");
    vi.stubEnv("AXIS_AGENT_FAST_ROLLOUT_PERCENT", "100");
    expect(route("What can you do?").provider).toBe("anthropic");
  });

  it("routes a clear product question to the no-tool fast lane", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "key");
    vi.stubEnv("AXIS_AGENT_FAST_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_FAST_ROLLOUT_PERCENT", "100");
    const selected = route("What can you do?");
    expect(selected).toMatchObject({ provider: "openrouter", route: "fast_direct", toolNames: [], readOnly: true });
  });

  it("routes a known one-tool lookup to the read-only fast lane", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "key");
    vi.stubEnv("AXIS_AGENT_FAST_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_FAST_ROLLOUT_PERCENT", "100");
    const selected = route("Show my overdue charges", ["get_overdue_charges", "send_rent_reminder"]);
    expect(selected).toMatchObject({ provider: "openrouter", route: "fast_lookup", toolNames: ["get_overdue_charges"], readOnly: true });
  });

  it("keeps mutations and analysis on Anthropic", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "key");
    vi.stubEnv("AXIS_AGENT_FAST_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_FAST_ROLLOUT_PERCENT", "100");
    expect(route("Send a rent reminder", ["send_rent_reminder"]).provider).toBe("anthropic");
    expect(route("Why is income down this quarter?", ["run_financial_report"]).provider).toBe("anthropic");
  });
  it("keeps text and reply requests on the confirmation-capable route", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "key");
    vi.stubEnv("AXIS_AGENT_FAST_ENABLED", "true");
    vi.stubEnv("AXIS_AGENT_FAST_ROLLOUT_PERCENT", "100");
    for (const prompt of ["Message the potential tenant", "Reply to the prospect", "Text the prospect about the room"]) {
      expect(route(prompt, ["list_inbox_threads", "list_sms_conversations", "reply_to_sms_conversation"]).provider).toBe("anthropic");
    }
    expect(route("Show texts from potential tenants", ["list_sms_conversations", "list_inbox_threads"]).toolNames)
      .toEqual(["list_sms_conversations"]);
  });

});
