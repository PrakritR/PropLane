import { describe, expect, it } from "vitest";

import {
  activeWordIndex,
  captionTrack,
  chunkAt,
  groupCaptionWords,
  normalizeWords,
  type CaptionWord,
} from "@/lib/growth/video/captions.server";

/** Fixture: spread the words of `text` evenly over [startMs, endMs). */
function evenWords(text: string, startMs: number, endMs: number): CaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const step = (endMs - startMs) / tokens.length;
  return tokens.map((word, i) => ({ word, startMs: Math.round(startMs + step * i), endMs: Math.round(startMs + step * (i + 1)) }));
}

describe("normalizeWords", () => {
  it("drops malformed entries, sorts, and removes overlaps", () => {
    const out = normalizeWords([
      { word: "b", startMs: 500, endMs: 900 },
      { word: "a", startMs: 0, endMs: 600 },
      { word: "  ", startMs: 0, endMs: 10 },
      { word: "x", startMs: Number.NaN, endMs: 10 },
    ]);
    expect(out.map((w) => w.word)).toEqual(["a", "b"]);
    expect(out[1].startMs).toBeGreaterThanOrEqual(out[0].endMs);
    expect(out.every((w) => w.endMs > w.startMs)).toBe(true);
  });
  it("tolerates undefined", () => {
    expect(normalizeWords(undefined)).toEqual([]);
  });
});

describe("groupCaptionWords / chunkAt / activeWordIndex", () => {
  const words = evenWords("Rent is collected. Repairs are handled by us", 0, 4000);
  it("breaks at sentence ends and the word cap", () => {
    const chunks = groupCaptionWords(words, { maxWords: 4 });
    expect(chunks[0].words.map((w) => w.word)).toEqual(["Rent", "is", "collected."]);
    expect(chunks.every((c) => c.words.length <= 4)).toBe(true);
  });
  it("breaks on a pause", () => {
    const chunks = groupCaptionWords([
      { word: "a", startMs: 0, endMs: 200 },
      { word: "b", startMs: 2000, endMs: 2200 },
    ]);
    expect(chunks).toHaveLength(2);
  });
  it("finds the chunk on screen and the spoken word", () => {
    const chunks = groupCaptionWords(words);
    const c = chunkAt(chunks, 100)!;
    expect(c.words[0].word).toBe("Rent");
    expect(activeWordIndex(c, 100)).toBe(0);
    expect(activeWordIndex(c, c.words[1].startMs + 1)).toBe(1);
    expect(chunkAt(chunks, 999_999)).toBeNull();
  });
  it("exports a track", () => {
    const track = captionTrack(words);
    expect(track[0]).toMatchObject({ text: "Rent is collected.", startMs: 0 });
  });
});
