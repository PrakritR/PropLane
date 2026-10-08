/**
 * Caption timing utilities. Pure (no server-only marker) because the Remotion bundle imports this file
 * as well as the render orchestration, so burned captions and the stored meta.captions never drift apart.
 */
import type { VoiceWord } from "./driver-types";

export type CaptionWord = VoiceWord;
export type CaptionChunk = { startMs: number; endMs: number; words: CaptionWord[] };

/** Spread the words of `text` evenly over [startMs, endMs). Used when a scene has text but no voice timings. */
export function wordsFromText(text: string, startMs: number, endMs: number): CaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || endMs <= startMs) return [];
  const step = (endMs - startMs) / tokens.length;
  return tokens.map((word, i) => ({
    word,
    startMs: Math.round(startMs + step * i),
    endMs: Math.round(startMs + step * (i + 1)),
  }));
}

/** Drop malformed timings, sort, and clamp so every word ends after it starts and none overlap backwards. */
export function normalizeWords(words: ReadonlyArray<Partial<CaptionWord>> | undefined | null): CaptionWord[] {
  if (!Array.isArray(words)) return [];
  const clean = words
    .filter((w): w is CaptionWord => typeof w?.word === "string" && w.word.trim() !== "" && Number.isFinite(w.startMs) && Number.isFinite(w.endMs))
    .map((w) => ({ word: w.word.trim(), startMs: Math.max(0, w.startMs), endMs: Math.max(0, w.endMs) }))
    .sort((a, b) => a.startMs - b.startMs);
  let cursor = 0;
  return clean.map((w) => {
    const startMs = Math.max(w.startMs, cursor);
    const endMs = Math.max(w.endMs, startMs + 1);
    cursor = endMs;
    return { word: w.word, startMs, endMs };
  });
}

/** Group words into short on-screen lines: at most `maxWords`, broken early by a pause or sentence end. */
export function groupCaptionWords(
  words: CaptionWord[],
  opts: { maxWords?: number; maxChars?: number; gapMs?: number } = {},
): CaptionChunk[] {
  const maxWords = opts.maxWords ?? 4;
  const maxChars = opts.maxChars ?? 26;
  const gapMs = opts.gapMs ?? 450;
  const chunks: CaptionChunk[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (cur.length) chunks.push({ startMs: cur[0].startMs, endMs: cur[cur.length - 1].endMs, words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length;
    if (prev && (cur.length >= maxWords || chars > maxChars || w.startMs - prev.endMs > gapMs)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.word)) flush();
  }
  flush();
  return chunks;
}

/** The chunk on screen at `ms` (held until the next chunk starts, up to a short tail), else null. */
export function chunkAt(chunks: CaptionChunk[], ms: number, tailMs = 250): CaptionChunk | null {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const next = chunks[i + 1];
    const end = Math.min(c.endMs + tailMs, next ? next.startMs : Infinity);
    if (ms >= c.startMs && ms < end) return c;
  }
  return null;
}

/** Index of the word being spoken at `ms` within a chunk (-1 before the first word starts). */
export function activeWordIndex(chunk: CaptionChunk, ms: number): number {
  let idx = -1;
  for (let i = 0; i < chunk.words.length; i++) if (ms >= chunk.words[i].startMs) idx = i;
  return idx;
}

/** Shift every word by `deltaMs` (voice that starts after the reel's first frame). */
export function shiftWords(words: CaptionWord[], deltaMs: number): CaptionWord[] {
  return words.map((w) => ({ ...w, startMs: w.startMs + deltaMs, endMs: w.endMs + deltaMs }));
}

/** meta.captions stored on the final asset: per-chunk text with timings, enough to rebuild SRT/VTT later. */
export function captionTrack(words: CaptionWord[]): Array<{ text: string; startMs: number; endMs: number }> {
  return groupCaptionWords(words).map((c) => ({ text: c.words.map((w) => w.word).join(" "), startMs: c.startMs, endMs: c.endMs }));
}
