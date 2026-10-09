import "server-only";

import type { ClipAspect, ClipResult, VideoDriver, VoiceResult } from "./driver-types";
import { estimateClipCostUsd as klingCost, generateClip as klingClip } from "./kling.server";
import { estimateClipCostUsd as veoCost, generateClip as veoClip } from "./veo.server";
import { synthesizeVoice } from "./elevenlabs.server";

export type ClipDriverId = "veo" | "kling";

export function clipDriverId(): ClipDriverId {
  return process.env.GROWTH_VIDEO_DRIVER?.trim().toLowerCase() === "kling" ? "kling" : "veo";
}

export function resolveClipDriver(): Pick<VideoDriver, "generateClip"> & { id: ClipDriverId } {
  const id = clipDriverId();
  const fn = id === "kling" ? klingClip : veoClip;
  return { id, generateClip: (p: string, o: { durationMs: number; aspect: ClipAspect }): Promise<ClipResult> => fn(p, o) };
}

export function resolveVoiceDriver(): Pick<VideoDriver, "synthesizeVoice"> {
  return { synthesizeVoice: (text: string): Promise<VoiceResult> => synthesizeVoice(text) };
}

/** Keys are reported as booleans only. Per-reel estimate: ~3 generated clips of 8 s plus ~600 chars of voice. */
export function videoDriverStatus() {
  const driver = clipDriverId();
  const has = (n: string) => Boolean(process.env[n]?.trim());
  const clipKey = driver === "kling" ? has("FAL_KEY") : has("GEMINI_API_KEY");
  const clipUsd = Math.round((driver === "kling" ? klingCost(24) : veoCost(24, "1080p")) * 100) / 100;
  // TODO(inferred): ElevenLabs ~USD 0.30 per 1,000 characters (plan-dependent).
  const voiceUsd = Math.round(0.3 * 0.6 * 100) / 100;
  return {
    clip: { driver, keyPresent: clipKey },
    voice: { keyPresent: has("ELEVENLABS_API_KEY") },
    estimatePerReelUsd: { clip: clipUsd, voice: voiceUsd, total: Math.round((clipUsd + voiceUsd) * 100) / 100 },
  };
}

export type VideoDriverStatus = ReturnType<typeof videoDriverStatus>;
