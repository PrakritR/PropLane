import { describe, expect, it } from "vitest";

import { parseDraftOutput } from "@/lib/growth/draft-parse";
import { sceneListSchema } from "@/lib/growth/scenes";
import { sceneFileStem, sceneOutputPath } from "@/lib/growth/video/render-plan.server";

const base = { index: 0, kind: "generated" as const, startMs: 0, endMs: 3000, text: "t", direction: "" };

describe("scene id is a plain file-name token", () => {
  it("rejects traversal and separators in the scene schema", () => {
    for (const id of ["../../etc/x", "a/b", "a.b", "a\\b", "", "x".repeat(65)]) {
      expect(sceneListSchema.safeParse([{ ...base, id }]).success).toBe(false);
    }
    expect(sceneListSchema.safeParse([{ ...base, id: "sc_ab-12" }]).success).toBe(true);
  });

  it("rejects a traversal id in a model draft", () => {
    const scene = (i: number, id?: string) => ({
      kind: "template", startMs: i * 1000, endMs: i * 1000 + 1000, text: "t", direction: "d", id,
    });
    const draft = {
      title: "t", hook: "h", script: "s",
      scenes: [scene(0, "../evil"), scene(1), scene(2)],
      captions: { linkedin: "c" },
      platforms: ["linkedin"],
    };
    expect(() => parseDraftOutput(JSON.stringify(draft), "text")).toThrow();
  });

  it("sceneFileStem falls back to the index for an unsafe id", () => {
    expect(sceneFileStem({ id: "../../x", index: 2 })).toBe("scene-2");
    expect(sceneFileStem({ id: "sc_ok", index: 2 })).toBe("scene-sc_ok");
  });

  it("sceneOutputPath stays under the post directory and refuses a bad post id", () => {
    const p = sceneOutputPath("3f2b8c1e-aaaa-bbbb-cccc-111122223333", { id: "../../x", index: 1 });
    expect(p).toMatch(/output\/growth\/3f2b8c1e-aaaa-bbbb-cccc-111122223333\/scene-1\.mp4$/);
    expect(() => sceneOutputPath("../x", { index: 1 })).toThrow();
    expect(() => sceneOutputPath("a/b", { index: 1 })).toThrow();
  });
});
