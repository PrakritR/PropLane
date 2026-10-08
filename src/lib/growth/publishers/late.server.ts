import "server-only";

import { createHash } from "node:crypto";
import type { GrowthPlatform, GrowthPublisher, PublishInput, PublishResult } from "../types";

// Late (getlate.dev, now docs.zernio.com). Bearer auth; POST /v1/posts with publishNow.
// UNVERIFIED (TODO): the exact request schema was not fully readable from the docs; the shape below follows
// the documented controls (content, platforms[{platform, accountId}], mediaItems, publishNow) and the
// documented Idempotency-Key header. Confirm against the OpenAPI spec before enabling in production.
// Video (Phase 2): reels pass through as mediaItems [{type:"video", url}]. TODO(inferred): the video item shape mirrors the image one.
const LATE_BASE = process.env.GROWTH_LATE_BASE_URL?.trim() || "https://getlate.dev/api";

const PLATFORM_MAP: Partial<Record<GrowthPlatform, string>> = {
  instagram: "instagram",
  tiktok: "tiktok",
  youtube: "youtube",
  linkedin: "linkedin",
  x: "twitter",
  threads: "threads",
  facebook: "facebook",
};

export const latePublisher: GrowthPublisher = {
  id: "late",
  async publish(input: PublishInput): Promise<PublishResult> {
    const key = process.env.GROWTH_LATE_API_KEY?.trim();
    if (!key) return { ok: false, error: "GROWTH_LATE_API_KEY is not set", retryable: false };
    const platform = PLATFORM_MAP[input.platform];
    if (!platform) return { ok: false, error: `Late does not support ${input.platform}`, retryable: false };
    if (!input.account.vendorAccountId) return { ok: false, error: "Account has no Late accountId", retryable: false };
    try {
      const res = await fetch(`${LATE_BASE}/v1/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          // Same (post, platform) always maps to the same key so a retry cannot double post (24h window).
          "Idempotency-Key": uuidFrom(`${input.post.id}:${input.platform}`),
        },
        body: JSON.stringify({
          content: input.caption,
          platforms: [{ platform, accountId: input.account.vendorAccountId }],
          mediaItems: input.media.map((m) => ({ type: m.kind, url: m.url })),
          publishNow: true,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok && res.status !== 200 && res.status !== 202) {
        return { ok: false, error: `Late ${res.status}: ${String(body.error ?? body.message ?? "request failed")}`, retryable: res.status >= 500 || res.status === 429 || res.status === 409 };
      }
      const post = (body.post ?? body) as Record<string, unknown>;
      const id = String(post._id ?? post.id ?? body.postId ?? "") || null;
      const plats = Array.isArray(post.platforms) ? (post.platforms as Array<Record<string, unknown>>) : [];
      const url = (plats[0]?.platformPostUrl ?? post.platformPostUrl ?? null) as string | null;
      const platformPostId = (plats[0]?.platformPostId ?? null) as string | null;
      return { ok: true, vendorPostId: id, platformPostId, platformUrl: url };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Late request failed", retryable: true };
    }
  },
};

/** Deterministic UUID-shaped string from a seed (sha1 based; not a real v5, only needs to be stable). */
function uuidFrom(seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
