import "server-only";

import { MissingKeyError, type VoiceResult, type VoiceWord } from "./driver-types";

// ElevenLabs POST /v1/text-to-speech/{voice_id}/with-timestamps (verified). Auth header is `xi-api-key`
// (TODO inferred: not shown on the fetched page). Response { audio_base64, alignment{characters, character_start_times_seconds, character_end_times_seconds} }.
const BASE = "https://api.elevenlabs.io/v1";
/** Rachel, the voice id used in ElevenLabs' own docs examples. */
export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
export const MAX_VOICE_CHARS = 1500;

type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };

/** Fold per-character timings into per-word timings (whitespace splits words). */
export function charsToWords(a: Alignment): VoiceWord[] {
  const words: VoiceWord[] = [];
  let cur = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (cur) words.push({ word: cur, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
    cur = "";
  };
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) return flush();
    if (!cur) start = a.character_start_times_seconds[i] ?? 0;
    cur += ch;
    end = a.character_end_times_seconds[i] ?? end;
  });
  flush();
  return words;
}

export async function synthesizeVoice(text: string, deps: { fetch?: typeof fetch } = {}): Promise<VoiceResult> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new MissingKeyError("ELEVENLABS_API_KEY");
  if (text.length > MAX_VOICE_CHARS) throw new Error(`Voice text is ${text.length} chars; the limit is ${MAX_VOICE_CHARS}`);
  const voiceId = process.env.GROWTH_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
  const f = deps.fetch ?? fetch;
  const res = await f(`${BASE}/text-to-speech/${voiceId}/with-timestamps`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const body = (await res.json()) as { audio_base64?: string; alignment?: Alignment | null };
  if (!body.audio_base64) throw new Error("ElevenLabs returned no audio");
  const words = body.alignment ? charsToWords(body.alignment) : [];
  const ends = body.alignment?.character_end_times_seconds ?? [];
  const durationMs = Math.round((ends.length ? ends[ends.length - 1]! : 0) * 1000);
  return { buffer: Buffer.from(body.audio_base64, "base64"), durationMs, words };
}
