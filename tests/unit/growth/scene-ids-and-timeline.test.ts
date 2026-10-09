/**
 * The three Reel studio defects the captain asked to be fixed as bugs (Oct 8):
 *
 * 1. a scene carries a STABLE id and its media is keyed on that id, so removing one
 *    scene never re-points another scene's clip;
 * 2. removing or reordering a scene re-flows `startMs`/`endMs` contiguously, so the
 *    timeline has no hole the renderer fills with flat background;
 * 3. the end card is clamped to `endCardMs` at the very end, so a voice track longer
 *    than the scenes holds the LAST SCENE instead of stretching the card over the
 *    narration.
 */
import { describe, expect, it } from "vitest";

import { MAX_SCENE_MS, newSceneId, reflowScenes, sceneListSchema, withSceneIds } from "@/lib/growth/scenes";
import type { GrowthAsset, GrowthPost, GrowthScene } from "@/lib/growth/types";
import { findAsset } from "@/lib/growth/video/assets.server";
import { planFromPost, sceneFileStem } from "@/lib/growth/video/render-plan.server";
import { DEFAULT_END_CARD_MS, endCardStartMs, reelDurationMs } from "../../../remotion/growth/types";

const scene = (index: number, over: Partial<GrowthScene> = {}): GrowthScene => ({
  index,
  kind: "generated",
  startMs: index * 3000,
  endMs: index * 3000 + 3000,
  text: `scene ${index}`,
  direction: "",
  ...over,
});

const clip = (sceneIndex: number, over: Partial<GrowthAsset> & { sceneId?: string } = {}): GrowthAsset => ({
  id: `clip-${over.sceneId ?? sceneIndex}`,
  postId: "p1",
  kind: "clip",
  storagePath: "",
  publicUrl: `https://cdn.test/${over.sceneId ?? sceneIndex}.mp4`,
  width: 1080,
  height: 1920,
  durationMs: 6000,
  meta: { sceneIndex, ...(over.sceneId ? { sceneId: over.sceneId } : {}) },
  createdAt: "",
});

const post = (scenes: GrowthScene[]): GrowthPost => ({
  id: "p1", ideaId: null, status: "review", format: "reel", title: "T", hook: "H", script: "Script.",
  scenes, captions: {}, platforms: ["instagram"], scheduledFor: null, approvedAt: null, approvedBy: null,
  publishedAt: null, createdBy: "admin", reviewNote: null, learnedFrom: null, createdAt: "", updatedAt: "",
});

describe("a scene's id is stable and unique", () => {
  it("mints an id for every scene and keeps the ones already there", () => {
    const [a, b] = withSceneIds([scene(0, { id: "sc_keepme" }), scene(1)]);
    expect(a.id).toBe("sc_keepme");
    expect(b.id).toMatch(/^sc_.+/);
    expect(b.id).not.toBe(a.id);
  });

  it("re-mints a duplicated id so two scenes never share one", () => {
    const ids = withSceneIds([scene(0, { id: "sc_dup" }), scene(1, { id: "sc_dup" })]).map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
    expect(newSceneId()).not.toBe(newSceneId());
  });

  it("gives each scene its own media file name, by id", () => {
    expect(sceneFileStem({ id: "sc_abc", index: 3 })).toBe("scene-sc_abc");
    // A row saved before ids existed still gets a stable name.
    expect(sceneFileStem({ index: 3 })).toBe("scene-3");
  });
});

describe("media follows the scene it was generated for", () => {
  it("keeps each scene's own clip after the scene before it is removed", () => {
    const first = scene(0, { id: "sc_one" });
    const second = scene(1, { id: "sc_two" });
    const assets = [clip(0, { sceneId: "sc_one" }), clip(1, { sceneId: "sc_two" })];

    // Remove the first scene in the studio: the survivor is renumbered to index 0.
    const after = sceneListSchema.parse([second]);
    const plan = planFromPost(post(after), assets);

    expect(after[0].index).toBe(0);
    expect(after[0].id).toBe("sc_two");
    expect(plan.needs[0].action).toBe("reuse");
    // Before the fix, index 0 matched sc_one's clip - the removed scene's video.
    expect(plan.needs[0].asset?.id).toBe("clip-sc_two");
  });

  it("refuses an index match when the pool is id-keyed, and generates instead", () => {
    const fresh = scene(0, { id: "sc_new" });
    expect(findAsset([clip(0, { sceneId: "sc_old" })], { postId: "p1", kind: "clip", sceneIndex: 0, sceneId: "sc_new" })).toBeUndefined();
    expect(planFromPost(post([fresh]), [clip(0, { sceneId: "sc_old" })]).needs[0].action).toBe("generate");
  });

  it("falls back to the index for a post saved before scene ids existed", () => {
    const legacy = clip(1);
    expect(findAsset([legacy], { postId: "p1", kind: "clip", sceneIndex: 1, sceneId: "sc_two" })).toMatchObject({ id: "clip-1" });
  });
});

describe("the timeline re-flows contiguously", () => {
  it("closes the hole a removed scene leaves, keeping every length", () => {
    const scenes = [
      scene(0, { startMs: 0, endMs: 3000 }),
      scene(1, { startMs: 3000, endMs: 8000 }),
      scene(2, { startMs: 8000, endMs: 10_000 }),
    ];
    const after = reflowScenes([scenes[0], scenes[2]]);
    expect(after.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 3000],
      [3000, 5000],
    ]);
    expect(after.map((s) => s.index)).toEqual([0, 1]);
  });

  it("re-flows a reorder with no overlap and no gap", () => {
    const saved = sceneListSchema.parse([
      scene(0, { startMs: 8000, endMs: 10_000 }),
      scene(1, { startMs: 0, endMs: 3000 }),
    ]);
    expect(saved.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 2000],
      [2000, 5000],
    ]);
    expect(saved.every((s, i) => s.startMs === (i === 0 ? 0 : saved[i - 1].endMs))).toBe(true);
    expect(saved.every((s) => typeof s.id === "string" && s.id.length > 0)).toBe(true);
  });

  it("rejects a scene longer than the per-scene ceiling", () => {
    expect(sceneListSchema.safeParse([scene(0, { startMs: 0, endMs: MAX_SCENE_MS + 1 })]).success).toBe(false);
  });
});

describe("the end card is clamped to the end", () => {
  it("starts exactly endCardMs before the end when the voice runs longer than the scenes", () => {
    const scenes = [scene(0, { startMs: 0, endMs: 3000 }), scene(1, { startMs: 3000, endMs: 6000 })];
    // A 12 s voice track over 6 s of scenes.
    const props = { scenes, endCardMs: DEFAULT_END_CARD_MS, totalMs: 12_600 };
    expect(reelDurationMs(props)).toBe(12_600);
    expect(endCardStartMs(props)).toBe(12_600 - DEFAULT_END_CARD_MS);
    // The last scene is therefore held across the extra narration instead of the card covering it.
    expect(endCardStartMs(props)).toBeGreaterThan(scenes[scenes.length - 1].endMs);
  });

  it("still sits right after the scenes when nothing runs longer", () => {
    const scenes = [scene(0, { startMs: 0, endMs: 4000 })];
    expect(endCardStartMs({ scenes, endCardMs: DEFAULT_END_CARD_MS })).toBe(4000);
  });

  it("never runs off the front of a very short reel", () => {
    expect(endCardStartMs({ scenes: [scene(0, { startMs: 0, endMs: 100 })], endCardMs: 9_000 })).toBeGreaterThanOrEqual(0);
  });
});
