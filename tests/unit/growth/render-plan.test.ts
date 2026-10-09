import { describe, expect, it, vi } from "vitest";

import { findAsset, generateClipWithFallback, resolveDrivers, type AssetStore, type SaveAssetInput } from "@/lib/growth/video/assets.server";
import { MissingKeyError } from "@/lib/growth/video/driver-types";
import { materializePlan, materializeScene, planFromPost, renderSignature } from "@/lib/growth/video/render-plan.server";
import type { GrowthAsset, GrowthPost, GrowthScene } from "@/lib/growth/types";

const scene = (index: number, kind: GrowthScene["kind"], extra: Partial<GrowthScene> = {}): GrowthScene => ({
  index, kind, startMs: index * 3000, endMs: index * 3000 + 3000, text: `scene ${index} text`, direction: "", ...extra,
});

const post = (scenes: GrowthScene[], over: Partial<GrowthPost> = {}): GrowthPost => ({
  id: "p1", ideaId: null, status: "review", format: "reel", title: "T", hook: "H", script: "Script text.", scenes,
  captions: {}, platforms: ["instagram"], scheduledFor: null, approvedAt: null, approvedBy: null, publishedAt: null,
  createdBy: "admin", reviewNote: null, learnedFrom: null, createdAt: "", updatedAt: "", ...over,
});

function fakeStore(initial: GrowthAsset[] = []) {
  const rows: GrowthAsset[] = [...initial];
  const store: AssetStore = {
    async list() { return [...rows]; },
    async save(i: SaveAssetInput) {
      const meta = { ...(i.meta ?? {}), sceneIndex: i.sceneIndex };
      const existing = findAsset(rows, i);
      const row: GrowthAsset = {
        id: existing?.id ?? `a${rows.length + 1}`, postId: i.postId, kind: i.kind, storagePath: `${i.postId}/${i.fileName}`,
        publicUrl: `https://cdn.test/${i.postId}/${i.fileName}`, width: i.width ?? null, height: i.height ?? null,
        durationMs: i.durationMs ?? null, meta, createdAt: "",
      };
      if (existing) rows[rows.indexOf(existing)] = row; else rows.push(row);
      return row;
    },
  };
  return { store, rows };
}

const buf = Buffer.from("x");

describe("planFromPost", () => {
  it("marks missing clips to generate, shots to shoot, templates as template", () => {
    const plan = planFromPost(post([scene(0, "template"), scene(1, "generated"), scene(2, "shot")]), []);
    expect(plan.needs.map((n) => n.action)).toEqual(["template", "generate", "shoot"]);
    expect(plan.voice.action).toBe("synthesize");
  });
  it("reuses an existing asset row for the same scene index and kind", () => {
    const existing: GrowthAsset = { id: "c1", postId: "p1", kind: "clip", storagePath: "", publicUrl: "u", width: null, height: null, durationMs: null, meta: { sceneIndex: 1 }, createdAt: "" };
    const plan = planFromPost(post([scene(0, "template"), scene(1, "generated")]), [existing]);
    expect(plan.needs[1]).toMatchObject({ action: "reuse", asset: { id: "c1" } });
  });
  it("skips voice for non-reels and when there is no text", () => {
    expect(planFromPost(post([scene(0, "template")], { format: "image" }), []).voice.action).toBe("skip");
    expect(planFromPost(post([scene(0, "template", { text: "" })], { script: null }), []).voice.action).toBe("skip");
  });
});

describe("materializeScene", () => {
  it("generates a missing clip through the driver and stores one clip asset", async () => {
    const { store, rows } = fakeStore();
    const generateClip = vi.fn().mockResolvedValue({ buffer: buf, durationMs: 3000, meta: { model: "m" } });
    const plan = planFromPost(post([scene(0, "generated", { direction: "a sunny house" })]), []);
    const r = await materializeScene("p1", plan.needs[0], { store, drivers: { clips: [{ id: "veo", generateClip }], voice: null } });
    expect(generateClip).toHaveBeenCalledWith("a sunny house", { durationMs: 3000, aspect: "9:16" });
    expect(r.scene.assetUrl).toContain("scene-0.mp4");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "clip", meta: { sceneIndex: 0, driver: "veo", model: "m" } });
  });

  it("falls back to a template scene on MissingKeyError and records the fallback", async () => {
    const { store, rows } = fakeStore();
    const generateClip = vi.fn().mockRejectedValue(new MissingKeyError("GEMINI_API_KEY"));
    const plan = planFromPost(post([scene(0, "generated")]), []);
    const r = await materializeScene("p1", plan.needs[0], { store, drivers: { clips: [{ id: "veo", generateClip }], voice: null } });
    expect(r.scene).toMatchObject({ kind: "template", fallback: "template" });
    expect(r.assetId).toBeNull();
    expect(r.fallback).toMatchObject({ sceneIndex: 0, from: "generated", to: "template", reason: "missing key GEMINI_API_KEY" });
    expect(rows).toHaveLength(0);
  });

  it("falls back when no driver module is present at all", async () => {
    const { store } = fakeStore();
    const plan = planFromPost(post([scene(0, "generated")]), []);
    const r = await materializeScene("p1", plan.needs[0], { store, drivers: { clips: [], voice: null } });
    expect(r.scene.fallback).toBe("template");
  });

  it("falls back when a product shot fails and records a shot asset when it works", async () => {
    const { store, rows } = fakeStore();
    const plan = planFromPost(post([scene(0, "shot", { direction: "route:/portal/dashboard" })]), []);
    const bad = await materializeScene("p1", plan.needs[0], { store, shoot: async () => { throw new Error("no showcase account"); } });
    expect(bad.fallback?.reason).toBe("no showcase account");
    const ok = await materializeScene("p1", plan.needs[0], { store, shoot: async () => buf, baseUrl: "http://localhost:3007" });
    expect(ok.scene.assetUrl).toBeTruthy();
    expect(rows[0]).toMatchObject({ kind: "shot", meta: { direction: "route:/portal/dashboard" } });
  });
});

