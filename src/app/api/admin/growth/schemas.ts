import { z } from "zod";
import { GROWTH_FORMATS, GROWTH_PLATFORMS, GROWTH_ANGLES, GROWTH_PUBLISHER_IDS } from "@/lib/growth/types";

export const platformSchema = z.enum(GROWTH_PLATFORMS);
export const formatSchema = z.enum(GROWTH_FORMATS);
export const angleSchema = z.enum(GROWTH_ANGLES);
export const publisherSchema = z.enum(GROWTH_PUBLISHER_IDS);
export const uuidSchema = z.string().uuid();
export const isoSchema = z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), "invalid date");

export const sceneSchema = z.object({
  index: z.number().int(),
  kind: z.enum(["generated", "template", "shot", "still"]),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string(),
  direction: z.string(),
});
