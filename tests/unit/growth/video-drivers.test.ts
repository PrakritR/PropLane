import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissingKeyError } from "@/lib/growth/video/driver-types";
import { generateClip as veo, estimateClipCostUsd as veoCost } from "@/lib/growth/video/veo.server";
import { generateClip as kling } from "@/lib/growth/video/kling.server";
import { charsToWords, synthesizeVoice } from "@/lib/growth/video/elevenlabs.server";
import { videoDriverStatus } from "@/lib/growth/video/index.server";

const json = (b: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => b, text: async () => JSON.stringify(b), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as unknown as Response;
const sleep = async () => undefined;
const KEYS = ["GEMINI_API_KEY", "FAL_KEY", "ELEVENLABS_API_KEY", "GROWTH_VIDEO_DRIVER"];

beforeEach(() => KEYS.forEach((k) => vi.stubEnv(k, "")));
afterEach(() => vi.unstubAllEnvs());

describe("veo", () => {
  it("throws MissingKeyError without a key", async () => {
    await expect(veo("x", { durationMs: 8000, aspect: "9:16" })).rejects.toBeInstanceOf(MissingKeyError);
  });
  it("starts, polls, downloads", async () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    let polls = 0;
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes(":predictLongRunning")) {
        expect(JSON.parse(String(init?.body)).parameters).toMatchObject({ aspectRatio: "9:16", resolution: "1080p", durationSeconds: "8" });
        return json({ name: "operations/abc" });
      }
      if (u.endsWith("operations/abc")) return json(++polls < 2 ? { done: false } : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://files/v.mp4" } }] } } });
      return json({});
    });
    const r = await veo("p", { durationMs: 8000, aspect: "9:16" }, { fetch: f as unknown as typeof fetch, sleep });
    expect(r.buffer?.length).toBe(3);
    expect(r.meta).toMatchObject({ operation: "operations/abc" });
    expect(polls).toBe(2);
  });
  it("estimates cost from the doc prices", () => {
    expect(veoCost(8, "1080p", true)).toBe(0.96);
  });
});

describe("kling", () => {
  it("throws MissingKeyError without a key", async () => {
    await expect(kling("x", { durationMs: 5000, aspect: "9:16" })).rejects.toBeInstanceOf(MissingKeyError);
  });
  it("submits, polls, fetches result", async () => {
    vi.stubEnv("FAL_KEY", "k");
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") return json({ request_id: "r1", status_url: "https://q/s", response_url: "https://q/r" });
      if (u === "https://q/s") return json({ status: "COMPLETED" });
      if (u === "https://q/r") return json({ video: { url: "https://cdn/v.mp4" } });
      return json({});
    });
    const r = await kling("p", { durationMs: 5000, aspect: "9:16" }, { fetch: f as unknown as typeof fetch, sleep });
    expect(r.buffer?.length).toBe(3);
    expect(r.meta).toMatchObject({ requestId: "r1" });
  });
});

describe("elevenlabs", () => {
  it("throws MissingKeyError without a key", async () => {
    await expect(synthesizeVoice("hi")).rejects.toBeInstanceOf(MissingKeyError);
  });
  it("rejects text over 1500 chars", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k");
    await expect(synthesizeVoice("a".repeat(1501))).rejects.toThrow(/1500/);
  });
  it("maps characters to words", () => {
    const words = charsToWords({ characters: [..."hi yo"], character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5] });
    expect(words).toEqual([{ word: "hi", startMs: 0, endMs: 200 }, { word: "yo", startMs: 300, endMs: 500 }]);
  });
  it("returns mp3 buffer, words and duration", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k");
    const f = vi.fn(async () => json({ audio_base64: Buffer.from("abc").toString("base64"), alignment: { characters: ["a"], character_start_times_seconds: [0], character_end_times_seconds: [0.5] } }));
    const r = await synthesizeVoice("a", { fetch: f as unknown as typeof fetch });
    expect(r.buffer.toString()).toBe("abc");
    expect(r.durationMs).toBe(500);
  });
});

describe("videoDriverStatus", () => {
  it("defaults to veo and reports key presence as booleans", () => {
    const s = videoDriverStatus();
    expect(s.clip).toEqual({ driver: "veo", keyPresent: false });
    expect(s.voice.keyPresent).toBe(false);
    expect(s.estimatePerReelUsd.total).toBeGreaterThan(0);
  });
});
