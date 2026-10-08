import { z } from "zod";
import type { GrowthScene } from "./types";

export const MAX_SCENES = 8;

export const growthSceneSchema = z.object({
  index: z.number().int().min(0),
  kind: z.enum(["generated", "template", "shot", "still"]),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string().max(600),
  direction: z.string().max(1000),
});

/** A replacement scenes array: at most 8, end after start, indexes re-numbered 0..n-1 in order. */
export const sceneListSchema = z
  .array(growthSceneSchema)
  .max(MAX_SCENES)
  .refine((s) => s.every((x) => x.endMs >= x.startMs), "scene endMs must not be before startMs")
  .transform((s): GrowthScene[] => s.map((x, i) => ({ ...x, index: i })));
