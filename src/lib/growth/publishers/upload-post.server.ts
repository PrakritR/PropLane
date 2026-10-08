import "server-only";

import type { GrowthPlatform, GrowthPublisher, PublishInput, PublishResult } from "../types";

// Upload-Post. POST https://api.upload-post.com/api/upload, multipart, `Authorization: Apikey <key>`.
// Verified from docs: video upload (user, platform[], video as URL, title, description) and the 200
// response { success, results: { <platform>: { success, url, error } } }.
// UNVERIFIED (TODO): the photo and text endpoints (upload-photo.md / upload-text.md) were not readable;
// photos/text below use /api/upload_photos and /api/upload_text as the best-known paths.
const BASE = "https://api.upload-post.com/api";

const PLATFORM_MAP: Partial<Record<GrowthPlatform, string>> = {
  instagram: "instagram",
  tiktok: "tiktok",
  youtube: "youtube",
  linkedin: "linkedin",
  x: "x",
  threads: "threads",
  facebook: "facebook",
};

export const uploadPostPublisher: GrowthPublisher = {
  id: "upload_post",
  async publish(input: PublishInput): Promise<PublishResult> {
    const key = process.env.GROWTH_UPLOAD_POST_API_KEY?.trim();
    if (!key) return { ok: false, error: "GROWTH_UPLOAD_POST_API_KEY is not set", retryable: false };
    const platform = PLATFORM_MAP[input.platform];
    if (!platform) return { ok: false, error: `Upload-Post does not support ${input.platform}`, retryable: false };
    // vendorAccountId is the Upload-Post profile username (`user`).
    const user = input.account.vendorAccountId;
    if (!user) return { ok: false, error: "Account has no Upload-Post profile (vendorAccountId)", retryable: false };

    const video = input.media.find((m) => m.kind === "video");
    const images = input.media.filter((m) => m.kind === "image");
    const form = new FormData();
    form.set("user", user);
    form.append("platform[]", platform);
    form.set("title", input.post.title);
    form.set("description", input.caption);
    let path = "upload";
    if (video) {
      form.set("video", video.url);
    } else if (images.length > 0) {
      path = "upload_photos";
      for (const img of images) form.append("photos[]", img.url);
    } else {
      path = "upload_text";
      form.set("title", input.caption);
    }
    try {
      const res = await fetch(`${BASE}/${path}`, {
        method: "POST",
        headers: { Authorization: `Apikey ${key}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || body.success === false) {
        return { ok: false, error: `Upload-Post ${res.status}: ${String(body.message ?? body.error ?? "request failed")}`, retryable: res.status >= 500 || res.status === 429 };
      }
      const results = (body.results ?? {}) as Record<string, Record<string, unknown>>;
      const mine = results[platform];
      if (mine && mine.success === false) return { ok: false, error: String(mine.error ?? "platform rejected"), retryable: false };
      const requestId = (body.request_id ?? body.job_id ?? null) as string | null;
      return { ok: true, vendorPostId: requestId, platformPostId: (mine?.platform_post_id ?? null) as string | null, platformUrl: (mine?.url ?? null) as string | null };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Upload-Post request failed", retryable: true };
    }
  },
};
