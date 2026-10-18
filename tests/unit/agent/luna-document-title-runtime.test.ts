import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@/lib/agent/provider", () => ({ completeAgentModel: mocks.complete }));
vi.mock("@/lib/observability/langfuse", () => ({ traceAgentTurn: async (_actor: unknown, _messages: unknown, run: () => Promise<unknown>) => run() }));
import { extractResidentDocumentWithAi } from "@/lib/resident-document-import/parse-ai.server";
import { generateAgentChatThreadTitle } from "@/lib/agent/chat-title-generate.server";
const actor = { userId: "fictional-manager" };
const completion = (text: string) => ({ content: [{ type: "text", text }], usage: { inputTokens: 10, outputTokens: 4 }, provider: "openai", responseModel: "gpt-6-luna", latencyMs: 1, stopReason: "end_turn" });
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("AXIS_AI_LUNA_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", "test-openai");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  mocks.complete.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe("document and title runtime utility selection", () => {
  it("extracts a document on Luna, keeps unknown rent null, and excludes SSN fields", async () => {
    mocks.complete.mockResolvedValue(completion(JSON.stringify({ tenantName: "Avery Example", monthlyRent: null, applicant: { employer: "Fictional Books", ssn: "123-45-6789" } })));
    const result = await extractResidentDocumentWithAi({ kind: "application", text: "Avery Example works for Fictional Books. Rent is not stated.", fileName: "fictional.txt", catalog: [], actor });
    expect(result).toMatchObject({ tenantName: "Avery Example", monthlyRent: null, applicant: { employer: "Fictional Books" } });
    expect(result?.applicant).not.toHaveProperty("ssn");
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ provider: "openai", model: "gpt-6-luna" }) }));
  });
  it("rejects malformed document JSON without inventing an extraction", async () => {
    mocks.complete.mockResolvedValue(completion("unreadable payload"));
    expect(await extractResidentDocumentWithAi({ kind: "application", text: "Fictional source", fileName: "fictional.txt", catalog: [], actor })).toBeNull();
  });
  it("does not spend a model call on a greeting title", async () => {
    await generateAgentChatThreadTitle(["hello"], actor);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("generates useful archive titles through Luna with only an OpenAI key", async () => {
    mocks.complete.mockResolvedValue(completion("Rent Balance"));
    const title = await generateAgentChatThreadTitle(["Please explain the balance on my rent ledger"], actor);
    expect(title).toContain("Rent Balance");
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ provider: "openai", model: "gpt-6-luna", maxOutputTokens: 1024 }) }));
  });
});
