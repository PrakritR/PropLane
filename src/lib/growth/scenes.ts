import { z } from "zod";
import type { GrowthScene } from "./types";

export const MAX_SCENES = 8;
/** Longest a single scene may run. A generated clip is 5-10 s; a template scene has no media to outlast. */
export const MAX_SCENE_MS = 30_000;
/** Longest the whole timeline may run (MAX_SCENES x MAX_SCENE_MS), so one bad save cannot hang a render. */
export const MAX_REEL_MS = MAX_SCENES * MAX_SCENE_MS;

/** Stable, isomorphic scene id: assets are keyed on it, so removing a scene never re-points another's media. */
export function newSceneId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `sc_${uuid ? uuid.slice(0, 12) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`}`;
}

export const growthSceneSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  index: z.number().int().min(0),
  kind: z.enum(["generated", "template", "shot", "still"]),
  startMs: z.number().int().min(0).max(MAX_REEL_MS),
  endMs: z.number().int().min(0).max(MAX_REEL_MS),
  text: z.string().max(600),
  direction: z.string().max(1000),
});

/**
 * Lay the scenes end to end from 0, each keeping its own length (clamped to {@link MAX_SCENE_MS}).
 * Removing or reordering a scene therefore leaves no hole and no overlap in the rendered timeline.
 */
export function reflowScenes(scenes: readonly GrowthScene[]): GrowthScene[] {
  let cursor = 0;
  return scenes.map((scene, index) => {
    const duration = Math.min(Math.max(0, scene.endMs - scene.startMs), MAX_SCENE_MS);
    const startMs = cursor;
    cursor = startMs + duration;
    return { ...scene, index, startMs, endMs: cursor };
  });
}

/** Every scene carries an id, and no two share one. */
export function withSceneIds(scenes: readonly GrowthScene[]): GrowthScene[] {
  const seen = new Set<string>();
  return scenes.map((scene) => {
    const id = scene.id && !seen.has(scene.id) ? scene.id : newSceneId();
    seen.add(id);
    return { ...scene, id };
  });
}

/**
 * A replacement scenes array: at most 8, each with a stable id, indexes re-numbered 0..n-1 in order,
 * and the timeline re-flowed contiguously from 0.
 */
export const sceneListSchema = z
  .array(growthSceneSchema)
  .max(MAX_SCENES)
  .refine((s) => s.every((x) => x.endMs >= x.startMs), "scene endMs must not be before startMs")
  .refine(
    (s) => s.every((x) => x.endMs - x.startMs <= MAX_SCENE_MS),
    `a scene may not run longer than ${MAX_SCENE_MS / 1000} seconds`,
  )
  .transform((s): GrowthScene[] => reflowScenes(withSceneIds(s as GrowthScene[])));
