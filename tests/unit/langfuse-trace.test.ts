import { describe, expect, it } from "vitest";
import { createOtelTrace } from "@/lib/observability/langfuse-trace";

describe("createOtelTrace (Langfuse v5 OTel handle)", () => {
  it("keeps the trace/generation/span surface and never throws without a tracer provider", () => {
    const trace = createOtelTrace(
      { name: "axis-agent-turn", userId: "u1", sessionId: "s1", metadata: { landlordId: "u1", nested: { a: 1 } }, input: "hi" },
      "development",
    );
    expect(typeof trace.id).toBe("string");
    expect(() => {
      trace.update({ metadata: { promptId: "p" } });
      trace.generation({ name: "axis-agent-llm", model: "m", usage: { input: 1, output: 1, unit: "TOKENS" }, usageDetails: { input: 1, output: 1 } }).end();
      trace.span({ name: "tool:x", input: { a: 1 }, output: { ok: true } }).end();
      trace.update({ output: "done" });
      trace.end();
    }).not.toThrow();
  });
});
