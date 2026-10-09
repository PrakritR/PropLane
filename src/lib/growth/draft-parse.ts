import { z } from "zod";
import { reflowScenes, withSceneIds } from "./scenes";
import {
  GROWTH_PLATFORMS,
  type DraftOutput,
  type GrowthFormat,
  type GrowthPlatform,
} from "./types";

const platformEnum = z.enum(GROWTH_PLATFORMS);

const sceneSchema = z.object({
  index: z.number().int().optional(),
  id: z.string().min(1).max(64).optional(),
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

/** Escape raw CR/LF characters that sit inside JSON string literals (a common model slip). */
export function escapeNewlinesInStrings(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (ch === "\\") {
        out += ch + (json[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      else if (ch === "\n") {
        out += "\\n";
        continue;
      } else if (ch === "\r") {
        out += "\\r";
        continue;
      }
    } else if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}

/**
 * Strip Markdown fences, take the outermost object, parse. If that fails, make one repair attempt
 * that escapes raw newlines inside string literals. Throws the original parse error when both fail.
 */
export function parseJsonLoose(text: string): unknown {
  const unfenced = text.replace(/```[a-zA-Z]*/g, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("draft: no JSON object in model output");
  const candidate = unfenced.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    try {
      return JSON.parse(escapeNewlinesInStrings(candidate));
    } catch {
      throw err;
    }
  }
}

/** Extract the JSON object from model text, validate, and normalise. Throws on any violation. */
export function parseDraftOutput(text: string, format: GrowthFormat): DraftOutput {
  const parsed = draftSchema.parse(parseJsonLoose(text));
  const platforms = parsed.platforms?.length ? [...new Set(parsed.platforms)] : defaultPlatforms(format);
  const captions: DraftOutput["captions"] = {};
  for (const p of platforms) {
    const c = parsed.captions[p];
    if (!c) throw new Error(`draft: missing caption for ${p}`);
    if (p === "x" && c.length > 280) throw new Error("draft: x caption exceeds 280 characters");
    if ((p === "instagram" || p === "tiktok") && hashtagCount(c) > 6) throw new Error(`draft: ${p} caption has more than 6 hashtags`);
    captions[p] = c;
  }
  for (const s of parsed.scenes) if (s.endMs <= s.startMs) throw new Error("draft: scene endMs must exceed startMs");
  // Stable ids and a contiguous timeline from the first save, the same shape `sceneListSchema` enforces.
  const scenes = reflowScenes(withSceneIds(parsed.scenes.map((s, i) => ({ ...s, index: i }))));
  return { title: parsed.title, hook: parsed.hook, script: parsed.script, scenes, captions, platforms };
}
