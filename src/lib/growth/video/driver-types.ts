export type ClipAspect = "9:16" | "16:9" | "1:1";

export type ClipResult = {
  url?: string;
  buffer?: Buffer;
  durationMs: number;
  meta: Record<string, unknown>;
};

export type VoiceWord = { word: string; startMs: number; endMs: number };

export type VoiceResult = { buffer: Buffer; durationMs: number; words: VoiceWord[] };

export interface VideoDriver {
  generateClip(prompt: string, opts: { durationMs: number; aspect: ClipAspect }): Promise<ClipResult>;
  synthesizeVoice(text: string): Promise<VoiceResult>;
}

/** Thrown when a vendor key is unset; the orchestrator skips the scene and falls back to a template scene. */
export class MissingKeyError extends Error {
  constructor(readonly envVar: string) {
    super(`${envVar} is not set`);
    this.name = "MissingKeyError";
  }
}
