import "server-only";

import { publishInstagramPhoto, publishMetaPagePhoto } from "@/lib/listing-channels/meta/graph.server";
import { metaChannelsLive } from "@/lib/listing-channels/registry";
import type { GrowthPublisher, PublishInput, PublishResult } from "../types";

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
    const photo = input.media.find((m) => m.kind === "image");
    if (!photo) return { ok: false, error: "Meta publisher needs an image (video/reels are Phase 2)", retryable: false };
    try {
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
      return { ok: false, error: e instanceof Error ? e.message : "Meta publish failed", retryable: true };
    }
  },
};
