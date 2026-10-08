import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

const good = {
  title: "The relay", hook: "Your job is relaying messages.", script: "Script body",
  scenes: [1, 2, 3].map((i) => ({ index: i, kind: "template", startMs: (i - 1) * 3000, endMs: i * 3000, text: `t${i}`, direction: "d" })),
  captions: { instagram: "Short #pm #landlord", tiktok: "Short #pm", youtube: "Yt caption" },
  platforms: ["instagram", "tiktok", "youtube"],
};
const reply = (text: string) => ({ content: [{ type: "text", text }] });
const idea = { title: "t", angle: "positioning", format: "reel", notes: null } as const;

describe("draft", () => {
  beforeEach(() => {
    create.mockReset();
    process.env.ANTHROPIC_API_KEY = "test";
  });

  it("parses a good JSON draft (with surrounding text)", async () => {
    create.mockResolvedValueOnce(reply("here: " + JSON.stringify(good)));
    const { generateDraft } = await import("@/lib/growth/draft.server");
    const out = await generateDraft(idea);
    expect(out.scenes.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(out.platforms).toEqual(["instagram", "tiktok", "youtube"]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries once on malformed output then succeeds", async () => {
    create.mockResolvedValueOnce(reply("not json")).mockResolvedValueOnce(reply(JSON.stringify(good)));
    const { generateDraft } = await import("@/lib/growth/draft.server");
    await expect(generateDraft(idea)).resolves.toMatchObject({ title: "The relay" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("throws after the retry also fails", async () => {
    create.mockResolvedValue(reply("{bad"));
    const { generateDraft } = await import("@/lib/growth/draft.server");
    await expect(generateDraft(idea)).rejects.toThrow(/draft failed after retry/);
    expect(create).toHaveBeenCalledTimes(2);
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
});
