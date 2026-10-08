import type { GrowthScene } from "../../src/lib/growth/types";

export type ReelWord = { word: string; startMs: number; endMs: number };

/** A scene as the renderer sees it: the plan scene plus the public URL of the asset that fills it, if any. */
export type ReelScene = GrowthScene & {
  assetUrl?: string;
  /** Set when the planned kind could not be produced (no key, shot failed) and a template scene stands in. */
  fallback?: "template";
};

export type Brand = { mark: string; blue: string };

export type ReelProps = {
  post: { id: string; title: string; hook: string | null };
  scenes: ReelScene[];
  voiceUrl?: string;
  /** Word timings for the voice track. Absent = per-scene caption text instead of karaoke. */
  words?: ReelWord[];
  musicUrl?: string;
  brand: Brand;
  /** Length of the PropLane end card appended after the last scene. */
  endCardMs?: number;
  /** Overrides the computed length when the voice runs longer than the scenes. */
  totalMs?: number;
};

export type CardProps = {
  title: string;
  hook: string | null;
  /** Slide text for carousel posts (scene text); falls back to hook. */
  body?: string | null;
  index: number;
  total: number;
  brand: Brand;
};

export const FPS = 30;
export const DEFAULT_END_CARD_MS = 2500;

export function scenesEndMs(scenes: Array<Pick<GrowthScene, "endMs">>): number {
  return scenes.reduce((m, s) => Math.max(m, s.endMs), 0);
}

export function reelDurationMs(props: Pick<ReelProps, "scenes" | "endCardMs" | "totalMs">): number {
  const natural = scenesEndMs(props.scenes) + (props.endCardMs ?? DEFAULT_END_CARD_MS);
  return Math.max(natural, props.totalMs ?? 0, 1000);
}
