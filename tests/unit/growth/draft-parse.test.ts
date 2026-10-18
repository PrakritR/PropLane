import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const complete = vi.fn();
vi.mock("@/lib/agent/provider", () => ({ completeAgentModel: complete }));

const good = {
  title: "The relay", hook: "Your job is relaying messages.", script: "Script body",
  scenes: [1, 2, 3].map((i) => ({ index: i, kind: "template", startMs: (i - 1) * 3000, endMs: i * 3000, text: `t${i}`, direction: "d" })),
  captions: { instagram: "Short #pm #landlord", tiktok: "Short #pm", youtube: "Yt caption" },
  platforms: ["instagram", "tiktok", "youtube"],
};
const reply = (text: string) => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 20 },
  provider: "openai",
  latencyMs: 1,
});
const idea = { title: "t", angle: "positioning", format: "reel", notes: null } as const;
let previousAnthropicKey: string | undefined;
let previousOpenAiKey: string | undefined;
let previousLunaEnabled: string | undefined;

describe("draft", () => {
  beforeEach(() => {
    complete.mockReset();
    previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    previousLunaEnabled = process.env.AXIS_AI_LUNA_ENABLED;
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.AXIS_AI_LUNA_ENABLED = "true";
  });

  afterEach(() => {
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousLunaEnabled === undefined) delete process.env.AXIS_AI_LUNA_ENABLED;
    else process.env.AXIS_AI_LUNA_ENABLED = previousLunaEnabled;
  });

  it("parses a good JSON draft (with surrounding text)", async () => {
    complete.mockResolvedValueOnce(reply("here: " + JSON.stringify(good)));
    const { generateDraft } = await import("@/lib/growth/draft.server");
    const out = await generateDraft(idea);
    expect(out.scenes.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(out.platforms).toEqual(["instagram", "tiktok", "youtube"]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      selection: { model: "gpt-6-luna", provider: "openai" },
      tools: [],
    });
  });

  it("retries once on malformed output then succeeds", async () => {
    complete.mockResolvedValueOnce(reply("not json")).mockResolvedValueOnce(reply(JSON.stringify(good)));
    const { generateDraft } = await import("@/lib/growth/draft.server");
    await expect(generateDraft(idea)).resolves.toMatchObject({ title: "The relay" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("throws after the retry also fails", async () => {
    complete.mockResolvedValue(reply("{bad"));
    const { generateDraft } = await import("@/lib/growth/draft.server");
    await expect(generateDraft(idea)).rejects.toThrow(/draft failed after retry/);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("enforces caption rules and defaults platforms by format", async () => {
    const { parseDraftOutput, defaultPlatforms } = await import("@/lib/growth/draft-parse");
    expect(defaultPlatforms("text")).toEqual(["linkedin", "x"]);
    expect(defaultPlatforms("carousel")).toEqual(["instagram", "linkedin"]);
    const longX = { ...good, platforms: ["linkedin", "x"], captions: { linkedin: "ok", x: "x".repeat(281) } };
    expect(() => parseDraftOutput(JSON.stringify(longX), "text")).toThrow(/280/);
    const tags = { ...good, platforms: ["instagram"], captions: { instagram: "#a #b #c #d #e #f #g" } };
    expect(() => parseDraftOutput(JSON.stringify(tags), "image")).toThrow(/hashtags/);
    const two = { ...good, scenes: good.scenes.slice(0, 2) };
    expect(() => parseDraftOutput(JSON.stringify(two), "reel")).toThrow();
    const noPlatforms = { ...good, platforms: undefined };
    expect(parseDraftOutput(JSON.stringify(noPlatforms), "reel").platforms).toEqual(["instagram", "tiktok", "youtube"]);
  });

  it("parses a response wrapped in Markdown code fences", async () => {
    const { parseDraftOutput } = await import("@/lib/growth/draft-parse");
    const fenced = "Here you go:\n```json\n" + JSON.stringify(good, null, 2) + "\n```\nThanks";
    expect(parseDraftOutput(fenced, "reel").title).toBe("The relay");
  });

  it("repairs a raw newline inside a string literal", async () => {
    const { parseDraftOutput } = await import("@/lib/growth/draft-parse");
    // A literal line break inside the "script" string, as a model might emit it.
    const withRaw = JSON.stringify(good).replace('"Script body"', '"Line one\nLine two"');
    expect(withRaw).toContain('"Line one\nLine two"');
    expect(() => JSON.parse(withRaw)).toThrow();
    expect(parseDraftOutput(withRaw, "reel").script).toBe("Line one\nLine two");
  });

  it("still rejects JSON that is broken beyond newline repair", async () => {
    const { parseDraftOutput } = await import("@/lib/growth/draft-parse");
    expect(() => parseDraftOutput('{"title": "x" "hook": "y"}', "text")).toThrow();
  });
});
