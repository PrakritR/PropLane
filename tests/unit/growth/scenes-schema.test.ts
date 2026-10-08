import { describe, expect, it } from "vitest";
import { sceneListSchema } from "@/lib/growth/scenes";

const scene = (i: number, over: object = {}) => ({ index: 9, kind: "template", startMs: i * 1000, endMs: i * 1000 + 900, text: "t", direction: "", ...over });

describe("sceneListSchema", () => {
  it("accepts up to 8 scenes and renumbers them", () => {
    const r = sceneListSchema.parse(Array.from({ length: 8 }, (_, i) => scene(i)));
    expect(r.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it("rejects 9 scenes, bad kinds and reversed times", () => {
    expect(sceneListSchema.safeParse(Array.from({ length: 9 }, (_, i) => scene(i))).success).toBe(false);
    expect(sceneListSchema.safeParse([scene(0, { kind: "video" })]).success).toBe(false);
    expect(sceneListSchema.safeParse([scene(0, { startMs: 500, endMs: 100 })]).success).toBe(false);
  });
});
