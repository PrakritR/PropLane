import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ complete: vi.fn(), trace: vi.fn(), llmCall: vi.fn() }));
vi.mock("@/lib/agent/provider", () => ({ completeAgentModel: mocks.complete }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "192.0.2.1", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/observability/langfuse", () => ({ tracePublicToolTurn: mocks.trace }));
import { POST } from "@/app/api/agent/general-chat/route";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("general-chat selected completion and telemetry", () => {
  it("runs a no-tools public turn on Luna without Anthropic credentials and records actual usage", async () => {
    vi.stubEnv("AXIS_AI_LUNA_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "test-openai");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    mocks.trace.mockImplementation(async ({ run }) => run({ llmCall: mocks.llmCall }));
    const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 };
    mocks.complete.mockResolvedValue({ content: [{ type: "text", text: "PropLane helps manage rentals." }], usage, provider: "openai", responseModel: "gpt-6-luna", latencyMs: 12 });
    const response = await POST(new Request("http://localhost/api/agent/general-chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "What is PropLane?" }] }) }));
    expect(response.status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ model: "gpt-6-luna", provider: "openai" }), tools: [] }));
    expect(mocks.llmCall).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-6-luna", usage }));
    expect(mocks.trace.mock.calls[0]![0].sessionId).not.toContain("192.0.2.1");
  });
});
