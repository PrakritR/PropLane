import { z } from "zod";
import {
  GROWTH_PLATFORMS,
  type DraftOutput,
  type GrowthFormat,
  type GrowthPlatform,
} from "./types";

const platformEnum = z.enum(GROWTH_PLATFORMS);

const sceneSchema = z.object({
  index: z.number().int().optional(),
  kind: z.enum(["generated", "template", "shot", "still"]),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  text: z.string().min(1),
  direction: z.string().min(1),
});

const draftSchema = z.object({
  title: z.string().min(1).max(140),
  hook: z.string().min(1).max(280),
  script: z.string().min(1),
  scenes: z.array(sceneSchema).min(3).max(5),
  captions: z.record(platformEnum, z.string().min(1)),
  platforms: z.array(platformEnum).min(1).optional(),
});

export function defaultPlatforms(format: GrowthFormat): GrowthPlatform[] {
  if (format === "reel") return ["instagram", "tiktok", "youtube"];
  if (format === "carousel" || format === "image") return ["instagram", "linkedin"];
  return ["linkedin", "x"];
}

function hashtagCount(s: string): number {
  return (s.match(/#\w+/g) ?? []).length;
}

/** Extract the JSON object from model text, validate, and normalise. Throws on any violation. */
export function parseDraftOutput(text: string, format: GrowthFormat): DraftOutput {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("draft: no JSON object in model output");
  const parsed = draftSchema.parse(JSON.parse(text.slice(start, end + 1)));
  const platforms = parsed.platforms?.length ? [...new Set(parsed.platforms)] : defaultPlatforms(format);
  const captions: DraftOutput["captions"] = {};
  for (const p of platforms) {
    const c = parsed.captions[p];
    if (!c) throw new Error(`draft: missing caption for ${p}`);
    if (p === "x" && c.length > 280) throw new Error("draft: x caption exceeds 280 characters");
    if ((p === "instagram" || p === "tiktok") && hashtagCount(c) > 6) throw new Error(`draft: ${p} caption has more than 6 hashtags`);
    captions[p] = c;
  }
  const scenes = parsed.scenes.map((s, i) => ({ ...s, index: i }));
  for (const s of scenes) if (s.endMs <= s.startMs) throw new Error("draft: scene endMs must exceed startMs");
  return { title: parsed.title, hook: parsed.hook, script: parsed.script, scenes, captions, platforms };
}
