import "server-only";

import { fetchInstagramMediaInsights, MetaReelError, publishInstagramPhoto, publishInstagramReel, publishMetaPagePhoto } from "@/lib/listing-channels/meta/graph.server";
import { metaChannelsLive } from "@/lib/listing-channels/registry";
import type { GrowthMetric, GrowthPublication, GrowthPublisher, PublishInput, PublishResult } from "../types";

/**
 * Direct Instagram/Facebook image posts. Phase 1 only: the token comes from env GROWTH_META_PAGE_TOKEN
 * (a long-lived Page token). Phase 2 should store per-account tokens encrypted server-side instead.
 * `growth_accounts.vendor_account_id` is the IG business account id (instagram) or the Page id (facebook).
 */
export const metaPublisher: GrowthPublisher = {
  id: "meta",
  async publish(input: PublishInput): Promise<PublishResult> {
    // AGENTS.md: Facebook Page / Instagram stay "Coming soon" until the Meta app is approved (META_APP_LIVE=1).
    if (!metaChannelsLive()) return { ok: false, error: "Meta publishing is not live (META_APP_LIVE is not 1)", retryable: false };
    const token = process.env.GROWTH_META_PAGE_TOKEN?.trim();
    if (!token) return { ok: false, error: "GROWTH_META_PAGE_TOKEN is not set", retryable: false };
    const id = input.account.vendorAccountId;
    if (!id) return { ok: false, error: "Account has no vendorAccountId", retryable: false };
    const video = input.media.find((m) => m.kind === "video");
    const photo = input.media.find((m) => m.kind === "image");
    if (!photo && !(video && input.platform === "instagram")) {
      return { ok: false, error: "Meta publisher needs an image (or a video for Instagram Reels)", retryable: false };
    }
    try {
      if (input.platform === "instagram" && video) {
        const mediaId = await publishInstagramReel({ igAccountId: id, token, videoUrl: video.url, caption: input.caption });
        return { ok: true, vendorPostId: mediaId, platformPostId: mediaId, platformUrl: null };
      }
      if (!photo) return { ok: false, error: "Meta publisher needs an image", retryable: false };
      if (input.platform === "instagram") {
        const postId = await publishInstagramPhoto({ igAccountId: id, token, photoUrl: photo.url, caption: input.caption });
        return { ok: true, vendorPostId: postId, platformPostId: postId, platformUrl: null };
      }
      if (input.platform === "facebook") {
        const postId = await publishMetaPagePhoto({ pageId: id, token, photoUrl: photo.url, caption: input.caption });
        return { ok: true, vendorPostId: postId, platformPostId: postId, platformUrl: `https://www.facebook.com/${postId}` };
      }
      return { ok: false, error: `Meta publisher does not handle ${input.platform}`, retryable: false };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Meta publish failed", retryable: !(e instanceof MetaReelError) };
    }
  },
  async fetchMetrics(pubs: GrowthPublication[]): Promise<Array<Omit<GrowthMetric, "id">>> {
    const token = process.env.GROWTH_META_PAGE_TOKEN?.trim();
    if (!token) return [];
    const out: Array<Omit<GrowthMetric, "id">> = [];
    for (const pub of pubs) {
      if (pub.platform !== "instagram" || !pub.platformPostId) continue;
      try {
        const m = await fetchInstagramMediaInsights(pub.platformPostId, token);
        out.push({
          publicationId: pub.id,
          capturedAt: new Date().toISOString(),
          views: m.views,
          likes: m.likes,
          comments: m.comments,
          shares: m.shares,
          saves: m.saved,
          followersSnapshot: null,
          raw: m.raw,
        });
      } catch {
        // One failing media must not block the others; the insights step retries next run.
      }
    }
    return out;
  },
};