describe("materializePlan", () => {
  it("is idempotent: a second run reuses assets instead of inserting new rows or calling drivers", async () => {
    const { store, rows } = fakeStore();
    const generateClip = vi.fn().mockResolvedValue({ buffer: buf, durationMs: 3000, meta: {} });
    const synthesizeVoice = vi.fn().mockResolvedValue({ buffer: buf, durationMs: 4000, words: [{ word: "Hi", startMs: 0, endMs: 300 }] });
    const drivers = { clips: [{ id: "veo", generateClip }], voice: synthesizeVoice };
    const p = post([scene(0, "template"), scene(1, "generated")]);

    const first = await materializePlan(planFromPost(p, await store.list("p1")), { store, drivers });
    const countAfterFirst = rows.length;
    expect(countAfterFirst).toBe(2); // clip + voice
    expect(first.props.words).toHaveLength(1);
    expect(first.props.voiceUrl).toContain("voice.mp3");

    const second = await materializePlan(planFromPost(p, await store.list("p1")), { store, drivers });
    expect(rows).toHaveLength(countAfterFirst);
    expect(generateClip).toHaveBeenCalledTimes(1);
    expect(synthesizeVoice).toHaveBeenCalledTimes(1);
    expect(second.sceneAssetIds).toEqual(first.sceneAssetIds);
    expect(second.props.words).toEqual(first.props.words);
  });

  it("renders with per-scene captions (no words, no voice) when no voice driver or key exists", async () => {
    const { store, rows } = fakeStore();
    const m = await materializePlan(planFromPost(post([scene(0, "template"), scene(1, "generated")]), []), {
      store,
      drivers: { clips: [{ id: "veo", generateClip: async () => { throw new MissingKeyError("GEMINI_API_KEY"); } }], voice: async () => { throw new MissingKeyError("ELEVENLABS_API_KEY"); } },
    });
    expect(m.props.voiceUrl).toBeUndefined();
    expect(m.props.words).toBeUndefined();
    expect(m.props.scenes.every((s) => s.kind === "template")).toBe(true);
    expect(m.fallbacks).toHaveLength(1);
    expect(rows).toHaveLength(0);
  });
});

describe("driver resolution", () => {
  it("skips modules that fail to import and honors GROWTH_VIDEO_DRIVER ordering", async () => {
    const gen = async () => ({ durationMs: 1, meta: {} });
    const loader = async (spec: string) => {
      if (spec === "./veo.server") return { generateClip: gen };
      if (spec === "./kling.server") return { generateClip: gen };
      throw new Error("Cannot find module");
    };
    const a = await resolveDrivers(loader);
    expect(a.clips.map((c) => c.id)).toEqual(["veo", "kling"]);
    expect(a.voice).toBeNull();
    vi.stubEnv("GROWTH_VIDEO_DRIVER", "kling");
    expect((await resolveDrivers(loader)).clips.map((c) => c.id)).toEqual(["kling", "veo"]);
    vi.unstubAllEnvs();
  });

  it("tries the next driver on MissingKeyError and rethrows real failures", async () => {
    const ok = vi.fn().mockResolvedValue({ buffer: buf, durationMs: 1, meta: {} });
    const r = await generateClipWithFallback(
      { clips: [{ id: "veo", generateClip: async () => { throw new MissingKeyError("A"); } }, { id: "kling", generateClip: ok }], voice: null },
      "p", { durationMs: 1000, aspect: "9:16" },
    );
    expect(r.driver).toBe("kling");
    await expect(
      generateClipWithFallback({ clips: [{ id: "veo", generateClip: async () => { throw new Error("boom"); } }], voice: null }, "p", { durationMs: 1000, aspect: "9:16" }),
    ).rejects.toThrow("boom");
  });
});

describe("renderSignature", () => {
  it("changes when scenes change and is stable otherwise", () => {
    const a = post([scene(0, "template")]);
    expect(renderSignature(a)).toBe(renderSignature({ ...a }));
    expect(renderSignature(a)).not.toBe(renderSignature(post([scene(0, "template", { text: "different" })])));
  });
});
