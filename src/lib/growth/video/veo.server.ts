import "server-only";

import { MissingKeyError, type ClipAspect, type ClipResult } from "./driver-types";

// Gemini API, Veo 3.1 (https://ai.google.dev/gemini-api/docs/veo). Verified from docs:
// POST {base}/models/{model}:predictLongRunning with x-goog-api-key, body {instances:[{prompt}], parameters:{aspectRatio, resolution, durationSeconds}},
// poll GET {base}/{operation.name} until done, video at response.generateVideoResponse.generatedSamples[0].video.uri (download with the key header).
// 1080p supports only 8 s clips. durationSeconds is a string "4"|"6"|"8".
const BASE = "https://generativelanguage.googleapis.com/v1beta";
export const VEO_MODEL = process.env.GROWTH_VEO_MODEL?.trim() || "veo-3.1-fast-generate-preview";
const POLL_MS = 10_000;
const CAP_MS = 6 * 60_000;

export type VeoQuality = "720p" | "1080p" | "4k";

/** USD per second of generated video with audio (ai.google.dev/gemini-api/docs/pricing). */
export function estimateClipCostUsd(durationS: number, quality: VeoQuality = "1080p", fast = VEO_MODEL.includes("fast")): number {
  const table = fast ? { "720p": 0.1, "1080p": 0.12, "4k": 0.3 } : { "720p": 0.4, "1080p": 0.4, "4k": 0.6 };
  return Math.round(table[quality] * durationS * 100) / 100;
}

export type VeoDeps = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; pollMs?: number; capMs?: number };

export async function generateClip(
  prompt: string,
  opts: { durationMs: number; aspect: ClipAspect },
  deps: VeoDeps = {},
): Promise<ClipResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new MissingKeyError("GEMINI_API_KEY");
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? POLL_MS;
  const capMs = deps.capMs ?? CAP_MS;
  const aspectRatio = opts.aspect === "16:9" ? "16:9" : "9:16"; // Veo supports only 16:9 and 9:16
  const requested = Math.round(opts.durationMs / 1000);
  // 1080p only works at 8 s, so any clip request is generated at 8 s and trimmed in the render.
  const durationSeconds = requested >= 8 || requested <= 0 ? 8 : requested <= 4 ? 4 : requested <= 6 ? 6 : 8;
  const resolution = durationSeconds === 8 ? "1080p" : "720p";
  const headers = { "x-goog-api-key": key, "Content-Type": "application/json" };

  const start = await f(`${BASE}/models/${VEO_MODEL}:predictLongRunning`, {
    method: "POST",
    headers,
    body: JSON.stringify({ instances: [{ prompt }], parameters: { aspectRatio, resolution, durationSeconds: String(durationSeconds) } }),
  });
  if (!start.ok) throw new Error(`Veo start failed (${start.status}): ${(await start.text().catch(() => "")).slice(0, 300)}`);
  const op = (await start.json()) as { name?: string };
  if (!op.name) throw new Error("Veo start returned no operation name");

  let waited = 0;
  for (;;) {
    const res = await f(`${BASE}/${op.name}`, { headers: { "x-goog-api-key": key } });
    if (!res.ok) throw new Error(`Veo poll failed (${res.status})`);
    const body = (await res.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }>; raiMediaFilteredReasons?: string[] } };
    };
    if (body.error) throw new Error(`Veo failed: ${body.error.message ?? "unknown"}`);
    if (body.done) {
      const uri = body.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error(`Veo returned no video${body.response?.generateVideoResponse?.raiMediaFilteredReasons?.[0] ? `: ${body.response.generateVideoResponse.raiMediaFilteredReasons[0]}` : ""}`);
      const dl = await f(uri, { headers: { "x-goog-api-key": key }, redirect: "follow" });
      if (!dl.ok) throw new Error(`Veo download failed (${dl.status})`);
      const buffer = Buffer.from(await dl.arrayBuffer());
      return { buffer, durationMs: durationSeconds * 1000, meta: { model: VEO_MODEL, operation: op.name, resolution } };
    }
    if (waited >= capMs) throw new Error("Veo timed out after 6 minutes");
    await sleep(pollMs);
    waited += pollMs;
  }
}
